import OpenAI from 'openai';
import type { Response as ModelResponse, ResponseCreateParamsStreaming, ResponseInput } from 'openai/resources/responses/responses';
import z from 'zod';
import type { GenerateObjectInput } from '../models/types';
import type { GeoStructuredModel } from './connection-settings';
import type { ChatGPTReasoningEffort } from './chatgpt-types';

export type ChatGPTInferenceMetadata = {
  model: string;
  reasoningEffort?: ChatGPTReasoningEffort;
  requestId?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export type ChatGPTRequestOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  onMetadata?: (metadata: ChatGPTInferenceMetadata) => void;
};

type ChatGPTModelOptions = ChatGPTRequestOptions & {
  getAccess?: () => Promise<{ accessToken: string; model: string; reasoningEffort?: ChatGPTReasoningEffort }>;
};

type FailureCode = 'request_failed' | 'incomplete' | 'interrupted' | 'invalid_response'
  | 'invalid_object' | 'refused' | 'usage_limit' | 'timeout' | 'cancelled' | 'unsupported_input';
const failureMessages: Record<FailureCode, string> = {
  request_failed: 'ChatGPT 请求失败，请检查登录状态、模型权限与可用额度',
  incomplete: 'ChatGPT 回答未完成，未接受部分结果',
  interrupted: 'ChatGPT 连接在完成事件前中断，未接受部分结果',
  invalid_response: 'ChatGPT 未返回完整、可解析的回答',
  invalid_object: 'ChatGPT 回答未通过结构化结果校验',
  refused: 'ChatGPT 未提供本次请求的结构化回答',
  usage_limit: 'ChatGPT 订阅额度已达限制或暂不可用，请在 ChatGPT 中检查额度',
  timeout: 'ChatGPT 请求超时，本次请求可能已消耗额度',
  cancelled: 'ChatGPT 请求已取消，本次请求可能已消耗额度',
  unsupported_input: 'ChatGPT 结构化分析只支持文本消息',
};

/** Never include upstream messages, response bodies, validation issues, or causes. */
export class ChatGPTModelError extends Error {
  constructor(public code: FailureCode, public status = 502) {
    super(`${failureMessages[code]}${status >= 400 && status < 500 && status !== 408 ? `（HTTP ${status}）` : ''}；未自动重试。`);
    this.name = 'ChatGPTModelError';
  }
}

function isUsageLimit(code: unknown): boolean {
  return code === 'subscription_sharing_usage_limit_exceeded' || code === 'subscription_sharing_usage_unavailable';
}

function responseText(response: ModelResponse): string {
  if (response.status !== 'completed' || response.error || !Array.isArray(response.output)) {
    throw new ChatGPTModelError('invalid_response');
  }
  const parts: string[] = [];
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
      throw new ChatGPTModelError('invalid_response');
    }
    for (const part of item.content) {
      if (part.type === 'refusal') throw new ChatGPTModelError('refused');
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  const text = parts.join('').trim();
  if (!text) throw new ChatGPTModelError('invalid_response');
  return text;
}

function safeMetadata(response: ModelResponse, requestId: string | null, model: string, secret: string,
  reasoningEffort?: ChatGPTReasoningEffort): ChatGPTInferenceMetadata {
  const identifier = (value: unknown): value is string => typeof value === 'string'
    && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value) && !value.includes(secret);
  const metadata: ChatGPTInferenceMetadata = { model: identifier(response.model) ? response.model : identifier(model) ? model : 'unknown' };
  if (reasoningEffort && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort)) {
    metadata.reasoningEffort = reasoningEffort;
  }
  if (identifier(requestId)) metadata.requestId = requestId;
  const usage = response.usage;
  if (usage && [usage.input_tokens, usage.output_tokens, usage.total_tokens].every(value => Number.isSafeInteger(value) && value >= 0)) {
    metadata.usage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens };
  }
  return metadata;
}

/** Official ChatGPT plan Responses transport; one request, no provider fallback. */
export default class ChatGPTModel implements GeoStructuredModel {
  constructor(private readonly options: ChatGPTModelOptions = {}) {}

  withRequestOptions(options: ChatGPTRequestOptions): ChatGPTModel {
    return new ChatGPTModel({ ...this.options, ...options });
  }

  async generateObject<T>(input: GenerateObjectInput): Promise<T> {
    const controller = new AbortController();
    const signal = this.options.signal ? AbortSignal.any([controller.signal, this.options.signal]) : controller.signal;
    const timeoutMs = this.options.timeoutMs ?? 180_000;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const messages: ResponseInput = input.messages.map(message => {
        if (message.role === 'tool' || (message.role === 'assistant' && message.tool_calls?.length)) {
          throw new ChatGPTModelError('unsupported_input', 400);
        }
        return { role: message.role === 'system' ? 'developer' : message.role, content: message.content };
      });
      // SIWC's model catalog does not promise JSON Schema mode for every model.
      // Preserve the full schema in instructions and validate strictly after completion.
      const instructions = `Return only one JSON object, without markdown or surrounding text. Preserve required fields and evidence; do not invent missing evidence. The JSON must satisfy this schema: ${JSON.stringify(z.toJSONSchema(input.schema))}`;
      const getAccess: NonNullable<ChatGPTModelOptions['getAccess']> = this.options.getAccess
        ?? (async () => (await import('./chatgpt-auth')).getChatGPTAccess());
      const { accessToken, model, reasoningEffort } = await getAccess();
      if (!accessToken?.trim() || !model?.trim()) throw new ChatGPTModelError('request_failed', 401);
      signal.throwIfAborted();
      const fetcher = this.options.fetch ?? fetch;
      const client = new OpenAI({
        apiKey: accessToken, baseURL: 'https://api.openai.com/v1', maxRetries: 0, timeout: timeoutMs, logLevel: 'off',
        fetch: (url, init) => fetcher(url, {
          ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        }),
      });
      // ChatGPT plan usage rejects sampling/token-limit fields, even when callers supply them.
      const { data: stream, request_id: requestId } = await client.responses.create({
        model, instructions, input: messages, store: false, stream: true,
        // The installed SDK predates the documented `max` effort; preserve its wire value.
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } as ResponseCreateParamsStreaming['reasoning'] } : {}),
      }, { signal, maxRetries: 0 }).withResponse();
      let completed: ModelResponse | undefined;
      for await (const event of stream) {
        if (event.type === 'response.failed') {
          throw new ChatGPTModelError(isUsageLimit(event.response.error?.code) ? 'usage_limit' : 'request_failed');
        }
        if (event.type === 'error') throw new ChatGPTModelError(isUsageLimit(event.code) ? 'usage_limit' : 'request_failed');
        if (event.type === 'response.incomplete') throw new ChatGPTModelError('incomplete');
        if (event.type === 'response.completed') { completed = event.response; break; }
      }
      signal.throwIfAborted();
      if (!completed) throw new ChatGPTModelError('interrupted');
      const text = responseText(completed);
      let object: unknown;
      try {
        object = JSON.parse(text);
        if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error();
        object = input.schema.parse(object);
      } catch { throw new ChatGPTModelError('invalid_object'); }
      // Observability cannot change an otherwise successful result; never pass content or credentials.
      try { this.options.onMetadata?.(safeMetadata(completed, requestId, model, accessToken, reasoningEffort)); } catch { /* Optional observer. */ }
      return object as T;
    } catch (error) {
      if (signal.aborted) throw new ChatGPTModelError(timedOut ? 'timeout' : 'cancelled', timedOut ? 504 : 408);
      if (error instanceof ChatGPTModelError) throw error;
      const status = error instanceof OpenAI.APIError && Number.isInteger(error.status) ? error.status : undefined;
      const code = error instanceof OpenAI.APIError && isUsageLimit(error.code) ? 'usage_limit' : 'request_failed';
      throw new ChatGPTModelError(code, status && status >= 400 && status <= 599 ? status : 502);
    } finally { clearTimeout(timer); }
  }
}

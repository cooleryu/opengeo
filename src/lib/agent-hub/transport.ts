import { APICallError, generateText, jsonSchema, NoObjectGeneratedError, Output, type JSONSchema7, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { getChatGPTStatus } from '../geo/chatgpt-auth';
import {
  getGeoModelConnection,
  GeoSettingsError,
  shouldUseChatGPTSubscription,
} from '../geo/connection-settings';
import { createLanguageModel } from '../models/ai-sdk';
import type { ModelProviderId } from '../models/providers';
import type { ChatMessage, LLMCompletionRequest, LLMCompletionResult, LLMTransport, ToolCallRequest } from './types';

export interface ModelTransportConfig {
  provider: ModelProviderId;
  baseURL: string;
  apiKey: string;
  models: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const FALLBACK_CODES = new Set([400, 404, 408, 429, 500, 502, 503, 504]);
const cleanEnv = (v?: string) => (v ? v.trim().replace(/^["']|["']$/g, '') : '');
/** Assistant turns carry the AI SDK's own copy so reasoning and provider signatures (e.g. Gemini) round-trip. */
const SDK_MESSAGES = 'sdkMessages';

function parseArguments(text: string): unknown {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function toSdkMessages(messages: ChatMessage[]): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const out: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      out.push({ role: message.role, content: message.content });
    } else if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
      const saved = message[SDK_MESSAGES];
      if (Array.isArray(saved)) { out.push(...(saved as ModelMessage[])); continue; }
      out.push({ role: 'assistant', content: [
        ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({ type: 'tool-call' as const, toolCallId: call.id, toolName: call.function.name, input: parseArguments(call.function.arguments) })),
      ] });
    } else if (message.role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: message.tool_call_id,
        toolName: toolNames.get(message.tool_call_id) ?? 'unknown', output: { type: 'text', value: message.content } }] });
    }
  }
  return out;
}

export function createModelTransport(config: ModelTransportConfig): LLMTransport {
  const models = [...new Set(config.models.filter(Boolean))];
  if (!config.apiKey || !config.baseURL || !models.length) throw new GeoSettingsError('模型连接缺少 API 地址、模型名称或密钥。');
  const timeoutMs = config.timeoutMs ?? 120_000;

  return {
    provider: config.provider,
    async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
      // The hub validates tool arguments itself, so the SDK only forwards the JSON Schema.
      const tools: ToolSet | undefined = req.tools?.length
        ? Object.fromEntries(req.tools.map((t) => [t.name, { description: t.description, inputSchema: jsonSchema(z.toJSONSchema(t.parameters, { unrepresentable: 'any' }) as JSONSchema7) }]))
        : undefined;

      for (let idx = 0; idx < models.length; idx += 1) {
        const model = models[idx];
        const hasFallback = idx < models.length - 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), hasFallback ? Math.min(timeoutMs, 90_000) : timeoutMs);
        const onAbort = () => controller.abort();
        req.signal?.addEventListener('abort', onAbort, { once: true });
        const start = Date.now();
        try {
          const languageModel = createLanguageModel({ provider: config.provider, baseURL: config.baseURL, apiKey: config.apiKey, model }, config.fetchImpl);
          const call = () => generateText({
            model: languageModel,
            messages: toSdkMessages(req.messages),
            allowSystemInMessages: true,
            tools,
            ...(req.jsonMode && !tools ? { output: Output.json() } : {}),
            temperature: req.temperature,
            maxOutputTokens: req.maxTokens,
            maxRetries: 0,
            abortSignal: controller.signal,
          });
          let result: Awaited<ReturnType<typeof call>> | undefined;
          for (let netAttempt = 0; netAttempt < 2 && !result; netAttempt += 1) {
            try {
              result = await call();
            } catch (callError) {
              // Invalid JSON goes back to the hub as text: its correction turn handles it.
              if (NoObjectGeneratedError.isInstance(callError)) {
                return { message: { role: 'assistant', content: callError.text ?? '' }, model: callError.response?.modelId || model,
                  latencyMs: Date.now() - start, promptTokens: callError.usage?.inputTokens, completionTokens: callError.usage?.outputTokens };
              }
              const isNetworkError = !APICallError.isInstance(callError) || callError.statusCode === undefined;
              if (controller.signal.aborted || netAttempt === 1 || !isNetworkError) throw callError;
            }
          }
          if (!result) throw new Error('模型调用失败。');
          const toolCalls: ToolCallRequest[] = result.toolCalls.map((c) => ({ id: c.toolCallId, type: 'function', function: { name: c.toolName, arguments: JSON.stringify(c.input ?? {}) } }));
          return {
            message: { role: 'assistant', content: result.text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), [SDK_MESSAGES]: result.response.messages },
            model: result.response.modelId || model,
            latencyMs: Date.now() - start,
            promptTokens: result.usage.inputTokens,
            completionTokens: result.usage.outputTokens,
          };
        } catch (error) {
          if (req.signal?.aborted) throw new Error('模型请求已取消。');
          const status = APICallError.isInstance(error) ? error.statusCode : undefined;
          if (status !== undefined) {
            if (hasFallback && FALLBACK_CODES.has(status)) continue;
            throw new Error(`模型服务返回 HTTP ${status}（${config.provider}/${model}）。`);
          }
          if (hasFallback) continue;
          if (error instanceof Error) {
            const cause = (error as Error & { cause?: { code?: string; message?: string } }).cause;
            const detail = cause?.code || cause?.message;
            throw new Error(detail ? `${error.message} (${detail})` : error.message);
          }
          throw new Error('模型调用失败。');
        } finally {
          clearTimeout(timer);
          req.signal?.removeEventListener('abort', onAbort);
        }
      }
      throw new Error('所有候选模型均暂不可用，请稍后重试。');
    },
  };
}

export function resolveAgentTransport(role: 'default' | 'fast' = 'default', preferredProvider?: 'gemini' | 'deepseek'): LLMTransport {
  const geminiKey = cleanEnv(process.env.GEMINI_API_KEY);
  const deepseekKey = cleanEnv(process.env.DEEPSEEK_API_KEY) || cleanEnv(process.env.OPENGEO_LLM_API_KEY);
  const saved = getGeoModelConnection();
  if (preferredProvider === 'gemini' && geminiKey) {
    const savedGemini = saved.configured && saved.provider === 'gemini' ? saved.model : '';
    const models = role === 'fast'
      ? ['gemini-3.5-flash-lite', 'gemini-3.6-flash']
      : [savedGemini || 'gemini-3.8-flash', 'gemini-3.6-flash'];
    return createModelTransport({ provider: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: geminiKey, models });
  }
  if (preferredProvider === 'deepseek' && deepseekKey) {
    const savedDeepseek = saved.configured && saved.provider === 'deepseek' ? saved.model : '';
    const models = role === 'fast'
      ? ['deepseek-flash']
      : [savedDeepseek || 'deepseek-flash', 'deepseek-flash'];
    return createModelTransport({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: deepseekKey, models });
  }
  if (saved.configured && saved.apiKey && saved.baseURL) {
    if (saved.source !== 'saved' && saved.provider === 'deepseek' && deepseekKey) return resolveAgentTransport(role, 'deepseek');
    const models = saved.provider === 'gemini' ? [saved.model, 'gemini-3.6-flash'] : saved.provider === 'deepseek' ? [saved.model, 'deepseek-flash'] : [saved.model];
    return createModelTransport({ provider: saved.provider, baseURL: saved.baseURL, apiKey: saved.apiKey, models });
  }
  if (deepseekKey) return resolveAgentTransport(role, 'deepseek');
  if (geminiKey) return resolveAgentTransport(role, 'gemini');
  if (shouldUseChatGPTSubscription(getChatGPTStatus())) {
    throw new GeoSettingsError(
      '当前仅登录了 ChatGPT 订阅账号：该通道用于回答审核与项目理解，暂不支持多步骤工具调用写稿；请在设置中配置 Gemini、DeepSeek 或 OpenAI 兼容 API Key 后生成优化方案。',
      409,
    );
  }
  throw new GeoSettingsError('尚未配置可用的分析模型（支持 Gemini、DeepSeek 或 OpenAI 兼容接口）。');
}

import { z } from 'zod';
import { getGeoModelConnection, GeoSettingsError } from '../geo/connection-settings';
import type { LLMCompletionRequest, LLMCompletionResult, LLMTransport } from './types';

export interface OpenAICompatibleConfig {
  provider: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const FALLBACK_CODES = new Set([400, 404, 408, 429, 500, 502, 503, 504]);
const cleanEnv = (v?: string) => (v ? v.trim().replace(/^["']|["']$/g, '') : '');

export function createOpenAICompatibleTransport(config: OpenAICompatibleConfig): LLMTransport {
  const models = [...new Set(config.models.filter(Boolean))];
  if (!config.apiKey || !config.baseURL || !models.length) throw new GeoSettingsError('模型连接缺少 API 地址、模型名称或密钥。');
  const base = config.baseURL.replace(/\/+$/, '');
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
  const fetcher = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 120_000;

  return {
    provider: config.provider,
    async complete(req: LLMCompletionRequest): Promise<LLMCompletionResult> {
      const tools = req.tools?.length
        ? req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.parameters) } }))
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
          let res: Response | undefined;
          for (let netAttempt = 0; netAttempt < 2; netAttempt += 1) {
            try {
              res = await fetcher(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
                signal: controller.signal,
                body: JSON.stringify({
                  model,
                  messages: req.messages,
                  ...(tools ? { tools, tool_choice: 'auto' } : {}),
                  ...(req.jsonMode && !tools ? { response_format: { type: 'json_object' } } : {}),
                  ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
                  ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
                }),
              });
              break;
            } catch (fetchErr) {
              if (controller.signal.aborted || netAttempt === 1) throw fetchErr;
            }
          }
          const latencyMs = Date.now() - start;
          if (!res || !res.ok) {
            if (res && hasFallback && FALLBACK_CODES.has(res.status)) continue;
            throw new Error(`模型服务返回 HTTP ${res?.status ?? 'ERR'}（${config.provider}/${model}）。`);
          }
          const data = (await res.json()) as { model?: string; choices?: Array<{ message?: LLMCompletionResult['message'] }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
          const message = data.choices?.[0]?.message;
          if (!message || message.role !== 'assistant') throw new Error(`模型未返回有效消息（${model}）。`);
          return { message, model: data.model || model, latencyMs, promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens };
        } catch (error) {
          if (req.signal?.aborted) throw new Error('模型请求已取消。');
          if (hasFallback) continue;
          throw error instanceof Error ? error : new Error('模型调用失败。');
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
    return createOpenAICompatibleTransport({ provider: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: geminiKey, models });
  }
  if (preferredProvider === 'deepseek' && deepseekKey) {
    const savedDeepseek = saved.configured && saved.provider === 'deepseek' ? saved.model : '';
    const models = role === 'fast'
      ? ['deepseek-flash']
      : [savedDeepseek || 'deepseek-flash', 'deepseek-flash'];
    return createOpenAICompatibleTransport({ provider: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: deepseekKey, models });
  }
  if (saved.configured && saved.apiKey && saved.baseURL) {
    if (saved.source !== 'saved' && saved.provider === 'deepseek' && deepseekKey) return resolveAgentTransport(role, 'deepseek');
    const models = saved.provider === 'gemini' ? [saved.model, 'gemini-3.6-flash'] : saved.provider === 'deepseek' ? [saved.model, 'deepseek-flash'] : [saved.model];
    return createOpenAICompatibleTransport({ provider: saved.provider, baseURL: saved.baseURL, apiKey: saved.apiKey, models });
  }
  if (deepseekKey) return resolveAgentTransport(role, 'deepseek');
  if (geminiKey) return resolveAgentTransport(role, 'gemini');
  throw new GeoSettingsError('尚未配置可用的分析模型（支持 Gemini 或 DeepSeek）。');
}

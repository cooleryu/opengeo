import type OpenAI from 'openai';
import { z } from 'zod';
import type { GenerateObjectInput } from '@/lib/models/types';
import { getGeoModelConnection, loadGeoModel } from './connection-settings';
import { getCollectionConfig, requireCollectionKey } from './providers/config';
import { buildDoubaoRequest, parseDoubaoAnswer } from './providers/doubao';
import { buildQwenRequest, parseQwenAnswer } from './providers/qwen';
import type { CollectionConfig, CollectionProvider } from './providers/types';

type TestSection = 'model' | CollectionProvider;
type StructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };
export type ConnectionTestRuntime = {
  loadModel: (signal: AbortSignal, timeoutMs: number) => Promise<StructuredModel>;
  collectionConfig: (provider: CollectionProvider) => CollectionConfig;
  collectionKey: (provider: CollectionProvider) => string;
  fetch: typeof fetch;
  timeoutMs: number;
};

export class ConnectionTestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const labels: Record<TestSection, string> = {
  model: '模型结构化回答', deepseek: 'DeepSeek 搜索', qwen: '千问联网回答', doubao: '豆包联网回答',
};
const modelResult = z.object({ ok: z.literal(true) }).strict();
const searchQuery = '请联网搜索 OpenAI 官方网站，只用一句话给出官网地址并附来源。';

/** Configure only this test instance; SDK retries and redirects must not add requests. */
export function singleRequestModel(model: StructuredModel, fetcher: typeof fetch,
  signal: AbortSignal, timeoutMs: number): StructuredModel {
  const instance = model as StructuredModel & { openAIClient?: OpenAI };
  if (!instance.openAIClient?.withOptions) {
    throw new ConnectionTestError('当前模型连接不支持单次测试，请先保存 OpenGEO 模型连接。', 409);
  }
  instance.openAIClient = instance.openAIClient.withOptions({
    maxRetries: 0,
    timeout: timeoutMs,
    fetch: (url, init) => fetcher(url, {
      ...init,
      redirect: 'error',
      signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
    }),
  });
  return instance;
}

const defaultRuntime: ConnectionTestRuntime = {
  loadModel: async (signal, timeoutMs) => {
    const connection = getGeoModelConnection();
    if (!connection.configured) throw new ConnectionTestError('请先保存完整的模型连接，再测试。', 409);
    // Other registry providers can discover models or retry internally. Do not
    // promise a single billed request for those legacy connections.
    if (connection.vaneProviderId) throw new ConnectionTestError('旧 Vane 连接暂不支持单次测试，请先保存 OpenGEO 模型连接。', 409);
    return singleRequestModel(await loadGeoModel(), fetch, signal, timeoutMs);
  },
  collectionConfig: getCollectionConfig,
  collectionKey: requireCollectionKey,
  fetch: (...args) => fetch(...args),
  timeoutMs: 45_000,
};

function testSection(input: unknown): TestSection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionTestError('测试请求格式无效。');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'section' && key !== 'acknowledgeCost')) {
    throw new ConnectionTestError('测试只使用已保存的连接，请勿传入临时配置。');
  }
  if (body.acknowledgeCost !== true) throw new ConnectionTestError('请先确认本次测试可能产生费用。');
  if (typeof body.section !== 'string' || !Object.hasOwn(labels, body.section)) throw new ConnectionTestError('请选择有效的连接进行测试。');
  return body.section as TestSection;
}

function safeFailure(error: unknown, label: string, aborted: boolean): ConnectionTestError {
  if (error instanceof ConnectionTestError) return error;
  const failure = error && typeof error === 'object' ? error as { status?: unknown; name?: unknown } : {};
  if (aborted || failure.name === 'AbortError' || failure.name === 'TimeoutError' || failure.name === 'APIConnectionTimeoutError') {
    return new ConnectionTestError(`${label}测试超时；请求可能已计费，未自动重试。`, 504);
  }
  const status = typeof failure.status === 'number' && Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599
    ? `（HTTP ${failure.status}）` : '';
  return new ConnectionTestError(`${label}请求失败${status}；请核对连接、模型权限及余额，未自动重试。`, 502);
}

async function readResponse(response: Response, label: string, section: TestSection): Promise<unknown> {
  if (!response.ok) {
    if (section === 'doubao' && response.status === 404) {
      // Recognize only the verified provider code; never relay upstream text.
      const failure = await response.json().catch(() => null);
      if (failure?.error?.code === 'ToolNotOpen') {
        throw new ConnectionTestError('豆包账号尚未开通联网内容插件，请前往火山方舟开通：https://console.volcengine.com/common-buy/CC_content_plugin 。开通后重新测试；本次未自动重试。', 502);
      }
    } else {
      await response.body?.cancel();
    }
    throw new ConnectionTestError(`${label}请求失败（HTTP ${response.status}）；请核对密钥、模型权限及余额，未自动重试。`, 502);
  }
  try { return await response.json(); }
  catch { throw new ConnectionTestError(`${label}响应格式无法解析，未自动重试。`, 502); }
}

/** One explicit small request, with no observation, run, or settings writes. */
export async function testGeoConnection(input: unknown, runtime: ConnectionTestRuntime = defaultRuntime) {
  const section = testSection(input);
  const label = labels[section];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectionTestError(`${label}测试超时；请求可能已计费，未自动重试。`, 504));
    }, runtime.timeoutMs);
  });
  try {
    const message = await Promise.race([timeout, (async () => {
      if (section === 'model') {
        const model = await runtime.loadModel(controller.signal, runtime.timeoutMs);
        controller.signal.throwIfAborted();
        const result = await model.generateObject({
          schema: modelResult,
          messages: [{ role: 'user', content: 'Return exactly this JSON object: {"ok":true}.' }],
          options: { temperature: 0, maxTokens: 64 },
        });
        if (!modelResult.safeParse(result).success) throw new ConnectionTestError('模型返回未通过结构化结果校验，未自动重试。', 502);
        return '模型连接与结构化回答测试通过。';
      }
      let key: string;
      let config: CollectionConfig;
      try {
        key = runtime.collectionKey(section);
        config = runtime.collectionConfig(section);
        if (!key.trim()) throw new Error();
      } catch { throw new ConnectionTestError(`请先保存完整的${label}连接，再测试。`, 409); }
      const testConfig = { ...config, parameters: { ...config.parameters,
        ...(section === 'qwen' ? { max_tokens: 256 } : section === 'doubao' ? { max_output_tokens: 256 } : {}),
      } };
      const request = section === 'deepseek'
        ? { url: 'https://api.deepseek.com/v1/tools/search',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: { query: 'OpenAI official website', count: 1, need_content: false } }
        : section === 'qwen' ? buildQwenRequest(searchQuery, testConfig, key) : buildDoubaoRequest(searchQuery, testConfig, key);
      controller.signal.throwIfAborted();
      const response = await runtime.fetch(request.url, { method: 'POST', headers: request.headers,
        body: JSON.stringify(request.body), signal: controller.signal, redirect: 'error' });
      const raw = await readResponse(response, label, section);
      if (section === 'deepseek') {
        const results = raw && typeof raw === 'object' ? (raw as { results?: unknown }).results : undefined;
        if (!Array.isArray(results) || results.some(result => !result || typeof result !== 'object' || typeof result.url !== 'string')) {
          throw new ConnectionTestError('DeepSeek 搜索响应未包含有效结果列表，未自动重试。', 502);
        }
        return results.length ? 'DeepSeek 搜索接口测试通过。' : 'DeepSeek 搜索接口已响应，本次测试未返回搜索结果。';
      }
      let answer;
      try { answer = section === 'qwen' ? parseQwenAnswer(raw) : parseDoubaoAnswer(raw); }
      catch { throw new ConnectionTestError(`${label}未返回完整、可解析的回答，未自动重试。`, 502); }
      if (!answer.searchPerformed) throw new ConnectionTestError(`${label}未返回已完成联网搜索的证据，不能确认联网能力。`, 502);
      return `${label}测试通过。`;
    })()]);
    return { ok: true, message, testedAt: new Date().toISOString() };
  } catch (error) {
    throw safeFailure(error, label, controller.signal.aborted);
  } finally { clearTimeout(timer); }
}

export async function handleConnectionTestRequest(request: Request, runtime?: ConnectionTestRuntime): Promise<Response> {
  try {
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    const origin = request.headers.get('origin');
    if (origin && origin !== `${url.protocol}//${authority}`) throw new ConnectionTestError('只接受当前应用页面发起的操作。', 403);
    let body: unknown;
    try { body = await request.json(); }
    catch { throw new ConnectionTestError('测试请求格式无效。'); }
    return Response.json(await testGeoConnection(body, runtime), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const failure = error instanceof ConnectionTestError ? error : new ConnectionTestError('连接测试失败，请检查已保存的配置。', 500);
    return Response.json({ error: failure.message }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } });
  }
}

import type OpenAI from 'openai';
import { z } from 'zod';
import type { GenerateObjectInput } from '@/lib/models/types';
import { getGeoModelConnection, loadGeoModel } from './connection-settings';

type TestSection = 'model';
type StructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };
export type ConnectionTestRuntime = {
  loadModel: (signal: AbortSignal, timeoutMs: number) => Promise<StructuredModel>;
  fetch: typeof fetch;
  timeoutMs: number;
};

export class ConnectionTestError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const labels: Record<TestSection, string> = {
  model: '模型结构化回答',
};
const modelResult = z.object({ ok: z.literal(true) }).strict();

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
    return singleRequestModel(await loadGeoModel(), fetch, signal, timeoutMs);
  },
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
      const model = await runtime.loadModel(controller.signal, runtime.timeoutMs);
      controller.signal.throwIfAborted();
      const result = await model.generateObject({
        schema: modelResult,
        messages: [{ role: 'user', content: 'Return exactly this JSON object: {"ok":true}.' }],
        options: { temperature: 0, maxTokens: 64 },
      });
      if (!modelResult.safeParse(result).success) throw new ConnectionTestError('模型返回未通过结构化结果校验，未自动重试。', 502);
      return '模型连接与结构化回答测试通过。';
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

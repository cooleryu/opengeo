import type OpenAI from 'openai';
import { z } from 'zod';
import type { GenerateObjectInput } from '@/lib/models/types';
import { getGeoModelConnection, loadGeoModel } from './connection-settings';
import type { GeoLanguage } from './i18n';
import {
  buildServerErrorPayload,
  resolveRequestUiLanguage,
  translateServerCode,
  type ServerErrorParams,
} from './i18n-server';

type TestSection = 'model';
type StructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };
export type ConnectionTestRuntime = {
  loadModel: (signal: AbortSignal, timeoutMs: number) => Promise<StructuredModel>;
  fetch: typeof fetch;
  timeoutMs: number;
};

export class ConnectionTestError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public params?: ServerErrorParams,
    public detail?: string,
  ) {
    super(translateServerCode('zh', code, params));
  }
}

const allowedSections = new Set<string>(['model']);
const modelResult = z.object({ ok: z.literal(true) }).strict();

/** Configure only this test instance; SDK retries and redirects must not add requests. */
export function singleRequestModel(model: StructuredModel, fetcher: typeof fetch,
  signal: AbortSignal, timeoutMs: number): StructuredModel {
  const instance = model as StructuredModel & { openAIClient?: OpenAI };
  if (!instance.openAIClient?.withOptions) {
    throw new ConnectionTestError('connection_test_failed', 409, { reason: 'unsupported', provider: 'model' });
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
    if (!connection.configured) throw new ConnectionTestError('model_not_configured', 409);
    return singleRequestModel(await loadGeoModel(), fetch, signal, timeoutMs);
  },
  fetch: (...args) => fetch(...args),
  timeoutMs: 45_000,
};

function testSection(input: unknown): TestSection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionTestError('invalid_request');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== 'section' && key !== 'acknowledgeCost')) {
    throw new ConnectionTestError('connection_test_failed', 400, { reason: 'temp_config', provider: 'model' });
  }
  if (body.acknowledgeCost !== true) throw new ConnectionTestError('connection_test_failed', 400, { reason: 'cost_unconfirmed', provider: 'model' });
  if (typeof body.section !== 'string' || !allowedSections.has(body.section)) throw new ConnectionTestError('invalid_settings', 400, { field: 'section' });
  return body.section as TestSection;
}

function safeFailure(error: unknown, provider: string, aborted: boolean): ConnectionTestError {
  if (error instanceof ConnectionTestError) return error;
  const failure = error && typeof error === 'object' ? error as { status?: unknown; name?: unknown } : {};
  if (aborted || failure.name === 'AbortError' || failure.name === 'TimeoutError' || failure.name === 'APIConnectionTimeoutError') {
    return new ConnectionTestError('connection_test_failed', 504, { reason: 'timeout', provider });
  }
  const status = typeof failure.status === 'number' && Number.isInteger(failure.status) && failure.status >= 400 && failure.status <= 599
    ? failure.status : undefined;
  if (status !== undefined) {
    return new ConnectionTestError('connection_test_failed', 502, { reason: 'http', status, provider });
  }
  return new ConnectionTestError('connection_test_failed', 502, { provider });
}

/** One explicit small request, with no observation, run, or settings writes. */
export async function testGeoConnection(
  input: unknown,
  runtime: ConnectionTestRuntime = defaultRuntime,
  lang: GeoLanguage = 'zh',
) {
  const section = testSection(input);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectionTestError('connection_test_failed', 504, { reason: 'timeout', provider: section }));
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
      if (!modelResult.safeParse(result).success) throw new ConnectionTestError('model_output_invalid', 502);
      return translateServerCode(lang, 'settings.test.ok');
    })()]);
    return { ok: true, message, testedAt: new Date().toISOString() };
  } catch (error) {
    throw safeFailure(error, section, controller.signal.aborted);
  } finally { clearTimeout(timer); }
}

export async function handleConnectionTestRequest(request: Request, runtime?: ConnectionTestRuntime): Promise<Response> {
  const lang = resolveRequestUiLanguage(request);
  try {
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    const origin = request.headers.get('origin');
    if (origin && origin !== `${url.protocol}//${authority}`) throw new ConnectionTestError('forbidden_origin', 403);
    let body: unknown;
    try { body = await request.json(); }
    catch { throw new ConnectionTestError('invalid_request', 400); }
    return Response.json(await testGeoConnection(body, runtime, lang), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const { status, body } = buildServerErrorPayload(
      error instanceof ConnectionTestError
        ? error
        : new ConnectionTestError('connection_test_failed', 500, { provider: 'model' }),
      lang,
    );
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inferModelProvider } from '../models/providers';
import {
  handleConnectionTestRequest,
  singleRequestModel,
  testGeoConnection,
  type ConnectionTestRuntime,
} from './connection-test';

const syntheticKey = 'unit-test-key-not-real';
function runtime(overrides: Partial<ConnectionTestRuntime> = {}): ConnectionTestRuntime {
  return {
    loadModel: async () => ({ generateObject: async <T>() => ({ ok: true }) as T }),
    fetch: async () => {
      throw new Error('Unexpected request');
    },
    timeoutMs: 1000,
    ...overrides,
  };
}
const input = (section: string) => ({ section, acknowledgeCost: true });
function request(body: unknown, origin = 'http://127.0.0.1:4327') {
  return new Request('http://localhost:4327/api/geo/settings/test', {
    method: 'POST',
    headers: { origin, host: '127.0.0.1:4327', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('cost consent and request shape are checked before loading connections or sending', async () => {
  let calls = 0;
  const run = runtime({
    loadModel: async () => {
      calls++;
      throw new Error();
    },
  });
  for (const body of [
    { section: 'model' },
    { section: 'model', acknowledgeCost: false },
    { ...input('model'), apiKey: syntheticKey },
    { ...input('model'), url: 'https://attacker.invalid' },
    input('chatgpt'),
  ]) {
    const response = await handleConnectionTestRequest(request(body), run);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  const response = await handleConnectionTestRequest(request(input('model'), 'https://attacker.invalid'), run);
  assert.equal(response.status, 403);
  assert.equal(calls, 0);
});

test('model test validates the returned object instead of treating any answer as success', async () => {
  let calls = 0;
  const run = runtime({
    loadModel: async () => ({
      generateObject: async <T>(payload: unknown) => {
        calls++;
        assert.match(JSON.stringify(payload), /maxTokens.*64/);
        return { ok: true } as T;
      },
    }),
  });
  const response = await handleConnectionTestRequest(request(input('model')), run);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(Date.parse(result.testedAt)));
  assert.equal(calls, 1);
  await assert.rejects(
    testGeoConnection(
      input('model'),
      runtime({
        loadModel: async () => ({
          generateObject: async <T>() => ({ ok: false }) as T,
        }),
      }),
    ),
    /结构化结果校验/,
  );
});

test('upstream model errors remain safe and are not retried', async () => {
  let calls = 0;
  const modelResponse = await handleConnectionTestRequest(
    request(input('model')),
    runtime({
      loadModel: async () => {
        calls++;
        throw Object.assign(new Error(syntheticKey), { status: 429 });
      },
    }),
  );
  assert.equal(modelResponse.status, 502);
  const modelText = await modelResponse.text();
  assert.match(modelText, /HTTP 429/);
  assert.ok(!modelText.includes(syntheticKey));
  assert.equal(calls, 1);
});

test('test deadline aborts the model request and does not retry or return upstream details', async () => {
  let calls = 0;
  let aborted = false;
  const response = await handleConnectionTestRequest(
    request(input('model')),
    runtime({
      timeoutMs: 15,
      loadModel: async (signal) =>
        singleRequestModel(
          { provider: inferModelProvider('https://generativelanguage.googleapis.com/v1beta/openai'), apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai' },
          async (_url, init) => {
            calls++;
            return new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(new Error(syntheticKey));
                },
                { once: true },
              ),
            );
          },
          signal,
        ),
    }),
  );
  assert.equal(response.status, 504);
  const timeoutBody = await response.text();
  assert.match(timeoutBody, /connection_test_failed/);
  assert.match(timeoutBody, /may still have been billed|可能已计费/);
  assert.ok(!timeoutBody.includes(syntheticKey));
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});

test('the actual OpenAI-compatible SDK wrapper makes one request on 500, with synthetic credentials only', async () => {
  let calls = 0;
  const run = runtime({
    loadModel: async (signal) =>
      singleRequestModel(
        { provider: inferModelProvider('https://example.invalid/v1'), apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://example.invalid/v1' },
        async () => {
          calls++;
          return Response.json({ error: { message: syntheticKey } }, { status: 500 });
        },
        signal,
      ),
  });
  const response = await handleConnectionTestRequest(request(input('model')), run);
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
  const text = await response.text();
  assert.match(text, /HTTP 500/);
  assert.ok(!text.includes(syntheticKey));
});

test('the actual structured SDK path parses a small valid JSON result and has a cancellable transport', async () => {
  let calls = 0;
  const run = runtime({
    loadModel: async (signal) =>
      singleRequestModel(
        { provider: inferModelProvider('https://example.invalid/v1'), apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://example.invalid/v1' },
        async (_url, init) => {
          calls++;
          assert.ok(init?.signal);
          assert.equal(init?.redirect, 'error');
          return Response.json({
            id: 'synthetic-id',
            object: 'chat.completion',
            created: 0,
            model: 'synthetic-model',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
          });
        },
        signal,
      ),
  });
  assert.equal((await testGeoConnection(input('model'), run)).ok, true);
  assert.equal(calls, 1);
});

test('the DeepSeek model adapter is cancelled by the test deadline despite its longer per-call timeout', async () => {
  let calls = 0;
  let aborted = false;
  const response = await handleConnectionTestRequest(
    request(input('model')),
    runtime({
      timeoutMs: 15,
      loadModel: async (signal) =>
        singleRequestModel(
          { provider: inferModelProvider('https://api.deepseek.com'), apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://api.deepseek.com' },
          async (_url, init) => {
            calls++;
            const body = JSON.parse(String(init?.body));
            assert.equal(body.response_format.type, 'json_object');
            assert.equal(body.max_tokens, 64);
            return new Promise<Response>((_resolve, reject) =>
              init?.signal?.addEventListener(
                'abort',
                () => {
                  aborted = true;
                  reject(new Error(syntheticKey));
                },
                { once: true },
              ),
            );
          },
          signal,
        ),
    }),
  );
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.ok(!(await response.text()).includes(syntheticKey));
});

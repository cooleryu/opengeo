import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAILLM from '../models/providers/openai/openaiLLM';
import { handleConnectionTestRequest, singleRequestModel, testGeoConnection, type ConnectionTestRuntime } from './connection-test';
import type { CollectionConfig, CollectionProvider } from './providers/types';

const syntheticKey = 'unit-test-key-not-real';
function config(provider: CollectionProvider): CollectionConfig {
  return { provider, label: provider,
    endpoint: provider === 'qwen' ? 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'
      : provider === 'doubao' ? 'https://ark.cn-beijing.volces.com/api/v3/responses' : 'https://api.deepseek.com/v1/tools/search',
    model: 'synthetic-model', metric: provider === 'deepseek' ? 'web_target_hit' : 'answer_target_citation',
    parameters: provider === 'qwen' ? { result_format: 'message', enable_search: true,
      search_options: { forced_search: true, enable_source: true, enable_citation: true, citation_format: '[ref_<number>]' } }
      : provider === 'doubao' ? { tools: [{ type: 'web_search', sources: ['search_engine'], limit: 1, max_keyword: 1 }] } : {},
  };
}
function runtime(overrides: Partial<ConnectionTestRuntime> = {}): ConnectionTestRuntime {
  return { loadModel: async () => ({ generateObject: async <T>() => ({ ok: true }) as T }),
    collectionKey: () => syntheticKey, collectionConfig: config,
    fetch: async () => { throw new Error('Unexpected request'); }, timeoutMs: 1000, ...overrides };
}
const input = (section: string) => ({ section, acknowledgeCost: true });
function request(body: unknown, origin = 'http://127.0.0.1:4327') {
  return new Request('http://localhost:4327/api/geo/settings/test', { method: 'POST',
    headers: { origin, host: '127.0.0.1:4327', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('cost consent and request shape are checked before loading connections or sending', async () => {
  let calls = 0;
  const run = runtime({ collectionKey: () => { calls++; return syntheticKey; },
    loadModel: async () => { calls++; throw new Error(); } });
  for (const body of [{ section: 'model' }, { section: 'model', acknowledgeCost: false },
    { ...input('model'), apiKey: syntheticKey }, { ...input('deepseek'), url: 'https://attacker.invalid' }, input('chatgpt')]) {
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
  const run = runtime({ loadModel: async () => ({ generateObject: async <T>(payload: unknown) => {
    calls++; assert.match(JSON.stringify(payload), /maxTokens.*64/); return { ok: true } as T;
  } }) });
  const response = await handleConnectionTestRequest(request(input('model')), run);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.ok(Number.isFinite(Date.parse(result.testedAt)));
  assert.equal(calls, 1);
  await assert.rejects(testGeoConnection(input('model'), runtime({ loadModel: async () => ({
    generateObject: async <T>() => ({ ok: false }) as T,
  }) })), /结构化结果校验/);
});

test('DeepSeek sends exactly one minimal search request and accepts an empty result list as an interface response', async () => {
  let calls = 0;
  const run = runtime({ fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${syntheticKey}`);
    assert.deepEqual(JSON.parse(String(init?.body)), { query: 'OpenAI official website', count: 1, need_content: false });
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    return Response.json({ results: [] });
  } });
  const result = await testGeoConnection(input('deepseek'), run);
  assert.equal(calls, 1);
  assert.match(result.message, /未返回搜索结果/);
});

test('Qwen tests its real web-answer protocol, effective model, and returned search evidence', async () => {
  let calls = 0;
  const run = runtime({ fetch: async (url, init) => {
    calls++;
    assert.equal(url, config('qwen').endpoint);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'synthetic-model');
    assert.equal(body.parameters.enable_search, true);
    assert.equal(body.parameters.search_options.forced_search, true);
    assert.equal(body.parameters.max_tokens, 256);
    assert.ok(body.input.messages[0].content);
    return Response.json({ output: { choices: [{ finish_reason: 'stop', message: { content: 'Official site.[ref_1]' } }],
      search_info: { search_results: [{ index: 1, url: 'https://openai.com/', title: 'OpenAI' }] } } });
  } });
  assert.equal((await testGeoConnection(input('qwen'), run)).ok, true);
  assert.equal(calls, 1);
  run.fetch = async () => Response.json({ output: { choices: [{ finish_reason: 'stop', message: { content: 'A chat answer.' } }] } });
  await assert.rejects(testGeoConnection(input('qwen'), run), /未返回已完成联网搜索的证据/);
});

test('Doubao tests Responses web search and rejects an unfinished answer', async () => {
  let calls = 0;
  const run = runtime({ fetch: async (url, init) => {
    calls++;
    assert.equal(url, config('doubao').endpoint);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, 'synthetic-model');
    assert.equal(body.tools[0].type, 'web_search');
    assert.equal(body.max_output_tokens, 256);
    return Response.json({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OpenAI.' }] },
    ] });
  } });
  assert.equal((await testGeoConnection(input('doubao'), run)).ok, true);
  assert.equal(calls, 1);
  run.fetch = async () => Response.json({ status: 'incomplete', output: [], error: syntheticKey });
  await assert.rejects(testGeoConnection(input('doubao'), run), error => {
    assert.match(String(error), /未返回完整/); assert.ok(!String(error).includes(syntheticKey)); return true;
  });
});

test('upstream errors remain safe and are not retried', async () => {
  let calls = 0;
  const response = await handleConnectionTestRequest(request(input('deepseek')), runtime({ fetch: async () => {
    calls++; return Response.json({ error: `Do not expose ${syntheticKey}` }, { status: 401 });
  } }));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /HTTP 401/);
  assert.ok(!text.includes(syntheticKey));
  assert.equal(calls, 1);
  const modelResponse = await handleConnectionTestRequest(request(input('model')), runtime({ loadModel: async () => {
    throw Object.assign(new Error(syntheticKey), { status: 429 });
  } }));
  assert.equal(modelResponse.status, 502);
  const modelText = await modelResponse.text();
  assert.match(modelText, /HTTP 429/);
  assert.ok(!modelText.includes(syntheticKey));
});

test('Doubao ToolNotOpen explains the verified plugin requirement without upstream details', async () => {
  let calls = 0;
  const response = await handleConnectionTestRequest(request(input('doubao')), runtime({ fetch: async () => {
    calls++;
    return Response.json({ error: { code: 'ToolNotOpen', message: `private upstream message ${syntheticKey}` } },
      { status: 404, headers: { 'x-private-upstream': syntheticKey } });
  } }));
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /豆包账号尚未开通联网内容插件/);
  assert.ok(text.includes('https://console.volcengine.com/common-buy/CC_content_plugin'));
  assert.ok(!text.includes('核对密钥'));
  assert.ok(!text.includes('private upstream message'));
  assert.ok(!text.includes(syntheticKey));
  assert.equal(response.headers.get('x-private-upstream'), null);
  assert.equal(calls, 1);
});

test('unrecognized provider errors keep the existing generic failure', async () => {
  for (const [section, status, body] of [
    ['doubao', 404, JSON.stringify({ error: { code: 'OtherCode', message: syntheticKey } })],
    ['doubao', 404, `malformed ${syntheticKey}`],
    ['doubao', 401, JSON.stringify({ error: { code: 'ToolNotOpen', message: syntheticKey } })],
    ['qwen', 404, JSON.stringify({ error: { code: 'ToolNotOpen', message: syntheticKey } })],
  ] as const) {
    let calls = 0;
    const response = await handleConnectionTestRequest(request(input(section)), runtime({ fetch: async () => {
      calls++; return new Response(body, { status });
    } }));
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(text.includes(`HTTP ${status}`));
    assert.match(text, /请核对密钥、模型权限及余额/);
    assert.ok(!text.includes('common-buy'));
    assert.ok(!text.includes(syntheticKey));
    assert.equal(calls, 1);
  }
});

test('test deadline aborts the request and does not retry or return upstream details', async () => {
  let calls = 0;
  let aborted = false;
  const response = await handleConnectionTestRequest(request(input('deepseek')), runtime({ timeoutMs: 15,
    fetch: async (_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
        aborted = true; reject(new Error(syntheticKey));
      }, { once: true }));
    },
  }));
  assert.equal(response.status, 504);
  assert.match(await response.text(), /可能已计费/);
  assert.equal(aborted, true);
  assert.equal(calls, 1);
});

test('missing saved search credentials stop before any request', async () => {
  let calls = 0;
  const response = await handleConnectionTestRequest(request(input('qwen')), runtime({
    collectionKey: () => { throw new Error(syntheticKey); },
    fetch: async () => { calls++; return Response.json({}); },
  }));
  assert.equal(response.status, 409);
  assert.equal(calls, 0);
  assert.ok(!(await response.text()).includes(syntheticKey));
});

test('the actual OpenAI-compatible SDK wrapper makes one request on 500, with synthetic credentials only', async () => {
  let calls = 0;
  const run = runtime({ loadModel: async (signal, timeoutMs) => singleRequestModel(
    new OpenAILLM({ apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://example.invalid/v1' }),
    async () => { calls++; return Response.json({ error: { message: syntheticKey } }, { status: 500 }); }, signal, timeoutMs,
  ) });
  const response = await handleConnectionTestRequest(request(input('model')), run);
  assert.equal(response.status, 502);
  assert.equal(calls, 1);
  const text = await response.text();
  assert.match(text, /HTTP 500/);
  assert.ok(!text.includes(syntheticKey));
});

test('the actual structured SDK path parses a small valid JSON result and has a cancellable transport', async () => {
  let calls = 0;
  const run = runtime({ loadModel: async (signal, timeoutMs) => singleRequestModel(
    new OpenAILLM({ apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://example.invalid/v1' }),
    async (_url, init) => {
      calls++; assert.ok(init?.signal); assert.equal(init?.redirect, 'error');
      return Response.json({ id: 'synthetic-id', object: 'chat.completion', created: 0, model: 'synthetic-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }] });
    }, signal, timeoutMs,
  ) });
  assert.equal((await testGeoConnection(input('model'), run)).ok, true);
  assert.equal(calls, 1);
});

test('the DeepSeek model adapter is cancelled by the test deadline despite its longer per-call timeout', async () => {
  let calls = 0;
  let aborted = false;
  const response = await handleConnectionTestRequest(request(input('model')), runtime({ timeoutMs: 15,
    loadModel: async (signal, timeoutMs) => singleRequestModel(
      new OpenAILLM({ apiKey: syntheticKey, model: 'synthetic-model', baseURL: 'https://api.deepseek.com' }),
      async (_url, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.response_format.type, 'json_object');
        assert.equal(body.max_tokens, 64);
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
          aborted = true; reject(new Error(syntheticKey));
        }, { once: true }));
      }, signal, timeoutMs,
    ),
  }));
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.equal(calls, 1);
  assert.ok(!(await response.text()).includes(syntheticKey));
});

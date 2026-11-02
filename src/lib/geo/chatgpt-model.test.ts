import assert from 'node:assert/strict';
import { test } from 'node:test';
import z from 'zod';
import ChatGPTModel, { ChatGPTModelError, type ChatGPTInferenceMetadata } from './chatgpt-model';

const secret = 'synthetic-access-token-not-real';
const selectedModel = 'synthetic-chatgpt-model';
const schema = z.object({ ok: z.literal(true), evidence: z.array(z.string()).min(1) }).strict();
const object = { ok: true, evidence: ['中文证据'] };
const input = { schema, messages: [{ role: 'user' as const, content: 'Verify the evidence.' }] };

function completed(text = JSON.stringify(object), extras: Record<string, unknown> = {}) {
  return { type: 'response.completed', response: {
    id: 'resp_synthetic', status: 'completed', model: selectedModel,
    output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 18, output_tokens: 9, total_tokens: 27, unsafe_extra: secret }, ...extras,
  } };
}

function sse(events: unknown[], byteChunks = false): Response {
  const bytes = new TextEncoder().encode(events.map(event => `event: ${(event as { type: string }).type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (byteChunks) for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_synthetic' } });
}

function model(fetcher: typeof fetch, onMetadata?: (metadata: ChatGPTInferenceMetadata) => void) {
  return new ChatGPTModel({ getAccess: async () => ({ accessToken: secret, model: selectedModel }),
    fetch: fetcher, timeoutMs: 1000, onMetadata });
}

test('uses the official Responses endpoint once with OAuth and only supported request fields', async () => {
  let calls = 0;
  let metadata: ChatGPTInferenceMetadata | undefined;
  const adapter = model(async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'store', 'stream']);
    assert.equal(body.model, selectedModel);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    assert.deepEqual(body.input, [
      { role: 'developer', content: 'Retain all evidence.' },
      { role: 'user', content: 'Verify the evidence.' },
    ]);
    assert.match(body.instructions, /"required":\["ok","evidence"\]/);
    assert.match(body.instructions, /"additionalProperties":false/);
    assert.match(body.instructions, /do not invent missing evidence/);
    return sse([completed()]);
  }, result => { metadata = result; });
  assert.deepEqual(await adapter.generateObject({ ...input,
    messages: [{ role: 'system', content: 'Retain all evidence.' }, ...input.messages],
    options: { temperature: 0, maxTokens: 64, topP: 0.5, stopSequences: ['STOP'], frequencyPenalty: 1, presencePenalty: 1 },
  }), object);
  assert.equal(calls, 1);
  assert.deepEqual(metadata, { model: selectedModel, requestId: 'req_synthetic',
    usage: { inputTokens: 18, outputTokens: 9, totalTokens: 27 } });
  assert.ok(!JSON.stringify(metadata).includes(secret));
});

test('handles SSE delimiters and multi-byte UTF-8 characters split across network chunks', async () => {
  const adapter = model(async () => sse([
    { type: 'response.output_text.delta', delta: '{"ok":true,' },
    { type: 'response.output_text.delta', delta: '"evidence":["中文证据"]}' },
    completed(),
  ], true));
  assert.deepEqual(await adapter.generateObject(input), object);
});

test('forwards the selected GPT-6.1 Terra max effort and records only the selected effort in metadata', async () => {
  let calls = 0;
  let metadata: ChatGPTInferenceMetadata | undefined;
  const adapter = new ChatGPTModel({
    getAccess: async () => ({ accessToken: secret, model: 'gpt-6.1-terra', reasoningEffort: 'max' }),
    timeoutMs: 1000,
    fetch: async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'gpt-6.1-terra');
      assert.deepEqual(body.reasoning, { effort: 'max' });
      assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'reasoning', 'store', 'stream']);
      return sse([completed(JSON.stringify(object), { model: 'gpt-6.1-terra', reasoning: { effort: secret } })]);
    },
    onMetadata: result => { metadata = result; },
  });
  assert.deepEqual(await adapter.generateObject(input), object);
  assert.equal(calls, 1);
  assert.deepEqual(metadata, { model: 'gpt-6.1-terra', reasoningEffort: 'max', requestId: 'req_synthetic',
    usage: { inputTokens: 18, outputTokens: 9, totalTokens: 27 } });
  assert.ok(!JSON.stringify(metadata).includes(secret));
});

test('does not accept valid-looking deltas before a terminal failure, incomplete event, or end of stream', async () => {
  const cases = [
    { event: { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: secret } } }, code: 'usage_limit' },
    { event: { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: secret } } }, code: 'usage_limit' },
    { event: { type: 'response.failed', response: { error: { code: secret, message: secret } } }, code: 'request_failed' },
    { event: { type: 'response.incomplete', response: { incomplete_details: { reason: secret } } }, code: 'incomplete' },
    { event: { type: 'error', code: secret, message: secret }, code: 'request_failed' },
    { event: undefined, code: 'interrupted' },
  ];
  for (const { event, code } of cases) {
    let calls = 0;
    let observed = false;
    const adapter = model(async () => {
      calls++;
      return sse([{ type: 'response.output_text.delta', delta: JSON.stringify(object) }, ...(event ? [event] : [])]);
    }, () => { observed = true; });
    await assert.rejects(adapter.generateObject(input), error => {
      assert.ok(error instanceof ChatGPTModelError);
      assert.equal(error.code, code);
      assert.ok(!String(error).includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(observed, false);
  }
});

test('rejects malformed JSON, repaired-looking output, missing evidence, extra keys, and non-object values', async () => {
  for (const text of ['{', '```json\n' + JSON.stringify(object) + '\n```',
    '{"ok":true}', '{"ok":true,"evidence":[]}',
    JSON.stringify({ ...object, unexpected: secret }), 'null', '[]', 'true']) {
    await assert.rejects(model(async () => sse([completed(text)])).generateObject(input), error => {
      assert.ok(error instanceof ChatGPTModelError);
      assert.equal(error.code, 'invalid_object');
      assert.ok(!String(error).includes(secret));
      return true;
    });
  }
});

test('rejects contradictory completed status, empty completed output, and refusals', async () => {
  const cases = [
    { status: 'incomplete' }, { error: { message: secret } }, { output: [] },
    { output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [] }] },
    { output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: secret }] }] },
  ];
  for (const extra of cases) await assert.rejects(
    model(async () => sse([completed(JSON.stringify(object), extra)])).generateObject(input),
    error => error instanceof ChatGPTModelError && !String(error).includes(secret),
  );
});

test('redacts HTTP and transport errors, does not retry, and rejects redirects', async () => {
  for (const status of [302, 401, 429, 500]) {
    let calls = 0;
    await assert.rejects(model(async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'error');
      return Response.json({ error: { message: secret, code: secret } }, { status });
    }).generateObject(input), error => error instanceof ChatGPTModelError && !String(error).includes(secret));
    assert.equal(calls, 1);
  }
  await assert.rejects(model(async () => { throw new Error(secret); }).generateObject(input),
    error => error instanceof ChatGPTModelError && !String(error).includes(secret));
  await assert.rejects(new ChatGPTModel({ getAccess: async () => { throw new Error(secret); } }).generateObject(input),
    error => error instanceof ChatGPTModelError && !String(error).includes(secret));
});

test('withRequestOptions applies the test transport and timeout without mutating the original adapter', async () => {
  let calls = 0;
  let aborted = false;
  const original = model(async () => sse([completed()]));
  const configured = original.withRequestOptions({ timeoutMs: 15, fetch: async (_url, init) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => {
      aborted = true; reject(new Error(secret));
    }, { once: true }));
  } });
  await assert.rejects(configured.generateObject(input), error => error instanceof ChatGPTModelError && error.code === 'timeout');
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.deepEqual(await original.generateObject(input), object);
});

test('external cancellation stops before sending and never exposes its reason', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error(secret));
  await assert.rejects(model(async () => { calls++; return sse([completed()]); })
    .withRequestOptions({ signal: controller.signal }).generateObject(input),
  error => error instanceof ChatGPTModelError && error.code === 'cancelled' && !String(error).includes(secret));
  assert.equal(calls, 0);
});

test('does not silently discard tool history or invoke a model for unsupported input', async () => {
  let calls = 0;
  await assert.rejects(model(async () => { calls++; return sse([completed()]); }).generateObject({ ...input,
    messages: [{ role: 'tool', id: 'tool_1', name: 'search', content: 'evidence' }],
  }), error => error instanceof ChatGPTModelError && error.code === 'unsupported_input');
  assert.equal(calls, 0);
});

test('keeps SDK debug logging disabled and metadata restricted to safe scalar fields', async () => {
  const previous = process.env.OPENAI_LOG;
  const methods = ['debug', 'info', 'warn', 'error'] as const;
  const originals = methods.map(method => console[method]);
  const logged: unknown[] = [];
  let metadata: ChatGPTInferenceMetadata | undefined;
  process.env.OPENAI_LOG = 'debug';
  methods.forEach(method => { console[method] = (...args) => { logged.push(args); }; });
  try {
    await model(async () => {
      const response = sse([completed(JSON.stringify(object), { model: secret })]);
      response.headers.set('x-request-id', secret);
      return response;
    }, result => { metadata = result; }).generateObject(input);
    assert.deepEqual(logged, []);
    assert.deepEqual(metadata, { model: selectedModel, usage: { inputTokens: 18, outputTokens: 9, totalTokens: 27 } });
  } finally {
    methods.forEach((method, index) => { console[method] = originals[index]; });
    if (previous === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previous;
  }
});

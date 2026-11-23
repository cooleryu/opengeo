import '../geo/test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { answerAuditorAgent } from '../geo/agents/auditor-agent';
import { createProjectInspectionTools } from '../geo/agents/project-tools';
import { AgentHub, createModelTransport, type AgentSpec } from './index';

test('model transport falls back to the next model on HTTP 503 and keeps the SDK turn for round trips', async () => {
  const attemptedModels: string[] = [];
  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-pro', 'deepseek-flash'],
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attemptedModels.push(body.model);
      if (body.model === 'deepseek-pro') {
        return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  const res = await transport.complete({ messages: [{ role: 'user', content: 'ping' }] });
  assert.deepEqual(attemptedModels, ['deepseek-pro', 'deepseek-flash']);
  assert.equal(res.model, 'deepseek-flash');
  assert.equal(res.message.content, '{"ok":true}');
  assert.equal(res.promptTokens, 12);
  assert.ok(Array.isArray(res.message.sdkMessages));
});

test('AgentHub executes multi-turn ReAct tool calls and emits plain-Chinese progress logs', async () => {
  const hub = new AgentHub();
  const scoutSpec: AgentSpec<Record<string, never>, { assetCount: number; firstQuestionId: string }> = {
    id: 'test-scout',
    title: '项目资料巡检官',
    outputSchema: z.object({ assetCount: z.number().int(), firstQuestionId: z.string() }),
    tools: () => createProjectInspectionTools(),
    buildPrompt: () => ({
      system: '先调用工具查看自有资料和监测题库，再输出汇总。',
      user: '请汇总当前项目自有资料数量和第一道核心题编号。',
    }),
  };

  let callIndex = 0;
  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-chat'],
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      callIndex += 1;
      const body = JSON.parse(String(init?.body));
      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'read_owned_asset', arguments: '{}' } },
                    { id: 'c2', type: 'function', function: { name: 'list_project_questions', arguments: '{}' } },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      const toolMsgs = body.messages.filter((m: { role: string }) => m.role === 'tool');
      assert.equal(toolMsgs.length, 2);
      const assets = JSON.parse(toolMsgs[0].content);
      const questions = JSON.parse(toolMsgs[1].content);
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  assetCount: assets.length,
                  firstQuestionId: questions[0].questionId,
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const result = await hub.run(scoutSpec, {}, { projectId: 'sample-project', transport });
  assert.equal(result.output.firstQuestionId, 'C01');
  assert.ok(result.output.assetCount > 0);
  assert.equal(result.telemetry.turns, 2);
  assert.equal(result.telemetry.toolCalls, 2);
  assert.equal(result.progress.length, 4);
  assert.match(result.progress[1].message, /正在盘点项目现有的自有资料清单/);
  assert.match(result.progress[2].message, /正在查看项目的核心监测问题/);
});

test('Guardrail interceptor blocks unauthorized write tools and cross-project args', async () => {
  const hub = new AgentHub();
  const unsafeSpec: AgentSpec<Record<string, never>, { done: boolean }> = {
    id: 'unsafe-writer',
    title: '测试写入员',
    outputSchema: z.object({ done: z.boolean() }),
    tools: () => [
      {
        name: 'mutate_external_site',
        description: 'Mutate external site',
        parameters: z.object({}),
        readOnly: false,
        humanLabel: () => '尝试写入外部站点',
        execute: () => ({ ok: true }),
      },
    ],
    buildPrompt: () => ({ system: 'call tool', user: 'go' }),
  };

  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-chat'],
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'w1', type: 'function', function: { name: 'mutate_external_site', arguments: '{}' } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
  });

  await assert.rejects(
    () => hub.run(unsafeSpec, {}, { projectId: 'sample-project', transport }),
    /安全切面拦截：未经用户确认，禁止执行写入类操作/,
  );
});

test('Validation aspect catches personal_memory false-positive and forces self-correction to no', async () => {
  const hub = new AgentHub();
  let turn = 0;
  const transport = createModelTransport({
    provider: 'custom',
    baseURL: 'https://example.invalid/v1',
    apiKey: 'synthetic-key',
    models: ['gemini-3.5-flash-lite'],
    fetchImpl: async () => {
      turn += 1;
      if (turn === 1) {
        // Simulates small model mistakenly saying mention=yes on personalized memory
        return new Response(
          JSON.stringify({
            model: 'gemini-3.5-flash-lite',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    identity: 'matched',
                    mention: 'yes',
                    citation: 'unknown',
                    mentionQuote: '结合你在做的 SampleProject',
                    mentionEvidence: '提到了你在做的项目',
                    citationEvidence: '引用来源待核实',
                    officialUrls: [],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          model: 'gemini-3.5-flash-lite',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  identity: 'personal_memory',
                  mention: 'no',
                  citation: 'unknown',
                  mentionQuote: '结合你在做的 SampleProject',
                  mentionEvidence: '仅因聊天个人记忆提及“你在做的 SampleProject”，不属于陌生用户自然发现。',
                  citationEvidence: '无原生引用记录。',
                  officialUrls: [],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const res = await hub.run(
    answerAuditorAgent,
    {
      query: '什么工具好用？',
      answerText: '除了通用工具，还可以结合你在做的 SampleProject 来测试。',
      citationSource: 'unknown',
      citationsComplete: false,
      nativeCitations: [],
    },
    { projectId: 'sample-project', transport },
  );

  assert.equal(turn, 2);
  assert.equal(res.output.identity, 'personal_memory');
  assert.equal(res.output.mention, 'no');
});

test('AgentHub.mapReduce runs parallel shards with bounded concurrency, preserves order, and reduces cleanly', async () => {
  const hub = new AgentHub();

  const mapSpec: AgentSpec<{ shard: string; delayMs: number }, { shard: string; count: number }> = {
    id: 'test-mapper',
    title: '分片阅读员',
    role: 'fast',
    outputSchema: z.object({ shard: z.string(), count: z.number().int() }),
    buildPrompt: (input) => ({ system: 'extract', user: JSON.stringify(input) }),
  };
  const reduceSpec: AgentSpec<{ items: Array<{ shard: string; count: number }> }, { total: number; shards: string[] }> = {
    id: 'test-reducer',
    title: '信号汇总官',
    role: 'fast',
    outputSchema: z.object({ total: z.number().int(), shards: z.array(z.string()) }),
    buildPrompt: (input) => ({ system: 'reduce', user: JSON.stringify(input) }),
  };

  hub.register(mapSpec).register(reduceSpec);

  let active = 0;
  let peakActive = 0;
  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-chat'],
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const payload = JSON.parse(body.messages.filter((m) => m.role === 'user').at(-1)!.content);
      if ('shard' in payload) {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((r) => setTimeout(r, payload.delayMs));
        active -= 1;
        return new Response(
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [{ message: { role: 'assistant', content: JSON.stringify({ shard: payload.shard, count: payload.shard.length }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200 },
        );
      }
      const items = payload.items as Array<{ shard: string; count: number }>;
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  total: items.reduce((s, i) => s + i.count, 0),
                  shards: items.map((i) => i.shard),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
        { status: 200 },
      );
    },
  });

  const mr = await hub.mapReduce<
    { shard: string; delayMs: number },
    { shard: string; count: number },
    { items: Array<{ shard: string; count: number }> },
    { total: number; shards: string[] }
  >({
    mapSpec: 'test-mapper',
    mapInputs: [
      { shard: 'chatgpt-1', delayMs: 40 },
      { shard: 'chatgpt-2', delayMs: 10 },
      { shard: 'google-1', delayMs: 30 },
      { shard: 'google-2', delayMs: 5 },
    ],
    reduceSpec: 'test-reducer',
    buildReduceInput: (items) => ({ items }),
    concurrency: 2,
    shardLabel: (item) => item.shard,
    projectId: 'sample-project',
    transport,
  });

  assert.equal(peakActive, 2);
  assert.deepEqual(mr.output.shards, ['chatgpt-1', 'chatgpt-2', 'google-1', 'google-2']);
  assert.equal(mr.output.total, 9 + 9 + 8 + 8);
  assert.equal(mr.telemetry.promptTokens, 60);
  assert.equal(mr.telemetry.completionTokens, 28);
  assert.ok(mr.progress.some((p) => p.message.includes('并发调度 4 个')));
});

test('model transport disables DeepSeek thinking in jsonMode and reports length cut-offs cleanly', async () => {
  let seenBody: Record<string, unknown> | null = null;
  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-flash'],
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{"partial":' } }],
          usage: { prompt_tokens: 100, completion_tokens: 1200 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  await assert.rejects(
    () => transport.complete({ messages: [{ role: 'user', content: 'return json' }], jsonMode: true, maxTokens: 1200 }),
    /Model JSON was cut off/,
  );
  assert.deepEqual((seenBody as { thinking?: unknown } | null)?.thinking, { type: 'disabled' });
});

test('model transport enables DeepSeek thinking when req.thinking is true in jsonMode', async () => {
  let seenBody: Record<string, unknown> | null = null;
  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-flash'],
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 240 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  const res = await transport.complete({
    messages: [{ role: 'user', content: 'reason carefully and return json' }],
    jsonMode: true,
    thinking: true,
    temperature: 0.3,
    maxTokens: 8192,
  });
  assert.equal(res.message.content, '{"ok":true}');
  assert.deepEqual((seenBody as { thinking?: unknown } | null)?.thinking, { type: 'enabled' });
  assert.equal((seenBody as { temperature?: unknown } | null)?.temperature, undefined);
  assert.equal((seenBody as { max_tokens?: number } | null)?.max_tokens, 16384);
});

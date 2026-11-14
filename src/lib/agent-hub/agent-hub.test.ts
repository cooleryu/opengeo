import '../geo/test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { answerAuditorAgent } from '../geo/agents/auditor-agent';
import { createProjectInspectionTools } from '../geo/agents/project-tools';
import { AgentHub, createOpenAICompatibleTransport, type AgentSpec } from './index';

test('OpenAICompatibleTransport automatically falls back on HTTP 503 and preserves extra_content', async () => {
  const attemptedModels: string[] = [];
  const transport = createOpenAICompatibleTransport({
    provider: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: 'synthetic-key',
    models: ['gemini-3.8-flash', 'gemini-3.6-flash'],
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      attemptedModels.push(body.model);
      if (body.model === 'gemini-3.8-flash') {
        return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
      }
      return new Response(
        JSON.stringify({
          model: 'gemini-3.6-flash',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '{"ok":true}',
                extra_content: { google: { thought_signature: 'sig-123' } },
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  const res = await transport.complete({ messages: [{ role: 'user', content: 'ping' }] });
  assert.deepEqual(attemptedModels, ['gemini-3.8-flash', 'gemini-3.6-flash']);
  assert.equal(res.model, 'gemini-3.6-flash');
  assert.deepEqual(res.message.extra_content, { google: { thought_signature: 'sig-123' } });
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
  const transport = createOpenAICompatibleTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-chat'],
    fetchImpl: async (_url, init) => {
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

  const transport = createOpenAICompatibleTransport({
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
  const transport = createOpenAICompatibleTransport({
    provider: 'gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
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

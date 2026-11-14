import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { collectResearch } from './research-collection';
import { getLatestResearch, getResearchRun } from './research';
import { requestResearchStop } from './research-store';

test('optional caps run without a placeholder limit and reject unsupported or insufficient strict budgets before sending', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-research-budget-'));
  const environment = ['DATA_DIR', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'].map(name => [name, process.env[name]] as const);
  const originalFetch = globalThis.fetch;
  let audits = 0;
  let competitorAnalyses = 0;
  const audit = mock.method(require('./answer-audit'), 'analyzeResearchObservation', async () => { audits++; });
  const competitor = mock.method(require('./competitor-analysis'), 'analyzeCompetitorCandidates', async () => { competitorAnalyses++; });
  try {
    process.env.DATA_DIR = temporary;
    process.env.DEEPSEEK_API_KEY = 'local-test-never-sent';
    process.env.DASHSCOPE_API_KEY = 'local-test-never-sent';
    const batch = getLatestResearch('sample-project')!;
    const selected = batch.questions.slice(0, 2);
    let requests = 0;
    globalThis.fetch = async input => {
      requests++;
      return new Response(JSON.stringify(String(input).includes('deepseek')
        ? { results: [{ url: 'https://example.com/test', title: 'Test result' }] }
        : { output: { choices: [{ finish_reason: 'stop', message: { content: 'Test answer [ref_1]' } }], search_info: { search_results: [{ index: 1, url: 'https://example.com/test', title: 'Test source' }] } } }), { status: 200 });
    };
    const input = { batchId: batch.id, language: 'zh', questionIds: selected.map(q => q.id) };
    const unlimitedInput = { ...input, requestId: 'test_unlimited_qwen_001', provider: 'qwen', budgetEnabled: false };
    const { run: unlimited } = await collectResearch(unlimitedInput);
    assert.equal(unlimited.status, 'completed');
    assert.equal(unlimited.budgetEnabled, false);
    assert.equal(unlimited.budgetEnforcement, 'disabled');
    assert.equal(unlimited.budgetLimit, null);
    assert.equal(unlimited.budget, undefined);
    assert.equal(unlimited.spent, 0.2, 'the old 0.1 reservation must not become an implicit cap');
    assert.equal(requests, 2);
    assert.equal(audits, 2, 'disabled caps preserve per-answer analysis');
    assert.equal(competitorAnalyses, 1, 'disabled caps preserve competitor analysis');
    assert.deepEqual(getResearchRun(batch.projectId, unlimited.id), JSON.parse(JSON.stringify(unlimited)));
    assert.deepEqual((await collectResearch(unlimitedInput)).run, JSON.parse(JSON.stringify(unlimited)));
    assert.equal(requests, 2, 'repeated intent must not send again');
    await assert.rejects(collectResearch({ ...unlimitedInput, budgetEnabled: true, budget: { currency: 'CNY', amount: 1 } }), /其他条件/);

    await assert.rejects(collectResearch({ ...input, requestId: 'test_too_small_cap_001', provider: 'deepseek', budgetEnabled: true,
      budget: { currency: 'CNY', amount: 0.005 } }), /费用上限不足/);
    for (const provider of ['qwen', 'doubao']) {
      await assert.rejects(collectResearch({ ...input, requestId: `test_unknown_cap_${provider}`, provider, budgetEnabled: true,
        budget: { currency: 'CNY', amount: 1 } }), /当前平台暂不能保证费用上限/);
    }
    assert.equal(requests, 2, 'rejected caps must never dispatch requests');
    const { run: bounded } = await collectResearch({ ...input, requestId: 'test_strict_deepseek_001', provider: 'deepseek', budgetEnabled: true,
      budget: { currency: 'CNY', amount: 0.01 } });
    assert.equal(bounded.status, 'completed');
    assert.equal(bounded.budgetEnforcement, 'strict');
    assert.equal(bounded.spent, 0.01);
    assert.equal(bounded.analysisStatus, 'pending_budget');
    assert.ok(bounded.analysisNote);
    assert.equal(requests, 4);
    assert.equal(audits, 2, 'strict cap must not start unbounded analysis');
    assert.equal(competitorAnalyses, 1, 'strict cap must not start unbounded competitor analysis');
    assert.deepEqual(getResearchRun(batch.projectId, bounded.id), JSON.parse(JSON.stringify(bounded)));
  } finally {
    audit.mock.restore(); competitor.mock.restore();
    globalThis.fetch = originalFetch;
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('a stop during either provider request retains its result and cost, skips later questions and analyses', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-research-stop-'));
  const environment = ['DATA_DIR', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'].map(name => [name, process.env[name]] as const);
  const originalFetch = globalThis.fetch;
  try {
    process.env.DATA_DIR = temporary;
    process.env.DEEPSEEK_API_KEY = 'local-test-never-sent';
    process.env.DASHSCOPE_API_KEY = 'local-test-never-sent';
    for (const provider of ['deepseek', 'qwen'] as const) {
      const before = getLatestResearch('sample-project')!;
      const selected = before.questions.slice(0, 2);
      const requestId = `test_stop_${provider}_run_001`;
      let requests = 0;
      globalThis.fetch = async input => {
        requests++;
        assert.equal(requests, 1, 'no later search or AI request may start');
        assert.match(String(input), provider === 'deepseek' ? /api\.deepseek\.com/ : /dashscope\.aliyuncs\.com/);
        const running = getResearchRun(before.projectId, requestId)!;
        assert.equal(running.status, 'running');
        assert.equal(running.phase, 'searching');
        assert.equal(running.currentQuestionId, selected[0].id);
        const stopped = requestResearchStop(before.projectId, requestId);
        assert.equal(stopped.status, 'running', 'the active request retains the project lock');
        return new Response(JSON.stringify(provider === 'deepseek'
          ? { results: [{ url: 'https://example.com/test', title: 'Test result' }] }
          : { output: { choices: [{ finish_reason: 'stop', message: { content: 'Test answer [ref_1]' } }], search_info: { search_results: [{ index: 1, url: 'https://example.com/test', title: 'Test source' }] } } }), { status: 200 });
      };
      const { run } = await collectResearch({ requestId, projectId: before.projectId, batchId: before.id, provider, language: 'zh', questionIds: selected.map(q => q.id), budget: { currency: 'CNY', amount: 0.2 } });
      assert.equal(requests, 1);
      assert.equal(run.status, 'interrupted');
      assert.ok(run.stopRequestedAt);
      assert.equal(run.completedCount, 1);
      assert.equal(run.currentQuestionId, undefined);
      assert.equal(run.phase, undefined);
      assert.equal(run.spent, provider === 'deepseek' ? 0.005 : 0.1);
      assert.equal(run.confirmedSpentCny, provider === 'deepseek' ? 0.005 : 0);
      assert.equal(run.reservedCny, provider === 'deepseek' ? 0 : 0.1);
      const after = getLatestResearch(before.projectId)!;
      assert.deepEqual(after.questions[0].observations.slice(0, -1), before.questions[0].observations);
      assert.equal(after.questions[0].observations.at(-1)!.runId, requestId);
      assert.deepEqual(after.questions[1].observations, before.questions[1].observations);
      const files = fs.readdirSync(path.join(temporary, 'data/geo-evidence', requestId));
      assert.ok(files.includes(`${selected[0].id}.json`));
      assert.equal(files.includes(`${selected[1].id}.request.json`), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

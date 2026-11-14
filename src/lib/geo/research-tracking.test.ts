import './test-fixtures';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { currentGeoProject } from './projects';
import { getLatestResearch, getResearchRun, saveResearchRun } from './research';
import type { ResearchRunRecord } from './research-store';
import { createResearchSchedule, isResearchScheduleEnabled, listResearchSchedules, tickResearchSchedules, updateResearchSchedule } from './research-tracking';
import type { ResearchSchedule } from './research-tracking-types';

const originalDataDirectory = process.env.DATA_DIR;
let temporary: string;
const CREATED = new Date('2026-10-28T01:00:00Z');
const DUE = new Date('2026-10-29T01:00:00Z');
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-research-tracking-'));
  process.env.DATA_DIR = temporary;
});
afterEach(() => {
  if (originalDataDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function input(overrides: Record<string, unknown> = {}) {
  return { projectId: 'sample-project', requestId: 'tracking_request_001', questionIds: ['C01'], language: 'zh', provider: 'deepseek', timeOfDay: '09:00', budget: { currency: 'CNY', amount: 0.01 }, ...overrides };
}

function recordFor(request: Record<string, unknown>, scheduleId: string, additions: Partial<ResearchRunRecord> = {}): ResearchRunRecord {
  const projectId = request.projectId as string;
  const batch = getLatestResearch(projectId)!;
  const language = request.language as 'zh' | 'en';
  return {
    id: request.requestId as string, projectId, batchId: request.batchId as string, provider: 'deepseek', language,
    questions: (request.questionIds as string[]).map(id => ({ questionId: id, query: batch.questions.find(q => q.id === id)![language] })),
    status: 'running', startedAt: DUE.toISOString(), updatedAt: DUE.toISOString(), budgetLimit: request.budgetLimit as number,
    spent: 0, completedCount: 0, ownerPid: process.pid, scheduleId, ...additions,
  } as ResearchRunRecord;
}

function paidResult(record: ResearchRunRecord, confirmed = record.budgetLimit): ResearchRunRecord {
  return { ...record, status: 'completed', completedAt: DUE.toISOString(), completedCount: record.questions.length,
    spent: confirmed, confirmedSpentCny: confirmed, reservedCny: 0 } as ResearchRunRecord;
}

function mutatePlan(plan: ResearchSchedule, mutate: (value: ResearchSchedule) => void): void {
  const db = new Database(path.join(temporary, 'data', 'db.sqlite'));
  try {
    const payload = JSON.parse((db.prepare('SELECT payload FROM geo_research_schedules WHERE id = ?').get(plan.id) as { payload: string }).payload) as ResearchSchedule;
    mutate(payload);
    db.prepare('UPDATE geo_research_schedules SET status = ?, next_run_at = ?, active_run_id = ?, payload = ? WHERE id = ?')
      .run(payload.status, payload.nextRunAt, payload.activeRunId, JSON.stringify(payload), plan.id);
  } finally { db.close(); }
}

test('creation freezes original questions, is idempotent, and starts tomorrow without collecting', async () => {
  const batch = getLatestResearch('sample-project')!;
  const plan = createResearchSchedule(input(), CREATED);
  assert.equal(plan.batchId, batch.id);
  assert.deepEqual(plan.questions, [{ questionId: 'C01', query: batch.questions[0].zh }]);
  assert.equal(plan.nextRunAt, '2026-10-29T01:00:00.000Z');
  assert.equal(plan.timeZone, 'Asia/Shanghai');
  assert.deepEqual(createResearchSchedule(input(), new Date('2026-10-28T23:00:00Z')), plan);
  assert.equal(listResearchSchedules('sample-project').length, 1);
  assert.throws(() => createResearchSchedule(input({ language: 'en' }), CREATED), /其他条件/);
  let calls = 0;
  await tickResearchSchedules({ now: CREATED, collect: async () => { calls++; throw new Error('unexpected call'); } });
  assert.equal(calls, 0);
});

test('currency, count, provider, language and query lengths are validated without sending', () => {
  assert.throws(() => createResearchSchedule(input({ budget: { currency: 'USD', amount: 1 } }), CREATED), /美元/);
  assert.throws(() => createResearchSchedule(input({ budget: { currency: 'CNY', amount: 101 } }), CREATED), /100/);
  assert.throws(() => createResearchSchedule(input({ questionIds: ['C01', 'C02'], budget: { currency: 'CNY', amount: 0.005 } }), CREATED), /一轮/);
  assert.throws(() => createResearchSchedule(input({ questionIds: Array(9).fill('C01') }), CREATED), /1—8/);
  assert.throws(() => createResearchSchedule(input({ questionIds: ['C01', 'C01'] }), CREATED), /不同/);
  assert.throws(() => createResearchSchedule(input({ provider: 'qwen' }), CREATED), /只支持 DeepSeek/);
  assert.throws(() => createResearchSchedule(input({ language: 'de' }), CREATED), /中文或英文/);
  assert.throws(() => createResearchSchedule(input({ timeOfDay: '25:00' }), CREATED), /HH:mm/);
  assert.throws(() => createResearchSchedule(input({ projectId: 'sample-project-two', questionIds: ['R01'], language: 'en' }), CREATED), /128/);
  const dollars = createResearchSchedule(input({ budget: { currency: 'USD', amount: 1, cnyPerUsd: 7 } }), CREATED);
  assert.equal(dollars.limitCny, 7);
  assert.deepEqual(dollars.budget, { currency: 'USD', amount: 1, cnyPerUsd: 7 });
});

test('two due ticks claim once and settle total plan budget before stopping', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  const calls: string[] = [];
  const collect = async (request: Record<string, unknown>, context: { scheduleId: string; shouldContinue: () => boolean }) => {
    calls.push(request.requestId as string);
    assert.equal(currentGeoProject(), request.projectId);
    assert.equal(request.batchId, plan.batchId);
    assert.equal(request.scheduleId, undefined);
    assert.equal(context.scheduleId, plan.id);
    assert.equal(context.shouldContinue(), true);
    const record = recordFor(request, context.scheduleId);
    saveResearchRun(plan.projectId, record);
    await new Promise(resolve => setTimeout(resolve, 20));
    const run = paidResult(record);
    saveResearchRun(plan.projectId, run);
    return { run };
  };
  await Promise.all([tickResearchSchedules({ now: DUE, collect }), tickResearchSchedules({ now: DUE, collect })]);
  assert.equal(calls.length, 1);
  let saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.spentCny, 0.005);
  assert.equal(saved.reservedCny, 0);
  assert.equal(saved.activeRunId, null);
  assert.equal(saved.status, 'active');
  assert.equal(saved.nextRunAt, '2026-10-30T01:00:00.000Z');
  await tickResearchSchedules({ now: new Date('2026-10-30T01:00:00Z'), collect });
  saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(calls.length, 2);
  assert.equal(saved.spentCny, 0.01);
  assert.equal(saved.status, 'budget_exhausted');
  assert.equal(saved.nextRunAt, null);
  await tickResearchSchedules({ now: new Date('2026-10-31T01:00:00Z'), collect });
  assert.equal(calls.length, 2);
  assert.throws(() => updateResearchSchedule(plan.projectId, plan.id, 'resume'), /预算不足/);
});

test('unknown request costs remain reserved across resume and are never retried', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  let calls = 0;
  await tickResearchSchedules({ now: DUE, collect: async (request, context) => {
    calls++;
    const running = recordFor(request, context.scheduleId);
    saveResearchRun(plan.projectId, running);
    const run = { ...running, status: 'failed', spent: 0.005, confirmedSpentCny: 0, reservedCny: 0.005, error: '请求结果未知，不自动重试。' } as ResearchRunRecord;
    saveResearchRun(plan.projectId, run);
    return { run };
  } });
  let saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.status, 'failed');
  assert.equal(saved.spentCny, 0);
  assert.equal(saved.reservedCny, 0.005);
  assert.match(saved.error!, /未知/);
  await tickResearchSchedules({ now: new Date('2026-10-30T01:00:00Z'), collect: async () => { calls++; throw new Error('must not retry'); } });
  assert.equal(calls, 1);
  updateResearchSchedule(plan.projectId, plan.id, 'resume', DUE);
  await tickResearchSchedules({ now: new Date('2026-10-30T01:00:00Z'), collect: async (request, context) => {
    calls++;
    const running = recordFor(request, context.scheduleId);
    saveResearchRun(plan.projectId, running);
    const run = paidResult(running);
    saveResearchRun(plan.projectId, run);
    return { run };
  } });
  saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.spentCny, 0.005);
  assert.equal(saved.reservedCny, 0.005);
  assert.equal(saved.status, 'budget_exhausted');
  assert.equal(calls, 2);
});

test('pause and stop block following requests; a completed in-flight request still settles', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  let canContinue = true;
  const tick = tickResearchSchedules({ now: DUE, collect: async (request, context) => {
    const running = recordFor(request, context.scheduleId);
    saveResearchRun(plan.projectId, running);
    entered();
    await releasePromise;
    canContinue = context.shouldContinue();
    const run = paidResult(running);
    saveResearchRun(plan.projectId, run);
    return { run };
  } });
  await enteredPromise;
  updateResearchSchedule(plan.projectId, plan.id, 'pause', DUE);
  assert.equal(isResearchScheduleEnabled(plan.projectId, plan.id), false);
  assert.throws(() => updateResearchSchedule(plan.projectId, plan.id, 'resume', DUE), /上一轮/);
  release();
  await tick;
  assert.equal(canContinue, false);
  let saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.status, 'paused');
  assert.equal(saved.spentCny, 0.005);
  assert.equal(saved.reservedCny, 0);
  saved = updateResearchSchedule(plan.projectId, plan.id, 'resume', DUE);
  assert.equal(saved.nextRunAt, '2026-10-30T01:00:00.000Z');
  updateResearchSchedule(plan.projectId, plan.id, 'stop', DUE);
  assert.throws(() => updateResearchSchedule(plan.projectId, plan.id, 'resume', DUE), /已停止/);
  await tickResearchSchedules({ now: new Date('2026-10-30T01:00:00Z'), collect: async () => { throw new Error('stopped plan sent a request'); } });
  assert.equal(listResearchSchedules(plan.projectId)[0].status, 'stopped');
});

test('missed calendar days are skipped, while projects and same request IDs stay isolated', async () => {
  const first = createResearchSchedule(input(), CREATED);
  const second = createResearchSchedule(input({ projectId: 'sample-project-two', questionIds: ['R01'] }), CREATED);
  assert.equal(listResearchSchedules('sample-project').length, 1);
  assert.equal(listResearchSchedules('sample-project-two').length, 1);
  assert.throws(() => updateResearchSchedule('sample-project-two', first.id, 'pause'), /当前项目/);
  let calls = 0;
  await tickResearchSchedules({ now: new Date('2026-10-31T02:00:00Z'), collect: async () => { calls++; throw new Error('missed days should not catch up'); } });
  assert.equal(calls, 0);
  assert.equal(listResearchSchedules(first.projectId)[0].nextRunAt, '2026-11-01T01:00:00.000Z');
  assert.equal(listResearchSchedules(second.projectId)[0].nextRunAt, '2026-11-01T01:00:00.000Z');
});

test('interrupted claims reconcile durable runs once and retain unknown reservations without resending', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  const runId = `${plan.id}_20261029`;
  mutatePlan(plan, saved => {
    saved.activeRunId = runId;
    saved.lastRunId = runId;
    saved.activeRunReservationCny = 0.005;
    saved.reservedCny = 0.005;
    saved.ownerPid = 2147483647;
  });
  let calls = 0;
  await tickResearchSchedules({ now: DUE, collect: async () => { calls++; throw new Error('must not resend interrupted claim'); } });
  const saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.status, 'failed');
  assert.equal(saved.reservedCny, 0.005);
  assert.equal(saved.spentCny, 0);
  assert.equal(saved.activeRunId, null);
  assert.equal(calls, 0);
  await tickResearchSchedules({ now: DUE, collect: async () => { calls++; throw new Error('must remain failed'); } });
  assert.equal(listResearchSchedules(plan.projectId)[0].reservedCny, 0.005);
  assert.equal(calls, 0);
});

test('a completed run left by an interrupted scheduler settles once without another request', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  const request = { ...input(), batchId: plan.batchId, requestId: `${plan.id}_20261029`, budgetLimit: 0.005 };
  const running = recordFor(request, plan.id);
  saveResearchRun(plan.projectId, running);
  saveResearchRun(plan.projectId, paidResult(running));
  mutatePlan(plan, saved => {
    saved.activeRunId = running.id;
    saved.lastRunId = running.id;
    saved.activeRunReservationCny = 0.005;
    saved.reservedCny = 0.005;
    saved.nextRunAt = '2026-10-30T01:00:00.000Z';
    saved.ownerPid = 2147483647;
  });
  const collect = async () => { throw new Error('completed claim must not send'); };
  await tickResearchSchedules({ now: DUE, collect });
  await tickResearchSchedules({ now: DUE, collect });
  assert.equal(listResearchSchedules(plan.projectId)[0].spentCny, 0.005);
  assert.equal(listResearchSchedules(plan.projectId)[0].reservedCny, 0);
  assert.equal(getResearchRun(plan.projectId, running.id)!.status, 'completed');
});

test('collector validation failure releases only its known unsent reservation and leaves a visible error', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  await tickResearchSchedules({ now: DUE, collect: async () => { throw new Error('Missing collection key, request not sent.'); } });
  const saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.status, 'failed');
  assert.equal(saved.activeRunId, null);
  assert.equal(saved.reservedCny, 0);
  assert.match(saved.error!, /Missing collection key/);
});

test('running confirmed costs replace the reservation once and pause releases unsent questions', async () => {
  const plan = createResearchSchedule(input({ questionIds: ['C01', 'C02'], budget: { currency: 'CNY', amount: 0.02 } }), CREATED);
  let release!: () => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  const tick = tickResearchSchedules({ now: DUE, collect: async (request, context) => {
    const running = recordFor(request, context.scheduleId);
    saveResearchRun(plan.projectId, running);
    const progressed = { ...running, spent: 0.005, confirmedSpentCny: 0.005, reservedCny: 0, completedCount: 1 } as ResearchRunRecord;
    saveResearchRun(plan.projectId, progressed);
    entered();
    await releasePromise;
    const run = { ...progressed, status: 'partial', error: 'Paused before the second request.' } as ResearchRunRecord;
    saveResearchRun(plan.projectId, run);
    return { run };
  } });
  await enteredPromise;
  const noSecondCollector = async () => { throw new Error('concurrent tick must not send'); };
  await tickResearchSchedules({ now: DUE, collect: noSecondCollector });
  await tickResearchSchedules({ now: DUE, collect: noSecondCollector });
  let saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.spentCny, 0.005);
  assert.equal(saved.reservedCny, 0.005);
  updateResearchSchedule(plan.projectId, plan.id, 'pause', DUE);
  release();
  await tick;
  saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.spentCny, 0.005);
  assert.equal(saved.reservedCny, 0);
  assert.equal(saved.status, 'paused');
});

test('a foreign run with the predicted ID is not charged to this plan', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  const request = { ...input(), batchId: plan.batchId, requestId: `${plan.id}_20261029`, budgetLimit: 0.005 };
  const foreign = recordFor(request, 'another-schedule');
  saveResearchRun(plan.projectId, foreign);
  saveResearchRun(plan.projectId, paidResult(foreign));
  await tickResearchSchedules({ now: DUE, collect: async () => { throw new Error('Run ID is already used for other conditions.'); } });
  const saved = listResearchSchedules(plan.projectId)[0];
  assert.equal(saved.status, 'failed');
  assert.equal(saved.spentCny, 0);
  assert.equal(saved.reservedCny, 0.005);
  assert.match(saved.error!, /无法核对/);
});

test('separate processes share the SQLite claim and send at most one collection', async () => {
  const plan = createResearchSchedule(input(), CREATED);
  const script = `
    const ts = require('typescript');
    require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(require('fs').readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, file);
    const { tickResearchSchedules } = require('./src/lib/geo/research-tracking.ts');
    const { getLatestResearch, saveResearchRun } = require('./src/lib/geo/research.ts');
    tickResearchSchedules({ now: new Date('2026-10-29T01:00:00Z'), collect: async (request, context) => {
      const batch = getLatestResearch(request.projectId);
      const run = { id: request.requestId, projectId: request.projectId, batchId: request.batchId, provider: 'deepseek', language: 'zh',
        questions: [{questionId:'C01',query:batch.questions[0].zh}], status: 'running', startedAt:'2026-10-29T01:00:00Z',
        updatedAt:'2026-10-29T01:00:00Z', budgetLimit:request.budgetLimit, spent:0, ownerPid:process.pid, scheduleId:context.scheduleId };
      saveResearchRun(request.projectId, run);
      await new Promise(resolve => setTimeout(resolve, 300));
      const completed = {...run,status:'completed',spent:0.005,confirmedSpentCny:0.005,reservedCny:0};
      saveResearchRun(request.projectId, completed);
      process.stdout.write('collected');
      return {run:completed};
    }}).catch(error => { console.error(error.message); process.exitCode=1; });
  `;
  const child = () => new Promise<string>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['-e', script], { cwd: globalThis.process.cwd(), env: { ...globalThis.process.env, DATA_DIR: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    process.stdout.on('data', chunk => { output += chunk.toString(); });
    process.stderr.on('data', chunk => { error += chunk.toString(); });
    process.on('error', reject);
    process.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
  });
  const outputs = await Promise.all([child(), child()]);
  assert.equal(outputs.join(''), 'collected');
  assert.equal(listResearchSchedules(plan.projectId)[0].spentCny, 0.005);
  assert.equal(listResearchSchedules(plan.projectId)[0].reservedCny, 0);
});

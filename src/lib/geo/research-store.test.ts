import { initialResearch } from './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import {
  appendResearchObservation, getLatestResearch, getResearchRun,
  listResearchRuns, saveResearchRun,
} from './research';
import type { ResearchRunRecord } from './research';
import type { ResearchBatch, ResearchObservation } from './research-types';
import { requestResearchStop } from './research-store';

const previousDirectory = process.env.DATA_DIR;
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-research-store-'));
  process.env.DATA_DIR = temporary;
});
afterEach(() => {
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function run(batch: ResearchBatch, id = 'run-1'): ResearchRunRecord {
  return {
    id, projectId: batch.projectId, batchId: batch.id, provider: 'deepseek', language: 'zh',
    questions: [{ questionId: batch.questions[0].id, query: batch.questions[0].zh }],
    status: 'running', startedAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z',
    budgetLimit: 0.02, spent: 0,
  };
}

function observation(record: ResearchRunRecord): ResearchObservation {
  return {
    runId: record.id, engine: record.provider, language: record.language, query: record.questions[0].query,
    recordedAt: '2026-10-27T00:01:00Z', collectedAt: '2026-10-27T00:01:00Z',
    status: 'not_observed', summary: 'Completed search without an official source.',
    conditions: 'Test fixture only; no network request.', sources: [],
    evidencePath: `data/geo-evidence/${record.id}/response.json`,
  };
}

test('all original fields and 52 observations migrate unchanged and process restart is idempotent', () => {
  for (const batch of initialResearch as ResearchBatch[]) {
    assert.deepEqual(getLatestResearch(batch.projectId), batch);
    assert.deepEqual(getLatestResearch(batch.projectId), batch);
    assert.deepEqual(listResearchRuns(batch.projectId), []);
  }
  const directory = path.join(temporary, 'data');
  assert.ok(fs.existsSync(path.join(directory, 'projects/sample-project-two/db.sqlite')));
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM geo_research_batches').get() as { n: number }).n, 1);
    // Simulates a separately saved database state across a new connection. The
    // JSON initializer must not overwrite it on subsequent reads.
    const batch = JSON.parse((db.prepare('SELECT payload FROM geo_research_batches').get() as { payload: string }).payload);
    batch.productSummary = 'Persisted database content';
    db.prepare('UPDATE geo_research_batches SET payload = ?').run(JSON.stringify(batch));
    db.exec('CREATE TABLE unrelated_existing_data (value TEXT); INSERT INTO unrelated_existing_data VALUES (\'preserved\')');
  } finally { db.close(); }
  assert.equal(getLatestResearch('sample-project')!.productSummary, 'Persisted database content');
  const restarted = spawnSync(process.execPath, ['-e', `
    const ts = require('typescript');
    require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(require('fs').readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
    }).outputText, file);
    const { getLatestResearch } = require('./src/lib/geo/research.ts');
    process.stdout.write(JSON.stringify(getLatestResearch('sample-project')));
  `], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATA_DIR: temporary } });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), getLatestResearch('sample-project'));
  const reopened = new Database(path.join(directory, 'db.sqlite'), { readonly: true });
  try { assert.equal((reopened.prepare('SELECT value FROM unrelated_existing_data').get() as { value: string }).value, 'preserved'); }
  finally { reopened.close(); }
});

test('append preserves original observation order and paths and refuses altered questions or overwrites', () => {
  const batch = getLatestResearch('sample-project')!;
  const record = run(batch);
  saveResearchRun(batch.projectId, record);
  const item = observation(record);
  const original = structuredClone(batch.questions[0].observations);
  assert.throws(() => appendResearchObservation(batch.projectId, batch.id, record.questions[0].questionId, { ...item, query: 'changed query' }), /对应语言原文/);
  appendResearchObservation(batch.projectId, batch.id, record.questions[0].questionId, item);
  appendResearchObservation(batch.projectId, batch.id, record.questions[0].questionId, item);
  assert.throws(() => appendResearchObservation(batch.projectId, batch.id, record.questions[0].questionId, { ...item, summary: 'overwrite' }), /不能覆盖/);
  const updated = getLatestResearch(batch.projectId)!;
  assert.deepEqual(updated.questions[0].observations.slice(0, original.length), original);
  assert.equal(updated.questions[0].observations.length, original.length + 1);
  assert.equal(updated.questions[0].observations.at(-1)!.evidencePath, item.evidencePath);
  assert.ok(updated.questions[0].observations.at(-1)!.id);
  assert.equal(updated.date, batch.date);
  assert.ok(updated.updatedAt);
  saveResearchRun(batch.projectId, { ...record, status: 'completed', completedCount: 1, spent: 0.005 });
  const next = run(batch, 'run-2');
  saveResearchRun(batch.projectId, next);
  appendResearchObservation(batch.projectId, batch.id, next.questions[0].questionId, observation(next));
  const history = getLatestResearch(batch.projectId)!.questions[0].observations;
  assert.deepEqual(history.slice(0, original.length), original);
  assert.deepEqual(history.slice(original.length).map((value) => value.runId), ['run-1', 'run-2']);
});

test('projects isolate identical run IDs, observations and database locations', () => {
  const first = getLatestResearch('sample-project')!;
  const second = getLatestResearch('sample-project-two')!;
  const firstRun = run(first);
  const secondRun = run(second);
  saveResearchRun(first.projectId, firstRun);
  saveResearchRun(second.projectId, secondRun);
  appendResearchObservation(first.projectId, first.id, firstRun.questions[0].questionId, observation(firstRun));
  assert.deepEqual(getLatestResearch(second.projectId), second);
  assert.equal(getResearchRun(second.projectId, firstRun.id)!.batchId, second.id);
  assert.throws(() => saveResearchRun(second.projectId, firstRun), /不属于当前项目/);
  assert.throws(() => appendResearchObservation(second.projectId, first.id, firstRun.questions[0].questionId, observation(firstRun)), /当前项目/);
});

test('stop requests are isolated and idempotent and survive stale progress and completion writes', () => {
  const first = getLatestResearch('sample-project')!;
  const second = getLatestResearch('sample-project-two')!;
  const firstRun = run(first);
  saveResearchRun(first.projectId, firstRun);
  saveResearchRun(second.projectId, run(second));
  const stopped = requestResearchStop(first.projectId, firstRun.id);
  assert.ok(stopped.stopRequestedAt);
  assert.deepEqual(requestResearchStop(first.projectId, firstRun.id), stopped);
  assert.equal(getResearchRun(second.projectId, firstRun.id)!.stopRequestedAt, undefined);
  assert.throws(() => requestResearchStop(first.projectId, 'missing'), /当前项目/);
  const progress = saveResearchRun(first.projectId, { ...firstRun, phase: 'searching', currentQuestionId: firstRun.questions[0].questionId, spent: 0.005 });
  assert.equal(progress.stopRequestedAt, stopped.stopRequestedAt);
  const completed = saveResearchRun(first.projectId, { ...firstRun, status: 'completed', completedCount: 1, spent: 0.005 });
  assert.equal(completed.status, 'interrupted');
  assert.equal(completed.stopRequestedAt, stopped.stopRequestedAt);
  assert.deepEqual(requestResearchStop(first.projectId, firstRun.id), completed);
  assert.throws(() => saveResearchRun(first.projectId, firstRun), /已经结束/);
});

test('run input stays frozen, one running request is enforced and failure does not add zero-hit observations', () => {
  const batch = getLatestResearch('sample-project')!;
  const record = run(batch);
  saveResearchRun(batch.projectId, record);
  saveResearchRun(batch.projectId, record);
  assert.throws(() => saveResearchRun(batch.projectId, run(batch, 'overlapping')), /已有研究采集/);
  assert.throws(() => saveResearchRun(batch.projectId, { ...record, questions: [{ ...record.questions[0], query: 'changed' }] }), /冻结输入/);
  assert.throws(() => saveResearchRun(batch.projectId, { ...record, budgetLimit: 0.03 }), /冻结输入/);
  assert.throws(() => saveResearchRun(batch.projectId, { ...record, spent: -0.001 }), /预算/);
  assert.throws(() => saveResearchRun(batch.projectId, { ...record, spent: 0.021 }), /预算/);
  saveResearchRun(batch.projectId, { ...record, spent: 0.005 });
  const failed = { ...record, status: 'failed' as const, spent: 0, completedCount: 0, error: 'Provider request failed; no completed observation.' };
  saveResearchRun(batch.projectId, failed);
  assert.deepEqual(getResearchRun(batch.projectId, record.id), failed);
  assert.deepEqual(getLatestResearch(batch.projectId), batch);
  assert.throws(() => saveResearchRun(batch.projectId, record), /已经结束/);
  saveResearchRun(batch.projectId, run(batch, 'next-run'));
  assert.equal(listResearchRuns(batch.projectId).length, 2);
});

test('imported historic failed runs retain original questions and paths without remapping observations', () => {
  const batch = getLatestResearch('sample-project')!;
  const imported: ResearchRunRecord = {
    ...run(batch, 'historic-run'), status: 'failed', imported: true,
    questions: [{ questionId: 'L1-legacy', query: 'Historical original query' }],
    importedRun: {
      id: 'historic-run', at: '2026-10-20T00:00:00Z', measurementAt: '2026-10-20T00:00:00Z',
      mode: 'live', status: 'failed', queryCount: 1, completedCount: 0, hitCount: null,
      resultCount: 0, cost: 0, summary: 'Failed historical request', questions: [],
    },
    evidencePath: 'data/geo-evidence/historic-run/raw.json', matchedQuestionIds: [],
  };
  saveResearchRun(batch.projectId, imported);
  saveResearchRun(batch.projectId, imported);
  assert.deepEqual(getResearchRun(batch.projectId, imported.id), imported);
  assert.deepEqual(getLatestResearch(batch.projectId), batch);
  assert.throws(() => appendResearchObservation(batch.projectId, batch.id, batch.questions[0].id, { ...observation(imported), query: batch.questions[0].zh }), /冻结输入/);
});

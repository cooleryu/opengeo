import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { getLatestResearch, getResearchRun } from './research';
import { assertResearchRunOwner, beginResearchQuestion, claimResearchRun, completeResearchQuestion, heartbeatResearchRun, newResearchExecution,
  requestResearchStop, ResearchLeaseLostError, saveResearchRun, updateOwnedResearchRun, type ResearchRunRecord } from './research-store';
import { collectResearch, LEGACY_RESEARCH_STALE_MS, recoverResearchRuns, recoverStoppedResearchRuns } from './research-collection';
import { saveCollectionResponse } from './collection-response';
import { observationFromResult } from './research-observation';
import { readAnswerAuditData } from './answer-audit-store';
import { analyzePreparedCompetitors, prepareCompetitorAnalysis } from './competitor-analysis';
import { competitorCandidateId, readCompetitorAnalysis } from './competitor-store';
import { getSeed } from './seed';
import { getCollectionConfig } from './providers/config';
import { buildSearchProtocolKey, frozenQuestion } from './search-protocol';
import { createResearchSchedule, updateResearchSchedule } from './research-tracking';
import { tickGeoScheduler } from './scheduler';
import { withGeoProject } from './projects';
import type { WorkflowQuestion } from './workflow-types';
import type { GeoQuestion } from './types';

const environment = ['DATA_DIR', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'OPENGEO_QWEN_MODEL'].map(key => [key, process.env[key]] as const);
const originalFetch = globalThis.fetch;
let temporary: string;
let requests: string[];
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-recovery-'));
  process.env.DATA_DIR = temporary;
  process.env.DEEPSEEK_API_KEY = 'recovery-test-secret-never-sent';
  process.env.DASHSCOPE_API_KEY = 'recovery-test-secret-never-sent';
  requests = [];
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    requests.push(payload.query ?? payload.input.messages[0].content);
    return new Response(JSON.stringify({ results: [{ url: 'https://example.com/sample-project/result', title: 'Saved result' }] }), { status: 200 });
  };
});
afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const [key, value] of environment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function seedRun(id: string, count = 2, overrides: Partial<ResearchRunRecord> = {}) {
  const batch = getLatestResearch('sample-project')!;
  const questions: WorkflowQuestion[] = batch.questions.slice(0, count).map(question => ({
    id: question.id, query: question.zh, language: 'zh', category: question.category ?? (question.id === 'C01' ? 'brand' : 'problem'),
    target: 'project', assetIds: [], exploratory: false, intent: question.zh, expectedResult: question.valueReason,
  }));
  const collection = overrides.collection ?? getCollectionConfig('deepseek');
  const now = new Date().toISOString();
  const run: ResearchRunRecord = { id, projectId: batch.projectId, batchId: batch.id, provider: 'deepseek', language: 'zh',
    questions: questions.map(question => ({ questionId: question.id, query: question.query })), status: 'running',
    startedAt: now, updatedAt: now, ownerPid: process.pid, budgetEnabled: true, budgetEnforcement: 'strict', budgetLimit: count * 0.005,
    spent: 0, confirmedSpentCny: 0, reservedCny: 0, completedCount: 0, collection,
    protocolKey: buildSearchProtocolKey(questions, collection), execution: newResearchExecution(),
    questionProgress: Object.fromEntries(questions.map(question => [question.id, { status: 'pending', reservedCny: 0, confirmedCny: 0 }])),
    ...overrides };
  saveResearchRun(run.projectId, run);
  return { run, questions: questions.map(frozenQuestion) };
}

function expire(run: ResearchRunRecord) {
  const db = new Database(path.join(temporary, 'data', 'db.sqlite'));
  try {
    const saved = JSON.parse((db.prepare('SELECT payload FROM geo_research_runs WHERE id = ?').get(run.id) as { payload: string }).payload) as ResearchRunRecord;
    saved.execution!.leaseUntil = new Date(Date.now() - 1000).toISOString();
    db.prepare('UPDATE geo_research_runs SET payload = ? WHERE id = ?').run(JSON.stringify(saved), run.id);
  } finally { db.close(); }
}

function saveResponse(run: ResearchRunRecord, question: GeoQuestion, raw = JSON.stringify({ results: [{ url: 'https://example.com/sample-project/saved', title: 'Saved' }] })) {
  const directory = path.join(temporary, 'data', 'geo-evidence', run.id);
  fs.mkdirSync(directory, { recursive: true });
  saveCollectionResponse(directory, { questionId: question.id, query: question.query, protocolKey: run.protocolKey,
    measuredAt: run.startedAt, httpStatus: 200, raw });
  return { ...question, measurementAt: run.startedAt, resultCount: 1, projectHit: true, rank: 1,
    evidencePath: `data/geo-evidence/${run.id}/${question.id}.json`, topSources: [] };
}

test('startup scheduler skips committed work, imports a saved response and sends only the remaining question', async () => {
  const { run, questions } = seedRun('recovery_saved_response_001', 3, { budgetEnforcement: 'legacy' });
  const token = run.execution!.token;
  beginResearchQuestion(run.projectId, run.id, token, questions[0].id, 0.005);
  const first = saveResponse(run, questions[0]);
  completeResearchQuestion(run.projectId, run.id, token, first, observationFromResult(first, run.id, 'deepseek'));
  updateOwnedResearchRun(run.projectId, run.id, token, saved => { saved.questionProgress![questions[0].id].analysis = 'started'; saved.finalAnalysis = 'started'; });
  beginResearchQuestion(run.projectId, run.id, token, questions[1].id, 0.005);
  saveResponse(run, questions[1]);
  // The complete response envelope can even restore a missing raw output file.
  fs.unlinkSync(path.join(temporary, 'data/geo-evidence', run.id, `${questions[1].id}.json`));
  expire(run);
  let audits = 0;
  mock.method(require('./answer-audit'), 'analyzeResearchObservation', async () => { audits++; });
  mock.method(require('./competitor-analysis'), 'analyzeCompetitorCandidates', async () => { audits++; });
  await tickGeoScheduler();
  const saved = getResearchRun(run.projectId, run.id)!;
  assert.equal(saved.status, 'completed');
  assert.equal(saved.completedCount, 3);
  assert.deepEqual(requests, [questions[2].query]);
  assert.equal(saved.spent, 0.015);
  assert.equal(saved.confirmedSpentCny, 0.015);
  assert.equal(saved.reservedCny, 0);
  assert.equal(saved.questionProgress![questions[0].id].analysis, 'uncertain');
  assert.equal(saved.finalAnalysis, 'uncertain');
  assert.equal(audits, 0, 'recovery must not replay paid analyses');
  assert.equal(JSON.stringify(saved).includes('recovery-test-secret-never-sent'), false);
  const observations = getLatestResearch(run.projectId)!.questions.flatMap(question => question.observations).filter(observation => observation.runId === run.id);
  assert.equal(observations.length, 3);
  await recoverResearchRuns();
  assert.equal(requests.length, 1);
  assert.deepEqual(getResearchRun(run.projectId, run.id), saved, 'finished runs remain unchanged');
});

test('unknown sent request keeps its reservation, is never resent, and does not turn into a zero observation', async () => {
  const { run, questions } = seedRun('recovery_unknown_request_001');
  beginResearchQuestion(run.projectId, run.id, run.execution!.token, questions[0].id, 0.005);
  expire(run);
  await recoverResearchRuns();
  const saved = getResearchRun(run.projectId, run.id)!;
  assert.equal(saved.status, 'partial');
  assert.equal(saved.questionProgress![questions[0].id].status, 'uncertain');
  assert.equal(saved.completedCount, 1);
  assert.equal(saved.reservedCny, 0.005);
  assert.equal(saved.confirmedSpentCny, 0.005);
  assert.equal(saved.spent, 0.01);
  assert.deepEqual(requests, [questions[1].query]);
  assert.equal(getLatestResearch(run.projectId)!.questions[0].observations.some(observation => observation.runId === run.id), false);
});

test('answer recovery retains the original model settings and never repeats the saved provider request', async () => {
  const collection = { ...getCollectionConfig('qwen'), model: 'frozen-original-model' };
  const { run, questions } = seedRun('recovery_frozen_answer_001', 2, { provider: 'qwen', collection,
    budgetEnforcement: 'legacy', budgetLimit: 0.2 });
  const raw = JSON.stringify({ output: { choices: [{ finish_reason: 'stop', message: { content: 'Saved answer [ref_1]' } }],
    search_info: { search_results: [{ index: 1, url: 'https://example.com/sample-project/saved', title: 'Saved' }] } } });
  beginResearchQuestion(run.projectId, run.id, run.execution!.token, questions[0].id, 0.1);
  saveResponse(run, questions[0], raw);
  process.env.OPENGEO_QWEN_MODEL = 'changed-after-restart';
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'frozen-original-model');
    requests.push(payload.input.messages[0].content);
    return new Response(raw, { status: 200 });
  };
  expire(run);
  await recoverResearchRuns();
  const saved = getResearchRun(run.projectId, run.id)!;
  assert.equal(saved.status, 'completed');
  assert.deepEqual(requests, [questions[1].query]);
  assert.equal(saved.reservedCny, 0.2, 'answer-provider reservations are not invented as confirmed bills');
  assert.equal(saved.confirmedSpentCny, 0);
  assert.equal(saved.questionProgress![questions[0].id].result!.answer!.model, 'frozen-original-model');
  assert.match(getLatestResearch(run.projectId)!.questions[0].observations.at(-1)!.conditions!, /frozen-original-model/);
});

test('uncertain spend still exhausts the cap and blocks otherwise unstarted questions', async () => {
  const { run, questions } = seedRun('recovery_budget_exhausted_001', 2, { budgetLimit: 0.005 });
  beginResearchQuestion(run.projectId, run.id, run.execution!.token, questions[0].id, 0.005);
  expire(run);
  await recoverResearchRuns();
  const saved = getResearchRun(run.projectId, run.id)!;
  assert.equal(requests.length, 0);
  assert.equal(saved.spent, 0.005);
  assert.equal(saved.reservedCny, 0.005);
  assert.equal(saved.questionProgress![questions[1].id].status, 'pending');
  assert.match(saved.error!, /费用上限/);
});

test('durable stop and schedule pause import completed responses but prevent any later dispatch', async () => {
  for (const pausedSchedule of [false, true]) {
    const schedule = pausedSchedule ? createResearchSchedule({ requestId: 'recovery_pause_schedule_001', questionIds: ['C01', 'C02'],
      language: 'zh', provider: 'deepseek', timeOfDay: '09:00', budget: { currency: 'CNY', amount: 0.02 } }) : undefined;
    const { run, questions } = seedRun(`recovery_stop_pause_${pausedSchedule}`, 2, schedule ? { scheduleId: schedule.id } : {});
    beginResearchQuestion(run.projectId, run.id, run.execution!.token, questions[0].id, 0.005);
    saveResponse(run, questions[0]);
    if (schedule) updateResearchSchedule(run.projectId, schedule.id, 'pause'); else requestResearchStop(run.projectId, run.id);
    expire(run);
    await recoverResearchRuns();
    const saved = getResearchRun(run.projectId, run.id)!;
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.completedCount, 1);
    assert.equal(saved.confirmedSpentCny, 0.005);
    assert.equal(saved.questionProgress![questions[1].id].status, 'pending');
    assert.equal(requests.length, 0);
  }
});

test('heartbeat delays takeover, claim is exclusive, stale owners cannot send or write, and completion is atomic', () => {
  const { run, questions } = seedRun('recovery_fenced_claim_001', 1);
  const old = run.execution!.token;
  const renewedAt = Date.now() + 1000;
  heartbeatResearchRun(run.projectId, run.id, old, renewedAt);
  const heartbeat = getResearchRun(run.projectId, run.id)!.execution!;
  assert.equal(heartbeat.heartbeatAt, new Date(renewedAt).toISOString());
  assert.equal(claimResearchRun(run.projectId, run.id, Date.parse(run.execution!.leaseUntil) + 1), null);
  expire(run);
  const claimed = claimResearchRun(run.projectId, run.id)!;
  assert.notEqual(claimed.execution!.token, old);
  assert.equal(claimResearchRun(run.projectId, run.id), null);
  assert.throws(() => beginResearchQuestion(run.projectId, run.id, old, questions[0].id, 0.005), ResearchLeaseLostError);
  assert.throws(() => updateOwnedResearchRun(run.projectId, run.id, old, saved => { saved.status = 'failed'; }), ResearchLeaseLostError);
  const token = claimed.execution!.token;
  beginResearchQuestion(run.projectId, run.id, token, questions[0].id, 0.005);
  assert.throws(() => beginResearchQuestion(run.projectId, run.id, token, questions[0].id, 0.005), /不会重复/);
  const result = saveResponse(run, questions[0]);
  const observation = observationFromResult(result, run.id, 'deepseek');
  assert.throws(() => completeResearchQuestion(run.projectId, run.id, token, result, { ...observation, query: 'changed query' }), /原文/);
  let saved = getResearchRun(run.projectId, run.id)!;
  assert.equal(saved.completedCount, 0);
  assert.equal(saved.reservedCny, 0.005);
  completeResearchQuestion(run.projectId, run.id, token, result, observation);
  completeResearchQuestion(run.projectId, run.id, token, result, observation);
  assert.throws(() => completeResearchQuestion(run.projectId, run.id, old, result, observation), ResearchLeaseLostError);
  saved = getResearchRun(run.projectId, run.id)!;
  assert.equal(saved.completedCount, 1);
  assert.equal(saved.confirmedSpentCny, 0.005);
  assert.equal(getLatestResearch(run.projectId)!.questions[0].observations.filter(item => item.runId === run.id).length, 1);
});

test('an audit returning after lease takeover is rejected before its result is saved', async () => {
  const batch = getLatestResearch('sample-project')!;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  mock.method(require('./answer-audit'), 'analyzeResearchObservation', async (...args: Parameters<typeof import('./answer-audit').analyzeResearchObservation>) => {
    entered();
    await held;
    const observation = args[2];
    args[4]!.persist!({ projectId: batch.projectId, batchId: batch.id, questionId: args[1], engine: observation.engine,
      language: observation.language, recordedAt: observation.recordedAt, evidencePath: observation.evidencePath,
      schemaVersion: 1, reviewedAt: new Date().toISOString(), method: 'model', analysisStatus: 'needs_review',
      mention: 'unknown', citation: 'unknown', mentionEvidence: 'Delayed audit', citationEvidence: 'Delayed audit',
      officialUrls: [], answerComplete: false, limitations: [] });
  });
  const requestId = 'recovery_late_audit_001';
  const pending = collectResearch({ requestId, batchId: batch.id, provider: 'deepseek', language: 'zh',
    questionIds: [batch.questions[0].id], budgetLimit: 0.005 });
  await waiting;
  const running = getResearchRun(batch.projectId, requestId)!;
  assert.equal(running.questionProgress![batch.questions[0].id].analysis, 'started');
  expire(running);
  try { await recoverResearchRuns(); }
  finally { release(); }
  await pending;
  const saved = getResearchRun(batch.projectId, requestId)!;
  assert.equal(saved.status, 'completed');
  assert.equal(saved.questionProgress![batch.questions[0].id].analysis, 'uncertain');
  assert.equal(readAnswerAuditData(batch.projectId, batch.id).records.filter(audit => audit.evidencePath.includes(requestId)).length, 0);
  assert.equal(requests.length, 1);
});

test('late competitor analysis cannot save progress or a verdict after takeover, using the same write transaction', async () => {
  const { run } = seedRun('recovery_late_competitor_001', 1);
  const project = getSeed().project;
  const url = 'https://github.com/example/recovery-tool';
  const prepared = prepareCompetitorAnalysis(project, run.batchId, [{ id: competitorCandidateId(project.id, url),
    name: 'RecoveryTool', aliases: [], officialUrls: [url], description: '', reason: '', saved: false,
    questions: [{ evidenceId: 'saved-evidence', batchId: run.batchId, questionId: 'C01', question: 'Which tool?',
      engine: 'chatgpt', language: 'en', recordedAt: run.startedAt, evidencePath: 'synthetic.md', observationIndex: 0,
      sourceUrl: url, excerpt: 'RecoveryTool preserves saved results.' }] }], new Map());
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let transactionChecks = 0;
  const pending = analyzePreparedCompetitors(prepared, {
    model: { async generateObject() { await held; return {}; } },
    assertActive: connection => {
      if (connection) { assert.equal(connection.inTransaction, true); transactionChecks++; }
      assertResearchRunOwner(run.projectId, run.id, run.execution!.token, connection);
    },
  });
  const before = readCompetitorAnalysis(prepared.inputKey)!;
  assert.equal(before.state.phase, 'generating');
  expire(run);
  assert.ok(claimResearchRun(run.projectId, run.id));
  const rejected = assert.rejects(pending, ResearchLeaseLostError);
  release();
  await rejected;
  assert.deepEqual(readCompetitorAnalysis(prepared.inputKey), before);
  assert.ok(transactionChecks >= 3);
});

test('legacy PID reuse and bounded stale ownership settle safely without changing completed history', async () => {
  const { run } = seedRun('legacy_reused_pid_001', 1, { execution: undefined, collection: undefined, questionProgress: undefined,
    protocolKey: undefined, updatedAt: new Date(Date.now() - process.uptime() * 1000 - 2000).toISOString(), spent: 0.005, reservedCny: 0.005 });
  recoverStoppedResearchRuns();
  const settled = getResearchRun(run.projectId, run.id)!;
  assert.equal(settled.status, 'failed');
  assert.equal(settled.reservedCny, 0.005);
  const { run: unknown } = seedRun('legacy_unknown_owner_001', 1, { execution: undefined, collection: undefined,
    questionProgress: undefined, protocolKey: undefined, ownerPid: undefined });
  recoverStoppedResearchRuns(Date.now() + LEGACY_RESEARCH_STALE_MS + 1);
  assert.equal(getResearchRun(unknown.projectId, unknown.id)!.status, 'failed');
  const finished = { ...unknown, id: 'legacy_finished_run_001', status: 'completed' as const };
  saveResearchRun(finished.projectId, finished);
  await withGeoProject(run.projectId, recoverResearchRuns);
  assert.deepEqual(getResearchRun(finished.projectId, finished.id), JSON.parse(JSON.stringify(finished)));
  assert.equal(requests.length, 0);
});

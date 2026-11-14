import { seedData } from './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { buildInitialQuestionPlan } from './question-planner';
import { researchBatchFromPlan, saveResearchBatchFromPlan } from './research-batch-plan';
import { appendResearchObservation, getLatestResearch, getResearchBatch, getResearchRun, researchEvidencePaths, saveResearchRun, type ResearchRunRecord } from './research';
import type { GeoQuestionPlan } from './question-types';
import type { GeoSeed } from './types';
import { getResearchRows, isBrandQuestion } from './research-view';

const seed = seedData as unknown as GeoSeed;
const previousDirectory = process.env.DATA_DIR;
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-batch-plan-'));
  process.env.DATA_DIR = temporary;
});
afterEach(() => {
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function readyPlan(): GeoQuestionPlan {
  const initial = buildInitialQuestionPlan(seed);
  return {
    ...initial, status: 'ready', revision: 5,
    candidates: initial.candidates.map((candidate, index) => ({ ...candidate, selected: index === 0 })),
  };
}

test('confirmation freezes reviewed selected questions, wording, lineage and value while retaining all other candidates', () => {
  const plan = readyPlan();
  const english = plan.candidates.find(candidate => seed.questions.find(question => question.id === candidate.originalQuestionId)?.language.startsWith('en'))!;
  english.selected = true;
  plan.candidates.find(candidate => seed.questions.find(question => question.id === candidate.originalQuestionId)?.language.startsWith('zh'))!.selected = true;
  plan.candidates.push({
    ...structuredClone(plan.candidates[0]), id: 'manual-new-version', origin: 'manual', originalQuestionId: undefined,
    sourceQuestionId: 'C01', sourceResearchBatchId: 'sample-project-2026-10-24-live-search',
    query: '编程助手继续执行前需要检查哪些条件？', queryEn: 'What should an agent check before resuming work?',
    selected: true, review: { decision: 'explore', source: 'manual', status: 'reviewed', reason: '值得先搜索，能力证据需要继续核实。', concerns: ['承接证据不足。'] },
  });
  const original = structuredClone(plan);
  const batch = researchBatchFromPlan(plan, seed);
  assert.deepEqual(plan, original);
  assert.deepEqual(batch.questionPlan, original);
  assert.equal(batch.questions.length, 3);
  assert.equal(batch.questions[0].id, plan.candidates[0].originalQuestionId);
  assert.equal(batch.questions[0].candidateId, plan.candidates[0].id);
  assert.equal(batch.questions[0].questionPlanRevision, 5);
  assert.equal(batch.questions[0].category, plan.candidates[0].category);
  const englishQuestion = batch.questions.find(question => question.id === english.originalQuestionId)!;
  assert.equal(englishQuestion.en, english.query);
  assert.equal(englishQuestion.zh, '');
  const revised = batch.questions.at(-1)!;
  assert.equal(revised.id, 'manual-new-version');
  assert.equal(revised.en, plan.candidates.at(-1)!.queryEn);
  assert.equal(revised.valueReason, plan.candidates.at(-1)!.rationale);
  assert.deepEqual(revised.gaps, ['承接证据不足。']);
  assert.equal(revised.decision, 'search_now');
  assert.equal(batch.deferredQuestions.length, plan.candidates.length - 3);
  assert.ok([...batch.questions, ...batch.deferredQuestions].every(question => question.observations.length === 0));
  assert.deepEqual(researchEvidencePaths(batch), []);
  for (const invalid of [
    { ...plan, status: 'draft' },
    { ...plan, candidates: plan.candidates.map(candidate => ({ ...candidate, selected: true })) },
    ...['pending', 'excluded', 'superseded'].map(kind => ({ ...plan, candidates: plan.candidates.map((candidate, index) => index ? candidate : {
      ...candidate, ...(kind === 'superseded' ? { supersededByCandidateId: 'replacement' } : {}),
      review: { ...candidate.review, ...(kind === 'pending' ? { status: 'pending' } : {}), ...(kind === 'excluded' ? { decision: 'exclude' } : {}) },
    }) })),
  ]) assert.throws(() => researchBatchFromPlan(invalid as GeoQuestionPlan, seed));
});

test('research kind uses saved brand and positioning categories before legacy IDs', () => {
  const batch = researchBatchFromPlan(readyPlan(), seed);
  const question = batch.questions[0];
  batch.questions = [
    { ...question, id: 'manual-brand', category: 'brand' },
    { ...question, id: 'manual-positioning', category: 'positioning' },
    { ...question, id: 'C01', category: 'problem' },
    { ...question, id: 'R01', category: undefined },
  ];
  const filters = { language: 'zh', engine: 'deepseek', kind: 'brand', result: 'all' } as const;
  assert.deepEqual(getResearchRows(batch, filters).map(row => row.question.id), ['manual-brand', 'manual-positioning', 'R01']);
  assert.deepEqual(getResearchRows(batch, { ...filters, kind: 'discovery' }).map(row => row.question.id), ['C01']);
  assert.equal(isBrandQuestion({ ...question, id: 'C01', category: undefined }), true);
});

test('new batches are idempotent and historical batch reads retain their own appended observations', () => {
  const old = getLatestResearch(seed.project.id)!;
  const plan = readyPlan();
  const batch = saveResearchBatchFromPlan(plan, seed);
  saveResearchBatchFromPlan(plan, seed);
  assert.deepEqual(getLatestResearch(seed.project.id), batch);
  assert.deepEqual(getResearchBatch(seed.project.id, old.id), old);
  assert.equal(getResearchBatch('sample-project-two', batch.id), null);
  const record: ResearchRunRecord = {
    id: 'old-batch-run', projectId: seed.project.id, batchId: old.id, provider: 'deepseek', language: 'zh',
    questions: [{ questionId: old.questions[0].id, query: old.questions[0].zh }],
    startedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z', status: 'running',
    spent: 0, budgetLimit: 0.02, scheduleId: 'schedule-1', budget: { currency: 'CNY', amount: 0.02, limitCny: 0.02 },
  };
  saveResearchRun(seed.project.id, record);
  assert.throws(() => saveResearchRun(seed.project.id, { ...record, scheduleId: 'changed' }), /冻结输入/);
  assert.throws(() => saveResearchRun(seed.project.id, { ...record, budget: { ...record.budget!, amount: 0.03 } }), /冻结输入/);
  saveResearchRun(seed.project.id, { ...record, confirmedSpentCny: 0.005, reservedCny: 0, spent: 0.005 });
  assert.equal(getResearchRun(seed.project.id, record.id)!.confirmedSpentCny, 0.005);
  appendResearchObservation(seed.project.id, old.id, old.questions[0].id, {
    runId: record.id, engine: 'deepseek', language: 'zh', query: old.questions[0].zh,
    status: 'not_observed', recordedAt: record.startedAt, summary: 'Offline fixture only.', conditions: 'No network.', sources: [], evidencePath: 'fixture.json',
  });
  const historical = getResearchBatch(seed.project.id, old.id)!;
  assert.deepEqual(historical.questions[0].observations.slice(0, -1), old.questions[0].observations);
  assert.equal(historical.questions[0].observations.at(-1)!.runId, record.id);
  assert.deepEqual(getLatestResearch(seed.project.id), batch);
  saveResearchBatchFromPlan(plan, seed);
  assert.deepEqual(getResearchBatch(seed.project.id, old.id), historical);
  const changed = structuredClone(plan);
  changed.candidates[0].rationale = '不能用同一题单版本覆盖已确认的价值依据。';
  assert.throws(() => saveResearchBatchFromPlan(changed, seed), /不能覆盖/);
  changed.revision++;
  const next = saveResearchBatchFromPlan(changed, seed);
  assert.notEqual(next.id, batch.id);
  assert.deepEqual(getResearchBatch(seed.project.id, batch.id), batch);
  assert.deepEqual(getLatestResearch(seed.project.id), next);
});

test('pure-English model candidate maps into question.en with empty zh on batch confirmation', () => {
  const plan = readyPlan();
  plan.candidates.push({
    ...structuredClone(plan.candidates[0]),
    id: 'model-en-1',
    origin: 'model',
    originalQuestionId: undefined,
    query: 'How do I check if ChatGPT recommends my open-source project?',
    queryEn: undefined,
    selected: true,
    review: {
      decision: 'include',
      source: 'model',
      status: 'reviewed',
      reason: 'Direct English discovery intent.',
      concerns: [],
    },
  });
  const batch = researchBatchFromPlan(plan, seed);
  const created = batch.questions.find(question => question.id === 'model-en-1')!;
  assert.equal(created.en, 'How do I check if ChatGPT recommends my open-source project?');
  assert.equal(created.zh, '');
});

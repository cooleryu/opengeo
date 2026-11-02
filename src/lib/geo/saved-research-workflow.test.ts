import { initialResearch as batches } from './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSeed } from './seed';
import { resolveResearchTaskContext } from './research-task-context';
import { buildIndependentReviewInput, buildTaskDiagnosisContext, prepareSavedResearchWorkflow } from './planner';
import { localDiagnosis, validateProposal } from './diagnosis';
import { readSavedResearchEvidence } from './saved-research-evidence';
import type { GeoProposal, GeoTask } from './types';
import type { ResearchBatch, ResearchObservation } from './research-types';

const seed = getSeed();
const batch = batches.find(item => item.projectId === seed.project.id)! as ResearchBatch;
const researchContext = resolveResearchTaskContext({ batchId: batch.id, questionId: 'C02', language: 'zh',
  engine: 'chatgpt', targetAssetId: 'guide-zh-CN' }, batch, seed.project.id, seed.assets).context;
const task = { id: 'saved-c02-test', projectId: seed.project.id, goal: '回答原问题并完善现有中文材料', status: 'queued',
  researchContext, implementation: null, proposal: null, runs: [] } as unknown as GeoTask;
const prepare = () => ({ ...structuredClone(task), workflow: prepareSavedResearchWorkflow(task, seed) });

test('synthetic saved C02 keeps original source and conditions without a live baseline or duplicate asset bodies', () => {
  const ready = prepare();
  const context = buildTaskDiagnosisContext(ready, seed);
  assert.equal(context.evidenceReady, true);
  assert.equal(ready.workflow.baseline, undefined);
  assert.equal(ready.workflow.collection, undefined);
  assert.equal(ready.runs.length, 0);
  assert.match(ready.workflow.protocolKey, /^saved-research:/);
  assert.equal(context.savedResearch?.entryType, 'web_answer');
  assert.equal(context.savedResearch?.recordedAt, ready.workflow.savedResearch!.recordedAt);
  assert.equal(context.savedResearch?.conditions, ready.workflow.savedResearch!.conditions);
  assert.equal(context.questions[0].answer, null);
  assert.equal(context.questions[0].projectHit, null);
  assert.equal(context.questions[0].resultCount, null);
  assert.match(context.questions[0].savedAnswer!.text, /Synthetic workflow check/);
  assert.deepEqual(context.materials.map(item => item.id), ['guide-zh-CN']);
  assert.deepEqual(context.research!.originalQuestion.observations, []);
  assert.deepEqual(context.research!.referenceEvidence, []);
  assert.equal('targetAsset' in context.research!.originalQuestion, false);
  assert.equal('en' in context.research!.originalQuestion.question, false);
  assert.equal(JSON.stringify(context).split('Synthetic workflow check').length - 1, 1);
});

test('saved preparation rejects wrong project, query, entry, language, missing file, target and implementation', () => {
  const mutate = (change: (value: GeoTask) => void) => {
    const changed = structuredClone(task); change(changed);
    assert.throws(() => prepareSavedResearchWorkflow(changed, seed));
  };
  mutate(value => { value.projectId = 'other-project'; });
  mutate(value => { value.researchContext!.snapshot!.question.zh = 'Different question'; });
  mutate(value => { value.researchContext!.engine = 'google'; });
  mutate(value => { value.researchContext!.language = 'en'; });
  mutate(value => { value.researchContext!.snapshot!.observations.forEach(item => { item.evidencePath = 'missing.json'; }); });
  mutate(value => { value.researchContext!.snapshot!.targetAsset!.markdown = ''; });
  mutate(value => { value.implementation = { kind: 'user_confirmed', at: '2026-10-29', note: 'implemented', url: 'https://example.org' }; });
  mutate(value => { value.researchContext!.snapshot!.question.decision = 'keep_and_fill'; });
});

test('the review gets primary content and the full candidate, never historical diagnosis, report prose or prior suggestions', () => {
  const ready = prepare();
  ready.researchContext!.snapshot!.question.diagnosis.hypothesis = 'HISTORICAL_DIAGNOSIS_SENTINEL';
  const context = buildTaskDiagnosisContext(ready, seed);
  const proposal = { id: 'test', after: 'FULL_CANDIDATE_SENTINEL' } as GeoProposal;
  const diagnosis = localDiagnosis(context);
  context.research!.referenceEvidence.push({ path: 'old-report.md', text: 'OLD_REPORT_SENTINEL', truncated: false });
  const input = buildIndependentReviewInput(context, diagnosis, proposal, []);
  const text = JSON.stringify(input);
  assert.equal(text.includes('HISTORICAL_DIAGNOSIS_SENTINEL'), false);
  assert.equal(text.includes('OLD_REPORT_SENTINEL'), false);
  assert.equal(text.includes('FULL_CANDIDATE_SENTINEL'), true);
  assert.deepEqual(input.context.strategies, []);
  assert.equal(input.diagnosisToReview, diagnosis);
});

test('missing raw evidence or a forged selected observation blocks later review, even with a valid replacement', () => {
  const ready = prepare();
  const context = buildTaskDiagnosisContext(ready, seed);
  const material = context.materials[0];
  const before = material.markdown.slice(0, 500);
  const proposal: GeoProposal = { id: 'p', title: '说明测量条件', status: 'draft', rationale: '已保存回答对照',
    targetAssetId: material.id, targetUrl: material.publicUrl!, before, after: before + '\n补充实验条件。',
    changes: ['补充条件'], evidencePaths: [context.questions[0].evidencePath],
    successCriteria: ['同题、同语言、同入口，实施后七天复测；不可比时停止比较。'], limitations: ['尚未实施。'] };
  assert.deepEqual(validateProposal(proposal, seed, context), []);
  assert.ok(validateProposal({ ...proposal, before: 'invented original' }, seed, context).length);
  ready.workflow.savedResearch!.query = 'forged query';
  const changed = buildTaskDiagnosisContext(ready, seed);
  assert.equal(changed.evidenceReady, false);
  assert.ok(validateProposal(proposal, seed, changed).some(issue => issue.severity === 'blocking'));
});

test('a summary-only capture, wrong raw query or missing original cannot stand in for a saved ChatGPT answer', () => {
  const observation = task.researchContext!.snapshot!.observations[0];
  const read = (value: string | null) => readSavedResearchEvidence(observation, () => value);
  assert.equal(read(null).available, false);
  assert.equal(read(`- Question: ${observation.query}\n## Summary\nSome summary.`).available, false);
  assert.equal(read('- Question: another question\n## Answer text\nA real body.').available, false);
  const noCitations = readSavedResearchEvidence({ ...observation, sources: [] }, () => `- Question: ${observation.query}\n## Answer text\nA visible answer with no captured citation list.`);
  assert.equal(noCitations.available, true);
  assert.match(noCitations.boundary, /隐藏引用.*未知/);
});

test('saved DeepSeek content requires the matching original request and actual content, not links alone', () => {
  const observation: ResearchObservation = { engine: 'deepseek', language: 'zh', query: 'exact question', recordedAt: '2026-10-28',
    conditions: 'count=10; need_content=true', entryType: 'api_search', status: 'not_observed', summary: 'summary only', sources: [], evidencePath: 'raw.json' };
  const read = (payload: unknown, query: string | null) => readSavedResearchEvidence(observation, file =>
    file === 'raw.json' ? JSON.stringify(payload) : query === null ? null : JSON.stringify({ payload: { query } }));
  const payload = { results: [{ title: 'Source', url: 'https://example.org', snippet: 'Saved content.' }] };
  assert.equal(read(payload, 'exact question').available, true);
  assert.equal(read(payload, null).available, false);
  assert.equal(read(payload, 'different question').available, false);
  assert.equal(read({ results: [{ url: 'https://example.org' }] }, 'exact question').available, false);
  assert.equal(read({ error: 'failure' }, 'exact question').available, false);
  assert.equal(read({ results: [] }, 'exact question').available, false);
});

test('a removed saved file invalidates the same workflow on refresh and path escapes remain unreadable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-b-evidence-'));
  const previous = process.env.GEO_WORKSPACE;
  try {
    process.env.GEO_WORKSPACE = root;
    const copied = structuredClone(task);
    const observation = copied.researchContext!.snapshot!.observations[0];
    observation.evidencePath = 'capture.md'; observation.answerPath = 'capture.md';
    copied.researchContext!.snapshot!.observations = [observation];
    fs.writeFileSync(path.join(root, 'capture.md'), `- Question: ${observation.query}\n## Answer text\nCaptured body.`);
    copied.workflow = prepareSavedResearchWorkflow(copied, seed);
    assert.equal(buildTaskDiagnosisContext(copied, seed).evidenceReady, true);
    fs.unlinkSync(path.join(root, 'capture.md'));
    assert.equal(buildTaskDiagnosisContext(copied, seed).evidenceReady, false);
    observation.evidencePath = '../outside.md';
    assert.throws(() => prepareSavedResearchWorkflow(copied, seed));
  } finally {
    if (previous === undefined) delete process.env.GEO_WORKSPACE; else process.env.GEO_WORKSPACE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

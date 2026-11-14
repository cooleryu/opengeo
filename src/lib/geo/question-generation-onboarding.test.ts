import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { analyzeProjectOnboarding } from './project-onboarding-analysis';
import { createProjectOnboarding, getProjectOnboarding, reviseProjectOnboarding } from './project-onboarding-store';
import { getGeoState, getQuestionGeneration, getQuestionPlan, handleGeoAction, startOnboardingQuestionGeneration } from './store';
import { buildInitialQuestionPlan, generateQuestionPlan } from './question-planner';
import { withGeoProject } from './projects';
import type { GeoStructuredModel } from './connection-settings';
import type { PublicSource } from './project-public-source';
import type { QuestionGenerationProgress } from './question-types';

const priorData = process.env.DATA_DIR;
const priorFetch = globalThis.fetch;
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-question-chain-'));
  process.env.DATA_DIR = temporary;
  globalThis.fetch = async () => { throw new Error('Synthetic chain must never call a live provider'); };
});
afterEach(() => {
  if (priorData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorData;
  globalThis.fetch = priorFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
});
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const understood = { summary: '公开资料介绍了一个文档编辑工具。', audience: '需要整理公开文档的作者。',
  capabilities: ['资料声明可以编辑文档，尚未实测。'], unknowns: ['实际效果尚未验证。'] };
const readSource = async (url: string): Promise<PublicSource> => ({ url, contentType: 'text/plain', readAt: '2026-11-03T08:00:00Z',
  text: 'A documentation editor for organizing reusable guides. It supports editing and exporting local documentation. These are public claims, not verified product outcomes.' });
const create = () => createProjectOnboarding({ kind: 'company', url: `https://example.com/${path.basename(temporary)}` }).project.id;
async function settled(id: string) {
  for (let i = 0; i < 20; i++) {
    const job = withGeoProject(id, getQuestionGeneration);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Synthetic job did not settle');
}

test('entry understanding and explicit retry reuse saved planning/proposals after a failed review', async () => {
  const id = create();
  const releaseReview = deferred();
  let planningCalls = 0;
  let proposalCalls = 0;
  let reviewCalls = 0;
  const model: GeoStructuredModel = { generateObject: async input => {
    const payload = JSON.parse(String(input.messages[1].content));
    const sourceId = payload.materials[0].id;
    if (payload.maxSelected) return { selectedIds: ['model-1'],
      coverage: [{ needId: 'need-1', candidateIds: ['model-1'], status: 'covered', reason: '这道问题覆盖文档整理与复用需求。' }],
      missingAdditionalNeeds: [], duplicates: [], reason: '根据已审查的问题和需求范围选择本批内容。' };
    if (!payload.candidates && !payload.direction) {
      planningCalls++;
      return { needs: [{ id: 'need-1', title: '整理可复用的文档步骤', audience: '需要整理公开文档的作者',
        trigger: '作者在整理公开文档时需要明确可复用的使用步骤', importance: 'high', assetIds: [sourceId] }],
      selectionAdvantages: [], directions: [{ title: '整理可复用的文档步骤', audience: '需要整理公开文档的作者',
        trigger: '作者在整理公开文档时需要明确可复用的使用步骤', assetIds: [sourceId], needIds: ['need-1'] }] };
    }
    if (payload.direction) {
      proposalCalls++;
      return { candidates: [{ query: '怎样整理公开文档中的使用步骤？', category: 'content', target: 'article',
        intent: '作者希望整理可复用的文档步骤。', assetIds: [sourceId],
        evidence: [{ assetId: sourceId, quote: 'A documentation editor for organizing reusable guides.' }],
        rationale: '已有公开材料介绍了文档编辑方法。', expectedResult: '找到整理文档步骤的方法与边界。' }] };
    }
    reviewCalls++;
    assert.equal(payload.candidates[0].review, undefined, 'review receives an independent context');
    if (reviewCalls === 1) throw new Error('Synthetic interrupted review');
    await releaseReview.promise;
    return { reviews: [{ id: 'model-1', decision: 'include', priority: 'high', reason: '方向与目标用户需求匹配，现有能力仍需核实。', concerns: [],
      assessment: { worthPursuing: { verdict: 'yes', reason: '作者需要管理和复用公开文档。', demandBasis: 'inferred', basis: '根据资料声明和使用情境推导。' },
        currentSupport: { level: 'unverified', reason: '现有资料仅是能力声明，实际效果尚未验证。' }, evidence: [],
        gaps: [{ kind: 'investigation', description: '继续核对实际编辑和导出能力。' }] } }] };
  } };
  await analyzeProjectOnboarding(id, { readSource, research: false, model: { generateObject: async () => understood },
    questionGeneration: { generate: (seed, positioning, runtime) => generateQuestionPlan(seed, positioning, { ...runtime, model }) } });
  assert.equal(getProjectOnboarding(id)?.status, 'ready');
  assert.ok(withGeoProject(id, getQuestionGeneration), 'ready understanding already has its durable continuation');
  const failed = await settled(id);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.checkpoints?.map(value => value.key), ['directions', 'draft-1']);
  await withGeoProject(id, async () => {
    const plan = getQuestionPlan();
    await handleGeoAction({ action: 'start_question_generation', planId: plan.id, revision: plan.revision,
      positioning: understood.summary, requestId: 'retry-saved-review' }, {
      questionGenerationRuntime: { generate: (seed, positioning, runtime) => generateQuestionPlan(seed, positioning, { ...runtime, model }) },
    });
  });
  for (let attempt = 0; attempt < 30 && reviewCalls < 2; attempt++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reviewCalls, 2, `Question preparation stopped before resumed review: ${JSON.stringify(withGeoProject(id, getQuestionGeneration))}`);
  await withGeoProject(id, async () => {
    for (let i = 0; i < 3; i++) assert.equal(getGeoState().questionGeneration?.stage, 'reviewing');
    const plan = getQuestionPlan();
    const duplicate = await handleGeoAction({ action: 'start_question_generation', planId: plan.id,
      revision: plan.revision, positioning: understood.summary, requestId: 'other-window' });
    assert.equal(duplicate.questionGeneration?.status, 'running');
    assert.equal(duplicate.questionPlan.candidates.length, 0);
  });
  releaseReview.resolve();
  assert.equal((await settled(id)).status, 'completed');
  const state = withGeoProject(id, getGeoState);
  assert.equal(state.questionPlan.candidates.length, 1);
  assert.equal(state.questionPlan.candidates[0].review.source, 'model');
  assert.equal(state.questionPlan.candidates[0].review.status, 'reviewed');
  assert.equal(state.questionPlan.revision, 2);
  assert.equal(planningCalls, 1);
  assert.equal(proposalCalls, 1);
  assert.equal(reviewCalls, 2, 'only the unfinished review was requested again');
  startOnboardingQuestionGeneration(id);
  assert.equal(planningCalls, 1, 'replaying the continuation does not plan again');
  assert.equal(proposalCalls, 1, 'replaying the continuation does not generate again');
});

test('correction starts latest work while the prior model is pending and only the new understanding can save', async () => {
  const id = create();
  const holdOld = deferred();
  let calls = 0;
  let reads = 0;
  const generate: typeof generateQuestionPlan = async (seed, positioning, runtime) => {
    calls++;
    if (calls === 1) await holdOld.promise;
    runtime?.onProgress?.({ stage: 'reviewing', message: 'Synthetic review' });
    return { ...buildInitialQuestionPlan(seed), positioning, source: 'model' };
  };
  await analyzeProjectOnboarding(id, { research: false, readSource: async url => { reads++; return readSource(url); },
    model: { generateObject: async () => understood }, questionGeneration: { generate } });
  const oldId = withGeoProject(id, getQuestionGeneration)?.id;
  reviseProjectOnboarding(id, '改为面向技术写作者，关注文档复用。', 'correction-1');
  assert.equal(withGeoProject(id, getQuestionGeneration)?.status, 'superseded');
  const summary = '面向技术写作者的文档复用工具。';
  await analyzeProjectOnboarding(id, { research: false, readSource: async () => { throw new Error('Correction must reuse saved sources'); },
    model: { generateObject: async () => ({ ...understood, summary }) }, questionGeneration: { generate } });
  assert.equal((await settled(id)).status, 'completed');
  holdOld.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  const state = withGeoProject(id, getGeoState);
  assert.notEqual(state.questionGeneration?.id, oldId);
  assert.equal(state.questionGeneration?.positioning, summary);
  assert.equal(state.questionPlan.positioning, summary);
  assert.equal(state.questionPlan.revision, 2, 'superseded output was never saved');
  assert.equal(calls, 2);
  assert.equal(reads, 1);
});

test('question failure preserves successful understanding; retry is explicit and synchronous generation remains compatible', async () => {
  const id = create();
  let failedCalls = 0;
  await analyzeProjectOnboarding(id, { readSource, research: false, model: { generateObject: async () => understood },
    questionGeneration: { generate: async () => { failedCalls++; throw new Error('Synthetic question failure'); } } });
  assert.equal((await settled(id)).status, 'failed');
  assert.equal(getProjectOnboarding(id)?.status, 'ready');
  startOnboardingQuestionGeneration(id);
  assert.equal(withGeoProject(id, getGeoState).questionGeneration?.status, 'failed');
  assert.equal(failedCalls, 1);
  const progress: QuestionGenerationProgress[] = [];
  await withGeoProject(id, async () => {
    const plan = getQuestionPlan();
    const state = await handleGeoAction({ action: 'generate_questions', planId: plan.id, revision: plan.revision,
      positioning: understood.summary, requestId: 'explicit-retry' }, {
      onQuestionProgress: value => progress.push(value), questionGenerationRuntime: { generate: async (seed, positioning, runtime) => {
        runtime?.onProgress?.({ stage: 'reviewing', message: 'Synthetic review' });
        return { ...buildInitialQuestionPlan(seed), positioning, source: 'model' };
      } },
    });
    assert.equal(state.questionGeneration?.status, 'completed');
    assert.equal(state.questionPlan.revision, 2);
  });
  assert.deepEqual(progress.map(value => value.stage), ['preparing', 'reviewing', 'saving']);
});

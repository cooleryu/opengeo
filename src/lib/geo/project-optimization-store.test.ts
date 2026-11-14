import { initialResearch } from './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { claimTask, createProjectOptimizationTask, finishProjectDelivery, finishProjectOptimization, geoRuntime, getGeoState, getTask, handleGeoAction, listTasks, releaseTask, retryProjectOptimizationTask, saveTask, taskIsBusy } from './store';
import type { ProjectOptimization } from './project-optimization-types';
import { buildTaskDiagnosisContext, reviewEditedProposal } from './planner';
import { getSeed } from './seed';
import { localDiagnosis } from './diagnosis';
import { buildQualityReview } from './quality';
import { selectProjectDelivery } from './project-optimization-delivery';
import { getProjectTaskProgress } from '../../components/geo/project-optimization-progress';
import type { GeoProposal } from './types';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-project-optimization-'));
const previous = { DATA_DIR: process.env.DATA_DIR, OPENGEO_LLM_MODEL: process.env.OPENGEO_LLM_MODEL,
  OPENGEO_LLM_API_KEY: process.env.OPENGEO_LLM_API_KEY };
process.env.DATA_DIR = temporary;
process.env.OPENGEO_LLM_MODEL = 'offline-test-model';
process.env.OPENGEO_LLM_API_KEY = 'offline-test-placeholder';
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is forbidden in this test'); };
after(() => {
  globalThis.fetch = previousFetch;
  geoRuntime.db?.close(); delete geoRuntime.db;
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(temporary, { recursive: true, force: true });
});

function prepareOfflineCandidate(taskId: string) {
  const task = getTask(taskId);
  const plan = task.projectOptimization!;
  const question = plan.snapshot.questions[0];
  plan.snapshot.evidence = [{ id: 'test-evidence', questionId: question.id, engine: 'chatgpt', language: 'zh', query: question.zh,
    recordedAt: '2026-11-02T00:00:00Z', conditions: '固定原条件', evidencePath: 'offline-fixture.md', text: '记录输入并对照结果。', boundary: '测试原始材料' }];
  saveTask(task);
  const candidate = { summary: '补充可核对步骤。', limitations: ['尚未实施。'], actions: [{ id: 'A1', title: '增加记录步骤', priority: 1,
    questionIds: [question.id], assetIds: [], observed: '回答提出记录输入。', hypothesis: '具体记录步骤可能帮助理解。',
    change: '新增输入、结果和条件记录表。', rationale: '提供可核对的步骤。', evidence: [{ evidenceId: 'test-evidence', quote: '记录输入' }],
    verification: '先核对步骤，实施后同题、同语言、同入口、同条件分别复测品牌提及与自有引用，未知不记为零。', limitations: ['待实施后验证。'] }] };
  const assessment = { issues: [], actions: [{ actionId: 'A1', scores: { evidence: 90, relevance: 90, actionability: 90, verifiability: 90 },
    preservesGoal: 'pass', evidenceGrounded: 'pass', issues: [] as string[] }] };
  return { candidate, assessment };
}

test('project creation persists all current questions and atomically reuses active work across modes', async () => {
  const before = getGeoState();
  const batch = before.latestResearch!;
  const first = createProjectOptimizationTask({ mode: 'focus', batchId: batch.id });
  assert.equal(first.created, true);
  assert.deepEqual(first.task.projectOptimization!.questionIds, batch.questions.map(question => question.id));
  const results = await Promise.all(['deep', 'focus', 'deep'].map(async mode => createProjectOptimizationTask({ mode, batchId: batch.id })));
  assert.ok(results.every(result => !result.created && result.task.id === first.task.id));
  assert.equal(listTasks().filter(task => task.projectOptimization).length, 1);
  assert.equal(getTask(first.task.id).projectOptimization!.mode, 'focus');
  assert.throws(() => createProjectOptimizationTask({ mode: 'focus', batchId: 'stale-batch' }), /批次/);
  assert.throws(() => createProjectOptimizationTask({ mode: 'invalid', batchId: batch.id }), /模式/);

  releaseTask(first.task.id);
  first.task.status = 'proposal_ready'; first.task.projectOptimization!.phase = 'awaiting_review'; saveTask(first.task);
  assert.equal(createProjectOptimizationTask({ mode: 'deep', batchId: batch.id }).task.id, first.task.id);
  for (const action of ['accept_plan', 'confirm_implementation', 'start_workflow', 'plan_from_saved', 'pause']) {
    await assert.rejects(handleGeoAction({ action, taskId: first.task.id }), /仅供审阅/);
  }
  assert.equal(getTask(first.task.id).implementation, null);
  assert.equal(getTask(first.task.id).monitor.enabled, false);
});

test('failed task retains frozen scope and cannot retry while a newer active plan exists', async () => {
  const old = listTasks().find(task => task.projectOptimization)!;
  const scope = structuredClone(old.projectOptimization!.snapshot);
  old.status = 'failed'; old.projectOptimization!.phase = 'failed'; saveTask(old);
  const fresh = createProjectOptimizationTask({ mode: 'deep', batchId: old.projectOptimization!.batchId });
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.task.id, old.id);
  await assert.rejects(handleGeoAction({ action: 'retry_project_optimization', taskId: old.id }), /已有项目优化任务/);
  assert.deepEqual(getTask(old.id).projectOptimization!.snapshot, scope);
  releaseTask(fresh.task.id);
});

test('blocked task explicitly retries the same snapshot or archives without claiming implementation', async () => {
  const task = listTasks().find(item => item.projectOptimization && item.status === 'investigating')!;
  task.status = 'proposal_ready'; task.projectOptimization!.phase = 'blocked';
  task.projectOptimization!.summary = '保留候选';
  task.projectOptimization!.snapshot.questions[0].zh = 'FROZEN_ORIGINAL_SENTINEL';
  saveTask(task);
  const scope = structuredClone(task.projectOptimization!.snapshot);
  retryProjectOptimizationTask(task.id);
  assert.equal(getTask(task.id).status, 'investigating');
  assert.deepEqual(getTask(task.id).projectOptimization!.snapshot, scope);
  assert.match(getTask(task.id).events.at(-1)!.detail, /不读取新证据/);
  await assert.rejects(handleGeoAction({ action: 'close_project_optimization', taskId: task.id }), /正在执行/);
  releaseTask(task.id);
  const stopped = getTask(task.id); stopped.status = 'proposal_ready'; stopped.projectOptimization!.phase = 'blocked'; saveTask(stopped);
  const archived = await handleGeoAction({ action: 'close_project_optimization', taskId: task.id });
  const closed = archived.tasks.find(item => item.id === task.id)!;
  assert.equal(closed.status, 'completed');
  assert.equal(closed.projectOptimization!.phase, 'closed');
  assert.equal(closed.projectOptimization!.summary, '保留候选');
  assert.deepEqual(closed.projectOptimization!.snapshot, scope);
  assert.equal(closed.implementation, null);
  assert.equal(closed.monitor.enabled, false);
  assert.match(closed.events.at(-1)!.detail, /未实施.*未验证效果/);
  assert.throws(() => retryProjectOptimizationTask(task.id), /归档|重试/);
  const fresh = createProjectOptimizationTask({ mode: 'focus', batchId: task.projectOptimization!.batchId });
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.task.id, task.id);
  assert.notEqual(fresh.task.projectOptimization!.snapshot.questions[0].zh, 'FROZEN_ORIGINAL_SENTINEL');
  releaseTask(fresh.task.id);
});

test('candidate and each assessment reach SQLite before later calls; retry keeps history and is exclusive', async () => {
  const task = listTasks().find(item => item.projectOptimization && item.status === 'investigating')!;
  claimTask(task.id, 'investigate');
  const { candidate, assessment } = prepareOfflineCandidate(task.id);
  const snapshot = structuredClone(getTask(task.id).projectOptimization!.snapshot);
  let calls = 0;
  await finishProjectOptimization(task.id, { prepareMaterials: async plan => ({ assets: plan.snapshot.assets, limitations: [] }), loadModel: async () => ({ generateObject: async () => {
    const saved = getTask(task.id).projectOptimization!;
    if (calls++ === 0) { assert.equal(saved.phase, 'planning'); return candidate; }
    assert.equal(saved.phase, 'reviewing');
    assert.equal(saved.history!.length, 1);
    assert.equal(saved.actions[0].change, candidate.actions[0].change);
    assert.equal(saved.review, null);
    throw new Error('审核连接中断');
  } }) });
  const failed = getTask(task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.projectOptimization!.phase, 'failed');
  assert.equal(failed.projectOptimization!.actions[0].change, candidate.actions[0].change);
  assert.equal(failed.projectOptimization!.history![0].review, null);
  assert.equal(failed.source, 'model');
  assert.match(failed.projectOptimization!.progress!.message, /已保存/);
  assert.equal(taskIsBusy(task.id), false);
  const retries = await Promise.allSettled([1, 2].map(async () => retryProjectOptimizationTask(task.id)));
  assert.equal(retries.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(retries.filter(item => item.status === 'rejected').length, 1);
  assert.equal(getTask(task.id).projectOptimization!.history!.length, 1);
  assert.equal(getTask(task.id).projectOptimization!.attempt, 2);
  assert.equal(getTask(task.id).projectOptimization!.phase, 'initializing');

  const failedReview = structuredClone(assessment); failedReview.actions[0].scores.actionability = 60;
  failedReview.actions[0].issues = ['补充逐步说明'];
  const revised = structuredClone(candidate); revised.actions[0].change += ' 表格后增加逐步说明。';
  const replies = [candidate, failedReview, revised, assessment];
  const persisted: ProjectOptimization[] = [];
  calls = 0;
  await finishProjectOptimization(task.id, { prepareMaterials: async plan => ({ assets: plan.snapshot.assets, limitations: [] }), onProgress: () => { persisted.push(getTask(task.id).projectOptimization!); },
    loadModel: async () => ({ generateObject: async () => {
      const saved = getTask(task.id).projectOptimization!;
      if (calls === 2) {
        assert.equal(saved.phase, 'revising');
        assert.equal(saved.history!.at(-1)!.review!.passed, false);
      }
      if (calls === 3) {
        assert.equal(saved.phase, 'reviewing');
        assert.equal(saved.actions[0].change, revised.actions[0].change);
        assert.equal(saved.history!.at(-1)!.review, null);
      }
      return replies[calls++];
    } }) });
  const ready = getTask(task.id);
  assert.deepEqual(persisted.map(item => item.phase), ['planning', 'reviewing', 'reviewing', 'revising', 'reviewing', 'awaiting_review']);
  assert.deepEqual(ready.projectOptimization!.history!.map(item => [item.attempt, item.round, item.review?.passed ?? null]), [[1, 1, null], [2, 1, false], [2, 2, true]]);
  assert.deepEqual(ready.projectOptimization!.snapshot, snapshot);
  assert.equal(ready.status, 'proposal_ready');
  assert.equal(ready.projectOptimization!.phase, 'awaiting_review');
  assert.equal(ready.implementation, null);
  assert.equal(ready.monitor.enabled, false);
  assert.equal(taskIsBusy(task.id), false);
});

test('server restart marks an interrupted revision failed and retains every saved result', () => {
  const task = listTasks().find(item => item.projectOptimization && item.status === 'proposal_ready')!;
  task.status = 'investigating';
  task.projectOptimization!.phase = 'revising';
  saveTask(task);
  claimTask(task.id, 'investigate');
  const before = structuredClone(task.projectOptimization!);
  geoRuntime.db!.close(); delete geoRuntime.db;
  const restored = getTask(task.id);
  assert.equal(restored.status, 'failed');
  assert.equal(restored.projectOptimization!.phase, 'failed');
  assert.deepEqual(restored.projectOptimization!.history, before.history);
  assert.deepEqual(restored.projectOptimization!.actions, before.actions);
  assert.deepEqual(restored.projectOptimization!.review, before.review);
  assert.deepEqual(restored.projectOptimization!.snapshot, before.snapshot);
  assert.match(restored.projectOptimization!.progress!.message, /重启中断/);
  assert.equal(taskIsBusy(task.id), false);
  assert.equal(restored.implementation, null);
});

test('project parameters remain compatible with the original single-task preview', async () => {
  const state = await handleGeoAction({ action: 'create_task', legacyQuestionPlan: true, goal: 'Synthetic single-task preview' });
  const task = state.tasks.find(item => item.goal === 'Synthetic single-task preview')!;
  const seed = getSeed();
  const result = await reviewEditedProposal(task, seed, seed.proposal);
  assert.equal(result.maxRounds, 3);
  assert.equal(result.rounds[0].review.passed, false);
});

test('one approved action automatically becomes an exact reviewed draft on the same task, without implementation', async () => {
  const seed = getSeed();
  const batch = getGeoState().latestResearch!;
  const created = createProjectOptimizationTask({ mode: 'focus', batchId: batch.id });
  const task = getTask(created.task.id);
  const plan = task.projectOptimization!;
  const question = initialResearch[0].questions.find(item => item.id === 'C02')!;
  const observation = question.observations.find(item => item.engine === 'chatgpt' && item.language === 'zh')!;
  const evidence = plan.snapshot.evidence.find(item => item.questionId === question.id && item.engine === 'chatgpt' && item.language === 'zh')!;
  const asset = seed.assets.find(item => item.id === 'guide-zh-CN')!;
  plan.phase = 'awaiting_review';
  plan.actions = [{ id: 'one-action', title: '补充原文中的操作步骤', priority: 1, questionIds: [question.id], assetIds: [asset.id],
    observed: '原回答说明了记录输入。', hypothesis: '具体步骤可能帮助读者。', change: '在现有步骤末尾增加复核方法。',
    rationale: '先完善已有内容。', evidence: [{ evidenceId: evidence.id, quote: 'record the input' }],
    verification: '保留原问题和条件，实施后分别复测提及与引用。', limitations: ['实际效果待复测。'], status: 'ready' }];
  plan.review = { passed: true, reviewedAt: new Date().toISOString(), issues: [], actions: [{ actionId: 'one-action',
    scores: { evidence: 90, relevance: 90, actionability: 90, verifiability: 90 }, preservesGoal: 'pass', evidenceGrounded: 'pass', passed: true, issues: [] }] };
  task.status = 'proposal_ready'; saveTask(task);
  const snapshot = structuredClone(plan.snapshot);
  const selection = selectProjectDelivery(plan);
  assert.equal(selection.context.snapshot!.observations.length, 1);
  assert.deepEqual(selection.context.snapshot!.observations[0], observation);
  selection.context.snapshot!.question.zh = 'not the original';
  assert.deepEqual(plan.snapshot, snapshot);
  const multi = structuredClone(plan); multi.actions[0].assetIds.push('guide-en');
  assert.throws(() => selectProjectDelivery(multi), /同时修改多份/);
  const multipleActions = structuredClone(task);
  multipleActions.projectOptimization!.actions.push({ ...structuredClone(plan.actions[0]), id: 'companion-action', priority: 2 });
  multipleActions.projectOptimization!.review!.actions.push({ ...structuredClone(plan.review.actions[0]), actionId: 'companion-action' });
  saveTask(multipleActions);
  await finishProjectDelivery(task.id, {
    readMaterial: async () => { assert.fail('multi-action delivery must not silently start only the first action'); },
  });
  const pendingDelivery = getTask(task.id);
  assert.deepEqual(pendingDelivery.projectOptimization!.actions, multipleActions.projectOptimization!.actions);
  assert.equal(pendingDelivery.projectOptimization!.delivery!.phase, 'blocked');
  assert.equal(getProjectTaskProgress(pendingDelivery).ready, false);
  assert.equal(pendingDelivery.implementation, null);
  saveTask(task);
  const missing = structuredClone(plan); missing.snapshot.evidence = [];
  assert.throws(() => selectProjectDelivery(missing), /原问题/);
  assert.equal(getProjectTaskProgress(task).ready, false, 'a high-level plan is not a ready draft');
  let draftCalls = 0;
  const taskCount = listTasks().length;
  await finishProjectDelivery(task.id, {
    readMaterial: async selected => {
      assert.equal(getTask(task.id).projectOptimization!.delivery!.phase, 'reading');
      assert.equal(selected.id, asset.id);
      return { asset: { ...selected, markdown: selected.markdown + '\n\nFresh original material.', markdownIsExcerpt: false }, readAt: '2026-11-11T00:00:00Z' };
    },
    buildPlan: async (current, currentSeed, _strategies, progress) => {
      draftCalls++;
      assert.equal(current.id, task.id);
      assert.equal(current.workflow!.baseline, undefined);
      assert.equal(current.workflow!.savedResearch!.query, question.zh);
      assert.equal(current.workflow!.savedResearch!.conditions, observation.conditions);
      assert.equal(current.workflow!.savedResearch!.recordedAt, observation.recordedAt);
      assert.match(current.researchContext!.snapshot!.targetAsset!.markdown, /Fresh original material/);
      progress!({ phase: 'reviewing', message: '正在检查修改稿' });
      assert.equal(getProjectTaskProgress(getTask(task.id)).label, '正在检查修改稿');
      const context = buildTaskDiagnosisContext(current, currentSeed);
      const proposal: GeoProposal = { ...seed.proposal, id: `${task.id}-proposal`, title: '新增复核方法', status: 'reviewed',
        targetAssetId: asset.id, targetUrl: asset.publicUrl!, before: 'Fresh original material.', after: 'Fresh original material.\nCheck the saved input.',
        changes: ['增加复核步骤'], successCriteria: ['同题、同语言、同入口复测品牌正确提及和自有引用；实施与效果分开，未知时不承诺改善。'],
        evidencePaths: [observation.evidencePath] };
      const check = { met: true, criterionQuote: proposal.successCriteria[0], reason: 'Explicit synthetic test criterion.' };
      const review = buildQualityReview(proposal, { scores: { evidence: 90, relevance: 90, actionability: 90, verifiability: 90 },
        issues: [], summary: 'Synthetic independent review.', geoAcceptanceRequired: true,
        geoAcceptance: { implementation: check, ownBrandMention: check, ownTargetCitation: check, comparableConditions: check, unknownBaseline: check } });
      return { proposal, blocks: [], source: 'model', diagnosis: localDiagnosis(context), appliedStrategyIds: [],
        quality: { maxRounds: 2, targetScore: 80, minimumDimensionScore: 70, stopReason: 'target_reached', bestRound: 1, rounds: [{ round: 1, candidate: structuredClone(proposal), review }] } };
    },
  });
  const ready = getTask(task.id);
  assert.equal(draftCalls, 1);
  assert.equal(listTasks().length, taskCount);
  assert.deepEqual(ready.projectOptimization!.snapshot, snapshot);
  assert.equal(ready.projectOptimization!.delivery!.phase, 'ready');
  assert.equal(ready.implementation, null);
  assert.equal(ready.monitor.enabled, false);
  assert.equal(getProjectTaskProgress(ready).label, '待你确认改动');
  assert.equal(getProjectTaskProgress(ready).ready, true);
  const changed = structuredClone(ready); changed.proposal!.after += '\nUnreviewed change.';
  assert.equal(getProjectTaskProgress(changed).ready, false);
  const oldReview = structuredClone(ready); delete oldReview.workflow!.quality!.rounds[0].review.geoAcceptance;
  assert.equal(getProjectTaskProgress(oldReview).ready, false);
  const approved = await handleGeoAction({ action: 'accept_plan', taskId: ready.id, proposalRevision: ready.workflow!.proposalRevision });
  const awaiting = approved.tasks.find(item => item.id === ready.id)!;
  assert.equal(awaiting.implementation, null);
  assert.equal(getProjectTaskProgress(awaiting).label, '修改稿已确认，等待实施');
  const implemented = structuredClone(awaiting);
  implemented.implementation = { kind: 'user_confirmed', at: new Date().toISOString(), note: 'Synthetic implementation', url: asset.publicUrl! };
  assert.equal(getProjectTaskProgress(implemented).label, '改动已登记，等待复测');
  assert.equal(getProjectTaskProgress(implemented).ready, false);
});

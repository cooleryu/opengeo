import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, test } from 'node:test';
import { appendResearchObservation, getLatestResearch, getResearchBatch, getResearchRun, saveResearchRun } from './research';
import { getSeed } from './seed';
import { withGeoProject } from './projects';
import { dataDirectory, getQuestionGeneration, getQuestionPlan, handleGeoAction, startQuestionGeneration } from './store';
import { completeProjectOnboarding, createProjectOnboarding } from './project-onboarding-store';
import type { GeoQuestionPlan } from './question-types';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-question-management-'));
const previousDataDirectory = process.env.DATA_DIR;
process.env.DATA_DIR = temporary;
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Question management must not call a network provider.'); };
after(() => {
  globalThis.fetch = previousFetch;
  if (previousDataDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});
const draft = {
  query: '怎样找到没有比赛结果提示的录像入口？', category: 'problem',
  intent: '用户想在看比赛录像前避免看到赛果。', rationale: '先检查用户需求和公开内容的差距。',
  expectedResult: '发现能够避免提前知道比赛结果的方法。', assetIds: [],
};

test('actions persist revisions, reject stale updates, and retain measured source data', async () => {
  await withGeoProject('sample-project', async () => {
    const source = structuredClone(getLatestResearch('sample-project'));
    const original = getQuestionPlan();
    const seedQuestions = getSeed().questions;
    const result = await handleGeoAction({ action: 'save_question', planId: original.id, revision: original.revision, ...draft, sourceQuestionId: 'C04' });
    const saved = result.questionPlan;
    assert.equal(saved.revision, original.revision + 1);
    assert.equal(saved.candidates.at(-1)!.sourceQuestionId, 'C04');
    assert.equal(saved.candidates.at(-1)!.review.status, 'pending');
    await assert.rejects(handleGeoAction({ action: 'review_question', planId: original.id, revision: original.revision, candidateId: saved.candidates.at(-1)!.id, decision: 'include', reason: '这是过期页面发出的审核。' }), (error: unknown) => (error as {status:number}).status === 409);
    assert.equal(getQuestionPlan().revision, saved.revision);
    const connection = new Database(path.join(dataDirectory(), 'db.sqlite'), { readonly: true });
    try {
      const rows = connection.prepare('SELECT payload FROM geo_question_plans ORDER BY seq').all() as {payload:string}[];
      assert.equal(rows.length, 2);
      assert.deepEqual(JSON.parse(rows[0].payload), original);
    } finally { connection.close(); }
    assert.deepEqual(getLatestResearch('sample-project'), source);
    assert.deepEqual(getSeed().questions, seedQuestions);
  });
});

test('pending and excluded questions cannot be selected, and confirmation is limited to eight core questions', async () => {
  await withGeoProject('sample-project-two', async () => {
    const previousBatch = getLatestResearch('sample-project-two')!;
    const act = async (action: string, values: Record<string, unknown> = {}) => {
      const plan = getQuestionPlan();
      return (await handleGeoAction({ action, planId: plan.id, revision: plan.revision, ...values })).questionPlan;
    };
    assert.equal(getQuestionPlan().candidates.length, 0);
    for (let index = 0; index < 9; index++) {
      const saved = await act('save_question', { ...draft, query: `${draft.query}（场景 ${index + 1}）`, ...(index === 0 ? { queryEn: 'How can I find a workflow recording tool?' } : {}) });
      const id = saved.candidates.at(-1)!.id;
      await assert.rejects(act('select_question', { candidateId: id, selected: true }), /先完成人工审阅/);
      await act('review_question', { candidateId: id, decision: 'explore', reason: '保留这个需求，先核实内容和能力差距。' });
      if (index < 8) await act('select_question', { candidateId: id, selected: true });
      else await assert.rejects(act('select_question', { candidateId: id, selected: true }), /最多 8 题/);
    }
    const confirmed = await act('confirm_questions');
    assert.equal(confirmed.status, 'ready');
    assert.equal(confirmed.candidates.filter(item => item.selected).length, 8);
    const batch = getLatestResearch('sample-project-two')!;
    assert.deepEqual(batch.questionPlan, confirmed);
    assert.equal(batch.questions.length, 8);
    assert.equal(batch.deferredQuestions.length, 1);
    assert.ok(batch.questions.every(question => question.decision === 'search_now' && question.observations.length === 0));
    assert.deepEqual(getResearchBatch('sample-project-two', previousBatch.id), previousBatch);
    const repeated = await act('confirm_questions');
    assert.deepEqual(repeated, confirmed);
    assert.deepEqual(getLatestResearch('sample-project-two'), batch);
    const first = confirmed.candidates[0];
    await act('review_question', { candidateId: first.id, decision: 'exclude', reason: '现在暂时不投入这个方向。' });
    await assert.rejects(act('select_question', { candidateId: first.id, selected: true }), /未通过审核/);
    const edited = await act('save_question', { ...draft, candidateId: first.id, query: '怎样为正在播放的录像关闭可能剧透的推荐？' });
    const replacement = edited.candidates.at(-1)!;
    assert.equal(replacement.queryEn, first.queryEn);
    assert.equal(replacement.review.status, 'pending');
    await assert.rejects(act('select_question', { candidateId: first.id, selected: true }), /新版本/);
    assert.equal(getQuestionPlan().candidates.filter(item => item.selected).length, 7);
  });
  assert.equal(getQuestionPlan().projectId, 'sample-project');
  assert.equal(getQuestionPlan().candidates.at(-1)!.sourceQuestionId, 'C04');
});

test('regeneration saves only the new eight selections and preserves the confirmed batch, observations, and old revisions', async () => {
  const { project } = createProjectOnboarding({ kind: 'company', url: 'https://example.com/isolated-recommendation-save' });
  completeProjectOnboarding(project.id, {
    summary: 'A synthetic documentation tool for preserving workflow records.', audience: 'Authors documenting reusable workflows.',
    capabilities: ['Documents workflow inputs and results.'], unknowns: ['Actual results are not verified.'],
  });
  await withGeoProject(project.id, async () => {
    const act = async (action: string, values: Record<string, unknown> = {}) => {
      const current = getQuestionPlan();
      return (await handleGeoAction({ action, planId: current.id, revision: current.revision, ...values })).questionPlan;
    };
    for (let index = 0; index < 8; index++) {
      const saved = await act('save_question', { ...draft, query: `旧方向 ${index + 1}：怎样保存流程的输入与结果？` });
      const candidateId = saved.candidates.at(-1)!.id;
      await act('review_question', { candidateId, decision: 'include', reason: '合成需求适合检查流程记录的方法。' });
      await act('select_question', { candidateId, selected: true });
    }
    const confirmedPlan = await act('confirm_questions');
    const confirmedBatch = getLatestResearch(project.id)!;
    const measured = confirmedBatch.questions[0];
    const at = '2026-11-04T00:00:00.000Z';
    const run = saveResearchRun(project.id, {
      id: 'synthetic-confirmed-observation', projectId: project.id, batchId: confirmedBatch.id,
      provider: 'chatgpt', language: 'zh', questions: [{ questionId: measured.id, query: measured.zh }],
      status: 'completed', startedAt: at, updatedAt: at, completedAt: at, budgetLimit: 0, spent: 0, completedCount: 1,
    });
    appendResearchObservation(project.id, confirmedBatch.id, measured.id, {
      runId: run.id, engine: 'chatgpt', language: 'zh', query: measured.zh, recordedAt: at,
      status: 'not_observed', summary: 'Synthetic recorded result for preservation testing.',
      conditions: 'Synthetic test only; no network request.', sources: [], evidencePath: 'synthetic/confirmed-observation.json',
    });
    const originalResearch = structuredClone(getLatestResearch(project.id));
    const originalSeed = structuredClone(getSeed());
    const generated: GeoQuestionPlan = {
      ...structuredClone(confirmedPlan), source: 'model', status: 'draft',
      candidates: [
        ...confirmedPlan.candidates.map(candidate => ({ ...candidate, selected: false })),
        ...Array.from({ length: 8 }, (_, index) => ({
          ...structuredClone(confirmedPlan.candidates[0]), id: `new-recommendation-${index + 1}`, origin: 'model' as const,
          query: `新方向 ${index + 1}：怎样核对流程前后发生的变化？`, selected: true,
          review: { decision: 'include' as const, priority: 'high' as const, reason: '新推荐优先检查当前需求中的流程变化。', concerns: [],
            source: 'model' as const, status: 'reviewed' as const, reviewedAt: at,
            assessment: {
              worthPursuing: { verdict: 'yes' as const, reason: '记录流程变化有助于使用者核对工作结果。', demandBasis: 'inferred' as const, basis: '由合成用户的流程记录任务推导。' },
              currentSupport: { level: 'unverified' as const, reason: '合成材料不足以证明实际能力，继续保留核查。' },
              evidence: [], gaps: [{ kind: 'investigation' as const, description: '需要核查具体流程中的实际记录能力。' }],
            } },
        })),
      ],
      coverageReview: {
        needs: [{ id: 'workflow-changes', title: '核对流程变化', audience: '记录工作流程的人', trigger: '完成流程后需要核对输入和结果的变化。', importance: 'high', assetIds: [] }],
        selectionAdvantages: [], selectedIds: Array.from({ length: 8 }, (_, index) => `new-recommendation-${index + 1}`),
        coverage: [{ needId: 'workflow-changes', candidateIds: ['new-recommendation-1'], status: 'covered', reason: '已选问题覆盖流程变化的核查需求。' }],
        duplicates: [], reason: '合成需求由当前选择覆盖，继续等待实际验证。', status: 'complete', refinementRounds: 0,
      },
    };
    const connection = new Database(path.join(dataDirectory(), 'db.sqlite'), { readonly: true });
    try {
      const revisions = () => connection.prepare('SELECT revision, payload FROM geo_question_plans WHERE project_id = ? ORDER BY seq')
        .all(project.id) as { revision: number; payload: string }[];
      const before = revisions();
      let generationCalls = 0;
      const started = startQuestionGeneration({ planId: confirmedPlan.id, revision: confirmedPlan.revision,
        positioning: confirmedPlan.positioning, requestId: 'new-eight-recommendations' }, {
        generate: async () => { generationCalls++; return structuredClone(generated); },
      });
      await started.completion;
      assert.equal(generationCalls, 1);
      assert.equal(getQuestionGeneration()?.status, 'completed');
      const saved = getQuestionPlan();
      assert.equal(saved.status, 'draft');
      assert.equal(saved.revision, confirmedPlan.revision + 1);
      assert.equal(saved.candidates.length, 16);
      assert.deepEqual(saved.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id),
        generated.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id));
      assert.equal(saved.candidates.filter(candidate => candidate.selected).length, 8);
      assert.deepEqual(saved.coverageReview, generated.coverageReview);
      assert.deepEqual(getLatestResearch(project.id), originalResearch);
      assert.deepEqual(getResearchBatch(project.id, confirmedBatch.id), originalResearch);
      assert.equal(originalResearch!.questions[0].observations.length, 1);
      assert.deepEqual(getResearchRun(project.id, run.id), run);
      assert.deepEqual(getSeed(), originalSeed);
      const after = revisions();
      assert.equal(after.length, before.length + 1);
      assert.deepEqual(after.slice(0, -1), before);
      assert.deepEqual(JSON.parse(before.at(-1)!.payload), confirmedPlan);

      for (const action of ['select_question', 'save_question']) {
        if (action === 'save_question') {
          const current = getQuestionPlan();
          const regenerated = startQuestionGeneration({ planId: current.id, revision: current.revision,
            positioning: current.positioning, requestId: 'restore-coverage-before-manual-edit' }, {
            generate: async () => structuredClone(generated),
          });
          await regenerated.completion;
          assert.equal(getQuestionGeneration()?.status, 'completed');
          assert.deepEqual(getQuestionPlan().coverageReview, generated.coverageReview);
        }
        const auditedPlan = structuredClone(getQuestionPlan());
        const previousRevisions = revisions();
        const candidateId = 'new-recommendation-1';
        const changed = await act(action, action === 'select_question' ? { candidateId, selected: false } : {
          ...draft, candidateId, query: '怎样记录一次流程重跑前后具体发生的变化？',
        });
        assert.equal(changed.coverageReview, undefined);
        assert.equal(getQuestionPlan().coverageReview, undefined);
        assert.equal(changed.revision, auditedPlan.revision + 1);
        assert.deepEqual(revisions().slice(0, -1), previousRevisions);
        assert.deepEqual(JSON.parse(previousRevisions.at(-1)!.payload), auditedPlan);
        assert.deepEqual(JSON.parse(previousRevisions.at(-1)!.payload).coverageReview, generated.coverageReview);
        assert.deepEqual(getLatestResearch(project.id), originalResearch);
        assert.deepEqual(getResearchRun(project.id, run.id), run);
      }
    } finally { connection.close(); }
  });
});

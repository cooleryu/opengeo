import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, test } from 'node:test';
import { getLatestResearch, getResearchBatch } from './research';
import { getSeed } from './seed';
import { withGeoProject } from './projects';
import { dataDirectory, getQuestionPlan, handleGeoAction } from './store';

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

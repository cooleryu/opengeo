import { seedData } from './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeoSeed } from './types';
import { buildInitialQuestionPlan, validateQuestionPlan } from './question-planner';
import { reviewManualQuestion, saveManualQuestion, type SaveQuestionInput } from './question-management';
import { getLatestResearch } from './research';

const seed = seedData as unknown as GeoSeed;
const draft: SaveQuestionInput = {
  query: '编程助手运行旧计划前需要检查哪些变化？', category: 'problem',
  intent: '用户希望继续执行暂停前的任务。', rationale: '原目标和授权发生变化时值得检查。',
  expectedResult: '找到执行前重新核对目标和权限的方法。', assetIds: [],
};

test('manual draft links existing asset text automatically, remains pending, and never invents English', () => {
  const plan = buildInitialQuestionPlan(seed);
  const original = structuredClone(plan);
  const next = saveManualQuestion(plan, seed, { ...draft, assetIds: [seed.assets[0].id] });
  const added = next.candidates.at(-1)!;
  assert.deepEqual(plan, original);
  assert.deepEqual(next.candidates.slice(0, -1), plan.candidates);
  assert.equal(added.origin, 'manual');
  assert.equal(added.queryEn, undefined);
  assert.equal(added.selected, false);
  assert.equal(added.review.source, 'manual');
  assert.equal(added.review.status, 'pending');
  assert.ok(seed.assets[0].summary.includes(added.evidence[0].quote) || seed.assets[0].markdown.includes(added.evidence[0].quote));
  assert.equal(added.demandStatus, 'unverified');
});

test('manual exploration is allowed with no matching content; exclusion prevents selection', () => {
  const plan = saveManualQuestion(buildInitialQuestionPlan(seed), seed, draft);
  const candidate = plan.candidates.at(-1)!;
  const reviewed = reviewManualQuestion(plan, seed, { candidateId: candidate.id, decision: 'explore', reason: '需求值得保留，先调查现有能力与内容缺口。' });
  const result = reviewed.candidates.at(-1)!;
  assert.equal(result.review.status, 'reviewed');
  assert.equal(result.review.source, 'manual');
  assert.equal(result.review.decision, 'explore');
  assert.equal(result.selected, false);
  assert.ok(result.review.concerns.some(item => item.includes('不代表问题不值得')));
  result.selected = true;
  assert.equal(validateQuestionPlan(reviewed, seed).candidates.at(-1)!.selected, true);
  const excluded = reviewManualQuestion(reviewed, seed, { candidateId: candidate.id, decision: 'exclude', reason: '当前目标人群不符，暂时不投入。' });
  assert.equal(excluded.candidates.at(-1)!.selected, false);
});

test('editing history retains original question text and measurements, with a new pending version', () => {
  const plan = buildInitialQuestionPlan(seed);
  const measured = structuredClone(seed.questions);
  const prior = plan.candidates[0];
  const next = saveManualQuestion(plan, seed, { ...draft, candidateId: prior.id, queryEn: 'What should be checked before resuming an agent plan?' });
  const current = next.candidates.at(-1)!;
  assert.deepEqual(seed.questions, measured);
  assert.equal(next.candidates[0].query, prior.query);
  assert.deepEqual(next.candidates[0].review, prior.review);
  assert.equal(next.candidates[0].selected, false);
  assert.equal(next.candidates[0].supersededByCandidateId, current.id);
  assert.equal(current.supersedesCandidateId, prior.id);
  assert.equal(current.originalQuestionId, undefined);
  assert.equal(current.sourceQuestionId, prior.originalQuestionId);
  assert.equal(current.review.status, 'pending');
  assert.throws(() => reviewManualQuestion(next, seed, { candidateId: prior.id, decision: 'include', reason: '旧版题目不应再操作。' }), /新版本/);
  assert.throws(() => saveManualQuestion(next, seed, { ...draft, candidateId: current.id, sourceQuestionId: 'other' }), /不能更换/);
});

test('no-op saves retain an existing human review; actual changes create a new version', () => {
  let plan = saveManualQuestion(buildInitialQuestionPlan(seed), seed, draft);
  const id = plan.candidates.at(-1)!.id;
  plan = reviewManualQuestion(plan, seed, { candidateId: id, decision: 'include', reason: '先搜索竞争答案，能力缺口另行核实。' });
  assert.equal(saveManualQuestion(plan, seed, { ...draft, candidateId: id }), plan);
  const updated = saveManualQuestion(plan, seed, { ...draft, candidateId: id, rationale: '增加理由，但不改动原问题和历史测量。' });
  assert.equal(updated.candidates.at(-1)!.review.status, 'pending');
  assert.equal(updated.candidates.at(-2)!.review.status, 'reviewed');
  assert.equal(updated.candidates.at(-2)!.query, updated.candidates.at(-1)!.query);
});

test('research sources must belong to the project and remain separate from historical measurement IDs', () => {
  const research = getLatestResearch(seed.project.id)!;
  const next = saveManualQuestion(buildInitialQuestionPlan(seed), seed, { ...draft, sourceQuestionId: research.questions[0].id }, research);
  assert.equal(next.candidates.at(-1)!.sourceResearchBatchId, research.id);
  assert.equal(next.candidates.at(-1)!.originalQuestionId, undefined);
  assert.throws(() => saveManualQuestion(buildInitialQuestionPlan(seed), seed, { ...draft, sourceQuestionId: 'R01' }, getLatestResearch('sample-project-two')), /不属于当前项目/);
  assert.throws(() => saveManualQuestion(buildInitialQuestionPlan(seed), seed, { ...draft, assetIds: ['foreign-asset'] }), /不属于当前项目/);
});

test('manual review cannot bypass malformed brand questions or fabricate source evidence', () => {
  const pending = saveManualQuestion(buildInitialQuestionPlan(seed), seed, { ...draft, query: 'SampleProject 可以保证降低全部任务的成本吗？' });
  assert.equal(pending.candidates.at(-1)!.review.status, 'pending');
  assert.throws(() => reviewManualQuestion(pending, seed, { candidateId: pending.candidates.at(-1)!.id, decision: 'include', reason: '测试品牌泄露不能绕过。' }), /请先修改问题/);
  const changed = structuredClone(pending);
  changed.candidates.at(-1)!.assetIds = [seed.assets[0].id];
  changed.candidates.at(-1)!.evidence = [{ assetId: seed.assets[0].id, quote: '这是一段不存在于材料的编造证据，不能保存。' }];
  assert.throws(() => validateQuestionPlan(changed, seed), /摘录必须/);
});

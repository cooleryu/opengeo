import assert from 'node:assert/strict';
import { test } from 'node:test';
import seedData from './data/contextadapt.json';
import type { GeoSeed } from './types';
import { buildInitialQuestionPlan, validateQuestionPlan } from './question-planner';

// The seed contains legacy proposal fields unrelated to question planning.
const seed = seedData as unknown as GeoSeed;

test('curated draft is reproducible, preserves history, and distinguishes article evidence from product capability', () => {
  const original = structuredClone(seed);
  const plan = buildInitialQuestionPlan(seed);
  assert.deepEqual(plan, buildInitialQuestionPlan(seed));
  assert.deepEqual(seed, original);
  assert.equal(plan.source, 'curated');
  assert.equal(plan.candidates.length, 18);
  assert.equal(plan.candidates.filter(q => q.origin === 'existing').length, seed.questions.length);
  assert.equal(plan.candidates.find(q => q.id === 'l2-zh03')?.target, 'article');
  for (const id of ['l2-zh02', 'l2-en02', 'l2-zh04', 'l2-en04']) {
    assert.equal(plan.candidates.find(q => q.id === id)?.review.decision, 'explore');
    assert.equal(plan.candidates.find(q => q.id === id)?.selected, false);
  }
  assert.ok(plan.candidates.every(q => q.demandStatus === 'unverified'));
  assert.ok(plan.candidates.some(q => q.category === 'positioning' && q.selected));
});

test('fabricated evidence and missing historical questions cannot be saved', () => {
  const plan = buildInitialQuestionPlan(seed);
  plan.candidates[0].evidence[0].quote = '材料中没有这段话，不能把模型生成的断言当成原文。';
  assert.throws(() => validateQuestionPlan(plan, seed), /摘录必须/);
  const missingHistory = buildInitialQuestionPlan(seed);
  missingHistory.candidates.shift();
  assert.throws(() => validateQuestionPlan(missingHistory, seed), /保留全部历史/);
});

test('nonbrand identity leakage is excluded and cannot enter measurement', () => {
  for (const identity of ['ContextAdapt', 'Context Adapt', 'cooleryu', seed.project.siteUrl]) {
    const plan = buildInitialQuestionPlan(seed);
    const candidate = plan.candidates.find(q => q.id === 'problem-01')!;
    candidate.query = `${identity} 能解决编程 Agent 暂停后计划过期的问题吗？`;
    candidate.selected = true;
    const result = validateQuestionPlan(plan, seed).candidates.find(q => q.id === candidate.id)!;
    assert.equal(result.review.decision, 'exclude');
    assert.equal(result.selected, false);
  }
});

test('missing public assets or supporting excerpts prevent inclusion', () => {
  const privateSeed = structuredClone(seed);
  privateSeed.assets.forEach(asset => { asset.publicUrl = null; });
  assert.ok(buildInitialQuestionPlan(privateSeed).candidates.every(q => q.review.decision === 'exclude' && !q.selected));
  const plan = buildInitialQuestionPlan(seed);
  const candidate = plan.candidates.find(q => q.id === 'problem-01')!;
  candidate.evidence = [];
  const result = validateQuestionPlan(plan, seed).candidates.find(q => q.id === candidate.id)!;
  assert.equal(result.review.decision, 'exclude');
  assert.equal(result.selected, false);
});

test('user may explicitly select an exploratory question while excluded questions remain blocked', () => {
  const plan = buildInitialQuestionPlan(seed);
  plan.candidates.find(q => q.id === 'l2-zh02')!.selected = true;
  assert.equal(validateQuestionPlan(plan, seed).candidates.find(q => q.id === 'l2-zh02')!.selected, true);
  const excluded = plan.candidates.find(q => q.id === 'problem-01')!;
  excluded.review.decision = 'exclude';
  excluded.selected = true;
  assert.equal(validateQuestionPlan(plan, seed).candidates.find(q => q.id === excluded.id)!.selected, false);
});

test('copying a long positioning phrase is not independent discovery', () => {
  const plan = buildInitialQuestionPlan(seed);
  plan.positioning = 'A project for retaining action critical code evidence before executing tools and verifying current permissions.';
  const candidate = plan.candidates.find(q => q.id === 'positioning-01')!;
  candidate.query = 'Which project is for retaining action critical code evidence before executing tools?';
  assert.equal(validateQuestionPlan(plan, seed).candidates.find(q => q.id === candidate.id)!.review.decision, 'exclude');
});

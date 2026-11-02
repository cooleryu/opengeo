import { seedData } from './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { GeoSeed } from './types';
import type { GeoStructuredModel } from './connection-settings';
import type { QuestionCandidate, QuestionDecision } from './question-types';
import { buildInitialQuestionPlan, generateQuestionPlan, reviewQuestionCandidate, validateQuestionPlan } from './question-planner';

// The seed contains legacy proposal fields unrelated to question planning.
const seed = seedData as unknown as GeoSeed;
type ModelInput = Parameters<GeoStructuredModel['generateObject']>[0];

function modelReview(id: string, decision: QuestionDecision = 'include') {
  return {
    id, decision, reason: '依据原始需求与当前方向分别判断争取价值和承接缺口。', concerns: [],
    assessment: {
      worthPursuing: {
        verdict: decision === 'exclude' ? 'no' as const : 'yes' as const,
        reason: decision === 'exclude' ? '目标人群与当前方向不符，暂不投入。' : '暂停后继续执行的用户需要重新检查原目标和权限。',
        demandBasis: 'inferred' as const, basis: '根据给定的用户情境和问题意图推导，未冒充公开需求。',
      },
      currentSupport: { level: 'unverified' as const, reason: '现有材料尚不足以证明所有情境下的实际能力。' },
      evidence: [] as { assetId: string; quote: string }[],
      gaps: [{ kind: 'investigation' as const, description: '继续调查能力边界以及具体情境下的需求。' }],
    },
  };
}

function fakeModel(reply: unknown | ((input: ModelInput) => unknown), calls: ModelInput[] = []): GeoStructuredModel {
  return {
    async generateObject(input) {
      calls.push(input);
      return typeof reply === 'function' ? reply(input) : reply;
    },
  };
}

function assertModelReview(candidate: QuestionCandidate, decision: QuestionDecision) {
  assert.equal(candidate.review.decision, decision);
  assert.equal(candidate.review.source, 'model');
  assert.equal(candidate.review.status, 'reviewed');
  assert.ok(Number.isFinite(Date.parse(candidate.review.reviewedAt!)));
  assert.ok(candidate.review.assessment);
  assert.equal(candidate.demandStatus, 'unverified');
}

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

test('a project without local editorial metadata uses only its own historical questions', () => {
  const generic = structuredClone(seed) as GeoSeed & { initialQuestionPlan?: unknown };
  delete generic.initialQuestionPlan;
  const plan = buildInitialQuestionPlan(generic);
  assert.equal(plan.candidates.length, generic.questions.length);
  assert.ok(plan.candidates.every(candidate => candidate.origin === 'existing'));
  assert.ok(plan.candidates.every(candidate => candidate.review.decision === 'include'));
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
  for (const identity of ['SampleProject', 'Sample Project', 'example', seed.project.siteUrl]) {
    const plan = buildInitialQuestionPlan(seed);
    const candidate = plan.candidates.find(q => q.id === 'problem-01')!;
    candidate.query = `${identity} 能解决编程 Agent 暂停后计划过期的问题吗？`;
    candidate.selected = true;
    const result = validateQuestionPlan(plan, seed).candidates.find(q => q.id === candidate.id)!;
    assert.equal(result.review.decision, 'exclude');
    assert.equal(result.selected, false);
  }
});

test('missing public assets or supporting excerpts remain gaps without automatically excluding demand', () => {
  const privateSeed = structuredClone(seed);
  privateSeed.assets.forEach(asset => { asset.publicUrl = null; });
  const privatePlan = buildInitialQuestionPlan(privateSeed);
  assert.deepEqual(privatePlan.candidates.map(q => q.review.decision), buildInitialQuestionPlan(seed).candidates.map(q => q.review.decision));
  assert.ok(privatePlan.candidates.every(q => q.review.concerns.some(item => item.includes('尚无记载为已发布'))));
  const plan = buildInitialQuestionPlan(seed);
  const candidate = plan.candidates.find(q => q.id === 'problem-01')!;
  candidate.evidence = [];
  const result = validateQuestionPlan(plan, seed).candidates.find(q => q.id === candidate.id)!;
  assert.equal(result.review.decision, 'include');
  assert.equal(result.selected, candidate.selected);
  assert.ok(result.review.concerns.some(item => item.includes('尚无逐项对应')));
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

test('legacy reviews without assessment remain valid and do not acquire a fabricated dual assessment', () => {
  const plan = buildInitialQuestionPlan(seed);
  assert.ok(plan.candidates.every(candidate => candidate.review.assessment === undefined));
  assert.deepEqual(validateQuestionPlan(plan, seed), plan);
});

test('one candidate review preserves every other candidate and only exclusion clears the target selection', async () => {
  for (const decision of ['include', 'explore', 'exclude'] as const) {
    for (const selected of [true, false]) {
      const plan = buildInitialQuestionPlan(seed);
      const target = plan.candidates.find(candidate => candidate.id === 'problem-01')!;
      target.selected = selected;
      target.queryEn = 'How should an agent check changed goals before resuming an old plan?';
      target.sourceQuestionId = 'l2-zh03';
      // This unrelated legacy review would gain a gap concern if whole-plan normalization leaked out.
      plan.candidates.find(candidate => candidate.id === 'content-01')!.evidence = [];
      const original = structuredClone(plan);
      const originalSeed = structuredClone(seed);
      const calls: ModelInput[] = [];
      const result = await reviewQuestionCandidate(seed, plan, target.id, { model: fakeModel({ reviews: [modelReview(target.id, decision)] }, calls) });
      assert.equal(calls.length, 1);
      assert.deepEqual(plan, original);
      assert.deepEqual(seed, originalSeed);
      assert.deepEqual(result.candidates.filter(item => item.id !== target.id), original.candidates.filter(item => item.id !== target.id));
      assert.deepEqual({ ...result, candidates: [] }, { ...original, candidates: [] });
      const updated = result.candidates.find(item => item.id === target.id)!;
      assertModelReview(updated, decision);
      assert.equal(updated.selected, decision === 'exclude' ? false : selected);
      assert.deepEqual({ ...updated, review: target.review, selected }, target);
    }
  }
});

test('wrong IDs and incomplete model reviews fail without changing the plan or retrying', async () => {
  const plan = buildInitialQuestionPlan(seed);
  const original = structuredClone(plan);
  const { assessment: _assessment, ...withoutAssessment } = modelReview('problem-01');
  for (const reviews of [
    [modelReview('another-question')],
    [withoutAssessment],
    [modelReview('problem-01'), modelReview('problem-01')],
  ]) {
    const calls: ModelInput[] = [];
    await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews }, calls) }));
    assert.equal(calls.length, 1);
    assert.deepEqual(plan, original);
  }
});

test('review contract keeps evidence at assessment level and rejects duplicate locations or fabricated evidence', async () => {
  const plan = buildInitialQuestionPlan(seed);
  const base = modelReview('problem-01');
  const calls: ModelInput[] = [];
  const misplaced = { ...base, assessment: { ...base.assessment,
    currentSupport: { ...base.assessment.currentSupport, evidence: [] },
  } };
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [misplaced] }, calls) }), /Unrecognized key.*evidence/);
  assert.equal(calls.length, 1);
  const system = String(calls[0].messages[0].content);
  assert.match(system, /currentSupport.*只能包含.*level.*reason/);
  const template = JSON.parse(system.match(/```json\n([\s\S]+?)\n```/)![1]);
  assert.deepEqual(Object.keys(template.reviews[0].assessment).sort(), ['currentSupport', 'evidence', 'gaps', 'worthPursuing']);
  assert.deepEqual(Object.keys(template.reviews[0].assessment.currentSupport).sort(), ['level', 'reason']);
  const supported = { ...base, assessment: { ...base.assessment,
    currentSupport: { level: 'partial', reason: '现有材料解释了部分方法，实际应用仍需要核实。' },
    evidence: [plan.candidates.find(candidate => candidate.id === 'problem-01')!.evidence[0]],
  } };
  const reviewed = await reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [supported] }) });
  assert.deepEqual(reviewed.candidates.find(candidate => candidate.id === 'problem-01')!.review.assessment?.evidence, supported.assessment.evidence);
  supported.assessment.evidence = [{ assetId: supported.assessment.evidence[0].assetId, quote: '这不是材料原文，不允许因结构正确就保存伪造依据。' }];
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [supported] }) }), /原文/);
});

test('provider-side parsing accepts only the known nested evidence shape and preserves every excerpt during normalization', async () => {
  const plan = buildInitialQuestionPlan(seed);
  const original = structuredClone(plan);
  const target = plan.candidates.find(candidate => candidate.id === 'problem-01')!;
  const base = modelReview(target.id);
  const { evidence: _evidence, ...assessment } = base.assessment;
  const excerpts = [target.evidence[0], plan.candidates.find(candidate => candidate.id === 'boundary-01')!.evidence[0]];
  const response = { reviews: [{ ...base, assessment: { ...assessment,
    currentSupport: { level: 'partial', reason: '现有文章能够回答部分方法，实际能力还需进一步核实。', evidence: excerpts },
  } }] };
  let calls = 0;
  const providerModel = (reply: unknown): GeoStructuredModel => ({
    async generateObject(input) {
      calls++;
      // Match DeepSeek's order: export JSON Schema, then parse before returning.
      const wireSchema = z.toJSONSchema(input.schema);
      assert.ok(JSON.stringify(wireSchema).includes('anyOf'));
      assert.doesNotThrow(() => zodResponseFormat(input.schema, 'question_review'));
      return input.schema.parse(reply);
    },
  });
  const result = await reviewQuestionCandidate(seed, plan, target.id, { model: providerModel(response) });
  assert.equal(calls, 1);
  assert.deepEqual(plan, original);
  const updated = result.candidates.find(candidate => candidate.id === target.id)!;
  assert.deepEqual(updated.review.assessment?.evidence, excerpts);
  assert.deepEqual(updated.review.assessment?.currentSupport, { level: 'partial', reason: response.reviews[0].assessment.currentSupport.reason });
  assert.deepEqual(updated.review.assessment?.worthPursuing, base.assessment.worthPursuing);
  assert.deepEqual(updated.review.assessment?.gaps, base.assessment.gaps);
  assert.deepEqual(result.candidates.filter(candidate => candidate.id !== target.id), original.candidates.filter(candidate => candidate.id !== target.id));

  const fabricated = structuredClone(response);
  fabricated.reviews[0].assessment.currentSupport.evidence[0].quote = '这段文字未出现在项目材料原文中，结构兼容也不能放行。';
  await assert.rejects(reviewQuestionCandidate(seed, plan, target.id, { model: providerModel(fabricated) }), /原文/);
  const tooMany = structuredClone(response);
  tooMany.reviews[0].assessment.currentSupport.evidence = Array.from({ length: 9 }, () => excerpts[0]);
  await assert.rejects(reviewQuestionCandidate(seed, plan, target.id, { model: providerModel(tooMany) }));
  const unexpected = { reviews: [{ ...response.reviews[0], assessment: { ...response.reviews[0].assessment,
    currentSupport: { ...response.reviews[0].assessment.currentSupport, confidence: 0.9 },
  } }] };
  await assert.rejects(reviewQuestionCandidate(seed, plan, target.id, { model: providerModel(unexpected) }));
  assert.equal(calls, 4);
  assert.deepEqual(plan, original);
});

test('assessment evidence cannot invent a quote or label inference as public observation', async () => {
  const plan = buildInitialQuestionPlan(seed);
  const fabricated = modelReview('problem-01');
  fabricated.assessment.evidence = [{ assetId: seed.assets[0].id, quote: '这是一段并未出现在任何项目材料中的伪造原文证据。' }];
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [fabricated] }) }), /原文/);
  const publicClaim = { ...modelReview('problem-01'), assessment: {
    ...modelReview('problem-01').assessment,
    worthPursuing: { ...modelReview('problem-01').assessment.worthPursuing, demandBasis: 'public-observation' },
  } };
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [publicClaim] }) }), /公开观测/);
  const noGaps = modelReview('problem-01');
  noGaps.assessment.gaps = [];
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [noGaps] }) }), /具体缺口/);
  for (const level of ['supported', 'partial', 'missing'] as const) {
    const base = modelReview('problem-01');
    const unsupported = { ...base, assessment: { ...base.assessment, currentSupport: { ...base.assessment.currentSupport, level } } };
    await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [unsupported] }) }), /必须附材料原文/);
  }
  const contradiction = { ...modelReview('problem-01'), decision: 'exclude' };
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [contradiction] }) }), /争取价值不一致/);
});

test('an English identity leak stays excluded even when the model recommends inclusion', async () => {
  const plan = buildInitialQuestionPlan(seed);
  const target = plan.candidates.find(candidate => candidate.id === 'problem-01')!;
  target.queryEn = 'Can SampleProject check whether an old agent plan is still authorized?';
  const result = await reviewQuestionCandidate(seed, plan, target.id, { model: fakeModel({ reviews: [modelReview(target.id)] }) });
  const updated = result.candidates.find(candidate => candidate.id === target.id)!;
  assert.equal(updated.queryEn, target.queryEn);
  assert.equal(updated.review.decision, 'exclude');
  assert.equal(updated.selected, false);
  assert.match(updated.review.reason, /项目名|身份/);
});

test('a valuable question with no material may be included or explored while its support remains unverified', async () => {
  const emptySeed = structuredClone(seed);
  emptySeed.assets = [];
  for (const decision of ['include', 'explore'] as const) {
    const plan = buildInitialQuestionPlan(emptySeed);
    const target = plan.candidates.find(candidate => candidate.id === 'problem-01')!;
    const result = await reviewQuestionCandidate(emptySeed, plan, target.id, { model: fakeModel({ reviews: [modelReview(target.id, decision)] }) });
    const updated = result.candidates.find(candidate => candidate.id === target.id)!;
    assertModelReview(updated, decision);
    assert.equal(updated.selected, target.selected);
    assert.deepEqual(updated.assetIds, []);
    assert.deepEqual(updated.evidence, []);
    assert.equal(updated.review.assessment?.currentSupport.level, 'unverified');
    assert.ok(updated.review.assessment?.gaps.length);
  }
});

test('single review input excludes prior verdicts and search records and obeys the UTF-8 budget', async () => {
  const largeSeed = structuredClone(seed);
  largeSeed.assets.forEach(asset => { asset.markdown += '\n' + '补充材料😀'.repeat(12000); });
  largeSeed.questions[0].topSources = [{ position: 1, title: 'PRIVATE_SEARCH_RESULT_SENTINEL', url: 'https://example.com/private-search', domain: 'example.com', isHomonym: false }];
  largeSeed.questions[0].evidencePath = 'PRIVATE_HIT_RECORD_SENTINEL';
  const plan = buildInitialQuestionPlan(largeSeed);
  const target = plan.candidates.find(candidate => candidate.id === 'problem-01')!;
  target.review.reason = 'PRIVATE_PREVIOUS_REVIEW_SENTINEL';
  const calls: ModelInput[] = [];
  await reviewQuestionCandidate(largeSeed, plan, target.id, { model: fakeModel({ reviews: [modelReview(target.id)] }, calls) });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages.map(message => message.role), ['system', 'user']);
  const contents = calls[0].messages.map(message => String(message.content));
  assert.ok(contents.reduce((bytes, content) => bytes + Buffer.byteLength(content, 'utf8'), 0) <= 48 * 1024);
  const input = JSON.parse(contents[1]);
  assert.deepEqual(Object.keys(input).sort(), ['candidates', 'materials', 'positioning', 'project']);
  assert.equal(input.candidates.length, 1);
  assert.equal(input.candidates[0].id, target.id);
  assert.equal(input.candidates[0].review, undefined);
  assert.equal(input.candidates[0].selected, undefined);
  assert.equal(input.existingQuestions, undefined);
  for (const marker of ['PRIVATE_SEARCH_RESULT_SENTINEL', 'PRIVATE_HIT_RECORD_SENTINEL', 'PRIVATE_PREVIOUS_REVIEW_SENTINEL']) assert.ok(!contents[1].includes(marker));
  assert.ok(input.materials.some((material: { truncated: boolean }) => material.truncated));
  for (const material of input.materials) {
    assert.equal(material.providedCharacters, material.markdown.length);
    assert.ok(!/[\uD800-\uDBFF]$/.test(material.markdown));
  }
});

test('oversized required metadata and invalid targets are rejected before model invocation', async () => {
  const largeSeed = structuredClone(seed);
  const plan = buildInitialQuestionPlan(largeSeed);
  largeSeed.assets[0].title = '必要元数据'.repeat(20000);
  const calls: ModelInput[] = [];
  const model = fakeModel({ reviews: [modelReview('problem-01')] }, calls);
  await assert.rejects(reviewQuestionCandidate(largeSeed, plan, 'problem-01', { model }), /超过输入预算/);
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'missing-candidate', { model }), /没有找到/);
  const replaced = structuredClone(plan);
  replaced.candidates.find(candidate => candidate.id === 'problem-01')!.supersededByCandidateId = 'newer-question';
  await assert.rejects(reviewQuestionCandidate(seed, replaced, 'problem-01', { model }), /新版本/);
  assert.equal(calls.length, 0);
});

test('generation uses two isolated stages with the same dual judgments and complete model review metadata', async () => {
  const initial = buildInitialQuestionPlan(seed);
  const drafts = ['problem-01', 'boundary-01'].map(id => {
    const { query, category, intent, target, assetIds, evidence, rationale, expectedResult } = initial.candidates.find(candidate => candidate.id === id)!;
    return { query, category, intent, target, assetIds, evidence, rationale, expectedResult };
  });
  const calls: ModelInput[] = [];
  const model = fakeModel((input: ModelInput) => {
    const context = JSON.parse(String(input.messages[1].content));
    if (calls.length === 1) return { candidates: drafts };
    assert.deepEqual(context.candidates.map((candidate: { id: string }) => candidate.id), ['model-1', 'model-2']);
    assert.ok(context.candidates.every((candidate: Record<string, unknown>) => candidate.review === undefined && candidate.selected === undefined));
    assert.equal(context.existingQuestions, undefined);
    return { reviews: [modelReview('model-1', 'include'), modelReview('model-2', 'explore')] };
  }, calls);
  const originalSeed = structuredClone(seed);
  const result = await generateQuestionPlan(seed, initial.positioning, { model });
  assert.equal(calls.length, 2);
  assert.deepEqual(seed, originalSeed);
  for (const call of calls) {
    const system = String(call.messages[0].content);
    assert.match(system, /是否值得争取/);
    assert.match(system, /目前能回答到哪里/);
    assert.ok(call.messages.reduce((bytes, message) => bytes + Buffer.byteLength(String(message.content), 'utf8'), 0) <= 48 * 1024);
  }
  assert.equal(result.source, 'model');
  assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'existing'), initial.candidates.filter(candidate => candidate.origin === 'existing'));
  const generated = result.candidates.filter(candidate => candidate.origin === 'model');
  assert.equal(generated.length, 2);
  assertModelReview(generated[0], 'include');
  assertModelReview(generated[1], 'explore');
  assert.equal(generated[0].selected, true);
  assert.equal(generated[1].selected, false);
});

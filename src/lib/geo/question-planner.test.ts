import { seedData } from './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { GeoSeed } from './types';
import type { GeoStructuredModel } from './connection-settings';
import type { QuestionCandidate, QuestionDecision, QuestionGenerationCheckpoint, QuestionGenerationProgress } from './question-types';
import { buildInitialQuestionPlan, generateQuestionPlan, reviewQuestionCandidate, validateQuestionPlan } from './question-planner';
import { createProjectOnboarding, completeProjectOnboarding, reviseProjectOnboarding } from './project-onboarding-store';

// The seed contains legacy proposal fields unrelated to question planning.
const seed = seedData as unknown as GeoSeed;
type ModelInput = Parameters<GeoStructuredModel['generateObject']>[0];

function modelReview(id: string, decision: QuestionDecision = 'include') {
  return {
    id, decision, priority: 'medium' as const, reason: '依据原始需求与当前方向分别判断争取价值和承接缺口。', concerns: [],
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
      const context = JSON.parse(String(input.messages[1].content));
      // Existing batch tests count proposal/review calls. Set-level behavior has
      // dedicated tests below; this default keeps those fixtures focused.
      if (context.maxSelected) return completeSetReply(context);
      calls.push(input);
      return typeof reply === 'function' ? reply(input) : reply;
    },
  };
}

function completeSetReply(context: { needs: { id: string }[]; candidates: { id: string; review: { decision: string; priority?: string; status?: string } }[] }) {
  const priorities: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const selectedIds = context.candidates.filter(candidate => candidate.review.decision === 'include' && candidate.review.status === 'reviewed').sort((a, b) =>
    Number(b.id.startsWith('model-')) - Number(a.id.startsWith('model-')) || priorities[a.review.priority ?? 'medium'] - priorities[b.review.priority ?? 'medium']).slice(0, 8).map(candidate => candidate.id);
  return { selectedIds, coverage: context.needs.map(need => ({ needId: need.id, candidateIds: selectedIds.slice(0, 1),
    status: selectedIds.length ? 'covered' : 'deferred', reason: selectedIds.length ? '合成候选能够覆盖当前需求。' : '现有候选不足，当前明确保留暂缓。',
  })), duplicates: [], missingAdditionalNeeds: [], reason: '根据合成需求覆盖选择问题，不代表真实项目评估。' };
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
  assert.equal(calls, 5); // The fabricated quote receives exactly one bounded repair attempt.
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

test('generation uses direction planning and isolated batches with the same dual judgments and complete model review metadata', async () => {
  const initial = buildInitialQuestionPlan(seed);
  const drafts = ['problem-01', 'boundary-01'].map(id => {
    const { query, category, intent, target, assetIds, evidence, rationale, expectedResult } = initial.candidates.find(candidate => candidate.id === id)!;
    return { query, category, intent, target, assetIds, evidence, rationale, expectedResult };
  });
  const calls: ModelInput[] = [];
  const model = fakeModel((input: ModelInput) => {
    if (calls.length === 1) return planningDirections();
    const context = JSON.parse(String(input.messages[1].content));
    if (calls.length === 2) return { candidates: drafts };
    assert.deepEqual(context.candidates.map((candidate: { id: string }) => candidate.id), ['model-1', 'model-2']);
    assert.ok(context.candidates.every((candidate: Record<string, unknown>) => candidate.review === undefined && candidate.selected === undefined));
    assert.equal(context.existingQuestions, undefined);
    return { reviews: [modelReview('model-1', 'include'), modelReview('model-2', 'explore')] };
  }, calls);
  const originalSeed = structuredClone(seed);
  const result = await generateQuestionPlan(seed, initial.positioning, { model });
  assert.equal(calls.length, 3);
  assert.deepEqual(seed, originalSeed);
  for (const call of calls) {
    const system = String(call.messages[0].content);
    assert.match(system, /是否值得争取/);
    assert.match(system, /目前能回答到哪里/);
    assert.ok(call.messages.reduce((bytes, message) => bytes + Buffer.byteLength(String(message.content), 'utf8'), 0) <= 48 * 1024);
  }
  assert.equal(result.source, 'model');
  assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'existing').map(({ selected: _selected, ...candidate }) => candidate),
    initial.candidates.filter(candidate => candidate.origin === 'existing').map(({ selected: _selected, ...candidate }) => candidate));
  assert.ok(result.candidates.filter(candidate => candidate.selected).length <= 8);
  const generated = result.candidates.filter(candidate => candidate.origin === 'model');
  assert.equal(generated.length, 2);
  assertModelReview(generated[0], 'include');
  assertModelReview(generated[1], 'explore');
  assert.equal(generated[0].selected, true);
  assert.equal(generated[1].selected, false);
});

test('topic generation and its independent review use the saved correction, never an unfinished revision', async () => {
  const created = createProjectOnboarding({ kind: 'repository', url: 'https://github.com/synthetic/corrected-topics', notes: 'Focus on useful demand.', requestId: 'topic-correction-test' });
  const initialUnderstanding = { summary: 'A tool for content analysis.', audience: 'Content teams.', capabilities: ['Analyze content.'], unknowns: [] };
  completeProjectOnboarding(created.project.id, initialUnderstanding);
  const feedback = '主要面向独立开发者，关注整个项目的优化。';
  reviseProjectOnboarding(created.project.id, feedback, 'topic-correction-1');
  const correctedSeed = structuredClone(seed);
  correctedSeed.project.id = created.project.id;
  const initial = buildInitialQuestionPlan(correctedSeed);
  const { query, category, intent, target, assetIds, evidence, rationale, expectedResult } = initial.candidates.find(candidate => candidate.id === 'problem-01')!;
  const calls: ModelInput[] = [];
  const model = fakeModel((input: ModelInput) => {
    if (calls.length === 1) return planningDirections();
    const context = JSON.parse(String(input.messages[1].content));
    assert.equal(context.projectUnderstanding.audience, '独立开发者');
    assert.deepEqual(context.projectUnderstanding.userCorrections, [{ id: 'topic-correction-1', feedback }]);
    assert.equal(context.projectUnderstanding.userInputIsPublicEvidence, false);
    assert.ok(!JSON.stringify(context.materials).includes(feedback));
    return calls.length === 2 ? { candidates: [{ query, category, intent, target, assetIds, evidence, rationale, expectedResult }] }
      : { reviews: [modelReview('model-1')] };
  }, calls);
  await assert.rejects(generateQuestionPlan(correctedSeed, initial.positioning, { model }), /先完成项目理解/);
  assert.equal(calls.length, 0);
  completeProjectOnboarding(created.project.id, { ...initialUnderstanding, audience: '独立开发者' });
  await generateQuestionPlan(correctedSeed, initial.positioning, { model });
  assert.equal(calls.length, 3);
});

function planningDirections(count = 1) {
  return { needs: Array.from({ length: count }, (_, index) => ({ id: `need-${index + 1}`, title: `恢复任务需求 ${index + 1}`,
    audience: '使用编程助手的开发者', trigger: '任务暂停之后需要恢复执行并核对目标和权限', importance: 'medium', assetIds: [],
  })), selectionAdvantages: [], directions: Array.from({ length: count }, (_, index) => ({
    title: `恢复任务方向 ${index + 1}`, audience: '使用编程助手的开发者', trigger: '任务暂停之后需要恢复执行并核对目标和权限', assetIds: [],
    needIds: [`need-${index + 1}`],
  })) };
}

function planningDraft() {
  const { query, category, intent, target, assetIds, evidence, rationale, expectedResult } = buildInitialQuestionPlan(seed).candidates.find(candidate => candidate.id === 'problem-01')!;
  return { query, category, intent, target, assetIds, evidence, rationale, expectedResult };
}

function correctedQuotes(input: ModelInput, quote: string | null) {
  const context = JSON.parse(String(input.messages[1].content));
  return { corrections: context.failures.map((failure: { candidateId: string; evidenceIndex: number; assetId: string }) => ({
    candidateId: failure.candidateId, evidenceIndex: failure.evidenceIndex, assetId: failure.assetId, quote,
  })) };
}

test('generation repairs only invalid quote slots and still receives independent review', async () => {
  const valid = planningDraft();
  const invalid = structuredClone(valid);
  invalid.evidence[0].quote = '这是一段对材料的概括，并不是可以逐字匹配的原文摘录。';
  const calls: ModelInput[] = [];
  const progress: string[] = [];
  const model = fakeModel((input: ModelInput) => {
    if (calls.length === 1) return planningDirections();
    const context = JSON.parse(String(input.messages[1].content));
    if (calls.length === 2) return { candidates: [invalid] };
    if (calls.length === 3) {
      assert.equal(context.failures[0].candidateId, 'model-1');
      assert.equal(context.failures[0].quote, invalid.evidence[0].quote);
      assert.equal(context.failures[0].assetId, valid.evidence[0].assetId);
      assert.match(String(input.messages[0].content), /不删除证据/);
      return correctedQuotes(input, valid.evidence[0].quote);
    }
    assert.equal(context.failures, undefined);
    assert.equal(context.existingQuestions, undefined);
    assert.deepEqual(context.candidates[0].evidence, valid.evidence);
    assert.equal(context.candidates[0].review, undefined);
    assert.equal(context.candidates[0].query, valid.query);
    return { reviews: [modelReview('model-1')] };
  }, calls);
  const result = await generateQuestionPlan(seed, seed.project.description, { model, onProgress: event => progress.push(event.stage) });
  assert.equal(calls.length, 4);
  const candidate = result.candidates.find(item => item.id === 'model-1')!;
  assert.deepEqual(candidate.evidence, valid.evidence);
  assert.equal(candidate.query, valid.query);
  assertModelReview(candidate, 'include');
  assert.deepEqual(progress, ['planning', 'planning', 'generating', 'checking', 'repairing', 'checking', 'checking', 'reviewing', 'checking', 'checking', 'reviewing', 'checking']);
});

test('generation and independent review each allow one exact quote repair without rewriting judgments', async () => {
  const draft = planningDraft();
  const invalidDraft = structuredClone(draft);
  invalidDraft.evidence[0].quote = '虚构的生成依据不能绕过原文检查，必须先修正再审核。';
  const review = modelReview('model-1', 'explore');
  review.assessment.evidence = [{ assetId: draft.evidence[0].assetId, quote: '复评阶段的概括也必须用一段连续的真实原文替换。' }];
  const calls: ModelInput[] = [];
  const model = fakeModel((input: ModelInput) => {
    if (calls.length === 1) return planningDirections();
    if (calls.length === 2) return { candidates: [invalidDraft] };
    if (calls.length === 4) return { reviews: [review] };
    return correctedQuotes(input, draft.evidence[0].quote);
  }, calls);
  const result = await generateQuestionPlan(seed, seed.project.description, { model });
  assert.equal(calls.length, 5);
  const candidate = result.candidates.find(item => item.id === 'model-1')!;
  assert.deepEqual(candidate.evidence, draft.evidence);
  assert.deepEqual(candidate.review.assessment?.evidence, [draft.evidence[0]]);
  assert.deepEqual(candidate.review.assessment?.worthPursuing, review.assessment.worthPursuing);
  assert.deepEqual(candidate.review.assessment?.currentSupport, review.assessment.currentSupport);
  assert.deepEqual(candidate.review.assessment?.gaps, review.assessment.gaps);
  assertModelReview(candidate, 'explore');
});

test('single review repairs its invalid excerpt while leaving every other field and question unchanged', async () => {
  const plan = buildInitialQuestionPlan(seed);
  const original = structuredClone(plan);
  const candidate = plan.candidates.find(item => item.id === 'problem-01')!;
  const review = modelReview(candidate.id);
  review.assessment.evidence = [{ assetId: candidate.evidence[0].assetId, quote: '这段用于复评的摘录不是原文，需要一次有界的修正。' }];
  const calls: ModelInput[] = [];
  const model = fakeModel((input: ModelInput) => calls.length === 1 ? { reviews: [review] } : correctedQuotes(input, candidate.evidence[0].quote), calls);
  const result = await reviewQuestionCandidate(seed, plan, candidate.id, { model });
  assert.equal(calls.length, 2);
  assert.deepEqual(plan, original);
  assert.deepEqual(result.candidates.filter(item => item.id !== candidate.id), original.candidates.filter(item => item.id !== candidate.id));
  const updated = result.candidates.find(item => item.id === candidate.id)!;
  assert.deepEqual(updated.review.assessment?.evidence, [candidate.evidence[0]]);
  assert.deepEqual({ ...updated, review: candidate.review }, candidate);
});

test('unrepaired quotes, deleted slots and mismatched corrections fail after one attempt before independent review', async () => {
  const draft = planningDraft();
  draft.evidence[0].quote = '这段被编造的原文不属于任何项目材料，不能保留。';
  const responses = [
    (input: ModelInput) => correctedQuotes(input, '再次编造的原文仍然不允许保存，也不会继续重试。'),
    (input: ModelInput) => correctedQuotes(input, null),
    () => ({ corrections: [] }),
    (input: ModelInput) => ({ corrections: correctedQuotes(input, planningDraft().evidence[0].quote).corrections.map((item: object) => ({ ...item, candidateId: 'wrong-question' })) }),
    (input: ModelInput) => ({ corrections: correctedQuotes(input, planningDraft().evidence[0].quote).corrections.map((item: object) => ({ ...item, assetId: 'another-asset' })) }),
  ];
  for (const response of responses) {
    const calls: ModelInput[] = [];
    await assert.rejects(generateQuestionPlan(seed, seed.project.description, {
      model: fakeModel((input: ModelInput) => calls.length === 1 ? planningDirections() : calls.length === 2 ? { candidates: [draft] } : response(input), calls),
    }), /原文|摘录/);
    assert.equal(calls.length, 3);
  }
});

test('repair remains within the original excerpt and UTF-8 budget and cannot cite unseen text', async () => {
  const largeSeed = structuredClone(seed);
  const unseen = 'UNSEEN_SOURCE_SENTINEL is real source text beyond the supplied excerpt.';
  largeSeed.assets.forEach(asset => { asset.markdown = '给定的公开说明😀'.repeat(18000) + unseen; });
  const draft = planningDraft();
  draft.evidence[0].quote = '这段摘要由模型自行写成，没有出现在材料正文和摘要中。';
  const calls: ModelInput[] = [];
  const original = structuredClone(largeSeed);
  const model = fakeModel((input: ModelInput) => {
    if (calls.length === 1) return planningDirections();
    assert.ok(input.messages.reduce((bytes, message) => bytes + Buffer.byteLength(String(message.content), 'utf8'), 0) <= 48 * 1024);
    const context = JSON.parse(String(input.messages[1].content));
    assert.ok(!JSON.stringify(context).includes(unseen));
    if (calls.length === 2) return { candidates: [draft] };
    const firstContext = JSON.parse(String(calls[1].messages[1].content));
    for (const material of context.materials) {
      const originalMaterial = firstContext.materials.find((item: { id: string }) => item.id === material.id);
      assert.ok(originalMaterial.markdown.startsWith(material.markdown));
      assert.equal(material.summary, originalMaterial.summary);
      assert.ok(!/[\uD800-\uDBFF]$/.test(material.markdown));
    }
    return correctedQuotes(input, unseen);
  }, calls);
  await assert.rejects(generateQuestionPlan(largeSeed, largeSeed.project.description, { model }), /仍不是.*原文/);
  assert.equal(calls.length, 3);
  assert.deepEqual(largeSeed, original);
});

test('strict validation still rejects whitespace and punctuation edits without model repair', () => {
  const plan = buildInitialQuestionPlan(seed);
  const candidate = plan.candidates.find(item => item.id === 'problem-01')!;
  candidate.evidence[0].quote = candidate.evidence[0].quote.split('').join(' ');
  assert.throws(() => validateQuestionPlan(plan, seed), /摘录必须/);
});

function directionOffset(input: { direction: { title: string } }) {
  return (Number(input.direction.title.match(/(\d+)$/)![1]) - 1) * 4;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function until(condition: () => boolean) {
  for (let index = 0; index < 30; index++) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Synthetic planning did not reach the expected stage');
}

test('fresh recommendations rank AI priority before position, cap at eight, and leave confirmed input unchanged', async () => {
  const original = structuredClone(seed);
  const initial = buildInitialQuestionPlan(seed);
  const drafts = Array.from({ length: 10 }, (_, index) => ({ ...planningDraft(), query: `第${index + 1}种任务恢复时如何检查目标和权限？` }));
  const calls: ModelInput[] = [];
  const result = await generateQuestionPlan(seed, seed.project.description, {
    model: fakeModel((input: ModelInput) => {
      if (calls.length === 1) return planningDirections(3);
      const context = JSON.parse(String(input.messages[1].content));
      if (context.direction) return { candidates: drafts.slice(directionOffset(context), directionOffset(context) + 4) };
      return { reviews: context.candidates.map((item: { id: string }) => ({ ...modelReview(item.id),
        priority: Number(item.id.slice(6)) >= 8 ? 'high' : 'low', reason: '先搜原始需求更明确的高优先级题；其他题仍保留供后续比较。',
      })) };
    }, calls),
  });
  assert.deepEqual(seed, original);
  assert.deepEqual(result.candidates.filter(item => item.origin === 'existing').map(({ selected: _selected, ...candidate }) => candidate),
    initial.candidates.filter(item => item.origin === 'existing').map(({ selected: _selected, ...candidate }) => candidate));
  assert.equal(result.candidates.filter(item => item.selected).length, 8);
  assert.deepEqual(result.candidates.filter(item => item.origin === 'model' && item.selected).map(item => item.id),
    ['model-1', 'model-2', 'model-3', 'model-4', 'model-5', 'model-8', 'model-9', 'model-10']);
  assert.equal(result.candidates.filter(item => item.origin === 'existing' && item.selected).length, 0);
});

test('fresh model reviews require priority while legacy saved reviews remain optional', async () => {
  const plan = buildInitialQuestionPlan(seed);
  assert.ok(plan.candidates.every(candidate => candidate.review.priority === undefined));
  const { priority: _priority, ...legacy } = modelReview('problem-01');
  await assert.rejects(reviewQuestionCandidate(seed, plan, 'problem-01', { model: fakeModel({ reviews: [legacy] }) }), /priority/);
  assert.deepEqual(validateQuestionPlan(plan, seed), plan);
});

test('three draft and review requests overlap, settle out of order, and retain stable IDs and isolated bounded inputs', async () => {
  const calls: ModelInput[] = [];
  const checkpoints: NonNullable<QuestionGenerationProgress['checkpoint']>[] = [];
  const draftGates = Array.from({ length: 3 }, () => deferred<unknown>());
  const reviewGates = Array.from({ length: 3 }, () => deferred<unknown>());
  const reviewInputs: Array<{ id: string }[]> = [];
  const drafts = Array.from({ length: 10 }, (_, index) => ({ ...planningDraft(), query: `并行问题 ${index + 1} 如何恢复任务并核对权限？`, rationale: 'GENERATION_REASONING_SENTINEL 不能进入独立审核。' }));
  let active = 0;
  let peak = 0;
  const resultPromise = generateQuestionPlan(seed, seed.project.description, {
    onProgress(event) { if (event.checkpoint) checkpoints.push(structuredClone(event.checkpoint)); },
    model: fakeModel(async (input: ModelInput) => {
      const context = JSON.parse(String(input.messages[1].content));
      assert.deepEqual(input.messages.map(message => message.role), ['system', 'user']);
      assert.ok(input.messages.reduce((bytes, message) => bytes + Buffer.byteLength(String(message.content), 'utf8'), 0) <= 48 * 1024);
      if (calls.length === 1) return planningDirections(3);
      active++; peak = Math.max(peak, active);
      try {
        if (context.direction) {
          assert.equal(context.previousQuestions, undefined);
          assert.deepEqual(context.allDirections, planningDirections(3).directions);
          return await draftGates[directionOffset(context) / 4].promise;
        }
        assert.equal(checkpoints.filter(checkpoint => checkpoint.key.startsWith('draft-')).length, 3);
        assert.equal(context.direction, undefined);
        assert.equal(context.allDirections, undefined);
        assert.ok(!JSON.stringify(context).includes('GENERATION_REASONING_SENTINEL'));
        assert.ok(!JSON.stringify(context).includes('PRIOR_REVIEW_SENTINEL'));
        assert.ok(context.candidates.every((candidate: Record<string, unknown>) => candidate.review === undefined && candidate.selected === undefined));
        const index = (Number(context.candidates[0].id.slice(6)) - 1) / 4;
        reviewInputs[index] = context.candidates;
        return await reviewGates[index].promise;
      } finally { active--; }
    }, calls),
  });
  await until(() => calls.length === 4);
  assert.equal(active, 3);
  assert.deepEqual(checkpoints.map(checkpoint => checkpoint.key), ['directions']);
  for (const index of [2, 0, 1]) {
    draftGates[index].resolve({ candidates: drafts.slice(index * 4, index * 4 + 4) });
    await until(() => checkpoints.some(checkpoint => checkpoint.key === `draft-${index + 1}`));
  }
  await until(() => calls.length === 7);
  assert.equal(active, 3);
  for (const index of [2, 0, 1]) {
    reviewGates[index].resolve({ reviews: reviewInputs[index].map(candidate => ({ ...modelReview(candidate.id), reason: 'PRIOR_REVIEW_SENTINEL 根据当前材料独立判断。' })) });
    await until(() => checkpoints.some(checkpoint => checkpoint.key === `review-${index + 1}`));
  }
  const result = await resultPromise;
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(checkpoints.map(checkpoint => checkpoint.key), ['directions', 'draft-3', 'draft-1', 'draft-2', 'review-3', 'review-1', 'review-2', 'set-review-0']);
  assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'model').map(candidate => [candidate.id, candidate.query]),
    drafts.map((draft, index) => [`model-${index + 1}`, draft.query]));
  for (const checkpoint of checkpoints.slice(1).filter(item => !item.key.startsWith('set-review'))) {
    for (const candidate of (checkpoint.payload as { candidates: QuestionCandidate[] }).candidates) {
      assert.deepEqual(candidate.evidence, planningDraft().evidence);
      if (checkpoint.key.startsWith('review-')) assertModelReview(candidate, 'include');
      else assert.equal(candidate.review.status, 'pending');
    }
  }
});

test('configured concurrency below three bounds active requests without changing deterministic results', async () => {
  const agentFiles = require('./agent-files');
  const originalRead = agentFiles.readAgentParameters;
  agentFiles.readAgentParameters = (name: string, schema: z.ZodType) => {
    const parameters = originalRead(name, schema);
    return name === 'question-planning' ? { ...parameters, maxConcurrency: 2 } : parameters;
  };
  let active = 0;
  let peak = 0;
  const calls: ModelInput[] = [];
  try {
    const result = await generateQuestionPlan(seed, seed.project.description, {
      model: fakeModel(async (input: ModelInput) => {
        const context = JSON.parse(String(input.messages[1].content));
        if (calls.length === 1) return planningDirections(3);
        active++; peak = Math.max(peak, active);
        await new Promise<void>(resolve => setImmediate(resolve));
        active--;
        if (context.direction) return { candidates: [{ ...planningDraft(), query: `方向 ${directionOffset(context)} 如何检查恢复任务的权限？` }] };
        return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
      }, calls),
    });
    assert.equal(peak, 2);
    assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'model').map(candidate => candidate.id), ['model-1', 'model-5', 'model-9']);
  } finally { agentFiles.readAgentParameters = originalRead; }
});

test('a failed parallel batch waits for every sibling and preserves successful checkpoints without returning a partial plan', async () => {
  for (const failureStage of ['draft', 'review'] as const) {
    const original = structuredClone(seed);
    const calls: ModelInput[] = [];
    const checkpoints: string[] = [];
    const gates = Array.from({ length: 3 }, () => deferred<unknown>());
    let requests = 0;
    let finished = false;
    const running = generateQuestionPlan(seed, seed.project.description, {
      onProgress(event) { if (event.checkpoint) checkpoints.push(event.checkpoint.key); },
      model: fakeModel((input: ModelInput) => {
        const context = JSON.parse(String(input.messages[1].content));
        if (calls.length === 1) return planningDirections(3);
        if (context.direction && failureStage === 'review') return { candidates: Array.from({ length: 4 }, (_, index) => ({ ...planningDraft(), query: `失败保留问题 ${directionOffset(context) + index + 1} 如何检查恢复权限？` })) };
        const index = context.direction ? directionOffset(context) / 4 : (Number(context.candidates[0].id.slice(6)) - 1) / 4;
        requests++;
        return gates[index].promise;
      }, calls),
    });
    const outcome = running.then(() => { finished = true; assert.fail('Failed run returned a partial plan'); }, error => { finished = true; assert.match(error.message, /synthetic failure/); });
    await until(() => requests === 3);
    gates[0].reject(new Error('synthetic failure'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    for (const index of [2, 1]) {
      gates[index].resolve(failureStage === 'draft' ? { candidates: [{ ...planningDraft(), query: `成功方向 ${index} 如何核对权限？` }] }
        : { reviews: Array.from({ length: 4 }, (_, offset) => modelReview(`model-${index * 4 + offset + 1}`)) });
      await until(() => checkpoints.includes(`${failureStage}-${index + 1}`));
    }
    await outcome;
    assert.equal(finished, true);
    const completedCheckpoints = [...checkpoints];
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(checkpoints, completedCheckpoints);
    assert.deepEqual(seed, original);
    assert.ok(!checkpoints.includes(`${failureStage}-1`));
  }
});

test('cross-batch duplicate questions merge deterministically while raw checkpoints retain every candidate', async () => {
  const checkpoints: QuestionGenerationCheckpoint[] = [];
  const calls: ModelInput[] = [];
  const result = await generateQuestionPlan(seed, seed.project.description, {
    onProgress(event) { if (event.checkpoint) checkpoints.push({ ...structuredClone(event.checkpoint), completedAt: new Date().toISOString() }); },
    model: fakeModel((input: ModelInput) => {
      if (calls.length === 1) return planningDirections(3);
      const context = JSON.parse(String(input.messages[1].content));
      if (context.direction) return { candidates: [{ ...planningDraft(), query: directionOffset(context) === 8 ? seed.questions[0].query : planningDraft().query }] };
      assert.deepEqual(context.candidates.map((candidate: { id: string }) => candidate.id), ['model-1']);
      return { reviews: [modelReview('model-1')] };
    }, calls),
  });
  assert.equal(result.candidates.filter(candidate => candidate.origin === 'model').length, 1);
  assert.equal(checkpoints.filter(checkpoint => checkpoint.key.startsWith('draft-')).length, 3);
  assert.deepEqual(checkpoints.filter(checkpoint => checkpoint.key.startsWith('draft-')).map(checkpoint => (checkpoint.payload as { candidates: QuestionCandidate[] }).candidates[0].id), ['model-1', 'model-5', 'model-9']);
  const resumed = await generateQuestionPlan(seed, seed.project.description, { resume: checkpoints.reverse(), model: fakeModel(() => { throw new Error('Complete resume requested model'); }) });
  assert.deepEqual(resumed.candidates, result.candidates);
});

test('uncovered review IDs fail without publishing a successful review checkpoint', async () => {
  const calls: ModelInput[] = [];
  const checkpoints: string[] = [];
  await assert.rejects(generateQuestionPlan(seed, seed.project.description, {
    onProgress(event) { if (event.checkpoint) checkpoints.push(event.checkpoint.key); },
    model: fakeModel((input: ModelInput) => {
      const context = JSON.parse(String(input.messages[1].content));
      if (calls.length === 1) return planningDirections(2);
      if (context.direction) return { candidates: [{ ...planningDraft(), query: `${directionOffset(context)} 如何检查恢复任务的权限？` }] };
      return { reviews: context.candidates.map(() => modelReview('model-1')) };
    }, calls),
  }), /逐项覆盖/);
  assert.deepEqual(checkpoints, ['directions', 'draft-1', 'draft-2']);
});

test('empty directions or empty candidate batches preserve history without inventing questions or invoking review', async () => {
  for (const directionCount of [0, 1]) {
    const calls: ModelInput[] = [];
    const result = await generateQuestionPlan(seed, seed.project.description, {
      model: fakeModel(() => calls.length === 1 ? planningDirections(directionCount) : { candidates: [] }, calls),
    });
    assert.equal(calls.length, directionCount + 1);
    assert.equal(result.candidates.length, seed.questions.length);
    assert.deepEqual(result.candidates.map(candidate => candidate.query), seed.questions.map(question => question.query));
    assert.ok(result.candidates.filter(candidate => candidate.selected).length <= 8);
  }
});

test('direction and batch limits reject oversized or unknown source output without silently dropping entries', async () => {
  for (const firstReply of [planningDirections(4), { directions: [{ ...planningDirections().directions[0], assetIds: ['missing-asset'] }] }]) {
    const calls: ModelInput[] = [];
    await assert.rejects(generateQuestionPlan(seed, seed.project.description, { model: fakeModel(firstReply, calls) }));
    assert.equal(calls.length, 1);
  }
  const calls: ModelInput[] = [];
  await assert.rejects(generateQuestionPlan(seed, seed.project.description, {
    model: fakeModel(() => calls.length === 1 ? planningDirections() : { candidates: Array.from({ length: 5 }, (_, index) => ({ ...planningDraft(), query: `超限问题 ${index + 1} 如何核实权限？` })) }, calls),
  }));
  assert.equal(calls.length, 2);
});

test('subscription activity follows each current stage including repair without replaying checkpoints', async () => {
  const auth = require('./chatgpt-auth');
  const adapter = require('./chatgpt-model');
  const originalStatus = auth.getChatGPTStatus;
  const OriginalModel = adapter.default;
  const progress: QuestionGenerationProgress[] = [];
  const valid = planningDraft();
  const invalid = structuredClone(valid);
  invalid.evidence[0].quote = '这是一段生成的概括，并不是对应材料的一段逐字原文。';
  let requestNumber = 0;
  auth.getChatGPTStatus = () => ({ enabled: true });
  adapter.default = class {
    constructor(private options: { timeoutMs: number; onActivity: (request: NonNullable<QuestionGenerationProgress['request']>) => void }) {
      assert.equal(options.timeoutMs, 1200000);
    }
    async generateObject(input: ModelInput) {
      requestNumber++;
      this.options.onActivity({ phase: 'connecting', elapsedMs: 0, eventCount: 0, outputCharacters: 0 });
      const context = JSON.parse(String(input.messages[1].content));
      const reply = requestNumber === 1 ? planningDirections() : context.maxSelected ? completeSetReply(context) : context.direction ? { candidates: [invalid] }
        : context.failures ? correctedQuotes(input, valid.evidence[0].quote) : { reviews: [modelReview('model-1')] };
      this.options.onActivity({ phase: 'completed', elapsedMs: 10, eventCount: 2, outputCharacters: JSON.stringify(reply).length });
      return reply;
    }
  };
  try {
    await generateQuestionPlan(seed, seed.project.description, { onProgress(event) { progress.push(structuredClone(event)); } });
  } finally {
    auth.getChatGPTStatus = originalStatus;
    adapter.default = OriginalModel;
  }
  assert.equal(requestNumber, 5);
  assert.deepEqual(progress.filter(event => event.request?.phase === 'connecting').map(event => event.stage), ['planning', 'generating', 'repairing', 'reviewing', 'reviewing']);
  assert.deepEqual(progress.filter(event => event.request?.phase === 'connecting').map(event => event.workflowStep), ['planning', 'generating', 'generating', 'reviewing', 'reviewing']);
  assert.deepEqual(progress.filter(event => event.checkpoint).map(event => event.workflowStep), ['planning', 'generating', 'reviewing', 'reviewing']);
  assert.ok(progress.filter(event => event.request).every(event => event.checkpoint === undefined));
  assert.deepEqual(progress.filter(event => event.checkpoint).map(event => event.checkpoint!.key), ['directions', 'draft-1', 'review-1', 'set-review-0']);
});

test('concurrent subscription activity stays attached to its own batch after a sibling checkpoint', async () => {
  const auth = require('./chatgpt-auth');
  const adapter = require('./chatgpt-model');
  const originalStatus = auth.getChatGPTStatus;
  const OriginalModel = adapter.default;
  const progress: QuestionGenerationProgress[] = [];
  const requests = new Map<string, { gate: ReturnType<typeof deferred<unknown>>; activity: () => void; context: { candidates?: { id: string }[] } }>();
  auth.getChatGPTStatus = () => ({ enabled: true });
  adapter.default = class {
    constructor(private options: { onActivity: (request: NonNullable<QuestionGenerationProgress['request']>) => void }) {}
    async generateObject(input: ModelInput) {
      const context = JSON.parse(String(input.messages[1].content));
      if (context.maxSelected) return completeSetReply(context);
      if (!context.direction && !context.candidates) return planningDirections(2);
      const key = context.direction ? `draft-${directionOffset(context) / 4 + 1}` : `review-${(Number(context.candidates[0].id.slice(6)) - 1) / 4 + 1}`;
      const gate = deferred<unknown>();
      const activity = () => this.options.onActivity({ phase: 'receiving', elapsedMs: 10, eventCount: 1, outputCharacters: 1, requestId: key });
      requests.set(key, { gate, activity, context });
      activity();
      return gate.promise;
    }
  };
  try {
    const resultPromise = generateQuestionPlan(seed, seed.project.description, { onProgress(event) { progress.push(structuredClone(event)); } });
    await until(() => requests.size === 2);
    requests.get('draft-1')!.gate.resolve({ candidates: Array.from({ length: 4 }, (_, index) => ({ ...planningDraft(), query: `活动阶段 ${index + 1} 如何核对任务权限？` })) });
    await until(() => progress.some(event => event.checkpoint?.key === 'draft-1'));
    requests.get('draft-2')!.activity();
    const draftActivity = progress.at(-1)!;
    assert.equal(draftActivity.stage, 'generating');
    assert.equal(draftActivity.workflowStep, 'generating');
    assert.match(draftActivity.message, /第 2\/2 个方向/);
    assert.equal(draftActivity.checkpoint, undefined);
    requests.get('draft-2')!.gate.resolve({ candidates: Array.from({ length: 4 }, (_, index) => ({ ...planningDraft(), query: `活动阶段 ${index + 5} 如何核对任务权限？` })) });
    await until(() => requests.size === 4);
    const first = requests.get('review-1')!;
    first.gate.resolve({ reviews: first.context.candidates!.map(candidate => modelReview(candidate.id)) });
    await until(() => progress.some(event => event.checkpoint?.key === 'review-1'));
    requests.get('review-2')!.activity();
    const reviewActivity = progress.at(-1)!;
    assert.equal(reviewActivity.stage, 'reviewing');
    assert.equal(reviewActivity.workflowStep, 'reviewing');
    assert.match(reviewActivity.message, /第 2\/2 批/);
    assert.equal(reviewActivity.checkpoint, undefined);
    const second = requests.get('review-2')!;
    second.gate.resolve({ reviews: second.context.candidates!.map(candidate => modelReview(candidate.id)) });
    await resultPromise;
  } finally {
    auth.getChatGPTStatus = originalStatus;
    adapter.default = OriginalModel;
  }
});

async function savedReviewFailure() {
  const checkpoints: QuestionGenerationCheckpoint[] = [];
  const calls: ModelInput[] = [];
  const drafts = Array.from({ length: 11 }, (_, index) => ({ ...planningDraft(), query: `续跑问题 ${index + 1} 如何恢复任务并核对权限？`, rationale: 'RESUME_GENERATION_REASONING 不可进入审核输入。' }));
  await assert.rejects(generateQuestionPlan(seed, seed.project.description, {
    onProgress(event) { if (event.checkpoint) checkpoints.push({ ...structuredClone(event.checkpoint), completedAt: new Date().toISOString() }); },
    model: fakeModel((input: ModelInput) => {
      const context = JSON.parse(String(input.messages[1].content));
      if (calls.length === 1) return planningDirections(3);
      if (context.direction) return { candidates: drafts.slice(directionOffset(context), directionOffset(context) + 4) };
      if (context.candidates[0].id === 'model-5') throw new Error('Synthetic second review connection failure');
      return { reviews: context.candidates.map((candidate: { id: string }) => ({ ...modelReview(candidate.id), reason: 'RESUME_PRIOR_REVIEW 已有审核必须原样保留，不进入后续审核输入。' })) };
    }, calls),
  }), /Synthetic second review connection failure/);
  assert.equal(calls.length, 7);
  assert.deepEqual(checkpoints.map(checkpoint => checkpoint.key), ['directions', 'draft-1', 'draft-2', 'draft-3', 'review-1', 'review-3']);
  return { checkpoints, drafts };
}

test('server resume accepts unordered checkpoints and requests only missing reviews while retaining old optional priorities', async () => {
  for (const legacy of [false, true]) {
    const { checkpoints, drafts } = await savedReviewFailure();
    if (legacy) {
      checkpoints[0].payload = { directions: (checkpoints[0].payload as { directions: unknown[] }).directions };
      for (const checkpoint of checkpoints.filter(item => item.key.startsWith('review-'))) {
        for (const candidate of (checkpoint.payload as { candidates: QuestionCandidate[] }).candidates) delete candidate.review.priority;
      }
    }
    const original = structuredClone(checkpoints);
    const replayed: QuestionGenerationCheckpoint[] = [];
    const calls: ModelInput[] = [];
    const result = await generateQuestionPlan(seed, seed.project.description, {
      resume: [...checkpoints].reverse(),
      onProgress(event) { if (event.checkpoint) replayed.push({ ...structuredClone(event.checkpoint), completedAt: new Date().toISOString() }); },
      model: fakeModel((input: ModelInput) => {
        const context = JSON.parse(String(input.messages[1].content));
        assert.deepEqual(input.messages.map(message => message.role), ['system', 'user']);
        assert.equal(context.direction, undefined);
        assert.equal(context.previousQuestions, undefined);
        assert.equal(context.existingQuestions, undefined);
        assert.ok(!JSON.stringify(context).includes('RESUME_PRIOR_REVIEW'));
        assert.ok(!JSON.stringify(context).includes('RESUME_GENERATION_REASONING'));
        assert.deepEqual(context.candidates.map((candidate: { id: string }) => candidate.id), ['model-5', 'model-6', 'model-7', 'model-8']);
        return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
      }, calls),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(checkpoints, original);
    assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'model').map(candidate => candidate.query), drafts.map(draft => draft.query));
    for (const checkpoint of original.filter(item => item.key.startsWith('review-'))) {
      for (const candidate of (checkpoint.payload as { candidates: QuestionCandidate[] }).candidates) {
        assert.deepEqual(result.candidates.find(item => item.id === candidate.id)?.review, candidate.review);
      }
    }
    assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'existing').map(candidate => candidate.query), seed.questions.map(question => question.query));
    assert.equal(result.candidates.filter(candidate => candidate.selected).length, 8);
    assert.deepEqual(replayed.map(checkpoint => checkpoint.key).sort(), ['directions', 'draft-1', 'draft-2', 'draft-3', 'review-1', 'review-2', 'review-3', ...(!legacy ? ['set-review-0'] : [])]);
    const completedCalls: ModelInput[] = [];
    const completed = await generateQuestionPlan(seed, seed.project.description, { resume: replayed,
      model: fakeModel(() => { throw new Error('Completed resume must not request a model'); }, completedCalls) });
    assert.equal(completedCalls.length, 0);
    assert.deepEqual(completed.candidates, result.candidates);
  }
});

test('partially completed parallel generation resumes only the missing direction with its reserved IDs', async () => {
  const { checkpoints } = await savedReviewFailure();
  const saved = checkpoints.filter(checkpoint => ['directions', 'draft-1', 'draft-3'].includes(checkpoint.key)).reverse();
  const original = structuredClone(saved);
  const calls: ModelInput[] = [];
  const result = await generateQuestionPlan(seed, seed.project.description, {
    resume: saved,
    model: fakeModel((input: ModelInput) => {
      const context = JSON.parse(String(input.messages[1].content));
      if (context.direction) {
        assert.equal(context.direction.title, planningDirections(3).directions[1].title);
        return { candidates: [{ ...planningDraft(), query: '补回中间方向时怎样重新核对权限？' }] };
      }
      return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
    }, calls),
  });
  assert.deepEqual(saved, original);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'model').map(candidate => candidate.id),
    ['model-1', 'model-2', 'model-3', 'model-4', 'model-5', 'model-9', 'model-10', 'model-11']);
});

test('legacy resume keeps cumulative IDs when previous directions returned fewer than four candidates', async () => {
  const { checkpoints } = await savedReviewFailure();
  const legacy = checkpoints.filter(checkpoint => !checkpoint.key.startsWith('review-'));
  legacy[0].payload = { directions: (legacy[0].payload as { directions: unknown[] }).directions };
  let next = 1;
  for (const checkpoint of legacy.slice(1)) {
    const payload = checkpoint.payload as { candidates: QuestionCandidate[] };
    payload.candidates = payload.candidates.slice(0, 1);
    payload.candidates[0].id = `model-${next++}`;
  }
  const calls: ModelInput[] = [];
  const result = await generateQuestionPlan(seed, seed.project.description, { resume: legacy, model: fakeModel((input: ModelInput) => {
    const context = JSON.parse(String(input.messages[1].content));
    assert.deepEqual(context.candidates.map((candidate: { id: string }) => candidate.id), ['model-1', 'model-2', 'model-3']);
    return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
  }, calls) });
  assert.equal(calls.length, 1);
  assert.deepEqual(result.candidates.filter(candidate => candidate.origin === 'model').map(candidate => candidate.id), ['model-1', 'model-2', 'model-3']);
});

test('invalid resume checkpoints fail before any model call without repair or regeneration', async () => {
  const { checkpoints } = await savedReviewFailure();
  const changes: Array<(saved: QuestionGenerationCheckpoint[]) => void> = [
    saved => { saved.splice(2, 1); },
    saved => { saved[2] = structuredClone(saved[1]); },
    saved => { saved[4].key = 'review-2'; },
    saved => { saved[0].key = 'another-stage'; },
    saved => { delete saved[3].payload; },
    saved => { saved[0].completedAt = 'not-a-date'; },
    saved => { (saved[1].payload as { candidates: QuestionCandidate[] }).candidates[0].id = 'model-99'; },
    saved => { (saved[2].payload as { candidates: QuestionCandidate[] }).candidates[0].query = (saved[1].payload as { candidates: QuestionCandidate[] }).candidates[0].query; },
    saved => { (saved[3].payload as { candidates: QuestionCandidate[] }).candidates[0].evidence[0].quote = '这段原文不存在，不得为了续跑而跳过已存候选的原文检查。'; },
    saved => { (saved[1].payload as { candidates: QuestionCandidate[] }).candidates[0].review.status = 'reviewed'; },
    saved => { (saved[4].payload as { candidates: QuestionCandidate[] }).candidates.pop(); },
    saved => { (saved[4].payload as { candidates: QuestionCandidate[] }).candidates[0].query += '已被改写'; },
    saved => { (saved[4].payload as { candidates: QuestionCandidate[] }).candidates[0].review.assessment = undefined; },
    saved => { (saved[4].payload as { candidates: QuestionCandidate[] }).candidates[0].review.assessment!.evidence = [{ assetId: planningDraft().evidence[0].assetId, quote: '这段审核原文是虚构的，续跑前必须重新检查并立即拒绝。' }]; },
    saved => { (saved[4].payload as { candidates: QuestionCandidate[] }).candidates[0].review.assessment!.worthPursuing.verdict = 'no'; },
    saved => { saved.push({ ...structuredClone(saved[4]), key: 'review-2' }); },
  ];
  for (const change of changes) {
    const resume = structuredClone(checkpoints);
    change(resume);
    const calls: ModelInput[] = [];
    await assert.rejects(generateQuestionPlan(seed, seed.project.description, {
      resume, model: fakeModel(() => { throw new Error('Invalid resume reached model'); }, calls),
    }));
    assert.equal(calls.length, 0);
  }
  const calls: ModelInput[] = [];
  await assert.rejects(generateQuestionPlan(seed, seed.project.description, { resume: [], model: fakeModel({}, calls) }));
  assert.equal(calls.length, 0);
});

function funnelFixture(needCount = 6) {
  const planned = planningDirections(3);
  planned.needs = Array.from({ length: needCount }, (_, index) => ({ ...planned.needs[index % 3], id: `need-${index + 1}`, title: `完整过程需求 ${index + 1}`, importance: 'high' }));
  planned.directions.forEach((direction, index) => { direction.needIds = planned.needs.filter((_, offset) => offset % 3 === index).map(need => need.id); });
  return planned;
}

test('complete need maps exceed concurrency groups and set review can select complementary lower priority questions', async () => {
  const planned = funnelFixture();
  const stages: string[] = [];
  const original = structuredClone(seed);
  const result = await generateQuestionPlan(seed, seed.project.description, { model: { async generateObject(input) {
    const context = JSON.parse(String(input.messages[1].content));
    assert.ok(input.messages.reduce((count, message) => count + Buffer.byteLength(String(message.content)), 0) <= 48 * 1024);
    if (context.maxSelected) {
      stages.push('set');
      assert.equal(context.needs.length, 6);
      assert.ok(!JSON.stringify(context).includes('PRIVATE_GENERATION_REASON'));
      return { ...completeSetReply(context), selectedIds: ['model-5'], coverage: context.needs.map((need: { id: string }) => ({ needId: need.id, candidateIds: ['model-5'], status: 'covered', reason: '此题覆盖关键需求，优先于单题高分但重复的问法。' })) };
    }
    if (context.direction) {
      stages.push('draft');
      assert.equal(context.needs.length, 6);
      assert.equal(context.direction.needIds.length, 2);
      return { candidates: [{ ...planningDraft(), query: `完整过程 ${directionOffset(context)} 怎样开始使用合适的工具？`, rationale: 'PRIVATE_GENERATION_REASON 不可进入审核。' }] };
    }
    if (context.candidates) {
      stages.push('review');
      assert.equal(context.needs, undefined);
      assert.equal(context.selectionAdvantages, undefined);
      assert.ok(!JSON.stringify(context).includes('PRIVATE_GENERATION_REASON'));
      return { reviews: context.candidates.map((candidate: { id: string }) => ({ ...modelReview(candidate.id), priority: candidate.id === 'model-5' ? 'low' : 'high' })) };
    }
    stages.push('plan'); return planned;
  } } });
  assert.deepEqual(stages, ['plan', 'draft', 'draft', 'draft', 'review', 'set']);
  assert.deepEqual(result.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id), ['model-5']);
  assert.equal(result.coverageReview?.status, 'complete');
  assert.equal(result.coverageReview?.needs.length, 6);
  assert.equal(result.coverageReview?.refinementRounds, 0);
  assert.deepEqual(seed, original);
  assert.equal(result.status, 'draft');
});

test('set review discovers missing map needs, refines once, preserves unresolved additions and resumes without calls', async () => {
  const planned = funnelFixture(16);
  const checkpoints: QuestionGenerationCheckpoint[] = [];
  const calls: string[] = [];
  const result = await generateQuestionPlan(seed, seed.project.description, {
    onProgress(event) { if (event.checkpoint) checkpoints.push({ ...structuredClone(event.checkpoint), completedAt: new Date().toISOString() }); },
    model: { async generateObject(input) {
      const context = JSON.parse(String(input.messages[1].content));
      if (context.maxSelected) {
        calls.push(`set-${context.refinementRound}`);
        const reply = completeSetReply(context);
        const additional = { ...planned.needs[0], id: context.refinementRound ? 'need-after-refinement' : 'need-discovered', title: '初始地图漏掉的选择需求' };
        return { ...reply, missingAdditionalNeeds: [additional] };
      }
      if (context.missingNeeds) {
        calls.push('refinement');
        assert.deepEqual(context.missingNeeds.map((need: { id: string }) => need.id), ['need-discovered']);
        assert.equal(context.needs.length, 17);
        return { candidates: [{ ...planningDraft(), query: '一个人维护项目时怎样选择能快速开始的工具？' }] };
      }
      if (context.direction) return { candidates: [{ ...planningDraft(), query: `完整地图 ${directionOffset(context)} 怎样评价工具是否合适？` }] };
      if (context.candidates) {
        calls.push(context.candidates[0].id === 'model-13' ? 'refinement-review' : 'review');
        assert.equal(context.missingNeeds, undefined);
        assert.equal(context.refinementRound, undefined);
        return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
      }
      return planned;
    } },
  });
  assert.deepEqual(calls, ['review', 'set-0', 'refinement', 'refinement-review', 'set-1']);
  assert.equal(result.coverageReview?.needs.length, 18);
  assert.equal(result.coverageReview?.refinementRounds, 1);
  assert.equal(result.coverageReview?.status, 'incomplete');
  assert.equal(result.coverageReview?.coverage.find(item => item.needId === 'need-after-refinement')?.status, 'missing');
  assert.ok(result.notes.some(note => note.includes('未完成')));
  const resumed = await generateQuestionPlan(seed, seed.project.description, { resume: checkpoints.reverse(), model: { async generateObject() { throw new Error('Completed funnel must not call any model'); } } });
  assert.deepEqual(resumed.coverageReview, result.coverageReview);
  assert.deepEqual(resumed.candidates, result.candidates);
});

test('failed refinement review resumes only missing review and final set audit', async () => {
  const planned = funnelFixture();
  const checkpoints: QuestionGenerationCheckpoint[] = [];
  const missingReply = (context: Parameters<typeof completeSetReply>[0]) => ({ ...completeSetReply(context), coverage: context.needs.map((need, index) => ({ needId: need.id,
    candidateIds: index ? ['model-1'] : [], status: index ? 'covered' : 'missing', reason: index ? '已选问题覆盖该需求。' : '这个重要需求尚未被候选覆盖，需要补题。',
  })) });
  await assert.rejects(generateQuestionPlan(seed, seed.project.description, {
    onProgress(event) { if (event.checkpoint) checkpoints.push({ ...structuredClone(event.checkpoint), completedAt: new Date().toISOString() }); },
    model: { async generateObject(input) {
      const context = JSON.parse(String(input.messages[1].content));
      if (context.maxSelected) return missingReply(context);
      if (context.missingNeeds) return { candidates: [{ ...planningDraft(), query: '新手第一次使用应如何快速验证效果？' }] };
      if (context.direction) return { candidates: [{ ...planningDraft(), query: `恢复过程 ${directionOffset(context)} 怎样找到可用工具？` }] };
      if (context.candidates) {
        if (context.candidates[0].id === 'model-13') throw new Error('refinement review connection failed');
        return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
      }
      return planned;
    } },
  }), /refinement review connection failed/);
  assert.ok(checkpoints.some(checkpoint => checkpoint.key === 'refinement-draft'));
  assert.ok(!checkpoints.some(checkpoint => checkpoint.key === 'refinement-review'));
  const requests: string[] = [];
  const result = await generateQuestionPlan(seed, seed.project.description, { resume: checkpoints.reverse(), model: { async generateObject(input) {
    const context = JSON.parse(String(input.messages[1].content));
    if (context.maxSelected) { requests.push('set'); return completeSetReply(context); }
    requests.push('review');
    assert.deepEqual(context.candidates.map((candidate: { id: string }) => candidate.id), ['model-13']);
    return { reviews: [modelReview('model-13')] };
  } } });
  assert.deepEqual(requests, ['review', 'set']);
  assert.equal(result.coverageReview?.status, 'complete');
  assert.equal(result.coverageReview?.refinementRounds, 1);
});

test('set review rejects invalid selections, coverage, duplicates and additional needs before supplementation', async () => {
  const changes = [
    (reply: ReturnType<typeof completeSetReply>) => { reply.selectedIds = ['model-1', 'model-1']; },
    (reply: ReturnType<typeof completeSetReply>) => { reply.selectedIds = [seed.questions[0].id]; },
    (reply: ReturnType<typeof completeSetReply>) => { reply.coverage.push(reply.coverage[0]); },
    (reply: ReturnType<typeof completeSetReply>) => { reply.coverage[0].candidateIds = ['missing-id']; },
    (reply: ReturnType<typeof completeSetReply>) => { Object.assign(reply, { duplicates: [{ candidateIds: ['model-1', 'model-5'], reason: '两个问题回答同一个需求。' }] }); },
    (reply: ReturnType<typeof completeSetReply>) => { Object.assign(reply, { missingAdditionalNeeds: [funnelFixture().needs[0]] }); },
    (reply: ReturnType<typeof completeSetReply>) => { Object.assign(reply, { missingAdditionalNeeds: [{ ...funnelFixture().needs[0], id: 'extra', assetIds: ['nonexistent'] }] }); },
  ];
  for (const change of changes) {
    let supplements = 0;
    await assert.rejects(generateQuestionPlan(seed, seed.project.description, { model: { async generateObject(input) {
      const context = JSON.parse(String(input.messages[1].content));
      if (context.maxSelected) { const reply = completeSetReply(context); change(reply); return reply; }
      if (context.missingNeeds) { supplements++; return { candidates: [] }; }
      if (context.direction) return { candidates: [{ ...planningDraft(), query: `边界检查 ${directionOffset(context)} 如何选择合适的工具？` }] };
      if (context.candidates) return { reviews: context.candidates.map((candidate: { id: string }) => modelReview(candidate.id)) };
      return funnelFixture();
    } } }), /整组审核/);
    assert.equal(supplements, 0);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateObjectInput } from '@/lib/models/types';
import type { GeoSeed } from './types';
import type { ResearchBatch, ResearchQuestion } from './research-types';
import { freezeProjectOptimization, buildProjectOptimization, recoverUnreadProjectEvidence, validateProjectOptimizationMode } from './project-optimization';
import type { ProjectOptimization } from './project-optimization-types';
import { prepareOptimizationMaterials } from './project-optimization-delivery';

const question = (id: string): ResearchQuestion => ({ id, zh: `${id} 中文原题`, en: `${id} original question`,
  decision: 'search_now', valueReason: '真实目标', evidenceBasis: '用户给定', answerability: '部分满足',
  gaps: ['缺少比较步骤'], decisionReason: '值得调查', reviewPath: '',
  diagnosis: { observed: '', hypothesis: 'OLD_DIAGNOSIS_NOT_REVIEW_EVIDENCE', nextStep: '' },
  observations: [{ engine: 'chatgpt', language: 'zh', query: `${id} 中文原题`, recordedAt: '2026-10-29',
    status: 'not_observed', summary: 'SUMMARY_NOT_RAW', conditions: '网页人工记录', sources: [], evidencePath: `${id}.md` }] });
const batch: ResearchBatch = { id: 'batch-1', date: '2026-10-29', projectId: 'sample-project', productSummary: '', contributionSummary: '',
  scopeNote: '', reportPath: '', sourceAuditPath: '', reviewPath: '', questions: [question('Q1'), question('Q2')], deferredQuestions: [], nextStep: '' };
const seed = { project: { id: 'sample-project', name: 'SampleProject' }, assets: [{ id: 'asset-1', title: '自有材料', markdown: '现有正文：应记录输入和条件。',
  language: 'zh', summary: '', sourcePath: 'owned.md', publicUrl: 'https://example.org/owned' }] } as GeoSeed;
const raw = (file: string) => `- Question: ${file.slice(0, 2)} 中文原题\n## Answer text\n先记录输入与结果，再对照变化。`;
const freeze = () => freezeProjectOptimization(batch, seed, 'focus', batch.id, raw, '2026-10-31T00:00:00Z');
const draft = () => ({ summary: '合并两题共同的比较步骤缺口。', limitations: ['尚未实施。'], actions: [{ id: 'A1', title: '补充比较步骤', priority: 1,
  questionIds: ['Q1', 'Q2'], assetIds: ['asset-1'], observed: '两个回答都要求记录并比较。', hypothesis: '缺少可执行步骤可能影响承接。',
  change: '在现有正文中增加输入、输出与条件记录表，再列出逐项比较步骤。', rationale: '用一项内容改动承接两道原题。',
  evidence: [{ evidenceId: 'Q1:observation:0', quote: '先记录输入与结果' }, { evidenceId: 'Q2:observation:0', quote: '再对照变化' }],
  verification: '先人工核对步骤；实施后使用两道原题、原语言和原入口条件复测，分别记录提及与自有引用；没有可比后测不判定有效。', limitations: ['尚无效果证明。'] }] });
const review = () => ({ issues: [], actions: [{ actionId: 'A1', scores: { evidence: 90, relevance: 90, actionability: 90, verifiability: 90 },
  preservesGoal: 'pass', evidenceGrounded: 'pass', issues: [] as string[] }] });
const run = async (candidate = draft(), assessment = review(), plan = freeze()) => {
  const calls: GenerateObjectInput[] = [];
  const phases: string[] = [];
  const result = await buildProjectOptimization({ ...plan, maxRounds: 1 }, { loadModel: async () => ({ generateObject: async (input: GenerateObjectInput) => {
    calls.push(input); return calls.length % 2 === 1 ? candidate : assessment;
  } }), onProgress: plan => { phases.push(plan.phase); } });
  return { result, calls, phases };
};

test('freezes the entire current batch and raw evidence independently from later data changes', () => {
  const source = structuredClone(batch);
  source.questions[1].decision = 'keep_and_fill';
  const saved = freezeProjectOptimization(source, seed, 'focus', batch.id, raw);
  source.questions[0].zh = '改写';
  assert.deepEqual(saved.questionIds, ['Q1', 'Q2']);
  assert.equal(saved.snapshot.questions[0].zh, 'Q1 中文原题');
  assert.equal(saved.snapshot.evidence.length, 2);
  assert.equal(saved.questionCount, 2);
  assert.throws(() => freezeProjectOptimization(batch, seed, 'focus', 'stale', raw), /批次/);
  assert.throws(() => validateProjectOptimizationMode('fast'), /模式/);
});

test('missing or unsupported raw records remain explicit limitations and never become evidence', async () => {
  const saved = freezeProjectOptimization(batch, seed, 'deep', batch.id, () => null);
  assert.equal(saved.snapshot.evidence.length, 0);
  assert.equal(saved.questionCount, 2);
  let called = false;
  const result = await buildProjectOptimization(saved, { loadModel: async () => { called = true; throw new Error('must not call'); } });
  assert.equal(called, false);
  assert.equal(result.phase, 'blocked');
  assert.equal(result.review, null);
  assert.ok(result.limitations.some(item => item.includes('Q1')));
});

test('retry can recover unread original files only before any model judgment, preserving all measurement conditions', async () => {
  const plan = await buildProjectOptimization(freezeProjectOptimization(batch, seed, 'focus', batch.id, () => null));
  const before = structuredClone(plan);
  assert.equal(recoverUnreadProjectEvidence(plan, raw), true);
  assert.equal(plan.snapshot.evidence.length, 2);
  assert.deepEqual(plan.snapshot.questions, before.snapshot.questions);
  assert.deepEqual(plan.snapshot.assets, before.snapshot.assets);
  assert.equal(plan.frozenAt, before.frozenAt);
  assert.equal(recoverUnreadProjectEvidence(plan, raw), false);
  before.actions = draft().actions.map(action => ({ ...action, status: 'blocked' as const }));
  assert.equal(recoverUnreadProjectEvidence(before, raw), false);
});

test('one grouped action serves multiple original questions and gets a separate independent review', async () => {
  const { result, calls, phases } = await run();
  assert.equal(calls.length, 2);
  assert.deepEqual(phases, ['planning', 'reviewing', 'awaiting_review']);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0].questionIds, ['Q1', 'Q2']);
  assert.equal(result.actions[0].status, 'ready');
  assert.equal(result.phase, 'awaiting_review');
  assert.equal(result.review!.passed, true);
  const reviewer = JSON.parse(calls[1].messages[1].content as string);
  assert.equal(JSON.stringify(reviewer).includes('OLD_DIAGNOSIS_NOT_REVIEW_EVIDENCE'), false);
  assert.equal(JSON.stringify(reviewer).includes('SUMMARY_NOT_RAW'), false);
  assert.equal(reviewer.candidateToReview.actions[0].change, draft().actions[0].change);
  assert.deepEqual(reviewer.context.evidence, JSON.parse(calls[0].messages[1].content as string).context.evidence);
});

test('unknown hard checks, low dimension scores and omitted action reviews cannot pass', async () => {
  const unknown = review(); unknown.actions[0].preservesGoal = 'unknown';
  assert.equal((await run(draft(), unknown)).result.review!.passed, false);
  const low = review(); low.actions[0].scores.evidence = 69;
  assert.equal((await run(draft(), low)).result.actions[0].status, 'blocked');
  const missing = review(); missing.actions = [];
  assert.equal((await run(draft(), missing)).result.review!.passed, false);
});

test('focused optimization retains up to three reviewed actions, including companion English changes', async () => {
  const plan = freeze();
  plan.snapshot.assets.push({ ...plan.snapshot.assets[0], id: 'asset-en', language: 'en',
    title: 'English guide', markdown: 'Record the inputs and conditions.' });
  const candidate = draft();
  candidate.actions = ['同步中英文导读', '增加条件记录表', '补充复测示例'].map((title, index) => ({
    ...draft().actions[0], id: `A${index + 1}`, priority: index + 1, title, change: `${title}：${draft().actions[0].change}`,
    assetIds: index === 0 ? ['asset-1', 'asset-en'] : ['asset-1'],
  }));
  const assessment = review();
  assessment.actions = candidate.actions.map(action => ({ ...review().actions[0], actionId: action.id }));
  const { result, calls } = await run(candidate, assessment, plan);
  assert.equal(result.review!.passed, true);
  assert.equal(result.phase, 'awaiting_review');
  assert.deepEqual(result.actions.map(action => action.id), ['A1', 'A2', 'A3']);
  assert.deepEqual(result.actions[0].assetIds, ['asset-1', 'asset-en']);
  assert.ok(result.actions.every(action => action.status === 'ready'));
  assert.ok(calls.every(call => JSON.parse(call.messages[1].content as string).context.maximumActions === 3));

  const incompleteReview = structuredClone(assessment); incompleteReview.actions.pop();
  assert.equal((await run(candidate, incompleteReview, plan)).result.review!.passed, false);

  candidate.actions.push({ ...draft().actions[0], id: 'A4', priority: 4 });
  assessment.actions.push({ ...review().actions[0], actionId: 'A4' });
  const excessive = (await run(candidate, assessment, plan)).result;
  assert.equal(excessive.review!.passed, false);
  assert.equal(excessive.actions.length, 4, 'over-limit plans are preserved for revision, not silently truncated');
  assert.ok(excessive.review!.issues.some(issue => issue.includes('最多交付 3 项')));
});

test('owned content can support an action without becoming an extra modification target, but fabricated quotes still fail', async () => {
  const candidate = draft();
  candidate.actions[0].evidence.push({ evidenceId: 'asset-1', quote: '应记录输入和条件。' });
  assert.equal((await run(candidate)).result.review!.passed, true);
  candidate.actions[0].evidence.at(-1)!.quote = '原文没有这句话';
  assert.equal((await run(candidate)).result.review!.passed, false);
});

test('supplementation reads bounded direct public documents and preserves frozen answers and original materials', async () => {
  const plan = freeze();
  plan.snapshot.project.repositoryUrl = 'https://github.com/example/project';
  plan.snapshot.assets[0].publicUrl = 'https://github.com/example/project/blob/main/README.md';
  const frozen = structuredClone(plan.snapshot);
  const urls: string[] = [];
  const result = await prepareOptimizationMaterials(plan, async asset => {
    urls.push(asset.publicUrl!);
    return { readAt: '2026-11-11', asset: { ...asset, markdownIsExcerpt: false,
      markdown: asset.id === 'asset-1' ? '[开始](docs/start.md#中文) [外部](https://example.org/other.md) [资料](docs/info.md) [更多](docs/extra.md)' : '完整使用步骤' } };
  });
  assert.equal(urls.length, 3);
  assert.ok(urls.every(url => url.startsWith('https://github.com/example/project/blob/main/')));
  assert.equal(result.assets.length, 3);
  assert.deepEqual(plan.snapshot, frozen);
});

test('a selected action receives complete saved answers within the fixed context budget', async () => {
  const plan = freeze();
  plan.snapshot.evidence[0].text = '原回答'.repeat(700);
  plan.actions = [{ ...draft().actions[0], questionIds: ['Q1'], status: 'blocked' }];
  const calls: GenerateObjectInput[] = [];
  await buildProjectOptimization({ ...plan, maxRounds: 1 }, { loadModel: async () => ({ generateObject: async input => {
    calls.push(input); return calls.length === 1 ? draft() : review();
  } }) });
  const context = JSON.parse(calls[0].messages[1].content as string).context;
  assert.equal(context.evidence[0].text, plan.snapshot.evidence[0].text);
  assert.ok(context.evidence.reduce((sum: number, item: { text: string }) => sum + Buffer.byteLength(item.text), 0) <= 56 * 1024);
});

test('high model scores cannot approve invented quotes, question IDs, asset IDs or duplicate actions', async () => {
  for (const mutate of [
    (value: ReturnType<typeof draft>) => { value.actions[0].evidence[0].quote = '不存在的证据'; },
    (value: ReturnType<typeof draft>) => { value.actions[0].questionIds.push('FORGED'); },
    (value: ReturnType<typeof draft>) => { value.actions[0].assetIds = ['FORGED']; },
    (value: ReturnType<typeof draft>) => { value.actions.push(structuredClone(value.actions[0])); },
  ]) {
    const candidate = draft(); mutate(candidate);
    const { result } = await run(candidate);
    assert.equal(result.review!.passed, false);
    assert.equal(result.phase, 'blocked');
  }
});

test('many long answers cannot starve owned content or later questions, with exact UTF-8 omission counts', async () => {
  const original = freeze();
  const first = original.snapshot.evidence[0];
  const second = original.snapshot.evidence[1];
  original.snapshot.evidence = [
    ...Array.from({ length: 23 }, (_, index) => ({ ...first, id: `Q1:observation:${index}`, text: '回答证据🙂'.repeat(5000) })),
    { ...second, text: '末题证据🙂'.repeat(5000) },
  ];
  original.snapshot.assets[0].markdown = '自有正文🙂'.repeat(5000);
  const inspect = async (mode: 'focus' | 'deep') => {
    const calls: GenerateObjectInput[] = [];
    await buildProjectOptimization({ ...original, mode }, { loadModel: async () => ({ generateObject: async input => {
      calls.push(input); return calls.length % 2 === 1 ? draft() : review();
    } }) });
    return JSON.parse(calls[0].messages[1].content as string).context;
  };
  const focus = await inspect('focus');
  const deep = await inspect('deep');
  assert.deepEqual(focus.questions.map((item: { id: string }) => item.id), ['Q1', 'Q2']);
  assert.equal(focus.evidence.length, 24);
  assert.ok(focus.assets[0].markdown.length > 1000);
  assert.ok(focus.evidence.find((item: { questionId: string }) => item.questionId === 'Q2').text.length > 0);
  const evidenceBytes = focus.evidence.reduce((sum: number, item: { text: string }) => sum + Buffer.byteLength(item.text), 0);
  assert.ok(evidenceBytes <= 56 * 1024);
  assert.ok(Buffer.byteLength(focus.assets[0].markdown) <= 32 * 1024);
  assert.ok(Buffer.byteLength(deep.assets[0].markdown) > Buffer.byteLength(focus.assets[0].markdown));
  assert.equal(JSON.stringify(focus).includes('�'), false);
  const provided = Buffer.byteLength(focus.evidence[0].text);
  const total = Buffer.byteLength('回答证据🙂'.repeat(5000));
  assert.ok(focus.limitations.some((item: string) => item.includes(`Q1:observation:0`) && item.includes(`${provided} / ${total} UTF-8 字节`) && item.includes(`${total - provided} 字节`)));
});

test('persists each candidate before independent review, then repairs from prior candidate and failed assessment', async () => {
  const firstReview = review();
  firstReview.actions[0].scores.actionability = 60;
  firstReview.actions[0].issues = ['FIRST_REVIEW_REPAIR_SENTINEL'];
  const revised = draft(); revised.actions[0].change += ' 表格增加每一步的验收记录与负责人。';
  const replies = [draft(), firstReview, revised, review()];
  const calls: GenerateObjectInput[] = [];
  const saved: ProjectOptimization[] = [freeze()];
  const result = await buildProjectOptimization(saved[0], {
    onProgress: plan => { saved.push(structuredClone(plan)); },
    loadModel: async () => ({ generateObject: async input => {
      const previous = saved.at(-1)!;
      const call = calls.length;
      if (call === 1 || call === 3) {
        assert.equal(previous.phase, 'reviewing');
        assert.equal(previous.history!.at(-1)!.review, null);
        assert.equal(previous.actions[0].change, (replies[call - 1] as ReturnType<typeof draft>).actions[0].change);
      }
      if (call === 2) {
        assert.equal(previous.phase, 'revising');
        assert.equal(previous.history![0].review!.passed, false);
      }
      calls.push(input);
      return replies[call];
    } }),
  });
  assert.deepEqual(saved.map(item => item.phase), ['initializing', 'planning', 'reviewing', 'reviewing', 'revising', 'reviewing', 'awaiting_review']);
  assert.deepEqual(result.history!.map(item => [item.round, item.review!.passed]), [[1, false], [2, true]]);
  assert.equal(result.phase, 'awaiting_review');
  assert.equal(result.progress!.round, 2);
  assert.equal(result.progress!.maxRounds, 2);
  assert.deepEqual(result.snapshot, freeze().snapshot);
  assert.deepEqual(result.questionIds, ['Q1', 'Q2']);
  const repairInput = JSON.parse(calls[2].messages[1].content as string);
  assert.equal(repairInput.previousCandidate.actions[0].change, draft().actions[0].change);
  assert.equal(repairInput.previousReview.actions[0].scores.actionability, 60);
  for (const call of [calls[1], calls[3]]) {
    const reviewerInput = JSON.parse(call.messages[1].content as string);
    assert.deepEqual(Object.keys(reviewerInput).sort(), ['candidateToReview', 'context']);
    assert.equal(JSON.stringify(reviewerInput).includes('FIRST_REVIEW_REPAIR_SENTINEL'), false);
    assert.deepEqual(reviewerInput.context, repairInput.context);
  }
});

test('stops unchanged revisions, enforces the round limit and never upgrades unresolved checks', async () => {
  const failed = review(); failed.actions[0].scores.evidence = 69;
  let unchangedCalls = 0;
  const unchangedReplies = [draft(), failed, draft(), review()];
  const unchanged = await buildProjectOptimization(freeze(), { loadModel: async () => ({ generateObject: async () => unchangedReplies[unchangedCalls++] }) });
  assert.equal(unchanged.stopReason, 'no_progress');
  assert.equal(unchanged.phase, 'blocked');
  assert.equal(unchangedCalls, 3);
  assert.equal(unchanged.history!.length, 2);
  assert.equal(unchanged.history![0].review!.passed, false);
  assert.equal(unchanged.history![1].review, null);
  assert.equal(unchanged.review, null);
  const revised = draft(); revised.actions[0].change += ' 补充不同条件下的记录栏。';
  let call = 0;
  const replies = [draft(), failed, revised, failed];
  const stopped = await buildProjectOptimization(freeze(), { loadModel: async () => ({ generateObject: async () => replies[call++] }) });
  assert.equal(call, 4);
  assert.equal(stopped.stopReason, 'round_limit');
  assert.equal(stopped.phase, 'blocked');
  assert.equal(stopped.review!.passed, false);
  assert.ok(stopped.history!.every(round => round.review?.passed === false));
  await assert.rejects(buildProjectOptimization({ ...freeze(), maxRounds: 3 }), /Too big|<=2/);
});

test('an empty candidate stops with saved review and missing evidence does not erase earlier results', async () => {
  const empty = draft(); empty.actions = [];
  const { result, calls } = await run(empty);
  assert.equal(calls.length, 2);
  assert.equal(result.stopReason, 'no_evidence');
  assert.equal(result.history!.length, 1);
  assert.equal(result.history![0].review!.passed, false);
  const earlier = (await run()).result;
  earlier.snapshot.evidence = [];
  const stopped = await buildProjectOptimization(earlier, { loadModel: async () => { throw new Error('must not call'); } });
  assert.deepEqual(stopped.actions, earlier.actions);
  assert.deepEqual(stopped.history, earlier.history);
  assert.equal(stopped.phase, 'blocked');
});

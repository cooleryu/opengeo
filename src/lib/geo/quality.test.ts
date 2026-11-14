import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildQualityReview, continueQualityLoop, GEO_ACCEPTANCE_CRITERIA_VERSION, proposalDigest, runQualityLoop } from './quality';
import { buildDiagnosisContext, localDiagnosis, validateDiagnosis, validateProposal } from './diagnosis';
import type { GeoProposal, GeoSeed, GeoTask } from './types';
import type { GeoAcceptanceReview, StrategyMemory } from './workflow-types';

const proposal: GeoProposal = { id: 'p', title: 'Clarify the measured scope', status: 'draft', rationale: 'Observed ambiguity',
  targetAssetId: 'article', targetUrl: 'https://example.com/article', before: 'Original paragraph.', after: 'Updated paragraph.',
  changes: ['Clarify scope'], evidencePaths: ['data/geo-evidence/b/q1.json', 'article.md'],
  successCriteria: ['Repeat the frozen question on the same surface for seven days; retain unchanged outcomes.'], limitations: ['Observed association only.'] };
const assessment = (score: number) => ({ scores: { evidence: score, relevance: score, actionability: score, verifiability: score }, issues: [], summary: 'Reviewed complete candidate.' });

test('minimum dimensions, blockers, local previews and edited proposal digests cannot bypass approval', () => {
  assert.equal(buildQualityReview(proposal, null).passed, false);
  const weak = assessment(100); weak.scores.evidence = 69;
  assert.equal(buildQualityReview(proposal, weak).passed, false);
  assert.equal(buildQualityReview(proposal, assessment(100), [{ dimension: 'evidence', severity: 'blocking', detail: 'Wrong source', suggestion: 'Correct evidence' }]).passed, false);
  assert.equal(buildQualityReview(proposal, assessment(80)).passed, true);
  assert.notEqual(proposalDigest(proposal), proposalDigest({ ...proposal, after: 'A later user edit.' }));
});

const geoCriteria: Record<keyof GeoAcceptanceReview, string> = {
  implementation: '实施验收：目标页面完成指定替换并保留准确的方法说明；内容更全不表示 GEO 效果改善。',
  ownBrandMention: 'GEO 提及：逐次记录 SampleProject 是否被正确提及并匹配本项目身份，排除同名项目。',
  ownTargetCitation: 'GEO 引用：单独核查自有目标页面 https://example.com/article 是否获得平台实际引用，其他链接不替代。',
  comparableConditions: '同原题、同语言、同 ChatGPT 入口和可比采集条件，实施后七天观察；条件不可比即停止比较。',
  unknownBaseline: '未知引用不记零；没有可比基线或后测时待跟测，不承诺提高、不编造数字或宣称差距缩小。',
};
const geoProposal = { ...proposal, successCriteria: Object.values(geoCriteria) };
const geoChecks = (): GeoAcceptanceReview => Object.fromEntries(Object.entries(geoCriteria).map(([key, criterionQuote]) =>
  [key, { met: true, criterionQuote, reason: '该原句明确保留对应验收目标和条件。' }])) as GeoAcceptanceReview;

test('GEO checks make content-only goal substitution blocking even with perfect scores', () => {
  const checks = geoChecks();
  checks.implementation.met = false;
  checks.implementation.reason = '把方法要点覆盖率称为 GEO 自身改善。';
  checks.ownBrandMention.met = false; checks.ownBrandMention.criterionQuote = '';
  checks.ownTargetCitation.met = false; checks.ownTargetCitation.criterionQuote = '';
  const review = buildQualityReview({ ...proposal, successCriteria: ['复测回答覆盖 τ、分层删除和封闭实验即判改善并缩小差距。'] },
    { ...assessment(100), geoAcceptanceRequired: true, geoAcceptance: checks });
  assert.equal(review.passed, false);
  assert.equal(review.criteriaVersion, GEO_ACCEPTANCE_CRITERIA_VERSION);
  assert.ok(review.issues.some(issue => issue.severity === 'blocking' && issue.detail.includes('自身品牌被正确提及')));
  assert.ok(review.issues.some(issue => issue.severity === 'blocking' && issue.detail.includes('自有目标页面被实际引用')));
});

test('GEO review requires exact criterion quotes and keeps unknown baseline handling without invented numbers', () => {
  const valid = buildQualityReview(geoProposal, { ...assessment(85), geoAcceptanceRequired: true, geoAcceptance: geoChecks() });
  assert.equal(valid.passed, true);
  assert.equal(valid.geoAcceptanceRequired, true);
  assert.match(valid.geoAcceptance!.unknownBaseline.criterionQuote, /待跟测/);
  assert.equal(buildQualityReview(geoProposal, { ...assessment(100), geoAcceptanceRequired: true }).passed, false);
  const forged = geoChecks(); forged.ownBrandMention.criterionQuote = '这是一条作者没有写的提及验收。';
  assert.equal(buildQualityReview(geoProposal, { ...assessment(100), geoAcceptanceRequired: true, geoAcceptance: forged }).passed, false);
});

test('one bounded GEO revision retains and rechecks mandatory judgments through review reconstruction', async () => {
  const checks = geoChecks(); checks.ownTargetCitation.met = false;
  const initial = buildQualityReview(geoProposal, { ...assessment(100), geoAcceptanceRequired: true, geoAcceptance: checks });
  let repairs = 0; let reviews = 0;
  const loop = await continueQualityLoop(geoProposal, initial, async candidate => {
    reviews++;
    return buildQualityReview(candidate, { ...assessment(85), geoAcceptanceRequired: true, geoAcceptance: geoChecks() });
  }, async candidate => {
    repairs++;
    return { ...candidate, successCriteria: [...candidate.successCriteria, '分别保留无提及、无引用与未知，不以内容覆盖判 GEO 成功。'] };
  }, 1);
  assert.equal(repairs, 1); assert.equal(reviews, 1);
  assert.equal(loop.stopReason, 'target_reached');
  assert.equal(loop.rounds[0].review.passed, false);
  assert.equal(loop.rounds[1].review.passed, true);
  assert.equal(loop.rounds[1].review.criteriaVersion, GEO_ACCEPTANCE_CRITERIA_VERSION);
  assert.deepEqual(loop.rounds[1].review.geoAcceptance, geoChecks());
});

test('quality loop retains candidates, stops without progress, caps at three and selects a passing candidate', async () => {
  for (const [scores, reason, count] of [[ [60, 60], 'no_progress', 2 ], [ [60, 65, 69], 'round_limit', 3 ], [ [71, 80], 'target_reached', 2 ]] as const) {
    let seen = 0;
    const loop = await runQualityLoop(proposal, async candidate => {
      const review = buildQualityReview(candidate, assessment(scores[seen++]!));
      return { ...review, passed: true, total: 100 }; // Recomputed by the loop, never trusted.
    }, async candidate => ({ ...candidate, after: `${candidate.after} Revised.` }));
    assert.equal(loop.stopReason, reason); assert.equal(loop.rounds.length, count);
    assert.equal(loop.rounds[0].review.passed, false);
    if (reason === 'target_reached') assert.equal(loop.rounds.find(item => item.round === loop.bestRound)?.review.passed, true);
  }
  const unchanged = await runQualityLoop(proposal, async candidate => buildQualityReview(candidate, assessment(60)), async candidate => candidate);
  assert.equal(unchanged.stopReason, 'no_progress'); assert.equal(unchanged.rounds.length, 1);
});

test('continuation revises from the saved criticisms before a full review and stops on passing', async () => {
  const initialReview = buildQualityReview(proposal, assessment(79), [{ dimension: 'verifiability', severity: 'improvement',
    detail: 'Measurement timing is unclear.', suggestion: 'Specify when to measure.' }]);
  const events: string[] = [];
  const loop = await continueQualityLoop(proposal, initialReview, async candidate => {
    events.push('review');
    assert.equal(candidate.before, proposal.before);
    assert.equal(candidate.after, 'Revised with timing.');
    return buildQualityReview(candidate, assessment(80));
  }, async (candidate, review) => {
    events.push('revise');
    assert.deepEqual(candidate, proposal);
    assert.deepEqual(review, initialReview);
    return { ...candidate, after: 'Revised with timing.' };
  });
  assert.deepEqual(events, ['revise', 'review']);
  assert.deepEqual(loop.rounds[0], { round: 1, candidate: proposal, review: initialReview });
  assert.equal(loop.stopReason, 'target_reached'); assert.equal(loop.bestRound, 2);
});

test('continuation keeps the original on regression or unchanged text and caps additional rounds at two', async () => {
  const initialReview = buildQualityReview(proposal, assessment(75));
  for (const [scores, reason, bestRound] of [[[74], 'no_progress', 1], [[76, 79], 'round_limit', 3]] as const) {
    let reviewed = 0;
    const loop = await continueQualityLoop(proposal, initialReview,
      async candidate => buildQualityReview(candidate, assessment(scores[reviewed++]!)),
      async candidate => ({ ...candidate, after: `${candidate.after} Revised.` }), 10);
    assert.equal(loop.stopReason, reason); assert.equal(loop.bestRound, bestRound);
    assert.equal(loop.maxRounds, 3); assert.equal(reviewed, scores.length);
    assert.deepEqual(loop.rounds[0].candidate, proposal);
  }
  const unchanged = await continueQualityLoop(proposal, initialReview,
    async () => { throw new Error('Unchanged drafts must not consume another review.'); }, async candidate => candidate);
  assert.equal(unchanged.stopReason, 'no_progress'); assert.equal(unchanged.rounds.length, 1);
});

test('continuation rejects stale, local or already passing reviews before any model call', async () => {
  const initialReview = buildQualityReview(proposal, assessment(75));
  const reviews = [
    { ...initialReview, source: 'local' as const },
    { ...initialReview, criteriaVersion: 'old-criteria' },
    { ...initialReview, proposalDigest: 'edited-after-review' },
    buildQualityReview(proposal, assessment(80)),
  ];
  for (const review of reviews) {
    await assert.rejects(continueQualityLoop(proposal, review,
      async () => { assert.fail('Invalid reviews must be rejected before another model call.'); },
      async () => { assert.fail('Invalid reviews must be rejected before a revision.'); }));
  }
});

test('diagnosis uses real raw evidence, scopes strategies and rejects fabricated citations and target text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-quality-'));
  const previous = { DATA_DIR: process.env.DATA_DIR, GEO_WORKSPACE: process.env.GEO_WORKSPACE };
  process.env.DATA_DIR = root; process.env.GEO_WORKSPACE = root;
  try {
    fs.mkdirSync(path.join(root, 'data/geo-evidence/b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/geo-evidence/b/q1.json'), JSON.stringify({ results: [{ url: 'https://example.net/other', title: 'Other', summary: 'A returned summary.', snippet: 'A returned excerpt.' }] }));
    fs.writeFileSync(path.join(root, 'article.md'), proposal.before);
    const seed = { project: { id: 'project' }, assets: [{ id: 'article', title: 'Article', publicUrl: proposal.targetUrl,
      sourcePath: 'article.md', summary: 'Source summary', markdown: proposal.before, markdownIsExcerpt: true, evidencePaths: [] }] } as unknown as GeoSeed;
    const task = { id: 'current-task', projectId: 'project', goal: 'Improve discovery', workflow: { protocolKey: 'deepseek-p1', questions: [{ id: 'q1', query: 'Question?',
      category: 'content', target: 'article', assetIds: ['article'], exploratory: false }], baseline: { id: 'b', mode: 'live', status: 'completed',
      protocolKey: 'deepseek-p1', phase: 'baseline', measurementAt: '2026-10-22T01:00:00Z', completedCount: 1,
      questions: [{ id: 'q1', query: 'Question?', resultCount: 1, projectHit: false, evidencePath: 'data/geo-evidence/b/q1.json' }] } } } as unknown as GeoTask;
    const strategy: StrategyMemory = { id: 's1', taskId: 'previous-task', projectId: 'project', protocolKey: 'deepseek-p1',
      targetAssetId: 'article', categories: ['content'], createdAt: '2026-10-20T00:00:00Z', status: 'active', version: 3,
      outcome: 'improved', recommendation: 'Use under the same observed conditions.', action: 'Clarify scope.',
      beforeRate: 0, afterRate: 1, baselineRunId: 'previous-baseline', followupRunIds: ['previous-followup'],
      evidencePaths: ['data/geo-evidence/previous-followup/q1.json'], implementationRevision: 1, confidence: 'observational',
      validation: { at: '2026-10-21T02:00:00Z', classification: 'improved', beforeRate: 0, afterRate: 1,
        runIds: ['fresh-followup'], evidencePaths: ['data/geo-evidence/fresh-followup/q1.json'], passed: true, summary: 'New comparable measurements improved.' },
      history: [{ version: 3, action: 'activated', at: '2026-10-21T03:00:00Z', reason: 'Confirmed by user.',
        runIds: ['fresh-followup'], evidencePaths: ['data/geo-evidence/fresh-followup/q1.json'] }] };
    const context = buildDiagnosisContext(task, seed, [strategy, { ...strategy, id: 'other-platform', protocolKey: 'gemini' }, { ...strategy, id: 'other-target', targetAssetId: 'absent' }]);
    assert.equal(context.evidenceReady, true); assert.equal(context.questions[0].sources[0].summary, 'A returned summary.');
    assert.equal(context.questions[0].sources[0].contentProvided, false); assert.equal(context.materials[0].markdownIsExcerpt, true);
    assert.deepEqual(context.strategies.map(item => item.id), ['s1']);
    assert.deepEqual(buildDiagnosisContext(task, seed, [{ ...strategy, status: 'candidate' }]).strategies, []);
    assert.deepEqual(validateProposal(proposal, seed, context), []);
    assert.ok(validateProposal({ ...proposal, before: 'Invented original.' }, seed, context).length);
    const diagnosis = localDiagnosis(context);
    diagnosis.comparisons.push({ questionId: 'q1', sourceUrl: 'https://fabricated.example', observedDifference: 'Invented', evidencePath: 'data/geo-evidence/b/q1.json' });
    assert.ok(validateDiagnosis(diagnosis, context).some(issue => issue.detail.includes('来源比较')));
    fs.unlinkSync(path.join(root, 'data/geo-evidence/b/q1.json'));
    assert.equal(buildDiagnosisContext(task, seed).evidenceReady, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildQualityReview, proposalDigest, runQualityLoop } from './quality';
import { buildDiagnosisContext, localDiagnosis, validateDiagnosis, validateProposal } from './diagnosis';
import type { GeoProposal, GeoSeed, GeoTask } from './types';
import type { StrategyMemory } from './workflow-types';

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
    const task = { goal: 'Improve discovery', workflow: { protocolKey: 'deepseek-p1', questions: [{ id: 'q1', query: 'Question?',
      category: 'content', target: 'article', assetIds: ['article'], exploratory: false }], baseline: { id: 'b', mode: 'live', status: 'completed',
      protocolKey: 'deepseek-p1', phase: 'baseline', measurementAt: '2026-10-22T01:00:00Z', completedCount: 1,
      questions: [{ id: 'q1', query: 'Question?', resultCount: 1, projectHit: false, evidencePath: 'data/geo-evidence/b/q1.json' }] } } } as unknown as GeoTask;
    const strategy = { id: 's1', projectId: 'project', protocolKey: 'deepseek-p1', targetAssetId: 'article', categories: ['content'] } as StrategyMemory;
    const context = buildDiagnosisContext(task, seed, [strategy, { ...strategy, id: 'other-platform', protocolKey: 'gemini' }, { ...strategy, id: 'other-target', targetAssetId: 'absent' }]);
    assert.equal(context.evidenceReady, true); assert.equal(context.questions[0].sources[0].summary, 'A returned summary.');
    assert.equal(context.questions[0].sources[0].contentProvided, false); assert.equal(context.materials[0].markdownIsExcerpt, true);
    assert.deepEqual(context.strategies.map(item => item.id), ['s1']);
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

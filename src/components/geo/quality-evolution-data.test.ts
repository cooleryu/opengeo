import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeoProposal, GeoTask } from '../../lib/geo/types';
import type { QualityLoop, QualityReview } from '../../lib/geo/workflow-types';
import { buildQualityEvolution } from './quality-evolution-data';

const original: GeoProposal = {
  id: 'p',
  title: 'Clarify scope',
  status: 'draft',
  rationale: 'Observed confusion',
  targetAssetId: 'article',
  targetUrl: 'https://example.org/article',
  before: 'Original.',
  after: 'Clarified.',
  changes: ['Add definition'],
  evidencePaths: ['evidence.json'],
  successCriteria: ['Repeat query'],
  limitations: ['Single observation'],
};
const review = (
  score: number,
  time: number,
  options: Partial<QualityReview> = {},
): QualityReview => ({
  source: 'model',
  criteriaVersion: 'v1',
  proposalDigest: `candidate-${time}`,
  reviewedAt: `2026-10-23T01:00:0${time}.000Z`,
  total: score,
  passed: score >= 80,
  scores: {
    evidence: score,
    relevance: score,
    actionability: score,
    verifiability: score,
  },
  issues: [],
  summary: 'Saved assessment',
  ...options,
});
const loop = (
  rounds: QualityLoop['rounds'],
  bestRound = rounds.length,
): QualityLoop => ({
  maxRounds: 3,
  targetScore: 80,
  minimumDimensionScore: 70,
  rounds,
  bestRound,
  stopReason: 'round_limit',
});
const task = (
  quality: QualityLoop,
  qualityHistory: NonNullable<GeoTask['workflow']>['qualityHistory'] = [],
): GeoTask =>
  ({
    proposal: quality.rounds.find((item) => item.round === quality.bestRound)
      ?.candidate,
    workflow: { quality, qualityHistory, proposalRevision: 2 },
  }) as GeoTask;

test('continued seed is shown once and a plan-only improvement never becomes a body rewrite', () => {
  const seed = { round: 1, candidate: original, review: review(79.8, 1) };
  const revised = {
    ...original,
    successCriteria: ['Repeat the fixed query once after 24 hours'],
  };
  const current = loop([
    seed,
    { round: 2, candidate: revised, review: review(83, 2) },
  ]);
  const result = buildQualityEvolution(
    task(current, [{ proposalRevision: 1, quality: loop([seed]) }]),
  );
  assert.equal(result.frames.length, 2);
  assert.deepEqual(result.frames[0].proposalRevisions, [1, 2]);
  assert.equal(result.frames[0].comparison.bodyChanged, true);
  assert.equal(
    result.frames[0].comparison.changes.find(
      (change) => change.field === 'successCriteria',
    )?.before,
    null,
  );
  assert.equal(result.frames[1].comparison.bodyChanged, false);
  assert.deepEqual(
    result.frames[1].comparison.changes
      .filter((change) => change.changed)
      .map((change) => change.field),
    ['successCriteria'],
  );
  assert.equal(result.frames[1].scoreDelta, 3.2);
  assert.equal(result.retainedFrameId, result.frames[1].id);
});

test('later re-reviews supersede an older verdict on the retained candidate', () => {
  const first = { round: 1, candidate: original, review: review(79, 1) };
  const worse = { ...original, after: 'Less precise.' };
  const second = { round: 2, candidate: worse, review: review(75, 2) };
  const third = {
    round: 3,
    candidate: original,
    review: review(78, 3, { proposalDigest: first.review.proposalDigest }),
  };
  const record = task(loop([first, second, third], 1));
  record.proposal = { ...original, status: 'accepted' };
  const result = buildQualityEvolution(record);
  assert.equal(result.frames.length, 3);
  assert.equal(result.frames[1].scoreDelta, -4);
  assert.equal(result.retainedFrameId, result.frames[2].id);
  assert.equal(result.retainedFrameId, result.latestFrameId);
  record.proposal = {
    ...original,
    successCriteria: ['Unreviewed manual edit'],
  };
  assert.equal(buildQualityEvolution(record).retainedFrameId, null);
});

test('a later failed review of the same digest cannot reuse an earlier approval', () => {
  const passed = { round: 1, candidate: original, review: review(90, 1) };
  const failed = {
    round: 2,
    candidate: original,
    review: review(90, 2, {
      proposalDigest: passed.review.proposalDigest,
      passed: false,
      issues: [
        {
          dimension: 'verifiability',
          severity: 'blocking' as const,
          detail: 'Missing outcome acceptance',
          suggestion: 'Review the acceptance criteria',
        },
      ],
    }),
  };
  for (const reviewedAt of [
    failed.review.reviewedAt,
    passed.review.reviewedAt,
  ]) {
    const result = buildQualityEvolution(
      task(
        loop(
          [passed, { ...failed, review: { ...failed.review, reviewedAt } }],
          1,
        ),
      ),
    );
    const retained = result.frames.find((frame) => frame.isRetained);
    assert.equal(result.frames.length, 2);
    assert.equal(result.frames[0].review.passed, true);
    assert.equal(retained?.review.passed, false);
    assert.equal(retained?.review.issues[0].severity, 'blocking');
  }
});

test('local checks are unscored and changed criteria prevent numerical improvement claims', () => {
  const result = buildQualityEvolution(
    task(
      loop([
        {
          round: 1,
          candidate: original,
          review: review(0, 1, { source: 'local' }),
        },
        { round: 2, candidate: original, review: review(70, 2) },
        {
          round: 3,
          candidate: original,
          review: review(90, 3, { criteriaVersion: 'v2' }),
        },
      ]),
    ),
  );
  assert.equal(result.frames[0].score, null);
  assert.equal(result.frames[1].scoreDelta, null);
  assert.equal(result.frames[2].criteriaChanged, true);
  assert.equal(result.frames[2].scoreDelta, null);
  assert.equal(result.frames[2].dimensionDeltas, null);
  assert.equal(result.hasMixedCriteria, true);
});

test('continuation and manual re-review compare to the retained source instead of a discarded attempt', () => {
  const first = { round: 1, candidate: original, review: review(70, 1) };
  const retained = {
    round: 2,
    candidate: { ...original, after: 'Retained body.' },
    review: review(75, 2),
  };
  const discarded = {
    round: 3,
    candidate: { ...original, after: 'Discarded body.' },
    review: review(73, 3),
  };
  const history = [
    { proposalRevision: 1, quality: loop([first, retained, discarded], 2) },
  ];
  const improved = {
    round: 2,
    candidate: { ...original, after: 'Revised from retained body.' },
    review: review(79, 4),
  };
  const continued = buildQualityEvolution(
    task(loop([{ ...retained, round: 1 }, improved]), history),
  );
  const frame = continued.frames[3];
  assert.equal(frame.previousFrameId, continued.frames[1].id);
  assert.equal(frame.previousSequence, 2);
  assert.equal(frame.scoreDelta, 4);
  assert.equal(frame.dimensionDeltas?.evidence, 4);
  assert.equal(frame.comparison.changes[0].before, 'Retained body.');
  const manual = buildQualityEvolution(
    task(loop([{ ...improved, round: 1 }]), history),
  );
  assert.equal(manual.frames[3].previousSequence, 2);
  assert.equal(manual.frames[3].comparison.changes[0].before, 'Retained body.');
});

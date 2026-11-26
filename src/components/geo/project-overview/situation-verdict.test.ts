import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSituationVerdict } from './situation-verdict';

const emptyOfficial: Parameters<typeof buildSituationVerdict>[0]['officialMetrics'] = {
  completed: 0,
  found: 0,
  unmeasured: 0,
  measuredQuestions: 0,
  coveredQuestions: 0,
  totalQuestions: 0,
  rate: null,
};

test('brand-only verdict labels non-branded denominator as answers rather than prompts', () => {
  const verdict = buildSituationVerdict({
    sourceOnly: false,
    isEn: true,
    officialMetrics: emptyOfficial,
    mention: {
      rate: 12.5,
      minimumRate: 12.5,
      yes: 1,
      no: 8,
      unknown: 0,
      completed: 9,
      unmeasured: 7,
      questions: 8,
    },
    topLeaderNames: 'Stake.us',
    brandSplit: { yes: 1, total: 1 },
    discoverySplit: { yes: 0, total: 8 },
    brandLabel: 'SweepsDuke',
    strongestPlatform: null,
    weakestPlatform: null,
    citation: {
      rate: 12.5,
      minimumRate: 12.5,
      yes: 1,
      no: 8,
      unknown: 0,
      completed: 9,
      unmeasured: 7,
      questions: 8,
    },
  });

  assert.equal(
    verdict.headline,
    'Visible on brand searches only — 0/8 non-branded answers',
  );
});

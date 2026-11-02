import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorComparison, CompetitorRow, CompetitorSelection } from './competitor-types';
import { getCompetitorProgress } from './competitor-progress';

const row = (questionId: string, own = false, target = true, extra: Partial<CompetitorRow> = {}): CompetitorRow => ({
  id: questionId, questionId, question: questionId, query: questionId, observationIndex: 0,
  engine: 'qwen', entryType: 'api_answer', language: 'zh', recordedAt: '2026-10-28T00:00:00Z',
  conditions: 'model-A · 联网', evidencePath: questionId, answerAvailable: true, sourcesAvailable: true,
  ownMention: { status: own ? 'matched' : 'not_seen', names: [], excerpts: [] },
  targetMention: { status: target ? 'matched' : 'not_seen', names: [], excerpts: [] }, sources: [], ...extra,
});
const target = { name: '参照', aliases: [], officialUrls: ['https://example.com'], updatedAt: '' };
const comparison = (rows: CompetitorRow[]): CompetitorComparison => ({ projectId: 'p', own: { name: '自己', aliases: [], officialUrls: [] }, target, batch: { id: 'b', date: '' }, rows });
const selection = (rows: CompetitorRow[]): CompetitorSelection => ({ id: 'selection', projectId: 'p', batchId: 'b', candidateId: 'c', selectedAt: '2026-10-29T00:00:00Z', target, baseline: { batch: { id: 'b', date: '' }, rows } });
const newer = { recordedAt: '2026-10-30T00:00:00Z', observationIndex: 1 };

test('selecting and rereading a reference is not progress', () => {
  const rows = [row('q1')];
  const result = getCompetitorProgress(comparison(rows), selection(rows));
  assert.equal(result.gap, 100);
  assert.equal(result.ownChange, null);
  assert.equal(result.gapChange, null);
  assert.equal(result.hasFollowup, false);
});

test('self progress and closing the gap are two independent measures', () => {
  const baseline = [row('q1'), row('q2', false, false)];
  const result = getCompetitorProgress(comparison([row('q1', true, true, newer), row('q2', false, true, newer)]), selection(baseline));
  assert.equal(result.ownChange, 50);
  assert.equal(result.gapChange, 0); // Competitor improved equally.
  assert.equal(result.baselineGap, 50);
  assert.equal(result.gap, 50);
});

test('missing samples, changed conditions and unknown outcomes never fabricate gains', () => {
  const baseline = [row('q1'), row('q2')];
  const variants = [
    [row('q1', true, true, newer)],
    [row('q1', true, true, newer), row('q2', true, true, { ...newer, conditions: 'model-B' })],
    [row('q1', true, true, newer), row('q2', true, true, { ...newer, answerAvailable: false })],
    [row('q1', true, true, newer), row('q2')],
  ];
  for (const rows of variants) {
    const result = getCompetitorProgress(comparison(rows), selection(baseline));
    assert.equal(result.ownChange, null);
    assert.equal(result.gapChange, null);
  }
});

test('new questions do not change the frozen denominator for progress', () => {
  const result = getCompetitorProgress(comparison([row('q1', true, true, newer), row('new', false, true, newer)]), selection([row('q1')]));
  assert.equal(result.current.own.rate, 50);
  assert.equal(result.ownChange, 100);
  assert.equal(result.gapChange, 100);
  assert.equal(result.pairedQuestions, 1);
});

test('scope keeps language and source-only search separate', () => {
  const baseline = [row('q1'), row('q1', false, true, { language: 'en' }), row('q2', true, true, { entryType: 'api_search' })];
  const current = [row('q1', true, true, newer), baseline[1], baseline[2]];
  const result = getCompetitorProgress(comparison(current), selection(baseline), { language: 'zh', engine: 'qwen' });
  assert.equal(result.current.own.total, 1);
  assert.equal(result.ownChange, 100);
});

test('reauditing an old observation and prose dates cannot pretend to be a new followup', () => {
  const original = row('q1');
  for (const recordedAt of ['2026-10-28T01:00:00Z', '2026-10-30 imported window']) {
    assert.equal(getCompetitorProgress(comparison([row('q1', true, true, { recordedAt })]), selection([original])).ownChange, null);
  }
});

test('a later source-only search does not remove an AI answer from the sample', () => {
  const result = getCompetitorProgress(comparison([
    row('q1', true, true, newer),
    row('q1', false, false, { ...newer, recordedAt: '2026-10-31T00:00:00Z', entryType: 'api_search' }),
  ]), selection([row('q1')]));
  assert.equal(result.current.own.total, 1);
  assert.equal(result.current.own.rate, 100);
  assert.equal(result.ownChange, 100);
});

test('catching up stops at parity and an increasing lead is only self improvement', () => {
  const baseline = [row('q1'), row('q2', false, false)];
  const result = getCompetitorProgress(comparison([
    row('q1', true, true, newer), row('q2', true, false, newer),
  ]), selection(baseline));
  assert.equal(result.gap, -50);
  assert.equal(result.ownChange, 100);
  assert.equal(result.gapChange, 50);

  const leading = getCompetitorProgress(comparison([
    row('q1', true, false, newer), row('q2', true, false, newer),
  ]), selection([row('q1', true, false), row('q2', false, false)]));
  assert.equal(leading.ownChange, 50);
  assert.equal(leading.gapChange, 0);
});

test('a different target or matching definition cannot reuse the selected baseline', () => {
  const before = selection([row('q1')]);
  for (const changedTarget of [
    { ...target, name: '另一个参照' },
    { ...target, aliases: ['新别名'] },
    { ...target, officialUrls: ['https://other.example.com'] },
  ]) {
    const result = getCompetitorProgress({ ...comparison([row('q1', true, true, newer)]), target: changedTarget }, before);
    assert.equal(result.ownChange, null);
    assert.equal(result.gapChange, null);
    assert.equal(result.baseline.own.total, 0);
  }
  const unchanged = getCompetitorProgress({ ...comparison([row('q1', true, true, newer)]), target: { ...target, updatedAt: '2026-11-01T00:00:00Z' } }, before);
  assert.equal(unchanged.ownChange, 100);
});

test('legacy selections need the same server-associated selection to establish identity', () => {
  const before = { ...selection([row('q1')]), target: undefined };
  const current = comparison([row('q1', true, true, newer)]);
  assert.equal(getCompetitorProgress(current, before).ownChange, null);
  assert.equal(getCompetitorProgress({ ...current, selection: { ...before, id: 'other' } }, before).ownChange, null);
  assert.equal(getCompetitorProgress({ ...current, selection: before }, before).ownChange, 100);
});

test('absent conditions, entry mode and ambiguous timestamps do not establish comparability', () => {
  for (const extra of [
    { conditions: '' },
    { entryType: undefined },
    { collectedAt: '2026-10-30' },
    { recordedAt: '2026-10-30T00:00:00' },
  ] satisfies Partial<CompetitorRow>[]) {
    const before = row('q1', false, true, extra);
    const after = row('q1', true, true, { ...newer, ...extra });
    assert.equal(getCompetitorProgress(comparison([after]), selection([before])).ownChange, null);
  }
  assert.equal(getCompetitorProgress(comparison([row('q1', true, true, newer)]), {
    ...selection([row('q1')]), selectedAt: '2026-10-29',
  }).ownChange, null);
});

test('unknown target results leave self progress measurable but the gap unknown', () => {
  const result = getCompetitorProgress(comparison([row('q1', true, false, {
    ...newer, targetMention: { status: 'unknown', names: [], excerpts: [] },
  })]), selection([row('q1')]));
  assert.equal(result.ownChange, 100);
  assert.equal(result.gap, null);
  assert.equal(result.gapChange, null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorRow } from './competitor-types';
import {
  summarizeCompetitorMentions,
  formatCompetitorMention,
} from './competitor-metrics';

const row = (
  questionId: string,
  status: 'matched' | 'not_seen' | 'unknown',
  extra: Partial<CompetitorRow> = {},
): CompetitorRow => ({
  id: questionId,
  questionId,
  question: questionId,
  query: questionId,
  observationIndex: 0,
  engine: 'chatgpt',
  language: 'zh',
  recordedAt: '2026-10-29T01:00:00Z',
  conditions: '',
  evidencePath: '',
  answerAvailable: status !== 'unknown',
  sourcesAvailable: true,
  ownMention: { status: 'not_seen', names: [], excerpts: [] },
  targetMention: { status, names: [], excerpts: [] },
  sources: [],
  ...extra,
});

test('candidate mentions include negative and unknown answers in the shared denominator', () => {
  const rows = [
    row('q1', 'matched'),
    row('q2', 'not_seen'),
    row('q3', 'unknown'),
  ];
  const summary = summarizeCompetitorMentions(rows, 'target');
  assert.equal(summary.total, 3);
  assert.equal(summary.rate, null);
  assert.equal(summary.unknown, 1);
  assert.equal(formatCompetitorMention(summary), '至少 33.3%');
  assert.equal(summarizeCompetitorMentions(rows, 'own').total, summary.total);
});

test('latest observations replace history without dropping a newly unreadable answer', () => {
  const summary = summarizeCompetitorMentions(
    [
      row('q1', 'matched'),
      row('q1', 'unknown', { recordedAt: '2026-10-29T02:00:00Z' }),
      row('q2', 'not_seen'),
    ],
    'target',
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.yes, 0);
  assert.equal(summary.unknown, 1);
  assert.equal(formatCompetitorMention(summary), '待核实');
});

test('search sources never become AI mentions, including API search from a vendor with answer APIs', () => {
  const summary = summarizeCompetitorMentions(
    [
      row('q1', 'matched', { engine: 'google' }),
      row('q1', 'matched', { engine: 'qwen', entryType: 'api_search' }),
    ],
    'target',
  );
  assert.equal(summary.total, 0);
  assert.equal(formatCompetitorMention(summary), '未测');
});

test('a later search record never removes the same platforms answer from the denominator', () => {
  const summary = summarizeCompetitorMentions([
    row('q1', 'not_seen', { engine: 'qwen', entryType: 'api_answer' }),
    row('q1', 'matched', { engine: 'qwen', entryType: 'api_search', recordedAt: '2026-10-30T00:00:00Z' }),
    row('q2', 'matched'),
  ], 'target');
  assert.equal(summary.total, 2);
  assert.equal(summary.no, 1);
  assert.equal(summary.rate, 50);
});

test('multiple platforms within one question do not outweigh another question', () => {
  const summary = summarizeCompetitorMentions(
    [
      row('q1', 'matched'),
      row('q1', 'matched', { engine: 'qwen' }),
      row('q2', 'not_seen'),
    ],
    'target',
  );
  assert.equal(summary.rate, 50);
  assert.equal(summary.yes, 2);
  assert.equal(summary.total, 3);
  assert.equal(
    formatCompetitorMention(
      summarizeCompetitorMentions([row('q1', 'unknown')], 'target'),
    ),
    '待核实',
  );
});

test('latest record uses actual time and collection time, consistent with the overview', () => {
  const summary = summarizeCompetitorMentions(
    [
      row('q1', 'matched', { recordedAt: '2026-10-29T01:00:00Z' }),
      row('q1', 'not_seen', { recordedAt: '2026-10-29T08:30:00+08:00' }),
      row('q2', 'matched', { collectedAt: '2026-10-29T02:00:00Z' }),
      row('q2', 'not_seen', { recordedAt: '2026-10-29T01:30:00Z' }),
    ],
    'target',
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.yes, 2);
  assert.equal(summary.rate, 100);
});

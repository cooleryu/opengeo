import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getCompetitorGapProgress,
  getCompetitorQuestionGaps,
} from './competitor-question-gaps';
import type {
  CandidateQuestion,
  CompetitorAnalysis,
  CompetitorCandidate,
  CompetitorComparison,
  CompetitorRow,
  CompetitorSelection,
} from './competitor-types';

const scope = { language: 'zh', engine: 'all' } as const;
const row = (
  questionId: string,
  extra: Partial<CompetitorRow> = {},
): CompetitorRow => ({
  id: questionId,
  questionId,
  question: `问题 ${questionId}`,
  query: questionId,
  observationIndex: 0,
  engine: 'chatgpt',
  entryType: 'web_answer',
  language: 'zh',
  recordedAt: '2026-10-29T01:00:00Z',
  conditions: '联网',
  evidencePath: `${questionId}/evidence.json`,
  answerPath: `${questionId}/answer.md`,
  answerAvailable: true,
  sourcesAvailable: true,
  ownMention: { status: 'not_seen', names: [], excerpts: [] },
  targetMention: { status: 'matched', names: ['竞品'], excerpts: ['竞品回答'] },
  sources: [],
  ...extra,
});
const comparison = (rows: CompetitorRow[]): CompetitorComparison => ({
  projectId: 'project',
  own: { name: '我们', aliases: [], officialUrls: [] },
  target: { name: '竞品', aliases: [], officialUrls: [], updatedAt: '' },
  batch: { id: 'batch', date: '2026-10-29' },
  rows,
});
const evidence = (
  answer: CompetitorRow,
  extra: Partial<CandidateQuestion> = {},
): CandidateQuestion => ({
  evidenceId: 'evidence-1',
  batchId: 'batch',
  questionId: answer.questionId,
  question: answer.question,
  language: answer.language,
  engine: answer.engine,
  recordedAt: answer.recordedAt,
  collectedAt: answer.collectedAt,
  evidencePath: answer.evidencePath,
  answerPath: answer.answerPath,
  observationIndex: answer.observationIndex,
  sourceUrl: 'https://example.com',
  excerpt: '竞品回答',
  ...extra,
});
const opportunity = (
  questionId: string,
  evidenceIds = ['evidence-1'],
): CompetitorAnalysis['opportunities'][number] => ({
  questionId,
  title: '补充案例',
  observed: '竞品出现在这条回答中。',
  hypothesis: '具体案例可能帮助解释适用范围。',
  action: '补充可验证案例，再按原问题复测。',
  evidenceIds,
});
const candidate = (
  questions: CandidateQuestion[],
  opportunities = [opportunity(questions[0].questionId)],
): CompetitorCandidate => ({
  id: 'candidate',
  name: '竞品',
  aliases: [],
  officialUrls: [],
  description: '',
  reason: '',
  saved: true,
  questions,
  analysis: {
    status: 'ready',
    description: '',
    reason: '',
    strengths: [],
    opportunities,
    limitations: [],
    evidenceIds: questions.map((record) => record.evidenceId!),
    quotes: questions.map((record) => ({
      evidenceId: record.evidenceId!,
      quote: record.excerpt,
    })),
    version: 'test',
  },
});

test('groups every platform answer once and preserves saved question order', () => {
  const q2Chatgpt = row('q2');
  const q1Chatgpt = row('q1');
  const q1Qwen = row('q1', { engine: 'qwen', entryType: 'api_answer' });
  const q2Qwen = row('q2', { engine: 'qwen', entryType: 'api_answer' });
  const currentQ2Chatgpt = row('q2', {
    observationIndex: 1,
    recordedAt: '2026-10-29T02:00:00Z',
    ownMention: { status: 'matched', names: ['我们'], excerpts: [] },
  });
  const result = getCompetitorQuestionGaps(
    comparison([q2Chatgpt, q1Chatgpt, q1Qwen, q2Qwen, currentQ2Chatgpt]),
    null,
    scope,
  );
  assert.deepEqual(
    result.map((group) => group.questionId),
    ['q2', 'q1'],
  );
  assert.equal(result[0].question, q2Qwen.question);
  assert.deepEqual(
    result[0].answers.map((answer) => answer.row),
    [q2Qwen],
  );
  assert.deepEqual(
    result[1].answers.map((answer) => answer.row),
    [q1Chatgpt, q1Qwen],
  );
  assert.ok(
    result.every((group) =>
      group.answers.every((answer) => !answer.opportunities.length),
    ),
  );
});

test('latest answer replaces a historical gap before gap filtering', () => {
  const original = row('q1');
  for (const newer of [
    { ownMention: { status: 'matched' as const, names: [], excerpts: [] } },
    { ownMention: { status: 'unknown' as const, names: [], excerpts: [] } },
    { targetMention: { status: 'not_seen' as const, names: [], excerpts: [] } },
    { answerAvailable: false },
  ]) {
    const current = row('q1', {
      observationIndex: 1,
      collectedAt: '2026-10-29T02:00:00Z',
      ...newer,
    });
    assert.deepEqual(
      getCompetitorQuestionGaps(comparison([original, current]), null, scope),
      [],
    );
  }
});

test('unknown mentions and unavailable answers never count as gaps', () => {
  const rows = [
    row('q1', { ownMention: { status: 'unknown', names: [], excerpts: [] } }),
    row('q2', {
      targetMention: { status: 'unknown', names: [], excerpts: [] },
    }),
    row('q3', { answerAvailable: false }),
  ];
  assert.deepEqual(
    getCompetitorQuestionGaps(comparison(rows), undefined, scope),
    [],
  );
});

test('scope uses the latest record before AI filtering, matching overview metrics', () => {
  const answer = row('q1', { engine: 'qwen', entryType: 'api_answer' });
  const currentAnswer = row('q5', { engine: 'qwen', entryType: 'api_answer' });
  const rows = [
    answer,
    row('q1', {
      engine: 'qwen',
      entryType: 'api_search',
      recordedAt: '2026-10-30T01:00:00Z',
    }),
    row('q2', { language: 'en', engine: 'qwen' }),
    row('q3'),
    row('q4', { engine: 'google', entryType: 'web_search' }),
    currentAnswer,
  ];
  const selected = candidate([evidence(answer)]);
  const result = getCompetitorQuestionGaps(comparison(rows), selected, {
    language: 'zh',
    engine: 'qwen',
  });
  assert.deepEqual(
    result.map((group) => group.questionId),
    ['q5'],
  );
  assert.equal(result[0].answers[0].row, currentAnswer);
  assert.deepEqual(result[0].answers[0].opportunities, []);
  assert.deepEqual(
    getCompetitorQuestionGaps(comparison(rows), selected, scope).map(
      (group) => group.questionId,
    ),
    ['q3', 'q5'],
  );
});

test('actions cannot borrow cross-question, cross-platform or obsolete evidence', () => {
  const answer = row('q1');
  const otherRecords: Partial<CandidateQuestion>[] = [
    { questionId: 'q2' },
    { engine: 'qwen' },
    { language: 'en' },
    { batchId: 'old-batch' },
    { observationIndex: 1 },
    { recordedAt: '2026-10-28T01:00:00Z' },
    { answerPath: 'old-answer.md' },
  ];
  for (const extra of otherRecords) {
    const selected = candidate([evidence(answer, extra)], [opportunity('q1')]);
    const result = getCompetitorQuestionGaps(
      comparison([answer]),
      selected,
      scope,
    );
    assert.equal(result.length, 1);
    assert.deepEqual(
      result[0].answers[0].opportunities,
      [],
      JSON.stringify(extra),
    );
  }
  const selected = candidate(
    [evidence(answer)],
    [opportunity('q2'), opportunity('q1', ['missing']), opportunity('q1', [])],
  );
  assert.deepEqual(
    getCompetitorQuestionGaps(comparison([answer]), selected, scope)[0]
      .answers[0].opportunities,
    [],
  );
});

test('every referenced evidence item must match, with no fallback to another scope', () => {
  const answer = row('q1');
  const current = evidence(answer);
  const otherPlatform = evidence(answer, {
    evidenceId: 'evidence-2',
    engine: 'qwen',
  });
  const selected = candidate(
    [current, otherPlatform],
    [
      opportunity('q1', ['evidence-1', 'evidence-2']),
      opportunity('q1', ['evidence-2']),
    ],
  );
  const result = getCompetitorQuestionGaps(
    comparison([answer]),
    selected,
    scope,
  );
  assert.deepEqual(result[0].answers[0].opportunities, []);
});

test('valid actions retain all their evidence on the corresponding current answer', () => {
  const answer = row('q1');
  const records = [
    evidence(answer),
    evidence(answer, {
      evidenceId: 'evidence-2',
      sourceUrl: 'https://example.com/case',
    }),
  ];
  const action = opportunity('q1', ['evidence-1', 'evidence-2']);
  const selected = candidate(records, [action]);
  selected.analysis!.stale = true;
  const result = getCompetitorQuestionGaps(
    comparison([answer]),
    selected,
    scope,
  );
  assert.deepEqual(result[0].answers[0].opportunities, [
    { ...action, evidence: records },
  ]);
  assert.equal(selected.analysis!.opportunities[0], action);
  assert.equal(selected.questions, records);
});

test('records without an answer path must match the underlying evidence path', () => {
  const answer = row('q1', { answerPath: undefined });
  const selected = candidate([evidence(answer)]);
  assert.equal(
    getCompetitorQuestionGaps(comparison([answer]), selected, scope)[0]
      .answers[0].opportunities.length,
    1,
  );
  selected.questions[0].evidencePath = 'old-evidence.json';
  assert.deepEqual(
    getCompetitorQuestionGaps(comparison([answer]), selected, scope)[0]
      .answers[0].opportunities,
    [],
  );
});

test('missing comparison is empty, and missing batch or unready analysis retains only answers', () => {
  assert.deepEqual(getCompetitorQuestionGaps(undefined, undefined, scope), []);
  const answer = row('q1');
  const selected = candidate([evidence(answer)]);
  const withoutBatch = { ...comparison([answer]), batch: null };
  assert.deepEqual(
    getCompetitorQuestionGaps(withoutBatch, selected, scope)[0].answers[0]
      .opportunities,
    [],
  );
  selected.analysis!.status = 'pending';
  assert.deepEqual(
    getCompetitorQuestionGaps(comparison([answer]), selected, scope)[0]
      .answers[0].opportunities,
    [],
  );
});

test('followup progress retains a resolved baseline gap after current gaps move to another question', () => {
  const baseline = comparison([row('q1'), row('q2')]);
  const selection: CompetitorSelection = {
    id: 'selection',
    projectId: baseline.projectId,
    batchId: baseline.batch!.id,
    candidateId: 'candidate',
    selectedAt: '2026-10-29T02:00:00Z',
    target: baseline.target!,
    baseline: { batch: baseline.batch, rows: baseline.rows },
  };
  const current = comparison([
    row('q1', {
      observationIndex: 1,
      recordedAt: '2026-10-30T01:00:00Z',
      ownMention: { status: 'matched', names: ['我们'], excerpts: [] },
    }),
    row('q2', {
      observationIndex: 1,
      recordedAt: '2026-10-30T01:00:00Z',
    }),
  ]);
  assert.deepEqual(
    getCompetitorQuestionGaps(current, undefined, scope).map(
      (gap) => gap.questionId,
    ),
    ['q2'],
  );
  const results = getCompetitorGapProgress(current, selection, scope);
  assert.deepEqual(
    results.map((result) => result.questionId),
    ['q1', 'q2'],
  );
  assert.equal(results[0].question, baseline.rows[0].question);
  assert.equal(results[0].progress.ownChange, 100);
  assert.equal(results[0].progress.gapChange, 100);
  assert.equal(results[1].progress.ownChange, 0);
});

test('a newer search record prevents a historical AI improvement from reappearing', () => {
  const baseline = comparison([row('q1')]);
  const selection: CompetitorSelection = {
    id: 'selection',
    projectId: baseline.projectId,
    batchId: baseline.batch!.id,
    candidateId: 'candidate',
    selectedAt: '2026-10-29T02:00:00Z',
    target: baseline.target!,
    baseline: { batch: baseline.batch, rows: baseline.rows },
  };
  const current = comparison([
    row('q1', {
      observationIndex: 1,
      recordedAt: '2026-10-30T01:00:00Z',
      ownMention: { status: 'matched', names: ['我们'], excerpts: [] },
    }),
    row('q1', {
      observationIndex: 2,
      recordedAt: '2026-10-31T01:00:00Z',
      entryType: 'web_search',
    }),
  ]);
  const original = structuredClone({ current, selection });
  const results = getCompetitorGapProgress(current, selection, scope);
  assert.equal(results.length, 1);
  assert.equal(results[0].progress.current.own.total, 0);
  assert.equal(results[0].progress.ownChange, null);
  assert.equal(results[0].progress.gapChange, null);
  assert.deepEqual({ current, selection }, original);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorComparison, CompetitorRow } from './competitor-types';
import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
} from './research-types';
import {
  auditRows,
  getOverviewComparison,
  summarizeMetric,
} from './overview-metrics';
import type { AnswerAuditRecord, AuditedResearchRow } from './overview-metrics';

const observation = (
  changes: Partial<ResearchObservation> = {},
): ResearchObservation => ({
  engine: 'chatgpt',
  language: 'zh',
  query: 'Question',
  recordedAt: '2026-10-24T10:00:00Z',
  status: 'found',
  summary: 'Official source found; body mention requires audit.',
  conditions: 'same conditions',
  sources: [],
  evidencePath: 'capture.json',
  answerPath: 'answer.md',
  ...changes,
});
const question = (
  id: string,
  observations: ResearchObservation[],
): ResearchQuestion => ({
  id,
  zh: id,
  en: id,
  observations,
  decision: 'search_now',
  valueReason: '',
  evidenceBasis: '',
  answerability: '',
  gaps: [],
  decisionReason: '',
  reviewPath: '',
  diagnosis: { observed: '', hypothesis: '', nextStep: '' },
});
const batch = (questions: ResearchQuestion[]): ResearchBatch => ({
  id: 'batch',
  projectId: 'project',
  date: '2026-10-24',
  questions,
  deferredQuestions: [],
  productSummary: '',
  contributionSummary: '',
  scopeNote: '',
  reportPath: '',
  sourceAuditPath: '',
  reviewPath: '',
  nextStep: '',
});
const rowsFor = (value: ResearchBatch): AuditedResearchRow[] =>
  value.questions.flatMap((question) =>
    (['chatgpt', 'google'] as const).flatMap((engine) => {
      const prefix = `${value.id}:${question.id}:${engine}:zh`;
      const matching = question.observations.flatMap((observation, index) =>
        observation.engine === engine && observation.language === 'zh'
          ? [{ key: `${prefix}:${index}`, question, engine, observation }]
          : [],
      );
      return matching.length
        ? matching
        : [{ key: `${prefix}:unmeasured`, question, engine }];
    }),
  );
const auditFor = (
  row: AuditedResearchRow,
  changes: Partial<AnswerAuditRecord> = {},
): AnswerAuditRecord => ({
  projectId: 'project',
  batchId: 'batch',
  questionId: row.question.id,
  engine: row.engine === 'google' ? 'google' : 'chatgpt',
  language: row.observation!.language,
  recordedAt: row.observation!.recordedAt,
  mention: 'yes',
  citation: 'no',
  mentionEvidence: 'Name in answer body',
  citationEvidence: 'No official URL cited',
  officialUrls: ['https://own.example'],
  evidencePath: row.observation!.answerPath ?? row.observation!.evidencePath,
  answerComplete: true,
  ...changes,
});
const comparisonFor = (
  rows: AuditedResearchRow[],
  targetMention: CompetitorRow['targetMention']['status'] = 'matched',
): CompetitorComparison => ({
  projectId: 'project',
  batch: { id: 'batch', date: '2026-10-24' },
  own: { name: 'Own', aliases: [], officialUrls: ['https://own.example'] },
  target: {
    name: 'Target',
    aliases: [],
    officialUrls: ['https://target.example'],
    updatedAt: '',
  },
  rows: rows.flatMap((row, index) =>
    row.observation && (row.engine === 'chatgpt' || row.engine === 'google')
      ? [
          {
            id: `${row.question.id}:${index}`,
            questionId: row.question.id,
            question: row.question.zh,
            query: row.observation.query,
            observationIndex: index,
            engine: row.engine,
            language: row.observation.language,
            recordedAt: row.observation.recordedAt,
            conditions: row.observation.conditions,
            evidencePath: row.observation.evidencePath,
            answerPath: row.observation.answerPath,
            answerAvailable: true,
            sourcesAvailable: true,
            ownMention: {
              status: row.audit?.mention === 'yes' ? 'matched' : 'not_seen',
              names: [],
              excerpts: [],
            },
            targetMention: { status: targetMention, names: [], excerpts: [] },
            sources: [],
          },
        ]
      : [],
  ),
});

test('repeat measurements are averaged within questions before equal question weighting', () => {
  const value = batch([
    question('Q1', [
      observation(),
      observation({ recordedAt: 'later' }),
      observation({ recordedAt: 'latest' }),
    ]),
    question('Q2', [observation()]),
  ]);
  const rows = rowsFor(value);
  const audits = rows
    .filter((row) => row.observation)
    .map((row) =>
      auditFor(row, { mention: row.question.id === 'Q1' ? 'yes' : 'no' }),
    );
  assert.deepEqual(summarizeMetric(auditRows(value, rows, audits), 'mention'), {
    rate: 50,
    minimumRate: 50,
    yes: 3,
    no: 1,
    unknown: 0,
    completed: 4,
    unmeasured: 0,
    questions: 2,
  });
});

test('unknown and unmeasured answers stay distinct from negative observations', () => {
  const value = batch([
    question('Q1', [observation()]),
    question('Q2', []),
    question('Q3', [observation()]),
  ]);
  const rows = rowsFor(value);
  const audited = auditRows(value, rows, [
    auditFor(rows[0], { mention: 'no' }),
  ]);
  assert.deepEqual(summarizeMetric(audited, 'mention'), {
    rate: null,
    minimumRate: 0,
    yes: 0,
    no: 1,
    unknown: 1,
    completed: 2,
    unmeasured: 1,
    questions: 3,
  });
  assert.equal(
    summarizeMetric(
      audited.filter((row) => row.question.id === 'Q2'),
      'mention',
    ).rate,
    null,
  );
  assert.equal(
    summarizeMetric(
      audited.filter((row) => row.question.id !== 'Q3'),
      'mention',
    ).rate,
    0,
  );
});

test('one confirmed citation among eight answers gives a 12.5% lower bound, not an exact rate', () => {
  const value = batch(
    Array.from({ length: 8 }, (_, i) => question(`Q${i}`, [observation()])),
  );
  const rows = rowsFor(value);
  const audits = rows
    .filter((row) => row.observation)
    .map((row, i) =>
      auditFor(row, {
        citation: i === 0 ? 'yes' : i === 1 ? 'no' : 'unknown',
      }),
    );
  const result = summarizeMetric(auditRows(value, rows, audits), 'citation');
  assert.equal(result.rate, null);
  assert.equal(result.minimumRate, 12.5);
  assert.equal(result.yes, 1);
  assert.equal(result.unknown, 6);
  assert.equal(result.completed, 8);
});

test('mention and citation are independent and Google records never enter AI metrics', () => {
  const value = batch([
    question('Q1', [observation(), observation({ engine: 'google' })]),
  ]);
  const rows = rowsFor(value);
  const audited = auditRows(
    value,
    rows,
    rows.map((row) =>
      auditFor(row, {
        mention: row.engine === 'chatgpt' ? 'no' : 'yes',
        citation: 'yes',
      }),
    ),
  );
  assert.equal(summarizeMetric(audited, 'mention').rate, 0);
  assert.equal(summarizeMetric(audited, 'citation').rate, 100);
  assert.equal(summarizeMetric(audited, 'mention').completed, 1);
});

test('audits match exact project, batch, question, engine, language, time and answer path', () => {
  const value = batch([question('Q1', [observation()])]);
  const rows = rowsFor(value);
  const audit = auditFor(rows[0]);
  const changes: Partial<AnswerAuditRecord>[] = [
    { projectId: 'other' },
    { batchId: 'older' },
    { questionId: 'Q2' },
    { engine: 'google' },
    { language: 'en' },
    { recordedAt: 'older' },
    { evidencePath: 'capture.json' },
  ];
  const before = JSON.stringify(rows);
  for (const change of changes) {
    const audited = auditRows(value, rows, [{ ...audit, ...change }]);
    assert.equal(audited[0].audit, undefined);
    assert.equal(summarizeMetric(audited, 'mention').unknown, 1);
  }
  assert.equal(JSON.stringify(rows), before);
  const valid = auditRows(value, rows, [audit]);
  assert.equal(valid[0].audit, audit);
  assert.equal(auditRows(value, valid, [])[0].audit, undefined);
  assert.equal(
    summarizeMetric(
      auditRows(value, rows, [{ ...audit, answerComplete: false }]),
      'mention',
    ).unknown,
    1,
  );
});

test('evidence path fallback is exact and records outside the batch do not acquire an audit', () => {
  const value = batch([
    question('Q1', [observation({ answerPath: undefined })]),
  ]);
  const rows = rowsFor(value);
  assert.equal(
    auditRows(value, rows, [auditFor(rows[0])])[0].audit?.evidencePath,
    'capture.json',
  );
  const otherRows = rowsFor({ ...value, id: 'other-batch' });
  assert.equal(
    auditRows(value, otherRows, [auditFor(rows[0])])[0].audit,
    undefined,
  );
  assert.equal(
    auditRows({ ...value, questions: [] }, rows, [auditFor(rows[0])])[0].audit,
    undefined,
  );
});

test('comparable rates use question weights and the share uses those same rates', () => {
  const value = batch([
    question('Q1', [
      observation(),
      observation({ recordedAt: 'later' }),
      observation({ recordedAt: 'latest' }),
    ]),
    question('Q2', [observation()]),
  ]);
  const rows = rowsFor(value);
  const audited = auditRows(
    value,
    rows,
    rows
      .filter((row) => row.observation)
      .map((row) =>
        auditFor(row, { mention: row.question.id === 'Q1' ? 'yes' : 'no' }),
      ),
  );
  assert.deepEqual(getOverviewComparison(audited, comparisonFor(audited)), {
    ownRate: 50,
    targetRate: 100,
    share: 1 / 3,
    paired: 4,
    completed: 4,
    questions: 2,
    reason: null,
  });
});

test('both-zero rates are valid but do not produce a fabricated share', () => {
  const value = batch([question('Q1', [observation()])]);
  const rows = rowsFor(value);
  const audited = auditRows(value, rows, [
    auditFor(rows[0], { mention: 'no' }),
  ]);
  const result = getOverviewComparison(
    audited,
    comparisonFor(audited, 'not_seen'),
  );
  assert.equal(result.ownRate, 0);
  assert.equal(result.targetRate, 0);
  assert.equal(result.share, null);
  assert.match(result.reason!, /双方提及率均为 0/);
  assert.match(getOverviewComparison(audited, null).reason!, /尚未设置/);
});

test('one missing or unknown pair suppresses all overall comparison rates', () => {
  const value = batch([
    question('Q1', [observation()]),
    question('Q2', [observation()]),
  ]);
  const rows = rowsFor(value);
  const audited = auditRows(
    value,
    rows,
    rows.filter((row) => row.observation).map((row) => auditFor(row)),
  );
  const full = comparisonFor(audited);
  const variants = [
    { ...full, rows: full.rows.slice(0, 1) },
    {
      ...full,
      rows: full.rows.map((row, index) =>
        index
          ? {
              ...row,
              targetMention: {
                ...row.targetMention,
                status: 'unknown' as const,
              },
            }
          : row,
      ),
    },
    {
      ...full,
      rows: full.rows.map((row, index) =>
        index ? { ...row, recordedAt: 'older' } : row,
      ),
    },
    {
      ...full,
      rows: full.rows.map((row, index) =>
        index ? { ...row, language: 'en' as const } : row,
      ),
    },
    {
      ...full,
      rows: full.rows.map((row, index) =>
        index ? { ...row, answerPath: 'other.md' } : row,
      ),
    },
  ];
  for (const variant of variants) {
    const result = getOverviewComparison(audited, variant);
    assert.equal(result.paired, 1);
    assert.equal(result.ownRate, null);
    assert.equal(result.targetRate, null);
    assert.equal(result.share, null);
    assert.match(result.reason!, /1 条已测回答无法配对/);
  }
  for (const variant of [
    { ...full, projectId: 'other' },
    { ...full, batch: { id: 'older', date: '' } },
  ]) {
    assert.equal(getOverviewComparison(audited, variant).paired, 0);
    assert.equal(getOverviewComparison(audited, variant).share, null);
  }
});

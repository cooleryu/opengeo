import { initialResearch } from './test-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getResearchMetrics,
  getResearchRows,
  isBrandQuestion,
} from './research-view.ts';

const filters = {
  language: 'zh',
  engine: 'chatgpt',
  kind: 'all',
  result: 'all',
};
const observation = (status, overrides = {}) => ({
  engine: 'chatgpt',
  language: 'zh',
  query: 'Where can I find help?',
  recordedAt: '2026-10-24T08:00:00Z',
  status,
  summary: '',
  conditions: 'test fixture',
  sources: [],
  evidencePath: 'fixture.json',
  ...overrides,
});
const question = (id, observations = []) => ({
  id,
  zh: '提到 SampleProject 的场景问题',
  en: 'A scenario mentioning SampleProject',
  decision: 'search_now',
  valueReason: '',
  evidenceBasis: '',
  answerability: '',
  gaps: [],
  decisionReason: '',
  reviewPath: '',
  observations,
  diagnosis: { observed: '', hypothesis: '', nextStep: '' },
});
const batch = (questions) => ({
  id: 'test-batch',
  date: '2026-10-24',
  projectId: 'sample-project',
  productSummary: '',
  contributionSummary: '',
  scopeNote: '',
  reportPath: '',
  sourceAuditPath: '',
  reviewPath: '',
  questions,
  deferredQuestions: [question('C99')],
  nextStep: '',
});

test('repeated observations survive, with distinct keys and separate row and question counts', () => {
  const first = observation('found');
  const repeat = observation('found');
  const missed = observation('not_observed');
  const source = batch([
    question('C01', [first, repeat]),
    question('C02', [missed]),
    question('C03'),
  ]);
  const rows = getResearchRows(source, filters, { includeHistory: true });
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.key)).size, 4);
  assert.equal(rows[0].observation, first);
  assert.equal(rows[1].observation, repeat);
  assert.equal(rows[3].observation, undefined);
  assert.deepEqual(getResearchMetrics(rows), {
    completed: 3,
    found: 2,
    unmeasured: 1,
    measuredQuestions: 2,
    coveredQuestions: 1,
    totalQuestions: 3,
    rate: (2 / 3) * 100,
  });
  assert.equal(source.questions[2].observations.length, 0);
});

test('languages and engines stay isolated, including a missing engine observation', () => {
  const zh = observation('found');
  const en = observation('not_observed', { language: 'en' });
  const google = observation('found', { engine: 'google', language: 'en' });
  const source = batch([question('C01', [zh, en, google])]);
  const chinese = getResearchRows(source, { ...filters, engine: 'all' });
  assert.deepEqual(
    chinese.map((row) => row.observation),
    [zh, undefined],
  );
  assert.deepEqual(
    chinese.map((row) => row.engine),
    ['chatgpt', 'google'],
  );
  const english = getResearchRows(source, {
    ...filters,
    language: 'en',
    engine: 'google',
  });
  assert.deepEqual(
    english.map((row) => row.observation),
    [google],
  );
  assert.notEqual(chinese[1].key, english[0].key);
});

test('default rows select the latest measurement, preserving original history keys', () => {
  const latest = observation('not_observed', {
    recordedAt: '2026-10-27T08:00:00Z',
  });
  const migratedOlder = observation('found', {
    recordedAt: '2026-10-25T08:00:00Z',
  });
  const source = batch([question('C02', [latest, migratedOlder])]);
  const rows = getResearchRows(source, filters);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].observation, latest);
  assert.equal(rows[0].key, 'test-batch:C02:chatgpt:zh:0');
  assert.equal(getResearchMetrics(rows).found, 0);
  assert.deepEqual(source.questions[0].observations, [latest, migratedOlder]);
  assert.deepEqual(
    getResearchRows(source, filters, { includeHistory: true }).map(
      (row) => row.observation,
    ),
    [latest, migratedOlder],
  );
});

test('API entries remain separate and a new unmeasured entry has no rate', () => {
  const api = observation('found', {
    engine: 'qwen',
    entryType: 'api_answer',
    collectedAt: '2026-10-27T09:00:00Z',
  });
  const source = batch([question('C02', [api])]);
  const rows = getResearchRows(source, { ...filters, engine: 'all' });
  assert.deepEqual(
    rows.map((row) => row.engine),
    ['chatgpt', 'google', 'qwen'],
  );
  assert.equal(rows.find((row) => row.engine === 'qwen').observation, api);
  assert.equal(
    getResearchMetrics(
      getResearchRows(source, { ...filters, engine: 'doubao' }),
    ).rate,
    null,
  );
});

test('unmeasured and empty selections have no rate instead of a zero finding', () => {
  const rows = getResearchRows(batch([question('C02')]), filters);
  assert.deepEqual(getResearchMetrics(rows), {
    completed: 0,
    found: 0,
    unmeasured: 1,
    measuredQuestions: 0,
    coveredQuestions: 0,
    totalQuestions: 1,
    rate: null,
  });
  assert.equal(getResearchMetrics([]).rate, null);
  assert.equal(getResearchMetrics([]).totalQuestions, 0);
});

test('brand and result filters match their displayed rows and metrics', () => {
  const source = batch([
    question('C01', [observation('found')]),
    question('C02', [observation('found'), observation('not_observed')]),
    question('C03'),
    question('C04', [observation('found')]),
  ]);
  assert.equal(isBrandQuestion(question('C01')), true);
  assert.equal(isBrandQuestion(question('R01')), true);
  assert.equal(isBrandQuestion(question('C02')), false);
  assert.deepEqual(
    getResearchRows(source, { ...filters, kind: 'brand' }).map(
      (row) => row.question.id,
    ),
    ['C01'],
  );
  for (const result of ['found', 'not_observed', 'unmeasured']) {
    const rows = getResearchRows(source, {
      ...filters,
      kind: 'discovery',
      result,
    });
    const metrics = getResearchMetrics(rows);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].observation?.status ?? 'unmeasured', result);
    assert.equal(metrics.totalQuestions, 1);
    assert.equal(metrics.completed, result === 'unmeasured' ? 0 : 1);
    assert.equal(metrics.found, result === 'found' ? 1 : 0);
    assert.equal(
      metrics.rate,
      result === 'unmeasured' ? null : result === 'found' ? 100 : 0,
    );
  }
});

test('the saved two-project batch retains every observation in its own language and engine', () => {
  const saved = initialResearch;
  assert.deepEqual(
    saved.map((entry) => entry.questions.length),
    [8, 5],
  );
  for (const entry of saved) {
    const rows = ['zh', 'en'].flatMap((language) =>
      getResearchRows(entry, { ...filters, language, engine: 'all' }),
    );
    assert.equal(rows.length, entry.questions.length * 4);
    assert.equal(getResearchMetrics(rows).unmeasured, 0);
    assert.equal(
      rows.filter((row) => row.observation).length,
      entry.questions.reduce((sum, item) => sum + item.observations.length, 0),
    );
    assert.ok(
      rows.every((row) => !entry.deferredQuestions.includes(row.question)),
    );
  }
});

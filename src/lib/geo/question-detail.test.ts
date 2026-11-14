import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildQuestionDetail,
  parseQuestionDetailFilters,
} from './question-detail';
import { getResearchRows } from './research-view';
import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
} from './research-types';

const observation = (
  overrides: Partial<ResearchObservation> = {},
): ResearchObservation => ({
  engine: 'chatgpt',
  language: 'zh',
  query: '中文实际问法',
  recordedAt: '2026-10-24T08:00:00Z',
  status: 'found',
  summary: '已保存的摘要',
  conditions: '离线测试记录',
  sources: [],
  evidencePath: 'saved.json',
  ...overrides,
});
const question = (observations: ResearchObservation[]): ResearchQuestion => ({
  id: 'C01',
  zh: '中文问题',
  en: 'English question',
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
const batch = (observations: ResearchObservation[]): ResearchBatch => ({
  id: 'test-batch',
  projectId: 'sample-project',
  date: '2026-10-24',
  productSummary: '',
  contributionSummary: '',
  scopeNote: '',
  reportPath: '',
  sourceAuditPath: '',
  reviewPath: '',
  questions: [question(observations)],
  deferredQuestions: [],
  nextStep: '',
});
const filters = parseQuestionDetailFilters(new URLSearchParams());

test('detail isolates project, language and engine; absent records have null counts', () => {
  const source = batch([
    observation(),
    observation({
      language: 'en',
      engine: 'google',
      query: 'English actual query',
    }),
    observation({ engine: 'qwen', entryType: 'api_answer' }),
  ]);
  const before = structuredClone(source);
  const detail = buildQuestionDetail(source, 'sample-project', 'C01', filters)!;
  assert.equal(detail.title, '中文问题');
  assert.equal(detail.platforms.length, 5);
  assert.deepEqual(
    detail.platforms.map((item) => item.status),
    ['found', 'unmeasured', 'unmeasured', 'found', 'unmeasured'],
  );
  for (const item of detail.platforms.filter(
    (item) => item.status === 'unmeasured',
  )) {
    assert.deepEqual(
      [
        item.observationIndex,
        item.recordedAt,
        item.officialCount,
        item.otherCount,
        item.totalSources,
        item.otherSourcesCount,
      ],
      [null, null, null, null, null, null],
    );
    assert.deepEqual(item.sources, []);
  }
  const english = buildQuestionDetail(source, 'sample-project', 'C01', {
    ...filters,
    language: 'en',
    engine: 'google',
  })!;
  assert.equal(english.title, 'English question');
  assert.equal(english.platforms.length, 1);
  assert.equal(english.platforms[0].query, 'English actual query');
  assert.equal(english.platforms[0].observationIndex, 1);
  assert.equal(
    buildQuestionDetail(source, 'sample-project-two', 'C01', filters),
    null,
  );
  assert.equal(
    buildQuestionDetail(source, 'sample-project', 'R01', filters),
    null,
  );
  assert.deepEqual(source, before);
  for (const status of ['unmeasured', 'failed']) {
    // Runtime imports can contain statuses beyond completed observation types.
    const incomplete = {
      ...observation(),
      status,
    } as unknown as ResearchObservation;
    const incompleteBatch = batch([incomplete]);
    const item = buildQuestionDetail(incompleteBatch, 'sample-project', 'C01', {
      ...filters,
      engine: 'chatgpt',
    })!.platforms[0];
    assert.equal(item.status, 'unmeasured');
    assert.deepEqual(
      [
        item.officialCount,
        item.otherCount,
        item.totalSources,
        item.otherSourcesCount,
      ],
      [null, null, null, null],
    );
    assert.equal(item.observationIndex, 0);
    assert.equal(item.recordedAt, incomplete.recordedAt);
    assert.equal(item.summary, incomplete.summary);
    assert.equal(incompleteBatch.questions[0].observations[0].status, status);
  }
});

test('Google deduplicates URLs and counts only saved web positions; API keeps native citations', () => {
  const sources: ResearchObservation['sources'] = [
    {
      title: '附带官网引用',
      url: 'https://official.example/',
      kind: 'official',
    },
    {
      title: '官网网页',
      url: 'https://official.example/',
      kind: 'official',
      position: 2,
    },
    {
      title: '其他网页',
      url: 'https://other.example/',
      kind: 'mirror',
      position: 3,
    },
    {
      title: '重复网页',
      url: 'https://other.example/',
      kind: 'mirror',
      position: 3,
    },
    { title: '无排名引用', url: 'https://citation.example/', kind: 'other' },
    {
      title: '未知排名引用',
      url: 'https://unknown.example/',
      kind: 'other',
      position: 0,
    },
  ];
  const source = batch([
    observation({ engine: 'google', sources }),
    observation({
      engine: 'qwen',
      entryType: 'api_answer',
      sources: sources.filter((s) => s.position === undefined),
      answerPath: 'answer.md',
    }),
  ]);
  const detail = buildQuestionDetail(source, source.projectId, 'C01', filters)!;
  const google = detail.platforms.find((item) => item.engine === 'google')!;
  assert.deepEqual(
    [
      google.officialCount,
      google.otherCount,
      google.totalSources,
      google.otherSourcesCount,
    ],
    [1, 1, 2, 2],
  );
  assert.equal(google.sources.length, 4);
  assert.equal(
    google.sources.find((item) => item.url === 'https://official.example/')!
      .position,
    2,
  );
  assert.equal(
    google.sources.find((item) => item.url === 'https://citation.example/')!
      .position,
    undefined,
  );
  const qwen = detail.platforms.find((item) => item.engine === 'qwen')!;
  assert.deepEqual(
    [qwen.officialCount, qwen.otherCount, qwen.totalSources],
    [1, 1, 2],
  );
  assert.equal(qwen.entryLabel, 'API 回答');
  assert.equal(qwen.answerPath, 'answer.md');
  assert.ok(qwen.sources.every((item) => item.position === undefined));
  const attachedOfficial = batch([
    observation({
      engine: 'google',
      status: 'found',
      sources: [sources[0], sources[2]],
    }),
  ]);
  const ordinaryResults = buildQuestionDetail(
    attachedOfficial,
    attachedOfficial.projectId,
    'C01',
    {
      ...filters,
      engine: 'google',
    },
  )!.platforms[0];
  assert.equal(ordinaryResults.status, 'not_observed');
  assert.deepEqual(
    [
      ordinaryResults.officialCount,
      ordinaryResults.otherCount,
      ordinaryResults.totalSources,
      ordinaryResults.otherSourcesCount,
    ],
    [0, 1, 1, 1],
  );
  assert.equal(attachedOfficial.questions[0].observations[0].status, 'found');
});

test('Google AI Overview counts its native citations without ordinary web positions', () => {
  const source = batch([
    observation({
      engine: 'google',
      entryType: 'web_answer',
      overviewStatus: 'generated',
      answerPath: 'google-overview.md',
      sources: [
        { title: '官网引用', url: 'https://official.example/', kind: 'official' },
        { title: '其他引用', url: 'https://other.example/', kind: 'other' },
      ],
    }),
  ]);
  const overview = buildQuestionDetail(source, source.projectId, 'C01', {
    ...filters,
    engine: 'google',
  })!.platforms[0];
  assert.equal(overview.entryType, 'web_answer');
  assert.equal(overview.entryLabel, 'AI 概览');
  assert.equal(overview.answerPath, 'google-overview.md');
  assert.equal(overview.status, 'found');
  assert.deepEqual(
    [overview.officialCount, overview.otherCount, overview.totalSources, overview.otherSourcesCount],
    [1, 1, 2, 0],
  );
});

test('latest/history preserve original record keys and reject malformed query parameters', () => {
  const source = batch([
    observation({ recordedAt: '2026-10-27T08:00:00Z', status: 'not_observed' }),
    observation({ recordedAt: '2026-10-25T08:00:00Z' }),
  ]);
  const selected = { ...filters, engine: 'chatgpt' as const };
  const latest = buildQuestionDetail(
    source,
    source.projectId,
    'C01',
    selected,
  )!;
  const history = buildQuestionDetail(source, source.projectId, 'C01', {
    ...selected,
    includeHistory: true,
  })!;
  const rows = getResearchRows(
    source,
    { language: 'zh', engine: 'chatgpt', kind: 'all', result: 'all' },
    { includeHistory: true },
  );
  assert.equal(latest.mode, 'latest');
  assert.equal(latest.platforms[0].recordKey, rows[0].key);
  assert.equal(latest.platforms[0].status, 'not_observed');
  assert.equal(latest.platforms[0].totalSources, 0);
  assert.equal(history.mode, 'history');
  assert.deepEqual(
    history.platforms.map((item) => item.recordKey),
    rows.map((row) => row.key),
  );
  assert.deepEqual(
    history.platforms.map((item) => item.observationIndex),
    [0, 1],
  );
  assert.equal(
    parseQuestionDetailFilters(
      new URLSearchParams('language=en&engine=doubao&history=1'),
    ).includeHistory,
    true,
  );
  for (const invalid of [
    'language=fr',
    'engine=gemini',
    'history=true',
    'engine=',
    'question=',
    'language=zh&language=en',
  ]) {
    assert.throws(() =>
      parseQuestionDetailFilters(new URLSearchParams(invalid)),
    );
  }
});

test('AI answer platforms surface audited mention verdicts when batch answerAudits are loaded', () => {
  const source: ResearchBatch = {
    ...batch([
      observation({
        engine: 'chatgpt',
        entryType: 'web_answer',
        status: 'not_observed',
        answerPath: 'chatgpt-q8.md',
        sources: [{ title: 'Other Repo', url: 'https://other.example', kind: 'other' }],
      }),
      observation({
        engine: 'google',
        entryType: 'web_answer',
        status: 'not_observed',
        answerPath: 'google-q8.md',
        sources: [{ title: 'Google Source', url: 'https://third.example', kind: 'other' }],
      }),
    ]),
    answerAudits: [
      {
        projectId: 'sample-project',
        batchId: 'test-batch',
        questionId: 'C01',
        engine: 'chatgpt',
        language: 'zh',
        recordedAt: '2026-10-24T08:00:00Z',
        mention: 'no',
        citation: 'unknown',
        mentionEvidence: '同名他项目。',
        citationEvidence: '原生引用待核实。',
        officialUrls: [],
        evidencePath: 'chatgpt-q8.md',
        answerComplete: true,
      },
      {
        projectId: 'sample-project',
        batchId: 'test-batch',
        questionId: 'C01',
        engine: 'google',
        language: 'zh',
        recordedAt: '2026-10-24T08:00:00Z',
        mention: 'yes',
        citation: 'unknown',
        mentionEvidence: '明确提及本项目。',
        citationEvidence: '原生引用待核实。',
        officialUrls: [],
        evidencePath: 'google-q8.md',
        answerComplete: true,
      },
    ],
  };
  const detail = buildQuestionDetail(source, 'sample-project', 'C01', filters)!;
  const chatgpt = detail.platforms.find((p) => p.engine === 'chatgpt')!;
  const google = detail.platforms.find((p) => p.engine === 'google')!;
  const qwen = detail.platforms.find((p) => p.engine === 'qwen')!;
  assert.equal(chatgpt.mention, 'no');
  assert.equal(chatgpt.officialCount, 0);
  assert.equal(chatgpt.totalSources, 1);
  assert.equal(google.mention, 'yes');
  assert.equal(google.officialCount, 0);
  assert.equal(google.totalSources, 1);
  assert.equal(qwen.mention, undefined);
});

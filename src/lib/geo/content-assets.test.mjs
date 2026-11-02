import { seeds, initialResearch } from './test-fixtures.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildContentWorkspace,
  countContentReferences,
  normalizeContentUrl,
} from './content-assets.ts';

const source = (url, kind = 'official', position) => ({
  title: 'Saved source',
  url,
  kind,
  ...(position === undefined ? {} : { position }),
});
const observation = (sources, engine = 'chatgpt') => ({
  engine,
  language: 'zh',
  query: '原问',
  recordedAt: '2026-10-24T08:00:00Z',
  status: 'found',
  summary: 'Saved observation',
  conditions: 'Saved conditions',
  sources,
  evidencePath: 'saved.json',
  answerPath: 'answer.md',
});
const question = (id, observations = [], gaps = []) => ({
  id,
  zh: '原始中文问题',
  en: 'Original English question',
  decision: 'search_now',
  valueReason: 'Value reason',
  evidenceBasis: 'inferred: demand',
  answerability: 'Partial, not tested',
  gaps,
  decisionReason: 'Keep goal',
  reviewPath: 'review.json',
  observations,
  diagnosis: { observed: '', hypothesis: '', nextStep: '' },
});
const asset = (id, publicUrl) => ({
  id,
  title: 'Saved asset',
  type: 'documentation',
  language: 'zh-CN',
  status: 'published',
  publishedAt: null,
  publicUrl,
  sourcePath: 'saved.md',
  summary: 'Saved summary',
  markdown: '# Saved asset\n\n## Scope\nSaved text',
  evidencePaths: [],
});
const state = (questions = [], assets = []) => ({
  project: {
    id: 'project-one',
    name: 'One',
    siteUrl: 'https://example.com/project-one/',
    repositoryUrl: 'https://github.com/owner/one',
    owner: 'owner',
    asOf: '2026-10-24',
    description: '',
  },
  assets,
  questions: [],
  gaps: [{ id: 'old-gap', title: 'Historical conclusion' }],
  latestResearch: {
    id: 'batch-one',
    projectId: 'project-one',
    date: '2026-10-24',
    productSummary: '',
    contributionSummary: '',
    scopeNote: '',
    reportPath: 'report.md',
    sourceAuditPath: 'audit.md',
    reviewPath: 'review.json',
    questions,
    deferredQuestions: [],
    nextStep: '',
  },
});

test('a foreign batch cannot populate sources, governance or coverage in the active project', () => {
  const data = state(
    [
      question(
        'Q1',
        [observation([source('https://github.com/owner/two')])],
        ['内容：外项目内容'],
      ),
    ],
    [asset('one', null)],
  );
  data.latestResearch.projectId = 'project-two';
  const result = buildContentWorkspace(data);
  assert.equal(result.batch, null);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].references, []);
  assert.deepEqual(result.items[0].coverage, []);
  assert.deepEqual(result.governance, []);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.historicalGaps, data.gaps);
});

test('page matching uses exact or explicit equivalent URLs, never a shared host or repo landing page', () => {
  const blob = 'https://github.com/owner/one/blob/main/docs/guide.md';
  const raw = 'https://raw.githubusercontent.com/owner/one/main/docs/guide.md';
  assert.equal(
    normalizeContentUrl(blob + '?utm_source=chatgpt.com#scope'),
    normalizeContentUrl(raw),
  );
  assert.notEqual(
    normalizeContentUrl(blob),
    normalizeContentUrl(blob.replace('/main/', '/dev/')),
  );
  assert.notEqual(
    normalizeContentUrl(blob),
    normalizeContentUrl(blob + '?version=other'),
  );
  assert.notEqual(
    normalizeContentUrl('https://example.com/page'),
    normalizeContentUrl('https://example.com/page/'),
  );
  assert.notEqual(
    normalizeContentUrl('https://example.com/#/one'),
    normalizeContentUrl('https://example.com/#/two'),
  );
  const data = state(
    [
      question('Q1', [
        observation([
          source(raw),
          source('https://github.com/owner/one'),
          source('https://github.com/owner/two/blob/main/docs/guide.md'),
          source(
            'https://github.com/community/weekly/issues/1',
            'self_submission',
          ),
          source('https://example.com/project-two/article'),
          source('https://mirror.example/one', 'mirror'),
        ]),
      ]),
    ],
    [asset('guide', blob)],
  );
  const result = buildContentWorkspace(data);
  const own = result.items.find((item) => item.asset);
  assert.equal(own.references.length, 1);
  assert.deepEqual(own.urls, [blob, raw]);
  assert.equal(
    result.items.find((item) => item.url === 'https://github.com/owner/one')
      .ownership,
    'owned',
  );
  assert.equal(
    result.items.find((item) => item.url.includes('/owner/two/')).ownership,
    'unknown',
  );
  assert.equal(
    result.items.find((item) => item.kind === 'self_submission').ownership,
    'external',
  );
  assert.equal(
    result.items.find(
      (item) => item.url === 'https://example.com/project-two/article',
    ).ownership,
    'unknown',
  );
  assert.equal(
    result.items.find((item) => item.kind === 'mirror').ownership,
    'external',
  );
});

test('saved ChatGPT links and answers are separate, Google ranks and other sources stay distinct', () => {
  const blob = 'https://github.com/owner/one/blob/main/README.md';
  const raw = 'https://raw.githubusercontent.com/owner/one/main/README.md';
  const data = state(
    [
      question('Q1', [
        observation([
          source(blob),
          source(raw),
          source(blob + '?utm_source=chatgpt.com'),
        ]),
        observation([source(blob)]),
        observation([source(blob, 'official', 2), source(raw)], 'google'),
      ]),
    ],
    [asset('readme', blob)],
  );
  data.questions = [
    {
      id: 'legacy',
      matchingAssetIds: ['readme'],
      query: 'Legacy mapped question',
    },
  ];
  const original = structuredClone(data);
  const item = buildContentWorkspace(data).items[0];
  assert.deepEqual(item.counts, {
    chatgptCitations: 4,
    chatgptAnswers: 2,
    googleResults: 1,
    googleOtherSources: 1,
    googleSearches: 1,
  });
  assert.equal(item.references.length, 6);
  assert.equal(item.questions.length, 1);
  assert.equal(item.recordedMappings.length, 1);
  assert.equal(item.questions[0].question.id, 'Q1');
  assert.equal(item.references[2].source.url, blob + '?utm_source=chatgpt.com');
  assert.equal(
    new URL(item.references[0].href, 'https://local.test').searchParams.get(
      'project',
    ),
    'project-one',
  );
  assert.deepEqual(
    countContentReferences([...item.references, ...item.references]),
    item.counts,
  );
  assert.deepEqual(data, original);
});

test('governance preserves original review context and only explicit capability prefixes create capability gaps', () => {
  const raw = [
    '内容：需要案例',
    '证据：运行未核实',
    '能力：缺少指定功能',
    '尚未调查运行能力',
    '待调查：先核对材料',
  ];
  const data = state([question('Q1', [], raw)]);
  const result = buildContentWorkspace(data);
  assert.deepEqual(
    result.governance.map((item) => item.category),
    ['content', 'evidence', 'capability', 'investigate', 'investigate'],
  );
  assert.deepEqual(
    result.governance.map((item) => item.raw),
    raw,
  );
  assert.ok(
    result.governance.every(
      (item) =>
        item.question === data.latestResearch.questions[0] &&
        item.reviewPath === 'review.json' &&
        item.batchId === 'batch-one' &&
        item.projectId === 'project-one',
    ),
  );
  assert.equal(
    result.governance.filter((item) => item.category === 'capability').length,
    1,
  );
  assert.equal(result.historicalGaps.length, 1);
});

test('saved project assets remain listed without citations, and documented coverage is independent of source appearances', () => {
  for (const batch of initialResearch) {
    const seed = seeds.find(item => item.project.id === batch.projectId);
    const result = buildContentWorkspace({ ...seed, latestResearch: batch });
    assert.equal(
      result.items.filter((item) => item.origin === 'asset').length,
      seed.assets.length,
    );
    assert.ok(result.items.every((item) => item.projectId === batch.projectId));
    assert.ok(
      result.items
        .flatMap((item) => item.references)
        .every((reference) => reference.batchId === batch.id),
    );
    if (batch.projectId === 'sample-project') {
      const article = result.items.find(
        (item) => item.asset?.id === 'troubleshooting-zh-CN',
      );
      assert.equal(article.references.length, 0);
      assert.equal(article.coverage[0].question.id, 'C05');
      assert.equal(article.coverage[0].status, 'documented');
      assert.equal(
        result.items.find((item) => item.asset?.id === 'troubleshooting-en')
          .coverage[0].status,
        'candidate',
      );
      assert.deepEqual(
        result.items.find((item) => item.asset?.id === 'sample-quote').coverage,
        [],
      );
    } else {
      const implementation = result.items.find(
        (item) => item.asset?.id === 'sample-implementation',
      );
      assert.ok(
        implementation.coverage.some((entry) => entry.question.id === 'R06'),
      );
      assert.ok(
        implementation.urls.some((url) =>
          url.startsWith('https://raw.githubusercontent.com/'),
        ),
      );
    }
  }
});

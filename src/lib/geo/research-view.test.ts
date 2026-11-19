import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractOutreachCitedPages,
  extractOverviewGapSources,
  extractQuestionTopWinners,
  extractTopExternalCitedSources,
  isBrandPrompt,
} from './research-view';
import type { ResearchBatch, ResearchQuestion, ResearchSource } from './research-types';

function makeQuestion(
  id: string,
  en: string,
  sources: Array<{ engine: 'chatgpt' | 'google'; language?: 'en' | 'zh'; sources: ResearchSource[] }>,
  category?: ResearchQuestion['category'],
): ResearchQuestion {
  return {
    id,
    category,
    zh: en,
    en,
    decision: 'search_now',
    valueReason: 'test',
    evidenceBasis: 'test',
    answerability: 'test',
    gaps: [],
    decisionReason: 'test',
    reviewPath: '',
    diagnosis: { observed: '', hypothesis: '', nextStep: '' },
    observations: sources.map((entry, idx) => ({
      id: `${id}-obs-${idx}`,
      entryType: 'web_answer',
      engine: entry.engine,
      language: entry.language ?? 'en',
      query: en,
      recordedAt: '2026-11-14T10:00:00.000Z',
      status: 'not_observed',
      summary: 'summary',
      conditions: '',
      sources: entry.sources,
      evidencePath: '',
    })),
  };
}

function makeBatch(questions: ResearchQuestion[]): ResearchBatch {
  return {
    id: 'batch-test',
    date: '2026-11-14',
    projectId: 'proj-1',
    productSummary: '',
    contributionSummary: '',
    scopeNote: '',
    reportPath: '',
    sourceAuditPath: '',
    reviewPath: '',
    questions,
    deferredQuestions: [],
    nextStep: '',
  };
}

test('isBrandPrompt detects direct brand mentions without misclassifying discovery prompts', () => {
  const brandQ = makeQuestion('Q1', 'What is OpenGEO and how does it work?', []);
  const discoveryQ = makeQuestion(
    'Q2',
    'What are the best open-source alternatives to Otterly AI?',
    [],
    'comparison',
  );
  assert.equal(isBrandPrompt(brandQ, 'OpenGEO'), true);
  assert.equal(isBrandPrompt(discoveryQ, 'OpenGEO'), false);
});

test('extractOutreachCitedPages filters chrome/owned URLs, strips utm_source, deduplicates titles, and ranks outreach types', () => {
  const project = {
    repositoryUrl: 'https://github.com/cooleryu/opengeo',
    siteUrl: 'https://github.com/cooleryu/opengeo',
  };

  const q1 = makeQuestion('Q1', 'How can I track if my website appears in ChatGPT?', [
    {
      engine: 'google',
      sources: [
        {
          title: 'Learn more about AI Mode',
          url: 'https://support.google.com/websearch/answer/123',
          kind: 'other',
        },
        {
          title: 'Privacy Policy',
          url: 'https://policies.google.com/privacy',
          kind: 'other',
        },
        {
          title: 'ai-visibility-tracker · GitHub Topics',
          url: 'https://www.google.com/goto?url=opaque_token_1',
          kind: 'other',
        },
        {
          title: 'Reddit · r/WebAfterAI',
          url: 'https://www.google.com/goto?url=opaque_token_2',
          kind: 'other',
        },
      ],
    },
    {
      engine: 'chatgpt',
      sources: [
        {
          title: 'OpenGEO Repo',
          url: 'https://github.com/cooleryu/opengeo?utm_source=chatgpt.com',
          kind: 'official',
        },
        {
          title: 'I built a local, open-source tool to check AI visibility',
          url: 'https://dev.to/author/i-built-a-local-tool?utm_source=chatgpt.com',
          kind: 'other',
        },
        {
          title: 'General Marketing Blog',
          url: 'https://example.com/blog?utm_source=chatgpt.com',
          kind: 'other',
        },
      ],
    },
  ]);

  const q2 = makeQuestion('Q2', 'Best open-source GEO alternatives?', [
    {
      engine: 'chatgpt',
      sources: [
        {
          title: 'Best GEO Tools 2026: 15 AI Visibility Tools Compared',
          url: 'https://example.org/best-geo-tools-2026?utm_source=chatgpt.com&ref=home',
          kind: 'other',
        },
        {
          title: 'ai-visibility-tracker · GitHub Topics',
          url: 'https://github.com/topics/ai-visibility-tracker?utm_source=chatgpt.com',
          kind: 'other',
        },
      ],
    },
  ]);

  const batch = makeBatch([q1, q2]);
  const pages = extractOutreachCitedPages(batch, project, {
    questionIds: ['Q1', 'Q2'],
    language: 'en',
    limit: 4,
  });

  assert.equal(pages.length, 4);
  // Excluded Google chrome, policies, and own repo
  assert.equal(
    pages.some((p) => p.title.includes('Learn more') || p.title.includes('Privacy') || p.title === 'OpenGEO Repo'),
    false,
  );

  // Deduplicated by lowercase title and upgraded opaque Google redirect when direct URL exists
  const ghTopic = pages.find((p) => p.title === 'ai-visibility-tracker · GitHub Topics');
  assert.ok(ghTopic);
  assert.equal(ghTopic.kind, 'directory');
  assert.equal(ghTopic.score, 4);
  assert.equal(ghTopic.questionCount, 2);
  assert.equal(ghTopic.url, 'https://github.com/topics/ai-visibility-tracker');
  assert.deepEqual(ghTopic.engines.sort(), ['chatgpt', 'google']);

  // Strips utm_source=chatgpt.com cleanly while preserving other query params
  const devto = pages.find((p) => p.url.includes('dev.to'));
  assert.ok(devto);
  assert.equal(devto.url, 'https://dev.to/author/i-built-a-local-tool');
  assert.equal(devto.kind, 'community');

  const roundup = pages.find((p) => p.title.includes('Best GEO Tools'));
  assert.ok(roundup);
  assert.equal(roundup.url, 'https://example.org/best-geo-tools-2026?ref=home');
  assert.equal(roundup.kind, 'roundup');
  assert.equal(roundup.score, 3);

  // Ranking puts score 4 before score 3 before score 1
  assert.equal(pages[0].title, 'ai-visibility-tracker · GitHub Topics');
  assert.equal(pages[3].title, 'Best GEO Tools 2026: 15 AI Visibility Tools Compared');
});

test('extractOutreachCitedPages prioritizes questionIds and supplements from rest of batch up to limit', () => {
  const qTarget = makeQuestion('Q-target', 'Target prompt', [
    {
      engine: 'chatgpt',
      sources: [
        {
          title: 'Some Overview Article',
          url: 'https://example.com/overview',
          kind: 'other',
        },
      ],
    },
  ]);

  const qExtra = makeQuestion('Q-extra', 'Extra prompt', [
    {
      engine: 'google',
      sources: [
        {
          title: 'Product Hunt Alternative List',
          url: 'https://www.producthunt.com/alternatives/otterly',
          kind: 'other',
        },
      ],
    },
  ]);

  const pages = extractOutreachCitedPages(makeBatch([qTarget, qExtra]), null, {
    questionIds: ['Q-target'],
    limit: 3,
  });

  assert.equal(pages.length, 2);
  assert.equal(pages[0].title, 'Some Overview Article');
  assert.equal(pages[1].title, 'Product Hunt Alternative List');
});

test('extractTopExternalCitedSources remains functional for batch summary', () => {
  const q = makeQuestion('Q1', 'Question', [
    {
      engine: 'chatgpt',
      sources: [
        { title: 'Otterly AI', url: 'https://otterly.ai/blog', kind: 'other' },
      ],
    },
  ]);
  const res = extractTopExternalCitedSources(makeBatch([q]), null);
  assert.equal(res.length, 1);
  assert.equal(res[0].url, 'https://otterly.ai');
});

test('extractTopExternalCitedSources and extractQuestionTopWinners deduplicate brand surfaces while preserving awesome lists', () => {
  const q = makeQuestion('Q1', 'Best GEO tools?', [
    {
      engine: 'chatgpt',
      sources: [
        { title: 'elmohq/elmo', url: 'https://github.com/elmohq/elmo', kind: 'other' },
        { title: 'Elmo Pricing', url: 'https://elmohq.com/pricing', kind: 'other' },
        { title: 'awesome-geo', url: 'https://github.com/deeflect/awesome-geo', kind: 'other' },
      ],
    },
  ]);
  const batch = makeBatch([q]);
  const batchWinners = extractTopExternalCitedSources(batch, null);
  assert.equal(batchWinners.length, 2);
  assert.ok(batchWinners.some((w) => w.label === 'Elmo' && w.questionCount === 1));
  assert.ok(batchWinners.some((w) => w.label === 'deeflect/awesome-geo'));

  const rowWinners = extractQuestionTopWinners(q, batch);
  assert.equal(rowWinners.length, 2);
  assert.ok(rowWinners.some((w) => w.label === 'Elmo'));
});

test('extractTopExternalCitedSources merges on registrable domain rather than docs subdomain and drops non-repo GitHub pages', () => {
  const q1 = makeQuestion('Q1', 'GEO tracking docs', [
    {
      engine: 'chatgpt',
      sources: [
        { title: 'Otterly Docs', url: 'https://docs.otterly.ai/quickstart', kind: 'other' },
        { title: 'Limelit Docs', url: 'https://docs.limelit.co/overview', kind: 'other' },
        { title: 'Limelit Repo', url: 'https://github.com/limelit-co/open', kind: 'other' },
        { title: 'GitHub Topics', url: 'https://github.com/topics/ai-visibility-tracker', kind: 'other' },
        { title: 'GitHub Search', url: 'https://github.com/search?q=geo', kind: 'other' },
      ],
    },
  ]);

  const batch = makeBatch([q1]);
  const winners = extractTopExternalCitedSources(batch, null);
  assert.equal(winners.some((w) => w.label === 'Docs' || w.label === 'github.com'), false);
  assert.ok(winners.some((w) => w.label === 'Limelit' && w.url === 'https://docs.limelit.co'));
  assert.ok(winners.some((w) => w.label === 'docs.otterly.ai' && w.key === 'otterly.ai'));

  const rowWinners = extractQuestionTopWinners(q1, batch);
  assert.equal(rowWinners.some((w) => w.label === 'Docs' || w.label === 'github.com'), false);
});

test('extractOverviewGapSources prioritizes awesome lists and community threads, normalizes Reddit redirects, and deduplicates competitors', () => {
  const q1 = makeQuestion('Q1', 'Best open-source GEO tools', [
    {
      engine: 'chatgpt',
      sources: [
        { title: 'awesome-geo', url: 'https://github.com/deeflect/awesome-geo', kind: 'other' },
        { title: 'Peec AI', url: 'https://peec.ai/?utm_source=chatgpt.com', kind: 'other' },
        { title: 'My own repo', url: 'https://github.com/cooleryu/opengeo', kind: 'other' },
      ],
    },
    {
      engine: 'google',
      sources: [
        {
          title: 'How do you track AI visibility? - Reddit',
          url: 'https://www.google.com/goto?url=CAES_opaque_token',
          kind: 'other',
        },
        { title: 'awesome-geo', url: 'https://github.com/deeflect/awesome-geo', kind: 'other' },
      ],
    },
  ]);

  const gapSources = extractOverviewGapSources(
    makeBatch([q1]),
    { repositoryUrl: 'https://github.com/cooleryu/opengeo' },
    { language: 'en', limit: 5 },
  );

  assert.equal(gapSources.length, 3);
  assert.equal(gapSources[0].kind, 'awesome');
  assert.equal(gapSources[0].title, 'deeflect/awesome-geo');
  assert.equal(gapSources[0].actionHint, 'submit_pr');
  assert.deepEqual(gapSources[0].engines.sort(), ['chatgpt', 'google']);

  assert.equal(gapSources[1].kind, 'community');
  assert.equal(gapSources[1].subtitle, 'reddit.com');
  assert.equal(gapSources[1].actionHint, 'community_draft');

  assert.equal(gapSources[2].kind, 'competitor');
  assert.equal(gapSources[2].title, 'peec.ai');
  assert.equal(gapSources[2].actionHint, 'inspect');
});

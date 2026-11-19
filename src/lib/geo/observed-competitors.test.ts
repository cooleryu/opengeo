import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildObservedCompetitorSnapshot,
  formatObservedCompetitorReportMarkdown,
} from './observed-competitors';
import type { ResearchBatch } from './research-types';

const sampleBatch: ResearchBatch = {
  id: 'batch-comp-1',
  date: '2026-11-18',
  projectId: 'acme',
  productSummary: '',
  contributionSummary: '',
  scopeNote: '',
  reportPath: 'research/report.md',
  sourceAuditPath: '',
  reviewPath: '',
  deferredQuestions: [],
  nextStep: '',
  questions: [
    {
      id: 'Q1',
      zh: '有哪些开源 AI 搜索监测工具？',
      en: 'What are the best open-source AI search visibility tools?',
      category: 'problem',
      decision: 'search_now',
      valueReason: 'test',
      evidenceBasis: 'test',
      answerability: 'test',
      gaps: [],
      decisionReason: 'test',
      reviewPath: '',
      diagnosis: { observed: '', hypothesis: '', nextStep: '' },
      observations: [
        {
          engine: 'chatgpt',
          language: 'en',
          entryType: 'web_answer',
          status: 'not_observed',
          query: 'What are the best open-source AI search visibility tools?',
          summary: 'Lists Elmo and Awesome GEO.',
          conditions: 'browser capture',
          recordedAt: '2026-11-18T10:00:00Z',
          evidencePath: 'research/q1-chatgpt.md',
          sources: [
            { title: 'Elmo GitHub', url: 'https://github.com/elmo-hq/elmo', kind: 'other' },
            { title: 'Elmo Docs', url: 'https://elmo.ai/docs', kind: 'other' },
            { title: 'Awesome GEO', url: 'https://github.com/org/awesome-geo', kind: 'other' },
          ],
        },
        {
          engine: 'google',
          language: 'en',
          entryType: 'web_answer',
          status: 'not_observed',
          query: 'What are the best open-source AI search visibility tools?',
          summary: 'Lists Elmo and Limelit.',
          conditions: 'browser capture',
          recordedAt: '2026-11-18T10:05:00Z',
          evidencePath: 'research/q1-google.md',
          sources: [
            { title: 'Elmo Home', url: 'https://elmo.ai/', kind: 'other' },
            { title: 'Limelit App', url: 'https://limelit.io/geo', kind: 'other' },
          ],
        },
      ],
    },
    {
      id: 'Q2',
      zh: 'Acme 适合做什么？',
      en: 'What is Acme used for?',
      category: 'brand',
      decision: 'search_now',
      valueReason: 'test',
      evidenceBasis: 'test',
      answerability: 'test',
      gaps: [],
      decisionReason: 'test',
      reviewPath: '',
      diagnosis: { observed: '', hypothesis: '', nextStep: '' },
      observations: [
        {
          engine: 'chatgpt',
          language: 'en',
          entryType: 'web_answer',
          status: 'found',
          query: 'What is Acme used for?',
          summary: 'Describes Acme and cites official docs.',
          conditions: 'browser capture',
          recordedAt: '2026-11-18T10:10:00Z',
          evidencePath: 'research/q2-chatgpt.md',
          sources: [
            { title: 'Acme Official', url: 'https://acme.dev/docs', kind: 'official' },
            { title: 'Limelit Comparison', url: 'https://limelit.io/vs-acme', kind: 'other' },
          ],
        },
      ],
    },
  ],
  answerAudits: [
    {
      projectId: 'acme',
      batchId: 'batch-comp-1',
      questionId: 'Q1',
      engine: 'chatgpt',
      language: 'en',
      recordedAt: '2026-11-18T10:00:00Z',
      mention: 'no',
      citation: 'no',
      mentionEvidence: '',
      citationEvidence: '',
      officialUrls: [],
      evidencePath: 'research/q1-chatgpt.md',
      answerComplete: true,
    },
    {
      projectId: 'acme',
      batchId: 'batch-comp-1',
      questionId: 'Q1',
      engine: 'google',
      language: 'en',
      recordedAt: '2026-11-18T10:05:00Z',
      mention: 'no',
      citation: 'no',
      mentionEvidence: '',
      citationEvidence: '',
      officialUrls: [],
      evidencePath: 'research/q1-google.md',
      answerComplete: true,
    },
    {
      projectId: 'acme',
      batchId: 'batch-comp-1',
      questionId: 'Q2',
      engine: 'chatgpt',
      language: 'en',
      recordedAt: '2026-11-18T10:10:00Z',
      mention: 'yes',
      citation: 'yes',
      mentionEvidence: 'Mentions Acme',
      citationEvidence: 'Cites acme.dev',
      officialUrls: ['https://acme.dev/docs'],
      evidencePath: 'research/q2-chatgpt.md',
      answerComplete: true,
    },
  ],
};

test('buildObservedCompetitorSnapshot aggregates real winners, excludes owned site, and reports per-engine metrics', () => {
  const snapshot = buildObservedCompetitorSnapshot(
    sampleBatch,
    {
      name: 'Acme',
      siteUrl: 'https://acme.dev',
      repositoryUrl: 'https://github.com/acme/acme',
      targetLanguage: 'en',
    },
  );

  assert.equal(snapshot.totalQuestions, 2);
  assert.equal(snapshot.measuredAnswers, 3);
  assert.equal(snapshot.ownMentionYes, 1);
  assert.equal(snapshot.ownCitationYes, 1);
  assert.equal(snapshot.ownCoveredQuestions, 1);
  assert.equal(snapshot.latestObservedDate, '2026-11-18');

  // Owned domain acme.dev must never appear as an external competitor
  assert.equal(
    snapshot.competitors.some((c) => c.url.includes('acme.dev')),
    false,
  );

  // Limelit covers both Q1 and Q2; Elmo merges github.com/elmo-hq/elmo + elmo.ai into one brand entity
  const limelit = snapshot.competitors.find((c) => c.label.toLowerCase().includes('limelit'));
  const elmo = snapshot.competitors.find((c) => c.label.toLowerCase().includes('elmo'));
  assert.ok(limelit);
  assert.equal(limelit.questionCount, 2);
  assert.equal(limelit.missedByYouCount, 1);
  assert.ok(elmo);
  assert.equal(elmo.label, 'Elmo');
  assert.equal(elmo.questionCount, 1);
  assert.deepEqual(elmo.engines.sort(), ['chatgpt', 'google']);

  const reportZh = formatObservedCompetitorReportMarkdown(snapshot, false);
  assert.match(reportZh, /Acme/);
  assert.match(reportZh, /1\/3/);
  assert.match(reportZh, /Elmo/);
});

test('buildObservedCompetitorSnapshot prefers AI-extracted audit recommendedCompetitors even when Google hides URLs behind goto redirects', () => {
  const googleOnlyBatch: ResearchBatch = {
    ...sampleBatch,
    id: 'batch-ai-comp',
    questions: [
      {
        ...sampleBatch.questions[0],
        observations: [
          {
            engine: 'google',
            language: 'en',
            entryType: 'web_answer',
            status: 'not_observed',
            query: 'What are the best open-source AI search visibility tools?',
            summary: 'Google AI Overview recommends Otterly AI and Profound.',
            conditions: 'browser capture',
            recordedAt: '2026-11-18T12:00:00Z',
            evidencePath: 'research/q1-google-ai.md',
            sources: [
              {
                title: 'Otterly AI',
                url: 'https://www.google.com/goto?url=opaque',
                kind: 'other',
              },
            ],
          },
        ],
      },
    ],
    answerAudits: [
      {
        projectId: 'acme',
        batchId: 'batch-ai-comp',
        questionId: 'Q1',
        engine: 'google',
        language: 'en',
        recordedAt: '2026-11-18T12:00:00Z',
        mention: 'no',
        citation: 'no',
        mentionEvidence: 'Not mentioned',
        citationEvidence: 'No official citation',
        officialUrls: [],
        recommendedCompetitors: [
          { name: 'Otterly AI' },
          { name: 'Profound', url: 'https://tryprofound.com' },
        ],
        evidencePath: 'research/q1-google-ai.md',
        answerComplete: true,
      },
    ],
  };

  const snap = buildObservedCompetitorSnapshot(googleOnlyBatch, {
    name: 'Acme',
    siteUrl: 'https://acme.dev',
    repositoryUrl: 'https://github.com/acme/acme',
    targetLanguage: 'en',
  });
  const googleSummary = snap.perEngine.find((e) => e.engine === 'google');
  assert.ok(googleSummary?.topWinner);
  assert.equal(googleSummary.topWinner.questionCount, 1);
  assert.equal(snap.competitors.length, 2);
  assert.ok(snap.competitors.some((c) => c.label === 'Otterly AI' && c.url === ''));
  assert.ok(snap.competitors.some((c) => c.label === 'Profound' && c.url.includes('tryprofound.com')));
});

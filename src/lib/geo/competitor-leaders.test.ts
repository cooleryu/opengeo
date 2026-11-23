import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTopCompetitorLeaders } from './competitor-leaders';
import type { ResearchBatch } from './research-types';

function makeBatch(overrides?: Partial<ResearchBatch>): ResearchBatch {
  return {
    id: 'batch-1',
    date: '2026-11-22',
    projectId: 'proj-1',
    productSummary: '',
    contributionSummary: '',
    scopeNote: '',
    reportPath: '',
    sourceAuditPath: '',
    reviewPath: '',
    deferredQuestions: [],
    nextStep: '',
    questions: [
      {
        id: 'q1',
        category: 'comparison',
        zh: 'AI 可见性工具推荐',
        en: 'What are the best AI visibility tools?',
        decision: 'search_now',
        valueReason: '',
        evidenceBasis: '',
        answerability: '',
        gaps: [],
        decisionReason: '',
        reviewPath: '',
        diagnosis: { observed: '', hypothesis: '', nextStep: '' },
        observations: [
          {
            id: 'obs-1',
            entryType: 'web_answer',
            engine: 'google',
            language: 'en',
            query: 'What are the best AI visibility tools?',
            recordedAt: '2026-11-22T05:00:00Z',
            status: 'not_observed',
            summary: '',
            conditions: '',
            sources: [
              { title: 'YouTube', url: 'https://www.youtube.com/watch?v=abc', kind: 'other' },
              { title: 'Bilibili', url: 'https://www.bilibili.com/video/123', kind: 'other' },
              { title: 'Random Blog', url: 'https://someblog.example/best-tools', kind: 'other' },
            ],
            evidencePath: '',
          },
        ],
      },
      {
        id: 'q2',
        category: 'comparison',
        zh: 'Profound 替代品',
        en: 'Best Profound alternatives?',
        decision: 'search_now',
        valueReason: '',
        evidenceBasis: '',
        answerability: '',
        gaps: [],
        decisionReason: '',
        reviewPath: '',
        diagnosis: { observed: '', hypothesis: '', nextStep: '' },
        observations: [],
      },
    ],
    ...overrides,
  };
}

test('extractTopCompetitorLeaders ranks model-audited competitors without hardcoded brand blacklists', () => {
  const batch = makeBatch({
    answerAudits: [
      {
        projectId: 'proj-1',
        batchId: 'batch-1',
        questionId: 'q1',
        engine: 'chatgpt',
        language: 'en',
        recordedAt: '2026-11-22T05:00:00Z',
        mention: 'no',
        citation: 'no',
        mentionEvidence: '',
        citationEvidence: '',
        officialUrls: [],
        recommendedCompetitors: [
          { name: 'Profound' },
          { name: 'Zapier' },
          { name: 'OpenGEO' },
        ],
        evidencePath: '',
        answerComplete: true,
      },
      {
        projectId: 'proj-1',
        batchId: 'batch-1',
        questionId: 'q2',
        engine: 'google',
        language: 'en',
        recordedAt: '2026-11-22T05:05:00Z',
        mention: 'no',
        citation: 'no',
        mentionEvidence: '',
        citationEvidence: '',
        officialUrls: [],
        recommendedCompetitors: [
          { name: 'Profound' },
          { name: 'Peec AI' },
        ],
        evidencePath: '',
        answerComplete: true,
      },
    ],
  });

  const leaders = extractTopCompetitorLeaders(
    batch,
    { name: 'OpenGEO', repositoryUrl: 'https://github.com/cooleryu/opengeo', siteUrl: '' },
    { language: 'en', engine: 'all', limit: 3 },
  );

  assert.equal(leaders.length, 3);
  assert.equal(leaders[0].label, 'Profound');
  assert.equal(leaders[0].questionCount, 2);
  // Real products like Zapier are NOT falsely suppressed by a hardcoded blacklist
  assert.equal(leaders.some((l) => l.label === 'Zapier'), true);
  // Own project name is still excluded
  assert.equal(leaders.some((l) => /opengeo/i.test(l.label)), false);
});

test('extractTopCompetitorLeaders returns empty when no audited recommendedCompetitors exist instead of guessing from raw cited domains', () => {
  const batch = makeBatch({ answerAudits: [] });
  const leaders = extractTopCompetitorLeaders(
    batch,
    { name: 'OpenGEO', repositoryUrl: '', siteUrl: '' },
    { language: 'en', limit: 2 },
  );
  assert.deepEqual(leaders, []);
});

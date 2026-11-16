import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPAQUE_GOOGLE_SOURCE_LABEL,
  buildOverviewSources,
  canonicalSourceKey,
  sameCanonicalSource,
} from './overview-sources';
import type { AuditedResearchRow } from './overview-metrics';
import type { ResearchQuestion } from './research-types';

function makeQuestion(id: string, zh: string): ResearchQuestion {
  return {
    id,
    zh,
    en: zh,
    decision: 'search_now',
    valueReason: '',
    evidenceBasis: '',
    answerability: '',
    gaps: [],
    decisionReason: '',
    reviewPath: '',
    observations: [],
    diagnosis: { observed: '', hypothesis: '', nextStep: '' },
  };
}

function makeRow(
  id: string,
  engine: AuditedResearchRow['engine'],
  mention: 'yes' | 'no',
  sources: Array<{ title: string; url: string; kind?: 'official' | 'other' }>,
  entryType: 'web_answer' | 'web_search' = 'web_answer',
): AuditedResearchRow {
  const question = makeQuestion(id, `问题 ${id}`);
  return {
    key: `batch:${id}:${engine}:zh:2026-11-08T00:00:00Z`,
    question,
    engine,
    observation: {
      engine,
      language: 'zh',
      query: question.zh,
      recordedAt: '2026-11-08T00:00:00Z',
      entryType,
      status: mention === 'yes' ? 'found' : 'not_observed',
      summary: '',
      conditions: '',
      evidencePath: '',
      sources: sources.map((s) => ({
        title: s.title,
        url: s.url,
        kind: s.kind ?? 'other',
      })),
    },
    audit: {
      projectId: 'proj-1',
      batchId: 'batch-1',
      questionId: id,
      engine,
      language: 'zh',
      recordedAt: '2026-11-08T00:00:00Z',
      mention,
      citation: 'unknown',
      mentionEvidence: '',
      citationEvidence: '',
      officialUrls: [],
      evidencePath: '',
      answerComplete: true,
    },
  };
}

test('canonicalSourceKey strips UTM parameters, fragments, trailing slashes, and www', () => {
  assert.equal(
    canonicalSourceKey('https://www.peec.ai/pricing/?utm_source=chatgpt.com#top'),
    'https://peec.ai/pricing',
  );
  assert.equal(
    sameCanonicalSource(
      'https://github.com/cooleryu/opengeo?utm_source=chatgpt.com',
      'https://github.com/cooleryu/opengeo/',
    ),
    true,
  );
  assert.equal(
    canonicalSourceKey('https://www.google.com/goto?url=OPAQUE1') ===
      canonicalSourceKey('https://www.google.com/goto?url=OPAQUE2'),
    false,
  );
});

test('buildOverviewSources filters scraper noise, classifies owned vs external, and separates api_search from AI answers', () => {
  const project = {
    siteUrl: '',
    repositoryUrl: 'https://github.com/cooleryu/opengeo',
  };

  const rows: AuditedResearchRow[] = [
    makeRow('q1', 'chatgpt', 'no', [
      { title: '官方网站', url: 'https://peec.ai/?utm_source=chatgpt.com' },
      { title: 'Brand Radar', url: 'https://ahrefs.com/brand-radar?utm_source=chatgpt.com' },
      { title: 'Translate this page', url: 'https://example.com/noise' },
    ]),
    makeRow('q2', 'chatgpt', 'yes', [
      { title: 'Brand Radar', url: 'https://ahrefs.com/brand-radar/' },
      { title: 'OpenGEO GitHub', url: 'https://github.com/cooleryu/opengeo?utm_source=chatgpt.com', kind: 'other' },
      { title: 'OpenGEO 知识库', url: 'https://www.opengeo.work/?utm_source=chatgpt.com', kind: 'other' },
    ]),
    makeRow('q3', 'google', 'no', [
      {
        title: 'Invisible in AI Search?\n\nReddit\nhttps://www.reddit.com › r › MachineLearning',
        url: 'https://www.google.com/goto?url=CAES_REDDIT_1',
      },
      {
        title: '当AI搜索开始抢走客户',
        url: 'https://www.google.com/goto?url=CAES_OPAQUE_2',
      },
    ]),
    makeRow(
      'q4',
      'google',
      'no',
      [{ title: 'Raw SERP Result', url: 'https://serp-only.example.com/doc#1' }],
      'web_search',
    ),
  ];

  const bundle = buildOverviewSources(rows, {
    sourceOnly: false,
    language: 'zh',
    project,
  });

  assert.equal(bundle.effectiveSourceOnly, false);
  // Noise and raw web_search rows should be excluded in AI mode
  assert.equal(bundle.pages.some((p) => p.openUrl.includes('example.com/noise')), false);
  assert.equal(bundle.pages.some((p) => p.openUrl.includes('serp-only.example.com')), false);

  // Deduplicated Brand Radar leads with questionCount = 2
  const ahrefs = bundle.pages.find((p) => p.displayDomain === 'ahrefs.com');
  assert.ok(ahrefs);
  assert.equal(ahrefs.questionCount, 2);
  assert.equal(ahrefs.hasMissedRow, true);

  // Generic anchor gets prefixed with domain
  const peec = bundle.pages.find((p) => p.displayDomain === 'peec.ai');
  assert.equal(peec?.displayTitle, 'peec.ai · 官方网站');

  // Owned repo detected cleanly even with ?utm_source=chatgpt.com while opengeo.work stays external
  assert.equal(bundle.ownedPages.length, 1);
  assert.equal(bundle.ownedPages[0].displayDomain, 'github.com');
  assert.equal(bundle.ownedPages[0].categoryLabel, '自有');
  const opengeoWork = bundle.pages.find((p) => p.displayDomain === 'opengeo.work');
  assert.equal(opengeoWork?.isOwned, false);

  // Google redirect extracts Reddit domain from breadcrumb, falls back cleanly without claiming google.com
  const reddit = bundle.pages.find((p) => p.displayDomain === 'reddit.com');
  assert.equal(reddit?.displayTitle, 'Invisible in AI Search?');
  const opaque = bundle.pages.find((p) => p.displayDomain === OPAQUE_GOOGLE_SOURCE_LABEL);
  assert.ok(opaque);
  assert.equal(bundle.domains.some((d) => d.domain === 'google.com'), false);
  const opaqueDomainIndex = bundle.domains.findIndex(
    (d) => d.domain === OPAQUE_GOOGLE_SOURCE_LABEL,
  );
  assert.equal(opaqueDomainIndex, bundle.domains.length - 1);

  // Source-only view surfaces web_search SERP sources cleanly
  const searchBundle = buildOverviewSources(
    rows.filter((r) => r.observation?.entryType === 'web_search'),
    { sourceOnly: true, language: 'zh', project },
  );
  assert.equal(searchBundle.effectiveSourceOnly, true);
  assert.equal(searchBundle.pages.length, 1);
  assert.equal(searchBundle.pages[0].displayDomain, 'serp-only.example.com');
});

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
  entryType: 'web_answer' | 'api_search' = 'web_answer',
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
        title: '品牌在AI大模型里“隐形”了？\n\n知乎专栏\nhttps://zhuanlan.zhihu.com › p',
        url: 'https://www.google.com/goto?url=CAES_ZHIHU_1',
      },
      {
        title: '当AI搜索开始抢走客户',
        url: 'https://www.google.com/goto?url=CAES_OPAQUE_2',
      },
    ]),
    makeRow(
      'q4',
      'deepseek',
      'no',
      [{ title: 'Raw SERP Result', url: 'https://serp-only.example.com/doc#1' }],
      'api_search',
    ),
  ];

  const bundle = buildOverviewSources(rows, {
    sourceOnly: false,
    language: 'zh',
    project,
  });

  assert.equal(bundle.effectiveSourceOnly, false);
  // Noise and raw api_search rows should be excluded in AI mode
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

  // Google redirect extracts Zhihu domain from breadcrumb, falls back cleanly without claiming google.com
  const zhihu = bundle.pages.find((p) => p.displayDomain === 'zhuanlan.zhihu.com');
  assert.equal(zhihu?.displayTitle, '品牌在AI大模型里“隐形”了？');
  const opaque = bundle.pages.find((p) => p.displayDomain === OPAQUE_GOOGLE_SOURCE_LABEL);
  assert.ok(opaque);
  assert.equal(bundle.domains.some((d) => d.domain === 'google.com'), false);
  const opaqueDomainIndex = bundle.domains.findIndex(
    (d) => d.domain === OPAQUE_GOOGLE_SOURCE_LABEL,
  );
  assert.equal(opaqueDomainIndex, bundle.domains.length - 1);

  // Source-only view surfaces api_search sources cleanly
  const deepseekBundle = buildOverviewSources(
    rows.filter((r) => r.engine === 'deepseek'),
    { sourceOnly: true, language: 'zh', project },
  );
  assert.equal(deepseekBundle.effectiveSourceOnly, true);
  assert.equal(deepseekBundle.pages.length, 1);
  assert.equal(deepseekBundle.pages[0].displayDomain, 'serp-only.example.com');
});

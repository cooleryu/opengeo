import assert from 'node:assert/strict';
import test from 'node:test';
import { extractHtmlSnapshot } from './action-board-browser-fetch';
import {
  acceptWhy,
  ACTION_CARD_KINDS,
  isCurrentActionBoard,
  KIND_INTERFACE,
  videoPlatformName,
  WHY_MAX,
  type ActionBoardRecord,
} from './action-board-catalog';
import { cleanCompleteSentence, groupRoundupsBySite, polishThreadTitle } from './action-board-message-workers';
import { ACTION_BOARD_MESSAGES_EN, ACTION_BOARD_MESSAGES_ZH } from './action-board-messages';
import { planActionBoard, type PlannerInput } from './action-board-planner';
import { fetchThreadSource, parseMetaDescription, parseRedditThread } from './action-board-threads';
import { assembleDocMarkdown, normalizeStoryboardTiming } from './action-board-workers';
import type { ChannelCitationEntry, OptimizationStrategicBrief } from './citation-landscape';
import type { PageAuditFinding, PageAuditRecord } from './page-audit';

function entry(label: string, domain: string, urls: string[], questionIds: string[], citations = 2): ChannelCitationEntry {
  return {
    label,
    domains: [domain],
    channel: 'open_channel',
    questionCount: questionIds.length,
    questionIds,
    totalCitations: citations,
    engines: ['google'],
    samplePages: urls.map((url, i) => ({ title: `${label} page ${i + 1}`, path: new URL(url).pathname, url })),
  } as ChannelCitationEntry;
}

function brief(overrides: Partial<OptimizationStrategicBrief['citationLandscape']> = {}): OptimizationStrategicBrief {
  const row = (id: string, brands: string[]) => ({
    questionId: id,
    category: 'discovery',
    query: `query ${id}`,
    fanoutQueries: [],
    ownedContentWedge: {} as never,
    chatgpt: { mention: 'no', citation: 'no', recommendedBrands: brands, topCited: [], evidenceSnippet: '' },
    google: { mention: 'no', citation: 'no', recommendedBrands: [], topCited: [], evidenceSnippet: '' },
  });
  return {
    coverage: {
      totalQuestions: 3,
      measuredAnswers: 6,
      mentionYes: 0,
      citationYes: 0,
      brand: { questions: 1, measured: 2, mentionYes: 0, homonymRisk: true, homonymClues: [] },
      discovery: { questions: 2, measured: 4, mentionYes: 0 },
      byEngine: { chatgpt: { measured: 3, mentionYes: 0, citationYes: 0 }, google: { measured: 3, mentionYes: 0, citationYes: 0 } },
    },
    citationLandscape: {
      openChannel: [
        entry('Reddit', 'reddit.com', ['https://www.reddit.com/r/SEO/comments/abc123/best_geo_tool/'], ['q1', 'q2'], 3),
        entry('YouTube', 'youtube.com', ['https://www.youtube.com/watch?v=xyz'], ['q2']),
        entry('AlternativeTo', 'alternativeto.net', ['https://alternativeto.net/software/x/'], ['q3']),
      ],
      directCompetitorRepos: [entry('awesome', 'github.com', ['https://github.com/someone/awesome-geo'], ['q1'])],
      directCompetitorSites: [],
      thirdPartyRoundups: [entry('Blog', 'example.com', ['https://example.com/best-geo-tools'], ['q3'])],
      authorityEditorial: [],
      channelGuidance: [],
      ...overrides,
    },
    questionMatrix: [row('q1', ['Profound', 'Otterly']), row('q2', ['Profound']), row('q3', [])] as never,
    alreadyShipped: { existingRepoDocs: ['README.md'], recentShippedDeliverables: [], outreachItems: [] },
  };
}

function finding(id: string, impact: 'high' | 'medium', status: PageAuditFinding['status'] = 'open'): PageAuditFinding {
  return {
    id,
    category: 'missing_definition',
    impact,
    sectionId: 'S0',
    sectionHeading: 'OpenGEO',
    startLine: 1,
    endLine: 4,
    sectionExcerpt: 'excerpt',
    anchorQuote: 'quote',
    title: 't',
    whyAiMissed: 'w',
    citedEngines: ['google'],
    codebaseFact: '',
    suggestedDirection: '',
    status,
  };
}

const audit = {
  id: 'pa-1',
  targetLabel: 'README.md',
  targetUrl: 'https://github.com/acme/tool/blob/main/README.md',
  findings: [finding('f-1', 'medium'), finding('f-2', 'high'), finding('f-3', 'medium', 'applied')],
} as unknown as PageAuditRecord;

const baseInput = (over: Partial<PlannerInput> = {}): PlannerInput => ({
  brief: brief(),
  audit,
  auditTarget: null,
  previous: null,
  brandName: 'Tool',
  repositoryUrl: 'https://github.com/acme/tool',
  ...over,
});

test('planner puts the page edit first, computes evidence in code, and caps primary cards at four', () => {
  const cards = planActionBoard(baseInput());
  assert.equal(cards[0].kind, 'page_diff');
  assert.equal(cards[0].reason, 'homonym');
  assert.deepEqual(cards[0].seeds.findingIds, ['f-2', 'f-1'], 'open findings only, high impact first');
  assert.ok(cards.filter((c) => c.placement === 'primary').length <= 4);
  const reply = cards.find((c) => c.kind === 'community_reply');
  assert.ok(reply);
  assert.deepEqual(reply.evidence.questionIds, ['q1', 'q2']);
  assert.equal(reply.evidence.questionCount, 2);
  assert.equal(reply.evidence.citationCount, 3);
  const doc = cards.find((c) => c.kind === 'doc_draft');
  assert.deepEqual(doc?.seeds.competitors, ['Profound', 'Otterly']);
  assert.equal(doc?.target.path, 'docs/comparisons/profound-otterly-alternatives.md');
  assert.equal(cards.find((c) => c.kind === 'outreach_email')?.placement, 'secondary');
  assert.ok(cards.every((c) => c.status === 'pending' && c.payload === null));
  assert.deepEqual(
    planActionBoard(baseInput()).map((c) => c.id),
    cards.map((c) => c.id),
    'ids are deterministic across refreshes',
  );
});

test('planner keeps done cards done and moves them out of the primary slots', () => {
  const first = planActionBoard(baseInput());
  const doneId = first.find((c) => c.kind === 'community_reply')!.id;
  const previous = {
    cards: first.map((c) => (c.id === doneId ? { ...c, completedAt: '2026-11-01T00:00:00Z', publishedUrl: 'https://x.test/p' } : c)),
  } as ActionBoardRecord;
  const next = planActionBoard(baseInput({ previous }));
  const carried = next.find((c) => c.id === doneId)!;
  assert.equal(carried.completedAt, '2026-11-01T00:00:00Z');
  assert.equal(carried.publishedUrl, 'https://x.test/p');
  assert.equal(carried.placement, 'secondary');
});

test('planner offers a page check when there is no audit yet', () => {
  const cards = planActionBoard(
    baseInput({
      audit: null,
      auditTarget: { assetId: 'asset-readme', label: 'README.md', targetKind: 'repo_doc', publicUrl: null, localFilePath: 'README.md' },
    }),
  );
  assert.equal(cards[0].kind, 'page_diff');
  assert.deepEqual(cards[0].seeds.findingIds, []);
  assert.equal(cards[0].target.assetId, 'asset-readme');
});

test('parseRedditThread keeps the post and the top three live replies', () => {
  const json = [
    { data: { children: [{ kind: 't3', data: { author: 'op', selftext: 'Which GEO tool tracks Google AI?', score: 12, num_comments: 9, locked: false } }] } },
    {
      data: {
        children: [
          { kind: 't1', data: { author: 'a', body: 'Try X', score: 3 } },
          { kind: 't1', data: { author: 'b', body: '[deleted]', score: 99 } },
          { kind: 't1', data: { author: 'c', body: 'Y works', score: 10 } },
          { kind: 'more', data: {} },
          { kind: 't1', data: { author: 'd', body: 'Z', score: 1 } },
          { kind: 't1', data: { author: 'e', body: 'W', score: 0 } },
        ],
      },
    },
  ];
  const source = parseRedditThread(json, '2026-11-22T00:00:00Z');
  assert.equal(source.status, 'fetched');
  assert.equal(source.op?.body, 'Which GEO tool tracks Google AI?');
  assert.deepEqual(source.replies?.map((r) => r.author), ['c', 'a', 'd']);
  assert.equal(source.commentCount, 9);
});

test('thread fetch degrades to title-only with a reason instead of guessing', async () => {
  const runtime = {
    lookup: async () => [{ address: '151.101.1.140', family: 4 }],
    request: async () => ({ status: 403, headers: { 'content-type': 'text/html' }, body: 'blocked' }),
  };
  const source = await fetchThreadSource('https://www.reddit.com/r/SEO/comments/abc123/x/', runtime);
  assert.equal(source.status, 'title_only');
  assert.equal(source.reason, 'blocked');
  assert.equal(source.op, undefined);
  assert.equal(parseMetaDescription('<meta property="og:description" content="Best &amp; cheapest">'), 'Best & cheapest');
});

test('board messages are complete en/zh pairs with matching placeholders and plural forms', () => {
  const keys = Object.keys(ACTION_BOARD_MESSAGES_EN) as Array<keyof typeof ACTION_BOARD_MESSAGES_EN>;
  for (const key of keys) {
    const en = ACTION_BOARD_MESSAGES_EN[key];
    const zh = ACTION_BOARD_MESSAGES_ZH[key];
    assert.ok(en.trim() && zh.trim(), `${key} is empty`);
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(vars(en), vars(zh), `${key} placeholders differ`);
    assert.ok(!/\p{Script=Han}/u.test(en), `${key} English text contains Chinese`);
    if (key.endsWith('.one')) assert.ok(`${key.slice(0, -4)}.other` in ACTION_BOARD_MESSAGES_EN, `${key} lacks .other`);
  }
  for (const kind of ACTION_CARD_KINDS) {
    assert.ok(`kind.${kind}` in ACTION_BOARD_MESSAGES_EN);
    assert.ok(KIND_INTERFACE[kind]);
  }
});

test('assembled comparison doc leads with the table, and v2 boards are detected as stale', () => {
  const md = assembleDocMarkdown({
    title: 'Tool vs Profound',
    tldr: 'Tool is self-hosted; Profound is a hosted service.',
    table: { products: ['Tool', 'Profound'], rows: [{ dimension: 'Hosting', cells: ['Self-hosted', 'Cloud'] }] },
    sections: [{ heading: 'Pricing', body: 'Tool is free.' }],
    claims: [],
  } as never);
  const lines = md.split('\n');
  assert.equal(lines[0], '# Tool vs Profound');
  assert.equal(lines[2], '| | Tool | Profound |');
  assert.ok(md.indexOf('**TL;DR**') > md.indexOf('| Hosting |'));
  assert.equal(isCurrentActionBoard({ cards: [], uiLanguage: 'zh' }), false);
  assert.equal(isCurrentActionBoard({ schemaVersion: 3, cards: [] }), true);

  const richMd = assembleDocMarkdown({
    title: 'Tool vs Profound',
    tldr: 'Tool runs locally; Profound is hosted.',
    screenshotUrl: 'https://example.com/overview.png',
    table: { products: ['Tool', 'Profound'], rows: [{ dimension: 'Hosting', cells: ['Local', 'Cloud'] }] },
    verdict: {
      ownHeadline: 'Choose Tool for local privacy',
      ownPoints: ['MIT open source', 'Zero SaaS fees'],
      saasHeadline: 'Choose Profound for managed dashboards',
      saasPoints: ['Hosted analytics', 'Enterprise reporting'],
    },
    bestFor: [
      { product: 'Tool', badge: 'Local-first', idealFor: 'Solo founders', tradeOff: 'Runs on your machine' },
      { product: 'Profound', badge: 'Hosted SaaS', idealFor: 'Large teams', tradeOff: 'Paid subscription' },
    ],
    workflow: {
      traditionalTitle: 'Hosted SaaS',
      traditionalSteps: ['Pay monthly', 'View dashboard', 'Write edits manually'],
      ownTitle: 'Tool',
      ownSteps: ['Capture locally', 'Audit gaps', 'Draft ready PR'],
    },
    sections: [{ heading: 'Pricing', body: 'Tool is free.' }],
    claims: [],
  } as never);
  assert.ok(richMd.includes('![Tool product interface](https://example.com/overview.png)'));
  assert.ok(richMd.includes('## Quick verdict'));
  assert.ok(richMd.includes('## Who should pick which?'));
  assert.ok(richMd.includes('```mermaid\nflowchart LR'));
});

test('acceptWhy keeps short bilingual lines and drops over-long, too-short, or mixed-language ones', () => {
  assert.deepEqual(
    acceptWhy({
      en: '  AI answers name competitors only; a clear opening puts you in.  ',
      zh: '  AI 回答只提竞品，写清开头才认得你。  ',
    }),
    {
      en: 'AI answers name competitors only; a clear opening puts you in.',
      zh: 'AI 回答只提竞品，写清开头才认得你。',
    },
  );
  assert.equal(acceptWhy(undefined), undefined);
  assert.equal(acceptWhy({ en: 'Too short.', zh: '足够长的中文说明句。' }), undefined);
  assert.equal(acceptWhy({ en: 'Long enough English sentence.', zh: '太短了' }), undefined);
  assert.equal(acceptWhy({ en: 'a'.repeat(WHY_MAX.en + 1), zh: '足够长的中文说明句。' }), undefined);
  assert.equal(acceptWhy({ en: 'Long enough English sentence.', zh: '字'.repeat(WHY_MAX.zh + 1) }), undefined);
  assert.equal(acceptWhy({ en: 'English mixed with 中文 fails.', zh: '足够长的中文说明句。' }), undefined);
  assert.equal(acceptWhy({ en: 'Long enough English sentence.', zh: 'English only in zh slot' }), undefined);
  assert.equal(videoPlatformName('youtube.com'), 'YouTube');
  assert.equal(videoPlatformName('bilibili.com'), 'Bilibili');
  assert.equal(videoPlatformName('vimeo.com'), 'Vimeo');
  assert.equal(videoPlatformName('loom.com'), 'loom.com');
});

test('roundups group by domain, sentences never cut mid-phrase, thread slugs polish, and storyboard timing fits speech', () => {
  const grouped = groupRoundupsBySite([
    { title: 'ansvisor.com', url: 'https://www.ansvisor.com/blog/guide-a', channel: 'ansvisor.com' },
    { title: 'ansvisor.com', url: 'https://www.ansvisor.com/blog/guide-b', channel: 'ansvisor.com' },
    { title: 'Built In', url: 'https://builtin.com/articles/ai-brand-monitoring', channel: 'builtin.com' },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].siteName, 'ansvisor.com');
  assert.equal(grouped[0].articles.length, 2);

  const sentence = cleanCompleteSentence(
    'OpenGEO is an open-source, local-first AI search visibility workbench. It captures real ChatGPT and Google AI Overview answers from your own browser and turns gaps into drafts you can publish.',
    120,
  );
  assert.equal(sentence, 'OpenGEO is an open-source, local-first AI search visibility workbench.');
  assert.equal(polishThreadTitle('What is the best tool to track brand mentions in'), 'What is the best tool to track brand mentions in…');
  assert.equal(polishThreadTitle('How can I see brand mentions in ChatGPT?'), 'How can I see brand mentions in ChatGPT?');

  const timed = normalizeStoryboardTiming([
    { t: '0:00', lines: ['Buyers ask AI which tool to use and your brand is missing.'] },
    { t: '1:30', lines: ['OpenGEO captures real ChatGPT and Google answers locally on your computer.'] },
    { t: '3:10', lines: ['Turn each gap into a verified edit and re-run the same questions.'] },
  ]);
  assert.equal(timed.beats[0].t, '0:00');
  assert.notEqual(timed.duration, '4:00');

  const blocked = extractHtmlSnapshot('<html><title>Just a moment...</title><body>Verify you are human</body></html>', 'https://example.com/');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'blocked');

  const okSnap = extractHtmlSnapshot(
    '<html><head><title>Profound Pricing</title><meta name="description" content="Enterprise AI visibility pricing and plans."></head><body><h1>Pricing</h1><p>Hosted SaaS plans starting at $99/mo with ChatGPT and Perplexity tracking.</p><a href="mailto:editors@example.com">Contact</a></body></html>',
    'https://www.tryprofound.com/pricing',
  );
  assert.equal(okSnap.ok, true);
  assert.deepEqual(okSnap.contactHints, ['editors@example.com']);
});

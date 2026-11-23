import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAutocompletePrefixes,
  collectDemandSignals,
  sanitizeCompetitorDomain,
  slugToTopic,
} from './demand-signals';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  });
}

test('sanitizeCompetitorDomain blocks localhost, private IPs, and invalid inputs (SSRF guard)', () => {
  assert.equal(sanitizeCompetitorDomain('https://www.Otterly.ai/pricing'), 'otterly.ai');
  assert.equal(sanitizeCompetitorDomain('tryprofound.com'), 'tryprofound.com');
  assert.equal(sanitizeCompetitorDomain('http://localhost:3000'), null);
  assert.equal(sanitizeCompetitorDomain('http://127.0.0.1/sitemap.xml'), null);
  assert.equal(sanitizeCompetitorDomain('192.168.1.5'), null);
  assert.equal(sanitizeCompetitorDomain('internal.local'), null);
  assert.equal(sanitizeCompetitorDomain('https://user:pass@example.com'), null);
  assert.equal(sanitizeCompetitorDomain('not a domain'), null);
});

test('slugToTopic converts high-intent URL slugs cleanly and ignores boilerplate routes', () => {
  assert.equal(slugToTopic('https://peec.ai/blog/how-to-get-cited-by-chatgpt'), 'how to get cited by chatgpt');
  assert.equal(slugToTopic('https://peec.ai/comparison/peec-vs-profound.html'), 'peec vs profound');
  assert.equal(slugToTopic('https://peec.ai/blog'), null);
  assert.equal(slugToTopic('https://peec.ai/privacy'), null);
});

test('buildAutocompletePrefixes builds high-intent templates for English and Chinese', () => {
  const en = buildAutocompletePrefixes({
    seeds: ['ai visibility'],
    painVerbs: ['get cited by chatgpt'],
    competitors: [{ name: 'Otterly AI' }],
    targetLanguage: 'en',
  });
  assert.ok(en.some(p => p.includes('best ai visibility')));
  assert.ok(en.some(p => p.includes('how to get cited by chatgpt')));
  assert.ok(en.some(p => p.includes('Otterly AI alternatives')));

  const zh = buildAutocompletePrefixes({
    seeds: ['AI 搜索监测'],
    painVerbs: ['提高 ChatGPT 引用率'],
    competitors: [{ name: '竞品甲' }],
    targetLanguage: 'zh',
  });
  assert.ok(zh.some(p => p.includes('AI 搜索监测 推荐')));
  assert.ok(zh.some(p => p.includes('怎么 提高 ChatGPT 引用率')));
  assert.ok(zh.some(p => p.includes('竞品甲 替代')));
});

test('free default track parses Autocomplete, robots.txt -> sitemap index, and HN Algolia', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith('https://suggestqueries.google.com/')) {
      return jsonResponse(['q', ['best ai visibility tools', 'otterly ai alternatives', 'peec ai vs profound']]);
    }
    if (url === 'https://peec.ai/robots.txt') {
      return textResponse('User-agent: *\nSitemap: https://peec.ai/custom-index.xml\n');
    }
    if (url === 'https://peec.ai/custom-index.xml') {
      return textResponse('<sitemapindex><sitemap><loc>https://peec.ai/blog-sitemap.xml</loc></sitemap></sitemapindex>');
    }
    if (url === 'https://peec.ai/blog-sitemap.xml') {
      return textResponse(
        '<urlset><url><loc>https://peec.ai/comparison/peec-vs-profound</loc></url><url><loc>https://peec.ai/blog/how-to-get-cited-by-chatgpt</loc></url></urlset>',
      );
    }
    if (url.startsWith('https://hn.algolia.com/')) {
      return jsonResponse({
        hits: [
          { title: 'Show HN: Open-source AI search visibility tracker', points: 42, num_comments: 15, objectID: '999' },
          { title: 'Zero engagement noise post', points: 0, num_comments: 0, objectID: '100' },
        ],
      });
    }
    return textResponse('', 404);
  };

  const result = await collectDemandSignals({
    seeds: ['ai visibility'],
    painVerbs: ['get cited by chatgpt'],
    competitors: [{ name: 'Peec AI', domain: 'peec.ai' }],
    targetLanguage: 'en',
    dataForSeo: null,
    fetcher,
  });

  assert.equal(result.trackUsed, 'free');
  assert.equal(result.costUsd, 0);
  assert.equal(result.selfCorrected, false);
  assert.ok(result.signals.every((s, idx) => s.id === `sig-${idx + 1}`));
  assert.ok(result.signals.some(s => s.keyword === 'best ai visibility tools' && s.source === 'google_autocomplete'));
  assert.ok(result.signals.some(s => s.keyword === 'peec vs profound' && s.competitorDomain === 'peec.ai'));
  assert.ok(result.signals.some(s => s.keyword.includes('Open-source AI search visibility tracker') && s.source === 'hn_discussion'));
  assert.ok(!result.signals.some(s => s.keyword.includes('Zero engagement noise')));
});

test('L2 -> L1 self-correction triggers when initial competitor has 0 sitemap hits and autocomplete discovers peer', async () => {
  const requestedUrls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.startsWith('https://suggestqueries.google.com/')) {
      if (url.includes('Profound')) {
        return jsonResponse(['q', ['profound alternatives', 'profound pricing']]);
      }
      return jsonResponse(['q', ['unknowncomp vs profound', 'best geo tools']]);
    }
    return textResponse('', 404);
  };

  const result = await collectDemandSignals({
    seeds: ['geo tools'],
    competitors: [{ name: 'UnknownComp', domain: 'unknowncomp.example' }],
    targetLanguage: 'en',
    includeHn: false,
    dataForSeo: null,
    fetcher,
  });

  assert.equal(result.selfCorrected, true);
  assert.ok(result.discoveredCompetitors.some(c => c.toLowerCase().includes('profound')));
  assert.ok(requestedUrls.some(u => decodeURIComponent(u).toLowerCase().includes('profound alternatives')));
});

test('DataForSEO Pro track enriches signals, merges ranked keywords, and respects strict $0.06 budget cap', async () => {
  let rankedCalls = 0;
  let overviewCalls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://suggestqueries.google.com/')) {
      return jsonResponse(['q', ['best ai visibility tools', 'otterly ai alternatives']]);
    }
    if (url.includes('/ranked_keywords/live')) {
      rankedCalls++;
      const body = JSON.parse(String(init?.body ?? '[]')) as Array<{ target?: string }>;
      const domain = body[0]?.target ?? 'otterly.ai';
      return jsonResponse({
        status_code: 20000,
        cost: 0.025,
        tasks: [{
          status_code: 20000,
          cost: 0.025,
          result: [{
            items: [{
              keyword_data: {
                keyword: `${domain === 'otterly.ai' ? 'query fan out tool' : 'peec ai vs profound'}`,
                keyword_info: { search_volume: 140, cpc: 17.6 },
                search_intent_info: { main_intent: 'commercial' },
                keyword_properties: { keyword_difficulty: 16 },
              },
              ranked_serp_element: { serp_item: { rank_group: 2, relative_url: '/ai-query-fan-out' } },
            }],
          }],
        }],
      });
    }
    if (url.includes('/keyword_overview/live')) {
      overviewCalls++;
      return jsonResponse({
        status_code: 20000,
        cost: 0.015,
        tasks: [{
          status_code: 20000,
          cost: 0.015,
          result: [{
            items: [{
              keyword: 'best ai visibility tools',
              keyword_info: { search_volume: 590, cpc: 53.51 },
              search_intent_info: { main_intent: 'commercial' },
              keyword_properties: { keyword_difficulty: 9 },
            }],
          }],
        }],
      });
    }
    return textResponse('', 404);
  };

  // Budget cap = $0.055 -> allows 2 ranked calls ($0.05) and skips 3rd competitor + overview to stay <= $0.055!
  const result = await collectDemandSignals({
    seeds: ['ai visibility'],
    competitors: [
      { name: 'Otterly', domain: 'otterly.ai' },
      { name: 'Peec', domain: 'peec.ai' },
      { name: 'Profound', domain: 'tryprofound.com' },
    ],
    includeHn: false,
    dataForSeo: { login: 'demo', password: 'secret' },
    maxBudgetUsd: 0.055,
    fetcher,
  });

  assert.equal(result.trackUsed, 'dataforseo');
  assert.equal(rankedCalls, 2, 'must stop before 3rd competitor to respect budget cap');
  assert.equal(overviewCalls, 0, 'must skip overview when remaining budget is below cost');
  assert.ok(result.costUsd <= 0.055);
  const fanoutSig = result.signals.find(s => s.keyword === 'query fan out tool');
  assert.ok(fanoutSig);
  assert.equal(fanoutSig.searchVolume, 140);
  assert.equal(fanoutSig.kd, 16);
  assert.equal(fanoutSig.competitorDomain, 'otterly.ai');
});

test('gracefully degrades without throwing when offline or DataForSEO returns 40104 verification error', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('api.dataforseo.com')) {
      return jsonResponse({
        status_code: 20000,
        cost: 0,
        tasks: [{ status_code: 40104, status_message: 'Please verify your account before using the API.' }],
      }, 403);
    }
    throw new Error('ECONNREFUSED offline');
  };

  const result = await collectDemandSignals({
    seeds: ['ai visibility'],
    competitors: [{ name: 'Otterly', domain: 'otterly.ai' }],
    dataForSeo: { login: 'demo', password: 'secret' },
    fetcher,
  });

  assert.equal(result.trackUsed, 'free');
  assert.equal(result.signals.length, 0);
  assert.equal(result.costUsd, 0);
  assert.ok(result.warnings.some(w => w.includes('verify')));
});

test('sparse kd=0 generic two-word phrase without CPC ranks below genuine commercial low-KD keyword', async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/ranked_keywords/live')) {
      return jsonResponse({
        status_code: 20000,
        cost: 0.015,
        tasks: [{
          status_code: 20000,
          cost: 0.015,
          result: [{
            items: [
              {
                keyword_data: {
                  keyword: 'different answers',
                  keyword_info: { search_volume: 2400, cpc: null },
                  search_intent_info: { main_intent: 'informational' },
                  keyword_properties: { keyword_difficulty: 0 },
                },
                ranked_serp_element: { serp_item: { rank_group: 9 } },
              },
              {
                keyword_data: {
                  keyword: 'best ai visibility tools',
                  keyword_info: { search_volume: 590, cpc: 53.51 },
                  search_intent_info: { main_intent: 'commercial' },
                  keyword_properties: { keyword_difficulty: 9 },
                },
                ranked_serp_element: { serp_item: { rank_group: 5 } },
              },
            ],
          }],
        }],
      });
    }
    return textResponse('', 404);
  };

  const result = await collectDemandSignals({
    seeds: [],
    competitors: [{ name: 'Otterly', domain: 'otterly.ai' }],
    includeHn: false,
    dataForSeo: { login: 'demo', password: 'secret' },
    maxBudgetUsd: 0.02,
    fetcher,
  });

  assert.equal(result.signals[0]?.keyword, 'best ai visibility tools');
  assert.ok(result.signals[0].score > (result.signals.find(s => s.keyword === 'different answers')?.score ?? 0));
});

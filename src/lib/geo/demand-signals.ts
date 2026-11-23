import type { QuestionDemandSignal, QuestionDemandSignalSource } from './question-types';

export interface CompetitorSeed { name: string; domain?: string; }

export interface DemandSignalCollectionInput {
  seeds: string[]; painVerbs?: string[]; competitors?: CompetitorSeed[];
  targetLanguage?: 'en' | 'zh'; includeHn?: boolean;
  dataForSeo?: { login: string; password: string } | null; maxBudgetUsd?: number; fetcher?: typeof fetch;
}

export interface RankedDemandSignal extends QuestionDemandSignal {
  score: number; sources: QuestionDemandSignalSource[];
  tacticHint?: 'direct-content' | 'outreach-monitor' | 'competitor-intercept';
}

export interface DemandSignalCollectionResult {
  signals: RankedDemandSignal[]; trackUsed: 'dataforseo' | 'free';
  discoveredCompetitors: string[]; selfCorrected: boolean; costUsd: number; warnings: string[];
}

const DEFAULT_TIMEOUT_MS = 7000;
const DATAFORSEO_TIMEOUT_MS = 20000;
const USER_AGENT = 'OpenGEO-DemandSignals/1.0 (+https://github.com/cooleryu/OpenGEO)';
const SOURCE_PRIORITY: Record<QuestionDemandSignalSource, number> = {
  dataforseo_ranked: 5, dataforseo_overview: 4, csv_import: 4,
  google_autocomplete: 3, competitor_sitemap: 2, hn_discussion: 1,
};

const cleanKeyword = (raw: string) => raw.replace(/\s+/g, ' ').trim().slice(0, 260);
const normalizeKey = (raw: string) =>
  raw.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

export function sanitizeCompetitorDomain(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let host = trimmed;
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  // Basic SSRF guard: require a public-looking multi-label hostname, never IPs or local hosts.
  if (
    !host.includes('.') ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    host.includes(':') ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    return null;
  }
  return host;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function safeFetchJson(fetcher: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown | null> {
  try {
    const res = await fetcher(url, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function safeFetchText(fetcher: typeof fetch, url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  try {
    const res = await fetcher(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, application/xml, text/xml;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 600_000);
  } catch {
    return null;
  }
}

export function buildAutocompletePrefixes(input: {
  seeds: string[];
  painVerbs?: string[];
  competitors?: CompetitorSeed[];
  targetLanguage?: 'en' | 'zh';
}): string[] {
  const lang = input.targetLanguage ?? 'en';
  const seeds = input.seeds.map(cleanKeyword).filter(Boolean).slice(0, 4);
  const pains = (input.painVerbs ?? []).map(cleanKeyword).filter(Boolean).slice(0, 3);
  const competitors = (input.competitors ?? [])
    .map(c => cleanKeyword(c.name))
    .filter(name => name.length >= 2)
    .slice(0, 3);

  const prefixes: string[] = [];
  const push = (value: string) => {
    const v = value.replace(/\s+/g, ' ').trim();
    if (v && !prefixes.includes(v)) prefixes.push(v);
  };

  if (lang === 'zh') {
    for (const seed of seeds.slice(0, 3)) {
      push(`${seed} 推荐`);
      push(`${seed} 工具`);
      push(`${seed} 对比`);
    }
    for (const pain of pains) {
      push(pain.startsWith('怎么') || pain.startsWith('如何') ? pain : `怎么 ${pain}`);
    }
    for (const comp of competitors) {
      push(`${comp} 替代`);
      push(`${comp} 价格`);
      push(`${comp} 对比`);
    }
  } else {
    for (const seed of seeds.slice(0, 3)) {
      const lower = seed.toLowerCase();
      push(lower.startsWith('best ') ? `${seed} ` : `best ${seed} `);
      if (!/\b(tool|tools|software|platform|app)\b/i.test(seed)) push(`${seed} tools`);
      push(`free ${seed} `);
    }
    for (const pain of pains) {
      const lower = pain.toLowerCase();
      push(lower.startsWith('how to ') ? pain : `how to ${pain}`);
    }
    for (const comp of competitors) {
      push(`${comp} alternatives`);
      push(`${comp} pricing`);
      push(`${comp} vs `);
    }
  }
  return prefixes.slice(0, 18);
}

async function fetchGoogleAutocomplete(fetcher: typeof fetch, prefix: string, lang: 'en' | 'zh'): Promise<string[]> {
  const hl = lang === 'zh' ? 'zh-CN' : 'en';
  const gl = lang === 'zh' ? 'cn' : 'us';
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=${hl}&gl=${gl}&q=${encodeURIComponent(prefix)}`;
  const data = await safeFetchJson(fetcher, url);
  if (!Array.isArray(data) || !Array.isArray(data[1])) return [];
  return data[1]
    .filter((item): item is string => typeof item === 'string')
    .map(cleanKeyword)
    .filter(item => item.length >= 3);
}

function extractCompetitorCandidatesFromSuggestions(suggestions: string[], knownNames: Set<string>): string[] {
  const found = new Map<string, number>();
  for (const s of suggestions) {
    const vsMatch = s.match(/^([a-z0-9][a-z0-9.\s-]{1,28}?)\s+vs\.?\s+([a-z0-9][a-z0-9.\s-]{1,28})$/i);
    if (vsMatch) {
      for (const raw of [vsMatch[1], vsMatch[2]]) {
        const cleaned = raw.trim().replace(/\b(pricing|review|reviews|202\d|tool|tools|seo|ai)\b$/i, '').trim();
        const key = normalizeKey(cleaned);
        if (cleaned.length >= 2 && cleaned.length <= 24 && !knownNames.has(key) && !/^(best|top|free|open source|how to)$/i.test(cleaned)) {
          found.set(cleaned, (found.get(cleaned) ?? 0) + 1);
        }
      }
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .slice(0, 4);
}

export function slugToTopic(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (!segments.length) return null;
    const last = decodeURIComponent(segments[segments.length - 1])
      .replace(/\.(html?|php|aspx?|md)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (last.length < 4 || last.length > 120) return null;
    if (/^(index|home|page|blog|posts|category|tag|author|privacy|terms|contact|about|login|signup)$/i.test(last)) return null;
    if (/^\d+$/.test(last)) return null;
    return last;
  } catch {
    return null;
  }
}

async function fetchCompetitorSitemapTopics(fetcher: typeof fetch, domain: string): Promise<{ topic: string; url: string }[]> {
  const sitemapCandidates: string[] = [];
  const robots = await safeFetchText(fetcher, `https://${domain}/robots.txt`, 5000);
  if (robots) {
    for (const match of robots.matchAll(/^\s*sitemap:\s*(https?:\/\/\S+)/gim)) {
      const candidate = match[1].trim();
      if (!sitemapCandidates.includes(candidate)) sitemapCandidates.push(candidate);
    }
  }
  for (const fallback of [`https://${domain}/sitemap.xml`, `https://${domain}/sitemap_index.xml`, `https://www.${domain}/sitemap.xml`]) {
    if (!sitemapCandidates.includes(fallback)) sitemapCandidates.push(fallback);
  }

  let pageUrls: string[] = [];
  for (const smUrl of sitemapCandidates.slice(0, 4)) {
    const xml = await safeFetchText(fetcher, smUrl, 6000);
    if (!xml || !xml.includes('<loc>')) continue;
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map(m => m[1].trim());
    if (!locs.length) continue;
    const subSitemaps = locs.filter(l => /\.xml(?:\?.*)?$/i.test(l));
    if (subSitemaps.length > 0 && subSitemaps.length >= locs.length * 0.6) {
      const prioritized = [
        ...subSitemaps.filter(s => /post|blog|compare|vs|alt|tool|guide|page/i.test(s)),
        ...subSitemaps.filter(s => !/post|blog|compare|vs|alt|tool|guide|page/i.test(s)),
      ].slice(0, 3);
      for (const sub of prioritized) {
        const subXml = await safeFetchText(fetcher, sub, 5000);
        if (!subXml) continue;
        for (const m of subXml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) pageUrls.push(m[1].trim());
      }
    } else {
      pageUrls = locs;
    }
    if (pageUrls.length) break;
  }

  // Prioritize comparison/alternative/tool/guide/blog pages, dedupe by slug topic
  const highIntent = pageUrls.filter(u =>
    /\/(vs|compare|comparison|alternative|alternatives|tools|guides?|blog|use-cases?|solutions?)\//i.test(u)
  );
  const pool = highIntent.length >= 5 ? highIntent : pageUrls;
  const seen = new Set<string>();
  const out: { topic: string; url: string }[] = [];
  const scored = pool
    .map(url => {
      const topic = slugToTopic(url);
      if (!topic) return null;
      let rank = 1;
      if (/\/(vs|compare|comparison|alternative|alternatives)\//i.test(url) || /\b(vs|alternative|alternatives|best|pricing|how to)\b/i.test(topic)) rank += 4;
      if (/\/(tools|guides?)\//i.test(url)) rank += 2;
      if (/\.(md|xml|json)$/i.test(url)) rank -= 2;
      return { topic, url, rank };
    })
    .filter((x): x is { topic: string; url: string; rank: number } => Boolean(x))
    .sort((a, b) => b.rank - a.rank);

  for (const item of scored) {
    const key = normalizeKey(item.topic);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ topic: item.topic, url: item.url });
    if (out.length >= 15) break;
  }
  return out;
}

async function fetchHnTopics(fetcher: typeof fetch, query: string): Promise<{ title: string; url: string; points: number }[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=6`;
  const data = await safeFetchJson(fetcher, url) as { hits?: Array<{ title?: string; points?: number; num_comments?: number; objectID?: string }> } | null;
  if (!data?.hits) return [];
  return data.hits
    .filter(h => typeof h.title === 'string' && h.title.trim().length >= 8 && ((h.points ?? 0) >= 2 || (h.num_comments ?? 0) >= 2))
    .map(h => ({
      title: cleanKeyword(h.title!),
      url: `https://news.ycombinator.com/item?id=${h.objectID ?? ''}`,
      points: h.points ?? 0,
    }))
    .slice(0, 5);
}

type DfsResponse = {
  status_code?: number;
  status_message?: string;
  cost?: number;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: Array<{ items?: Array<Record<string, unknown>> }>;
  }>;
};

async function callDataForSeo(
  fetcher: typeof fetch,
  creds: { login: string; password: string },
  endpoint: string,
  payload: unknown[],
): Promise<{ ok: boolean; cost: number; items: Array<Record<string, unknown>>; error?: string }> {
  const auth = 'Basic ' + Buffer.from(`${creds.login}:${creds.password}`).toString('base64');
  try {
    const res = await fetcher(`https://api.dataforseo.com${endpoint}`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(DATAFORSEO_TIMEOUT_MS),
    });
    const data = (await res.json()) as DfsResponse;
    const cost = typeof data?.cost === 'number' ? data.cost : 0;
    const task = data?.tasks?.[0];
    if (!res.ok || data?.status_code !== 20000 || (task?.status_code && task.status_code !== 20000)) {
      return {
        ok: false,
        cost,
        items: [],
        error: task?.status_message || data?.status_message || `HTTP ${res.status}`,
      };
    }
    return { ok: true, cost, items: task?.result?.[0]?.items ?? [] };
  } catch (err) {
    return { ok: false, cost: 0, items: [], error: err instanceof Error ? err.message : 'network error' };
  }
}

function inferTacticHint(sig: {
  keyword: string;
  kd?: number;
  competitorDomain?: string;
  intent?: string;
}): 'direct-content' | 'outreach-monitor' | 'competitor-intercept' {
  const lower = sig.keyword.toLowerCase();
  if (/\b(vs|versus|alternative|alternatives|pricing|competitors?|review|reviews)\b|替代|对比|价格/.test(lower)) {
    return 'competitor-intercept';
  }
  if (typeof sig.kd === 'number' && sig.kd >= 35) return 'outreach-monitor';
  return 'direct-content';
}

function computeSignalScore(sig: {
  source: QuestionDemandSignalSource;
  sources: QuestionDemandSignalSource[];
  keyword: string;
  searchVolume?: number;
  cpc?: number;
  kd?: number;
  intent?: string;
  competitorRank?: number;
}): number {
  let score = SOURCE_PRIORITY[sig.source] * 10 + (sig.sources.length - 1) * 18;
  const lower = sig.keyword.toLowerCase();

  // High-intent commercial & problem patterns
  if (/\b(best|top|alternative|alternatives|vs|pricing|tool|tools|software|tracker|platform)\b|推荐|替代|对比|工具/.test(lower)) {
    score += 18;
  }
  if (/\b(how to|why does|guide)\b|怎么|如何/.test(lower)) {
    score += 10;
  }

  // Quantitative SEO scoring when available (DataForSEO / CSV)
  if (typeof sig.searchVolume === 'number' && sig.searchVolume > 0) {
    score += Math.min(40, Math.log10(sig.searchVolume + 1) * 14);
  }
  if (typeof sig.cpc === 'number' && sig.cpc > 0) {
    score += Math.min(35, Math.log10(sig.cpc + 1) * 18);
  }
  if (sig.intent === 'commercial' || sig.intent === 'transactional') {
    score += 22;
  }
  if (typeof sig.kd === 'number') {
    const wordLen = sig.keyword.trim().split(/\s+/).filter(Boolean).length;
    const isSparseZeroKd =
      sig.kd === 0 &&
      !(typeof sig.cpc === 'number' && sig.cpc > 0) &&
      sig.intent !== 'commercial' &&
      sig.intent !== 'transactional' &&
      wordLen <= 2;
    if (!isSparseZeroKd) {
      if (sig.kd <= 20) score += 16; // Low-KD blue ocean bonus
      else if (sig.kd <= 35) score += 8;
    }
  }
  if (typeof sig.competitorRank === 'number' && sig.competitorRank <= 10) {
    score += 14;
  }
  return Math.round(score * 10) / 10;
}

/**
 * L2 Engineering Dual-Track Demand Signal Collector.
 * - Free default track: Google Autocomplete + Competitor robots.txt/Sitemap + HN Algolia.
 * - Pro optional track: DataForSEO ranked_keywords + keyword_overview (budget capped).
 * - Never throws on network failures; degrades cleanly to whatever signals succeeded.
 */
export async function collectDemandSignals(input: DemandSignalCollectionInput): Promise<DemandSignalCollectionResult> {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const lang = input.targetLanguage ?? 'en';
  const maxBudgetUsd = input.maxBudgetUsd ?? 0.06;
  const warnings: string[] = [];
  let costUsd = 0;
  let trackUsed: 'dataforseo' | 'free' = 'free';
  let selfCorrected = false;

  type MutableSignal = {
    source: QuestionDemandSignalSource;
    sources: Set<QuestionDemandSignalSource>;
    keyword: string;
    searchVolume?: number;
    cpc?: number;
    kd?: number;
    intent?: string;
    competitorDomain?: string;
    competitorRank?: number;
    url?: string;
  };

  const pool = new Map<string, MutableSignal>();
  const upsert = (entry: Omit<MutableSignal, 'sources'>) => {
    const cleaned = cleanKeyword(entry.keyword);
    const key = normalizeKey(cleaned);
    if (!key || key.length < 3) return;
    const existing = pool.get(key);
    if (!existing) {
      pool.set(key, { ...entry, keyword: cleaned, sources: new Set([entry.source]) });
      return;
    }
    existing.sources.add(entry.source);
    if (SOURCE_PRIORITY[entry.source] > SOURCE_PRIORITY[existing.source]) {
      existing.source = entry.source;
      existing.keyword = cleaned;
    }
    if (entry.searchVolume !== undefined && (existing.searchVolume === undefined || entry.searchVolume > existing.searchVolume)) {
      existing.searchVolume = entry.searchVolume;
    }
    if (entry.cpc !== undefined && (existing.cpc === undefined || entry.cpc > existing.cpc)) existing.cpc = entry.cpc;
    if (entry.kd !== undefined && existing.kd === undefined) existing.kd = entry.kd;
    if (entry.intent && !existing.intent) existing.intent = entry.intent;
    if (entry.competitorDomain && !existing.competitorDomain) existing.competitorDomain = entry.competitorDomain;
    if (entry.competitorRank !== undefined && (existing.competitorRank === undefined || entry.competitorRank < existing.competitorRank)) {
      existing.competitorRank = entry.competitorRank;
    }
    if (entry.url && !existing.url) existing.url = entry.url;
  };

  const competitors = (input.competitors ?? []).slice(0, 4);
  const validDomains = [...new Set(competitors.map(c => sanitizeCompetitorDomain(c.domain)).filter((d): d is string => Boolean(d)))].slice(0, 3);
  const knownCompetitorKeys = new Set(competitors.map(c => normalizeKey(c.name)).filter(Boolean));

  // Track A1: Google Autocomplete
  const prefixes = buildAutocompletePrefixes({
    seeds: input.seeds,
    painVerbs: input.painVerbs,
    competitors,
    targetLanguage: lang,
  });
  const acBatches = await mapWithConcurrency(prefixes, 4, prefix => fetchGoogleAutocomplete(fetcher, prefix, lang));
  const allAutocomplete = acBatches.flat();
  for (const suggestion of allAutocomplete) {
    upsert({ source: 'google_autocomplete', keyword: suggestion });
  }
  const discoveredCompetitors = extractCompetitorCandidatesFromSuggestions(allAutocomplete, knownCompetitorKeys);

  // Track A2: Competitor robots.txt / Sitemap topics
  const sitemapResults = await mapWithConcurrency(validDomains, 3, async domain => ({
    domain,
    topics: await fetchCompetitorSitemapTopics(fetcher, domain),
  }));
  let competitorSignalsFound = 0;
  for (const { domain, topics } of sitemapResults) {
    for (const item of topics) {
      upsert({ source: 'competitor_sitemap', keyword: item.topic, competitorDomain: domain, url: item.url });
      competitorSignalsFound++;
    }
  }

  // Track A3: HN Algolia (English / tech topics)
  if (input.includeHn !== false && lang === 'en') {
    const hnSeeds = input.seeds.map(cleanKeyword).filter(Boolean).slice(0, 3);
    const hnBatches = await mapWithConcurrency(hnSeeds, 3, seed => fetchHnTopics(fetcher, seed));
    for (const story of hnBatches.flat()) {
      upsert({ source: 'hn_discussion', keyword: story.title, url: story.url });
    }
  }

  // L2 -> L1 Self-Correction Fuse (max 1 bounded pass):
  // If initial competitors yielded 0 competitor sitemap signals and autocomplete discovered peer names, sweep those once.
  if (competitorSignalsFound === 0 && discoveredCompetitors.length > 0) {
    selfCorrected = true;
    const fallbackPrefixes = discoveredCompetitors.slice(0, 2).flatMap(name =>
      lang === 'zh' ? [`${name} 替代`, `${name} 对比`] : [`${name} alternatives`, `${name} pricing`, `${name} vs `]
    );
    const fallbackBatches = await mapWithConcurrency(fallbackPrefixes, 4, prefix => fetchGoogleAutocomplete(fetcher, prefix, lang));
    for (const suggestion of fallbackBatches.flat()) {
      upsert({ source: 'google_autocomplete', keyword: suggestion });
    }
  }

  // Track B: Optional DataForSEO Pro Enhancement (strictly budget-capped)
  const dfsCreds = input.dataForSeo?.login && input.dataForSeo?.password ? input.dataForSeo : null;
  if (dfsCreds) {
    const locationCode = 2840; // US default for global English; CN not supported natively by Google Ads US index
    const languageCode = lang === 'zh' ? 'zh_CN' : 'en';

    // B1: Competitor ranked keywords (up to 2-3 domains within budget)
    let rankedSuccessCount = 0;
    for (const domain of validDomains.slice(0, 3)) {
      if (costUsd + 0.016 > maxBudgetUsd) break;
      const res = await callDataForSeo(fetcher, dfsCreds, '/v3/dataforseo_labs/google/ranked_keywords/live', [{
        target: domain,
        location_code: locationCode,
        language_code: languageCode,
        limit: 20,
        order_by: ['ranked_serp_element.serp_item.etv,desc'],
        filters: [['ranked_serp_element.serp_item.type', '=', 'organic']],
      }]);
      costUsd += res.cost;
      if (!res.ok) {
        warnings.push(`DataForSEO ranked_keywords(${domain}): ${res.error}`);
        // Stop early on auth/verification errors rather than burning repeated failed calls.
        if (res.error && /verify|auth|credit|balance/i.test(res.error)) break;
        continue;
      }
      trackUsed = 'dataforseo';
      rankedSuccessCount++;
      for (const raw of res.items) {
        const kdObj = raw.keyword_data as Record<string, unknown> | undefined;
        const kw = typeof kdObj?.keyword === 'string' ? kdObj.keyword : '';
        if (!kw) continue;
        const info = kdObj?.keyword_info as Record<string, unknown> | undefined;
        const intentInfo = kdObj?.search_intent_info as Record<string, unknown> | undefined;
        const props = kdObj?.keyword_properties as Record<string, unknown> | undefined;
        const serpElem = raw.ranked_serp_element as Record<string, unknown> | undefined;
        const serpItem = serpElem?.serp_item as Record<string, unknown> | undefined;
        const relUrl = typeof serpItem?.relative_url === 'string' ? serpItem.relative_url : undefined;
        upsert({
          source: 'dataforseo_ranked',
          keyword: kw,
          searchVolume: typeof info?.search_volume === 'number' ? info.search_volume : undefined,
          cpc: typeof info?.cpc === 'number' ? Number(info.cpc.toFixed(2)) : undefined,
          kd: typeof props?.keyword_difficulty === 'number' ? props.keyword_difficulty : undefined,
          intent: typeof intentInfo?.main_intent === 'string' ? intentInfo.main_intent : undefined,
          competitorDomain: domain,
          competitorRank: typeof serpItem?.rank_group === 'number' ? serpItem.rank_group : undefined,
          url: relUrl ? `https://${domain}${relUrl.startsWith('/') ? relUrl : `/${relUrl}`}` : undefined,
        });
      }
    }

    // B2: Batch keyword_overview enrichment on top autocomplete + seed keywords (single cheap call ~$0.015)
    const shouldEnrich = costUsd + 0.016 <= maxBudgetUsd && !warnings.some(w => /verify|auth|credit|balance/i.test(w));
    if (shouldEnrich) {
      const candidateBatch = [
        ...input.seeds.map(cleanKeyword),
        ...[...pool.values()]
          .filter(s => s.source === 'google_autocomplete' && s.searchVolume === undefined)
          .map(s => s.keyword),
      ]
        .filter(kw => kw.length >= 3 && kw.length <= 75 && kw.split(/\s+/).length <= 8);
      const dedupedBatch = [...new Set(candidateBatch.map(kw => kw.toLowerCase()))].slice(0, 45);
      if (dedupedBatch.length > 0) {
        const res = await callDataForSeo(fetcher, dfsCreds, '/v3/dataforseo_labs/google/keyword_overview/live', [{
          keywords: dedupedBatch,
          location_code: locationCode,
          language_code: languageCode,
        }]);
        costUsd += res.cost;
        if (res.ok) {
          trackUsed = 'dataforseo';
          for (const raw of res.items) {
            const kw = typeof raw.keyword === 'string' ? raw.keyword : '';
            if (!kw) continue;
            const info = raw.keyword_info as Record<string, unknown> | undefined;
            const intentInfo = raw.search_intent_info as Record<string, unknown> | undefined;
            const props = raw.keyword_properties as Record<string, unknown> | undefined;
            const volume = typeof info?.search_volume === 'number' ? info.search_volume : 0;
            if (volume <= 0 && !pool.has(normalizeKey(kw))) continue;
            upsert({
              source: 'dataforseo_overview',
              keyword: kw,
              searchVolume: volume,
              cpc: typeof info?.cpc === 'number' ? Number(info.cpc.toFixed(2)) : undefined,
              kd: typeof props?.keyword_difficulty === 'number' ? props.keyword_difficulty : undefined,
              intent: typeof intentInfo?.main_intent === 'string' ? intentInfo.main_intent : undefined,
            });
          }
        } else {
          warnings.push(`DataForSEO keyword_overview: ${res.error}`);
        }
      }
    }

    if (rankedSuccessCount === 0 && validDomains.length > 0 && warnings.length === 0) {
      warnings.push('No DataForSEO ranked keywords returned for the provided competitor domains.');
    }
  }

  // Score, sort, and assign deterministic signal IDs (top 65 for focused LLM context)
  const ranked: RankedDemandSignal[] = [...pool.values()]
    .map(entry => {
      const sources = [...entry.sources];
      const score = computeSignalScore({
        source: entry.source,
        sources,
        keyword: entry.keyword,
        searchVolume: entry.searchVolume,
        cpc: entry.cpc,
        kd: entry.kd,
        intent: entry.intent,
        competitorRank: entry.competitorRank,
      });
      return {
        id: '',
        source: entry.source,
        sources,
        keyword: entry.keyword,
        ...(entry.searchVolume !== undefined ? { searchVolume: entry.searchVolume } : {}),
        ...(entry.cpc !== undefined ? { cpc: entry.cpc } : {}),
        ...(entry.kd !== undefined ? { kd: entry.kd } : {}),
        ...(entry.intent ? { intent: entry.intent } : {}),
        ...(entry.competitorDomain ? { competitorDomain: entry.competitorDomain } : {}),
        ...(entry.competitorRank !== undefined ? { competitorRank: entry.competitorRank } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        tacticHint: inferTacticHint(entry),
        score,
      };
    })
    .sort((a, b) => b.score - a.score || a.keyword.localeCompare(b.keyword))
    .slice(0, 65)
    .map((sig, index) => ({ ...sig, id: `sig-${index + 1}` }));

  return {
    signals: ranked,
    trackUsed,
    discoveredCompetitors,
    selfCorrected,
    costUsd: Number(costUsd.toFixed(5)),
    warnings,
  };
}

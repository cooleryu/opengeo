import { ensureProjectRelationalData, withProjectDb } from '../db';
import { unwrapSourceUrl } from '../overview-sources';
import { extractRegistrableDomainParts, parseGitHubRepoUrl } from '../source-identity';

export type CitedChannelBucket =
  | 'open_channel'
  | 'direct_competitor_repo'
  | 'direct_competitor_site'
  | 'third_party_roundup'
  | 'authority_editorial';

export type OwnedContentWedge =
  | 'brand_disambiguation'
  | 'competitor_comparison'
  | 'high_leverage_owned'
  | 'authority_walled_offsite_first';

export interface QuestionPlanMeta {
  tactic?: 'direct-content' | 'competitor-intercept' | 'outreach-monitor' | 'brand-check';
  demandStatus?: string;
  demandStrength?: 'strong' | 'moderate' | 'niche';
  fanoutQueries: string[];
  competitorDomains: string[];
}

export interface EnrichedTargetQuestion {
  id: string;
  queryZh: string;
  queryEn: string;
  tactic?: QuestionPlanMeta['tactic'];
  fanoutQueries?: string[];
  demandStatus?: string;
}

export interface CompactCitedSource {
  domain: string;
  title: string;
  url: string;
  channel: CitedChannelBucket;
}

export interface NormalizedUrlMeta {
  url: string;
  host: string;
  registrable: string;
  path: string;
  isRootOrProduct: boolean;
}

const SKIP_PLATFORM_HOST_RE =
  /(?:^|\.)(?:google\.[a-z.]+|chatgpt\.com|openai\.com|bing\.com|support\.google\.com|policies\.google\.com|accounts\.google\.com)$/i;

export const OPEN_CHANNEL_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'reddit.com', 'quora.com', 'news.ycombinator.com',
  'dev.to', 'medium.com', 'substack.com', 'x.com', 'twitter.com', 'linkedin.com',
  'stackoverflow.com', 'stackexchange.com', 'indiehackers.com', 'zhihu.com', 'v2ex.com',
  'producthunt.com', 'alternativeto.net', 'g2.com', 'capterra.com', 'trustradius.com',
  'getapp.com', 'sourceforge.net', 'openalternative.co', 'selfh.st', 'libhunt.com',
  'stackshare.io', 'theresanaiforthat.com', 'toolify.ai', 'futurepedia.io',
  'mcpmarket.com', 'skillsdirectory.com', 'glama.ai', 'smithery.ai', 'mcp.so',
  'pulsemcp.com', 'saasworthy.com', 'softwareadvice.com', 'betalist.com',
]);

export const AUTHORITY_EDITORIAL_DOMAINS = new Set([
  'wikipedia.org', 'coursera.org', 'britannica.com', 'investopedia.com', 'forbes.com',
  'gartner.com', 'forrester.com', 'mckinsey.com', 'hbr.org', 'techcrunch.com',
  'wired.com', 'theverge.com', 'nytimes.com', 'hubspot.com', 'semrush.com',
  'ahrefs.com', 'moz.com', 'zapier.com', 'yext.com', 'searchengineland.com',
  'searchenginejournal.com', 'shopify.com', 'salesforce.com', 'atlassian.com',
  'cloudflare.com', 'microsoft.com', 'ibm.com', 'oracle.com', 'amazon.com', 'mozilla.org',
]);

const ROUNDUP_PATH_OR_TITLE_RE =
  /(?:\/(?:blog|blogs|articles|guides|comparisons|insights|resources|reviews|learn|knowledge-center)\/|\b(?:best|top\s+\d+|alternatives?|vs\.?|pricing\s+guide|review|how[- ]to|open[- ]source\s+\w+\s+tools?)\b)/i;

const AWESOME_REPO_RE = /awesome|curated|directory|resources|collection|-list$/i;

function normalizePromptKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeUrlMeta(rawUrl: string): NormalizedUrlMeta | null {
  const unwrapped = unwrapSourceUrl(rawUrl.trim());
  try {
    const u = new URL(unwrapped);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host || SKIP_PLATFORM_HOST_RE.test(host)) return null;
    const registrable = extractRegistrableDomainParts(host)?.registrableDomain ?? host;
    const cleanPath = u.pathname.replace(/\/+$/, '') || '/';
    const watchVideo = host === 'youtube.com' && cleanPath === '/watch' ? u.searchParams.get('v') : null;
    const displayPath = watchVideo ? `${cleanPath}?v=${watchVideo}` : cleanPath;
    const isRootOrProduct =
      cleanPath === '/' ||
      /^\/(?:features|product|pricing|platform|solutions|brand-radar)(?:\/|$)/i.test(cleanPath);
    return { url: `${u.origin}${displayPath}`, host, registrable, path: displayPath, isRootOrProduct };
  } catch {
    return null;
  }
}

export function classifyCitedChannel(
  rawUrl: string,
  title = '',
  knownSiteRoots?: Set<string>,
): CitedChannelBucket {
  const unwrapped = unwrapSourceUrl(rawUrl.trim());
  let parsed: URL | null = null;
  try {
    parsed = new URL(unwrapped);
  } catch {
    parsed = null;
  }

  const host = parsed ? parsed.hostname.replace(/^www\./i, '').toLowerCase() : '';
  const pathname = parsed ? parsed.pathname.toLowerCase() : '';
  const registrable = host ? (extractRegistrableDomainParts(host)?.registrableDomain ?? host) : '';

  if (host === 'github.com') {
    const gh = parseGitHubRepoUrl(unwrapped, { allowSubpaths: true });
    if (gh) {
      if (AWESOME_REPO_RE.test(`${gh.repo} ${title}`)) return 'open_channel';
      return 'direct_competitor_repo';
    }
    return 'open_channel';
  }

  if (OPEN_CHANNEL_DOMAINS.has(host) || OPEN_CHANNEL_DOMAINS.has(registrable)) return 'open_channel';
  if (!host && /\breddit\b|r\/[a-z0-9_]+|\byoutube\b|hacker news|\bquora\b/i.test(title)) {
    return 'open_channel';
  }
  if (AUTHORITY_EDITORIAL_DOMAINS.has(host) || AUTHORITY_EDITORIAL_DOMAINS.has(registrable)) {
    return 'authority_editorial';
  }
  if (registrable && knownSiteRoots?.has(registrable)) return 'direct_competitor_site';

  const isDeepPath = pathname !== '' && pathname !== '/' && pathname.split('/').filter(Boolean).length >= 1;
  if (isDeepPath && (ROUNDUP_PATH_OR_TITLE_RE.test(`${pathname} ${title}`) || host.startsWith('blog.'))) {
    return 'third_party_roundup';
  }

  return 'direct_competitor_site';
}

export function pickUnifiedEntityKey(
  registrable: string,
  channel: CitedChannelBucket,
  ghRepoKey: string | null,
  allSiteStems: Set<string>,
): { key: string; label: string } {
  if (ghRepoKey) return { key: ghRepoKey, label: ghRepoKey.replace(/^github:/, '') };
  if (channel === 'direct_competitor_site') {
    const sld = extractRegistrableDomainParts(registrable)?.sld ?? registrable;
    const stripped = sld.replace(/^(?:try|get|use)(?=[a-z]{4,})/, '');
    if (stripped !== sld && allSiteStems.has(stripped)) {
      return { key: `site:${stripped}`, label: stripped };
    }
    if (allSiteStems.has(sld)) {
      return { key: `site:${sld}`, label: registrable };
    }
  }
  return { key: `${channel}:${registrable}`, label: registrable };
}

export function classifyOwnedWedge(params: {
  category: string;
  tactic?: QuestionPlanMeta['tactic'];
  channels: Set<CitedChannelBucket>;
}): OwnedContentWedge {
  if (params.category === 'brand' || params.tactic === 'brand-check') return 'brand_disambiguation';
  if (params.tactic === 'competitor-intercept' || params.category === 'comparison') {
    return 'competitor_comparison';
  }
  if (params.channels.has('direct_competitor_repo') || params.channels.has('third_party_roundup')) {
    return 'high_leverage_owned';
  }
  if (params.channels.has('authority_editorial')) return 'authority_walled_offsite_first';
  return 'high_leverage_owned';
}

function summarizeDemandStrength(
  signals: Array<{ searchVolume?: number; cpc?: number }> | undefined,
): QuestionPlanMeta['demandStrength'] {
  if (!signals?.length) return undefined;
  const maxVol = Math.max(0, ...signals.map((s) => s.searchVolume ?? 0));
  const maxCpc = Math.max(0, ...signals.map((s) => s.cpc ?? 0));
  if (maxVol >= 500 || maxCpc >= 20) return 'strong';
  if (maxVol >= 80 || signals.length >= 2) return 'moderate';
  return 'niche';
}

export function loadQuestionPlanSignalsMap(projectId: string): {
  byId: Map<string, QuestionPlanMeta>;
  byQuery: Map<string, QuestionPlanMeta>;
} {
  const byId = new Map<string, QuestionPlanMeta>();
  const byQuery = new Map<string, QuestionPlanMeta>();
  try {
    withProjectDb(projectId, (db, id) => {
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'geo_question_plans'")
        .get() as { name?: string } | undefined;
      if (!table?.name) return;
      const row = db
        .prepare('SELECT payload FROM geo_question_plans WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
        .get(id) as { payload?: string } | undefined;
      if (!row?.payload) return;
      const parsed = JSON.parse(row.payload) as {
        candidates?: Array<{
          id?: string;
          zh?: string;
          en?: string;
          tactic?: QuestionPlanMeta['tactic'];
          demandStatus?: string;
          fanoutQueries?: unknown;
          demandSignals?: Array<{ searchVolume?: number; cpc?: number; competitorDomain?: string }>;
        }>;
      };
      for (const c of parsed.candidates ?? []) {
        const fanoutQueries = Array.isArray(c.fanoutQueries)
          ? c.fanoutQueries.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 6)
          : [];
        const competitorDomains = Array.from(
          new Set(
            (c.demandSignals ?? [])
              .map((s) => s.competitorDomain?.trim().toLowerCase())
              .filter((d): d is string => Boolean(d)),
          ),
        ).slice(0, 5);
        const strength = summarizeDemandStrength(c.demandSignals);
        const meta: QuestionPlanMeta = {
          ...(c.tactic ? { tactic: c.tactic } : {}),
          ...(c.demandStatus ? { demandStatus: c.demandStatus } : {}),
          ...(strength ? { demandStrength: strength } : {}),
          fanoutQueries,
          competitorDomains,
        };
        if (c.id) byId.set(c.id, meta);
        if (c.en) byQuery.set(normalizePromptKey(c.en), meta);
        if (c.zh) byQuery.set(normalizePromptKey(c.zh), meta);
      }
    });
  } catch {
    // Non-fatal when geo_question_plans is absent in isolated unit test DBs
  }
  return { byId, byQuery };
}

export function lookupQuestionPlanMeta(
  maps: ReturnType<typeof loadQuestionPlanSignalsMap>,
  question: { id: string; queryEn?: string; queryZh?: string },
): QuestionPlanMeta | undefined {
  return (
    maps.byId.get(question.id) ??
    (question.queryEn ? maps.byQuery.get(normalizePromptKey(question.queryEn)) : undefined) ??
    (question.queryZh ? maps.byQuery.get(normalizePromptKey(question.queryZh)) : undefined)
  );
}

export function loadActiveQuestionsWithPlanMeta(projectId: string): EnrichedTargetQuestion[] {
  const planMaps = loadQuestionPlanSignalsMap(projectId);
  return withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const rows = db
      .prepare(
        "SELECT id, query_zh AS queryZh, query_en AS queryEn FROM opengeo_questions WHERE project_id = ? AND status = 'active'",
      )
      .all(id) as Array<{ id: string; queryZh: string; queryEn: string }>;
    return rows.map((q) => {
      const meta = lookupQuestionPlanMeta(planMaps, q);
      return {
        ...q,
        ...(meta?.tactic ? { tactic: meta.tactic } : {}),
        ...(meta?.fanoutQueries?.length ? { fanoutQueries: meta.fanoutQueries } : {}),
        ...(meta?.demandStatus ? { demandStatus: meta.demandStatus } : {}),
      };
    });
  });
}

export function parseRecommendedBrands(rawJson: string | null | undefined): string[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson) as Array<{ name?: unknown }>;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      const name = typeof item?.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : '';
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= 8) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function formatWriterTargetQuestions(
  targetQuestions: EnrichedTargetQuestion[],
  targetLanguage: 'en' | 'zh',
): Array<string | { prompt: string; tactic?: string; subQuestionsToCover?: string[] }> {
  const hasMetadata = targetQuestions.some((q) => q.fanoutQueries?.length || q.tactic);
  if (!hasMetadata) {
    return targetQuestions.map((q) => (targetLanguage === 'en' ? q.queryEn || q.queryZh : q.queryZh || q.queryEn));
  }
  return targetQuestions.map((q) => ({
    prompt: targetLanguage === 'en' ? q.queryEn || q.queryZh : q.queryZh || q.queryEn,
    ...(q.tactic ? { tactic: q.tactic } : {}),
    ...(q.fanoutQueries?.length ? { subQuestionsToCover: q.fanoutQueries } : {}),
  }));
}

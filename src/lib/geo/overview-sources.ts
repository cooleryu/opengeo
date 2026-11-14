import { isProjectOwnedUrl } from './asset-ownership';
import { isAiAnswerRow, type AuditedResearchRow } from './overview-metrics';
import { RESEARCH_ENGINES } from './research-engines';
import type { ResearchEngine, ResearchSource } from './research-types';
import type { GeoProject } from './types';

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'ref',
  'spm',
]);

const NOISE_TITLE_RE =
  /^(?:translate this page|read more|show more|learn more|翻译此页|阅读更多|展开|<|\d{1,2}:\d{2}(?::\d{2})?)$/i;

const GENERIC_NAV_RE =
  /^(?:官方网站|官网|网站首页|首页|套餐详情|价格|价格方案|官方网站及价格|official\s*(?:site|website)?|homepage|pricing)$/i;

const BARE_DOMAIN_RE = /^(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

const PUBLISHER_DOMAIN_HINTS: Array<[RegExp, string]> = [
  [/知乎/, 'zhihu.com'],
  [/CSDN/i, 'csdn.net'],
  [/Reddit/i, 'reddit.com'],
  [/YouTube/i, 'youtube.com'],
  [/LinkedIn/i, 'linkedin.com'],
  [/阿里云/, 'aliyun.com'],
  [/腾讯云|Tencent/i, 'cloud.tencent.com'],
  [/搜狐/, 'sohu.com'],
  [/Ahrefs/i, 'ahrefs.com'],
  [/Similarweb/i, 'similarweb.com'],
  [/Semrush/i, 'semrush.com'],
  [/Instagram/i, 'instagram.com'],
];

const OPEN_SOURCE_DOMAINS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'pkg.go.dev',
  'pypi.org',
  'npmjs.com',
  'docs.rs',
]);

const PAPER_DOMAINS = new Set(['arxiv.org', 'paper.dou.ac', 'openreview.net']);

const COMMUNITY_DOMAINS = new Set([
  'reddit.com',
  'zhihu.com',
  'zhuanlan.zhihu.com',
  'csdn.net',
  'blog.csdn.net',
  'dev.to',
  'medium.com',
  'juejin.cn',
  'v2ex.com',
  'linkedin.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'instagram.com',
  'douyin.com',
]);

export const OPAQUE_GOOGLE_SOURCE_LABEL = 'Google AI 引用源';

export interface OverviewSourcePageItem {
  key: string;
  source: ResearchSource;
  openUrl: string;
  displayTitle: string;
  displayDomain: string;
  displayPath: string;
  sampleQuestion: string;
  isOwned: boolean;
  categoryLabel: string | null;
  rows: AuditedResearchRow[];
  engines: ResearchEngine[];
  questionCount: number;
  hasMissedRow: boolean;
}

export interface OverviewSourceDomainItem {
  domain: string;
  openUrl: string;
  primarySource: ResearchSource;
  samplePageTitle: string;
  pageCount: number;
  isOwned: boolean;
  categoryLabel: string | null;
  rows: AuditedResearchRow[];
  engines: ResearchEngine[];
  questionCount: number;
  hasMissedRow: boolean;
}

export interface OverviewSourcesBundle {
  effectiveSourceOnly: boolean;
  pages: OverviewSourcePageItem[];
  domains: OverviewSourceDomainItem[];
  missedPages: OverviewSourcePageItem[];
  ownedPages: OverviewSourcePageItem[];
}

function isGoogleRedirect(url: URL): boolean {
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  return host === 'google.com' && (url.pathname === '/goto' || url.pathname === '/url');
}

export function unwrapSourceUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (isGoogleRedirect(parsed)) {
      for (const param of ['q', 'url']) {
        const candidate = parsed.searchParams.get(param);
        if (candidate && /^https?:\/\//i.test(candidate)) {
          return candidate;
        }
      }
    }
    return rawUrl;
  } catch {
    return rawUrl;
  }
}

export function canonicalSourceKey(rawUrl: string): string | null {
  try {
    const unwrapped = unwrapSourceUrl(rawUrl);
    const parsed = new URL(unwrapped);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (isGoogleRedirect(parsed)) {
      return `${parsed.origin}${parsed.pathname}?url=${parsed.searchParams.get('url') ?? ''}`;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : '/';
    const sorted = new URLSearchParams([...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const qs = sorted.toString();
    return `https://${host}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return null;
  }
}

export function sameCanonicalSource(urlA: string, urlB: string): boolean {
  if (urlA === urlB) return true;
  const keyA = canonicalSourceKey(urlA);
  return Boolean(keyA && keyA === canonicalSourceKey(urlB));
}

function isScraperNoiseSource(source: ResearchSource): boolean {
  return NOISE_TITLE_RE.test((source.title ?? '').trim());
}

function classifySourceCategory(domain: string, isOwned: boolean): string | null {
  if (isOwned) return '自有';
  if (OPEN_SOURCE_DOMAINS.has(domain)) return '开源';
  if (PAPER_DOMAINS.has(domain)) return '论文';
  if (COMMUNITY_DOMAINS.has(domain)) return '社区';
  if (domain === 'chromewebstore.google.com') return '商店';
  return null;
}

function presentSource(
  source: ResearchSource,
  parsedUrl: URL,
): {
  openUrl: string;
  displayTitle: string;
  displayDomain: string;
  displayPath: string;
} {
  const openUrl = unwrapSourceUrl(source.url);
  const opaqueRedirect = isGoogleRedirect(parsedUrl);
  const lines = (source.title ?? '')
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headline = lines[0] ?? '';

  let displayDomain = '';
  for (const line of lines.slice(1)) {
    const match = line.match(/^https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/i);
    if (match) {
      displayDomain = match[1].replace(/^www\./i, '').toLowerCase();
      break;
    }
  }

  let displayPath = '';
  if (!opaqueRedirect) {
    displayDomain = parsedUrl.hostname.replace(/^www\./i, '').toLowerCase();
    const cleanPath =
      parsedUrl.pathname.length > 1 ? parsedUrl.pathname.replace(/\/+$/, '') : '';
    displayPath =
      cleanPath && cleanPath.length <= 44 ? `${displayDomain}${cleanPath}` : displayDomain;
  } else {
    if (!displayDomain) {
      const bareMatch = headline.match(BARE_DOMAIN_RE);
      if (bareMatch) {
        displayDomain = bareMatch[1].toLowerCase();
      } else {
        const hint = PUBLISHER_DOMAIN_HINTS.find(([pattern]) => pattern.test(headline));
        displayDomain = hint ? hint[1] : OPAQUE_GOOGLE_SOURCE_LABEL;
      }
    }
    displayPath = displayDomain;
  }

  let displayTitle = headline || displayDomain;
  if (!headline || GENERIC_NAV_RE.test(headline)) {
    displayTitle =
      headline && displayDomain !== OPAQUE_GOOGLE_SOURCE_LABEL
        ? `${displayDomain} · ${headline}`
        : headline || displayDomain;
  }

  return {
    openUrl,
    displayTitle,
    displayDomain,
    displayPath,
  };
}

function rowIsMissed(row: AuditedResearchRow): boolean {
  return isAiAnswerRow(row)
    ? row.audit?.mention === 'no'
    : row.observation?.status === 'not_observed';
}

export function buildOverviewSources(
  rows: AuditedResearchRow[],
  options: {
    sourceOnly: boolean;
    language: 'zh' | 'en';
    project?: Pick<GeoProject, 'siteUrl' | 'repositoryUrl'>;
  },
): OverviewSourcesBundle {
  const aiRows = rows.filter((row) => row.observation && isAiAnswerRow(row));
  const nonEmptyAi = aiRows.some((row) =>
    (row.observation?.sources ?? []).some(
      (source) => !isScraperNoiseSource(source) && Boolean(canonicalSourceKey(source.url)),
    ),
  );

  const effectiveSourceOnly = options.sourceOnly || !nonEmptyAi;
  const scopedRows =
    !options.sourceOnly && nonEmptyAi
      ? aiRows
      : rows.filter((row) => Boolean(row.observation));

  const pageMap = new Map<
    string,
    {
      source: ResearchSource;
      openUrl: string;
      displayTitle: string;
      displayDomain: string;
      displayPath: string;
      sampleQuestion: string;
      isOwned: boolean;
      rows: AuditedResearchRow[];
      engineSet: Set<ResearchEngine>;
      questionIds: Set<string>;
    }
  >();

  for (const row of scopedRows) {
    for (const source of row.observation?.sources ?? []) {
      if (isScraperNoiseSource(source)) continue;
      const key = canonicalSourceKey(source.url);
      if (!key) continue;

      const openUrl = unwrapSourceUrl(source.url);
      let parsedOpen: URL;
      try {
        parsedOpen = new URL(openUrl);
      } catch {
        continue;
      }

      const presented = presentSource(source, parsedOpen);
      const owned = options.project
        ? isProjectOwnedUrl(openUrl, options.project)
        : source.kind === 'official';

      const existing = pageMap.get(key);
      if (!existing) {
        pageMap.set(key, {
          source,
          openUrl: presented.openUrl,
          displayTitle: presented.displayTitle,
          displayDomain: presented.displayDomain,
          displayPath: presented.displayPath,
          sampleQuestion: row.question[options.language] || row.question.zh || row.question.en,
          isOwned: owned,
          rows: [row],
          engineSet: new Set([row.engine]),
          questionIds: new Set([row.question.id]),
        });
      } else {
        if (!existing.rows.some((item) => item.key === row.key)) {
          existing.rows.push(row);
        }
        existing.engineSet.add(row.engine);
        existing.questionIds.add(row.question.id);
        if (owned) existing.isOwned = true;
      }
    }
  }

  const pages: OverviewSourcePageItem[] = [...pageMap.entries()]
    .map(([key, item]) => ({
      key,
      source: item.source,
      openUrl: item.openUrl,
      displayTitle: item.displayTitle,
      displayDomain: item.displayDomain,
      displayPath: item.displayPath,
      sampleQuestion: item.sampleQuestion,
      isOwned: item.isOwned,
      categoryLabel: classifySourceCategory(item.displayDomain, item.isOwned),
      rows: item.rows,
      engines: RESEARCH_ENGINES.filter((engine) => item.engineSet.has(engine)),
      questionCount: item.questionIds.size,
      hasMissedRow: !item.isOwned && item.rows.some(rowIsMissed),
    }))
    .sort(
      (a, b) =>
        b.questionCount - a.questionCount ||
        b.engines.length - a.engines.length ||
        b.rows.length - a.rows.length ||
        Number(a.displayDomain === OPAQUE_GOOGLE_SOURCE_LABEL) -
          Number(b.displayDomain === OPAQUE_GOOGLE_SOURCE_LABEL),
    );

  const domainMap = new Map<
    string,
    {
      domain: string;
      primaryPage: OverviewSourcePageItem;
      pageCount: number;
      isOwned: boolean;
      categoryLabel: string | null;
      rows: AuditedResearchRow[];
      rowKeys: Set<string>;
      engineSet: Set<ResearchEngine>;
      questionIds: Set<string>;
      hasMissedRow: boolean;
    }
  >();

  for (const page of pages) {
    const existing = domainMap.get(page.displayDomain);
    if (!existing) {
      domainMap.set(page.displayDomain, {
        domain: page.displayDomain,
        primaryPage: page,
        pageCount: 1,
        isOwned: page.isOwned,
        categoryLabel: page.categoryLabel,
        rows: [...page.rows],
        rowKeys: new Set(page.rows.map((r) => r.key)),
        engineSet: new Set(page.engines),
        questionIds: new Set(page.rows.map((r) => r.question.id)),
        hasMissedRow: page.hasMissedRow,
      });
    } else {
      existing.pageCount += 1;
      if (page.isOwned) {
        existing.isOwned = true;
        existing.categoryLabel = '自有';
      }
      if (page.hasMissedRow) existing.hasMissedRow = true;
      for (const eng of page.engines) existing.engineSet.add(eng);
      for (const row of page.rows) {
        existing.questionIds.add(row.question.id);
        if (!existing.rowKeys.has(row.key)) {
          existing.rowKeys.add(row.key);
          existing.rows.push(row);
        }
      }
    }
  }

  const domains: OverviewSourceDomainItem[] = [...domainMap.values()]
    .map((item) => {
      let domainHomeUrl = item.primaryPage.openUrl;
      if (item.domain !== OPAQUE_GOOGLE_SOURCE_LABEL) {
        try {
          const parsed = new URL(item.primaryPage.openUrl);
          if (!isGoogleRedirect(parsed)) {
            domainHomeUrl = parsed.origin;
          }
        } catch {
          domainHomeUrl = item.primaryPage.openUrl;
        }
      }
      return {
        domain: item.domain,
        openUrl: domainHomeUrl,
        primarySource: item.primaryPage.source,
        samplePageTitle: item.primaryPage.displayTitle,
        pageCount: item.pageCount,
        isOwned: item.isOwned,
        categoryLabel: item.categoryLabel,
        rows: item.rows,
        engines: RESEARCH_ENGINES.filter((engine) => item.engineSet.has(engine)),
        questionCount: item.questionIds.size,
        hasMissedRow: item.hasMissedRow,
      };
    })
    .sort(
      (a, b) =>
        Number(a.domain === OPAQUE_GOOGLE_SOURCE_LABEL) -
          Number(b.domain === OPAQUE_GOOGLE_SOURCE_LABEL) ||
        b.questionCount - a.questionCount ||
        b.pageCount - a.pageCount ||
        b.engines.length - a.engines.length,
    );

  return {
    effectiveSourceOnly,
    pages,
    domains,
    missedPages: pages.filter((page) => page.hasMissedRow),
    ownedPages: pages.filter((page) => page.isOwned),
  };
}

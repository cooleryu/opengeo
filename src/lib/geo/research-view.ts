import { isProjectOwnedUrl } from './asset-ownership';
import { getBatchResearchEngines } from './research-engines';
import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
  ResearchEngine,
} from './research-types';
import type { GeoProject } from './types';

export type ResearchFilter = {
  language: 'zh' | 'en';
  engine: 'all' | ResearchEngine;
  kind: 'all' | 'brand' | 'discovery';
  result: 'all' | 'found' | 'not_observed' | 'unmeasured';
};

export type ResearchRow = {
  key: string;
  question: ResearchQuestion;
  engine: ResearchEngine;
  observation?: ResearchObservation;
};

export interface TopExternalCitedSource {
  key: string;
  label: string;
  url: string;
  questionCount: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isBrandQuestion(question: ResearchQuestion): boolean {
  if (question.category) return question.category === 'brand' || question.category === 'positioning';
  return question.id === 'C01' || question.id === 'R01';
}

/**
 * Classifies whether a prompt directly names the project/brand (`Brand`) vs
 * asks as an unbranded buyer (`Discovery`). Keeps legacy `isBrandQuestion` intact.
 */
export function isBrandPrompt(question: ResearchQuestion, projectName?: string): boolean {
  if (question.category === 'brand') return true;
  if (!question.category && (question.id === 'C01' || question.id === 'R01')) return true;
  const trimmed = (projectName ?? '').trim();
  if (trimmed.length >= 3) {
    const tokenRe = new RegExp(`(^|[^a-z0-9])${escapeRegExp(trimmed)}([^a-z0-9]|$)`, 'i');
    if (tokenRe.test(question.en || '') || tokenRe.test(question.zh || '')) {
      return true;
    }
  }
  return false;
}

const SKIP_INTERNAL_HOST_RE = /(^|\.)(google\.[a-z.]+|chatgpt\.com|openai\.com|bing\.com)$/i;
const GITHUB_NON_REPO_OWNERS = new Set([
  'topics',
  'search',
  'orgs',
  'features',
  'pricing',
  'about',
  'settings',
  'explore',
  'marketplace',
  'sponsors',
  'collections',
  'events',
  'login',
  'signup',
  'trending',
  'blog',
  'customer-stories',
  'security',
  'enterprise',
  'readme',
  'pulls',
  'issues',
  'notifications',
]);

const TWO_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'com.br',
  'co.in',
  'co.kr',
  'co.nz',
  'com.sg',
  'com.hk',
  'com.tw',
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'readthedocs.io',
  'gitbook.io',
  'substack.com',
]);

function extractRegistrableDomainParts(
  host: string,
): { registrableDomain: string; sld: string } | null {
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (labels.length >= 3) {
    const tailTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
    if (TWO_PART_PUBLIC_SUFFIXES.has(tailTwo)) {
      const sld = labels[labels.length - 3] ?? '';
      return sld
        ? { registrableDomain: `${sld}.${tailTwo}`, sld }
        : { registrableDomain: tailTwo, sld: tailTwo.split('.')[0] ?? '' };
    }
  }
  const sld = labels[labels.length - 2] ?? '';
  const tld = labels[labels.length - 1] ?? '';
  return sld && tld ? { registrableDomain: `${sld}.${tld}`, sld } : null;
}

const MULTI_TENANT_HOSTS = new Set([
  'github.com',
  'reddit.com',
  'dev.to',
  'medium.com',
  'news.ycombinator.com',
  'youtube.com',
  'youtu.be',
  'substack.com',
  'linkedin.com',
  'producthunt.com',
  'alternativeto.net',
  'wikipedia.org',
  'en.wikipedia.org',
  'x.com',
  'twitter.com',
  'npm.im',
  'npmjs.com',
  'pypi.org',
]);

function stripVendorSuffix(raw: string): string {
  const lower = raw.toLowerCase().trim();
  const stripped = lower.replace(/(?:[-_]?(?:hq|co|ai|io|app|dev|labs|inc|official))$/i, '');
  return stripped.length >= 3 ? stripped : lower;
}

function capitalizeBrand(stem: string): string {
  const clean = stem.replace(/[-_]+/g, ' ').trim();
  if (!clean) return stem;
  return clean.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function normalizeExternalCitedSource(
  rawUrl: string,
): { key: string; entityKey: string; mergedLabel?: string; label: string; url: string } | null {
  try {
    const u = new URL(rawUrl.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (!host || SKIP_INTERNAL_HOST_RE.test(host)) return null;
    if (host === 'github.com' || host.endsWith('.github.com')) {
      if (host !== 'github.com') return null;
      const parts = u.pathname.split('/').filter(Boolean);
      const owner = parts[0];
      const repo = parts[1]?.replace(/\.git$/i, '');
      if (!owner || !repo || GITHUB_NON_REPO_OWNERS.has(owner.toLowerCase())) {
        return null;
      }
      const key = `github.com/${owner.toLowerCase()}/${repo.toLowerCase()}`;
      const isAwesomeOrList = /awesome|list|directory|curated/i.test(`${owner}/${repo}`);
      const ownerStem = stripVendorSuffix(owner);
      const entityKey =
        !isAwesomeOrList && ownerStem.length >= 4 ? `brand:${ownerStem}` : key;
      return {
        key,
        entityKey,
        ...(entityKey.startsWith('brand:')
          ? { mergedLabel: capitalizeBrand(ownerStem) }
          : {}),
        label: `${owner}/${repo}`,
        url: `https://github.com/${owner}/${repo}`,
      };
    }

    const domainParts = extractRegistrableDomainParts(host);
    if (!domainParts) return null;

    const isMultiTenant =
      MULTI_TENANT_HOSTS.has(host) ||
      (MULTI_TENANT_HOSTS.has(domainParts.registrableDomain) &&
        domainParts.registrableDomain !== 'substack.com');

    if (!isMultiTenant) {
      const domainStem = stripVendorSuffix(domainParts.sld);
      if (domainStem.length >= 4) {
        return {
          key: domainParts.registrableDomain,
          entityKey: `brand:${domainStem}`,
          mergedLabel: capitalizeBrand(domainStem),
          label: host,
          url: `${u.protocol}//${u.hostname}`,
        };
      }
      return {
        key: domainParts.registrableDomain,
        entityKey: domainParts.registrableDomain,
        label: host,
        url: `${u.protocol}//${u.hostname}`,
      };
    }

    return {
      key: host,
      entityKey: host,
      label: host,
      url: `${u.protocol}//${u.hostname}`,
    };
  } catch {
    return null;
  }
}

function collectCitedSourcesForQuestions(
  questions: ResearchQuestion[],
  engines: ResearchEngine[],
  project: Pick<GeoProject, 'repositoryUrl' | 'siteUrl'> | null | undefined,
  language: 'en' | 'zh' | undefined,
  limit: number,
): TopExternalCitedSource[] {
  const counts = new Map<
    string,
    {
      rawKey: string;
      label: string;
      mergedLabel?: string;
      url: string;
      rawUrls: Set<string>;
      questionIds: Set<string>;
      totalMentions: number;
    }
  >();

  for (const question of questions) {
    for (const engine of engines) {
      const matching = question.observations.filter(
        (obs) =>
          obs.engine === engine &&
          obs.entryType === 'web_answer' &&
          (!language || obs.language === language),
      );
      const fallback =
        matching.length > 0
          ? matching
          : question.observations.filter(
              (obs) => obs.engine === engine && obs.entryType === 'web_answer',
            );
      const latest = getLatestResearchObservation(fallback);
      if (!latest) continue;

      const refs = latest.sources ?? [];
      for (const ref of refs) {
        if (!ref?.url) continue;
        if (project && isProjectOwnedUrl(ref.url, project)) continue;
        const normalized = normalizeExternalCitedSource(ref.url);
        if (!normalized) continue;
        const entry = counts.get(normalized.entityKey);
        if (!entry) {
          counts.set(normalized.entityKey, {
            rawKey: normalized.key,
            label: normalized.label,
            mergedLabel: normalized.mergedLabel,
            url: normalized.url,
            rawUrls: new Set([normalized.url]),
            questionIds: new Set([question.id]),
            totalMentions: 1,
          });
        } else {
          entry.rawUrls.add(normalized.url);
          if (entry.rawUrls.size > 1 && entry.mergedLabel) {
            entry.label = entry.mergedLabel;
            if (!normalized.url.includes('github.com')) {
              if (entry.url.includes('github.com') || normalized.url.length < entry.url.length) {
                entry.url = normalized.url;
              }
            }
          }
          entry.questionIds.add(question.id);
          entry.totalMentions += 1;
        }
      }
    }
  }

  return [...counts.entries()]
    .map(([entityKey, entry]) => ({
      key: entry.rawUrls.size > 1 ? entityKey : entry.rawKey,
      label: entry.label,
      url: entry.url,
      questionCount: entry.questionIds.size,
      totalMentions: entry.totalMentions,
    }))
    .sort((a, b) => b.questionCount - a.questionCount || b.totalMentions - a.totalMentions)
    .slice(0, limit)
    .map(({ key, label, url, questionCount }) => ({ key, label, url, questionCount }));
}

/**
 * Aggregates the top external domains / GitHub repositories currently cited in AI answers
 * (using the latest `web_answer` observation per question/engine) with canonical entity deduplication.
 */
export function extractTopExternalCitedSources(
  batch: ResearchBatch | null | undefined,
  project: Pick<GeoProject, 'repositoryUrl' | 'siteUrl'> | null | undefined,
  language?: 'en' | 'zh',
  limit = 4,
): TopExternalCitedSource[] {
  if (!batch?.questions?.length) return [];
  return collectCitedSourcesForQuestions(
    batch.questions,
    getBatchResearchEngines(batch),
    project,
    language,
    limit,
  );
}

/**
 * Extracts up to `limit` canonical external winners cited on a single prompt's latest web answers.
 */
export function extractQuestionTopWinners(
  question: ResearchQuestion,
  batchOrEngines: ResearchBatch | ResearchEngine[],
  project?: Pick<GeoProject, 'repositoryUrl' | 'siteUrl'> | null,
  language?: 'en' | 'zh',
  limit = 3,
): TopExternalCitedSource[] {
  const engines = Array.isArray(batchOrEngines)
    ? batchOrEngines
    : getBatchResearchEngines(batchOrEngines);
  return collectCitedSourcesForQuestions([question], engines, project, language, limit);
}

export type OutreachPageKind = 'directory' | 'community' | 'roundup' | 'other';

export interface OutreachCitedPage {
  key: string;
  title: string;
  url: string;
  host: string;
  kind: OutreachPageKind;
  score: number;
  questionCount: number;
  questionIds: string[];
  engines: ResearchEngine[];
}

const GENERIC_OUTREACH_TITLES = new Set([
  'website',
  'open',
  'learn more',
  'learn more about ai mode',
  'privacy policy',
  'terms of service',
  'make a legal removal request',
  'cookie policy',
  'help center',
  'sign in',
  'google',
  'chatgpt',
]);

const CHROME_POLICY_HOSTS = new Set([
  'support.google.com',
  'policies.google.com',
  'accounts.google.com',
  'myactivity.google.com',
  'policies.openai.com',
  'help.openai.com',
  'auth.openai.com',
  'platform.openai.com',
  'openai.com',
  'chatgpt.com',
]);

function normalizeOutreachSourceUrl(rawUrl: string): { url: string; host: string } | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase();
    const isGoogleHost = hostname === 'google.com' || hostname.endsWith('.google.com');

    if (isGoogleHost) {
      if (parsed.pathname === '/goto' && parsed.searchParams.get('url')) {
        const inner = parsed.searchParams.get('url')?.trim() ?? '';
        if (/^https?:\/\//i.test(inner)) {
          return normalizeOutreachSourceUrl(inner);
        }
        return {
          url: parsed.toString(),
          host: '',
        };
      }
      return null;
    }

    const bareHost = hostname.replace(/^www\./, '');
    if (CHROME_POLICY_HOSTS.has(hostname) || CHROME_POLICY_HOSTS.has(bareHost)) {
      return null;
    }

    if (parsed.searchParams.get('utm_source') === 'chatgpt.com') {
      parsed.searchParams.delete('utm_source');
    }

    return {
      url: parsed.toString(),
      host: bareHost,
    };
  } catch {
    return null;
  }
}

function classifyOutreachPage(
  title: string,
  url: string,
): { kind: OutreachPageKind; score: number } {
  const haystack = `${title} ${url}`.toLowerCase();

  if (
    /\bgithub topics\b|github\.com\/topics\/|\bawesome-|producthunt\.com|alternativeto\.net|toolify\.ai|theresanaiforthat\.com/i.test(
      haystack,
    )
  ) {
    return { kind: 'directory', score: 4 };
  }

  if (
    /\breddit\b|(?:^|[\s·/])r\/[a-z0-9_]+|news\.ycombinator\.com|hacker news|\bdev\.to\b|stackoverflow\.com|\/discussions|\bi built\b|\bwhat tool do you use\b|\bhow do you track\b/i.test(
      haystack,
    )
  ) {
    return { kind: 'community', score: 4 };
  }

  if (
    /\bbest\b|\btop\s+\d+|\balternatives?\b|\bcompared\b|\bcomparison\b|\bvs\.?\b|\bhow to\b|\bguide\b/i.test(
      haystack,
    )
  ) {
    return { kind: 'roundup', score: 3 };
  }

  return { kind: 'other', score: 1 };
}

function isUsefulOutreachTitle(title: string): boolean {
  const lower = title.toLowerCase();
  if (lower.length < 3) return false;
  if (GENERIC_OUTREACH_TITLES.has(lower)) return false;
  if (
    lower.includes('learn more about ai mode') ||
    lower.includes('make a legal removal request') ||
    lower === 'privacy' ||
    lower === 'terms'
  ) {
    return false;
  }
  return true;
}

export function extractOutreachCitedPages(
  batch: ResearchBatch | null | undefined,
  project?: { repositoryUrl?: string | null; siteUrl?: string | null } | null,
  options?: { questionIds?: string[]; language?: 'en' | 'zh'; limit?: number },
): OutreachCitedPage[] {
  if (!batch?.questions?.length) return [];

  const normalizedProject = project
    ? {
        repositoryUrl: project.repositoryUrl ?? '',
        siteUrl: project.siteUrl ?? '',
      }
    : null;
  const limit = Math.max(1, options?.limit ?? 4);
  const targetIdSet = options?.questionIds?.length
    ? new Set(options.questionIds)
    : null;
  const language = options?.language;

  interface CandidateEntry {
    key: string;
    title: string;
    url: string;
    host: string;
    kind: OutreachPageKind;
    score: number;
    questionIds: Set<string>;
    engines: Set<ResearchEngine>;
  }

  const collectGroup = (
    questions: ResearchQuestion[],
    excludeTitleKeys?: Set<string>,
  ): OutreachCitedPage[] => {
    const byTitle = new Map<string, CandidateEntry>();

    for (const question of questions) {
      for (const obs of question.observations ?? []) {
        if (language && obs.language !== language) continue;
        for (const source of obs.sources ?? []) {
          const title = (source.title ?? '').replace(/\s+/g, ' ').trim();
          if (!isUsefulOutreachTitle(title)) continue;

          const titleKey = title.toLowerCase();
          if (excludeTitleKeys?.has(titleKey)) continue;

          const normalized = normalizeOutreachSourceUrl(source.url ?? '');
          if (!normalized) continue;
          if (normalizedProject && isProjectOwnedUrl(normalized.url, normalizedProject)) continue;

          const classification = classifyOutreachPage(title, normalized.url);
          const existing = byTitle.get(titleKey);
          if (!existing) {
            byTitle.set(titleKey, {
              key: titleKey,
              title,
              url: normalized.url,
              host: normalized.host,
              kind: classification.kind,
              score: classification.score,
              questionIds: new Set([question.id]),
              engines: new Set([obs.engine]),
            });
          } else {
            existing.questionIds.add(question.id);
            existing.engines.add(obs.engine);
            // Prefer a resolved external URL over an opaque google.com/goto redirect
            if (!existing.host && normalized.host) {
              existing.url = normalized.url;
              existing.host = normalized.host;
              const nextClass = classifyOutreachPage(title, normalized.url);
              if (nextClass.score > existing.score) {
                existing.kind = nextClass.kind;
                existing.score = nextClass.score;
              }
            }
          }
        }
      }
    }

    return [...byTitle.values()]
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.questionIds.size - a.questionIds.size ||
          a.title.localeCompare(b.title),
      )
      .map((entry) => ({
        key: entry.key,
        title: entry.title,
        url: entry.url,
        host: entry.host,
        kind: entry.kind,
        score: entry.score,
        questionCount: entry.questionIds.size,
        questionIds: [...entry.questionIds],
        engines: [...entry.engines],
      }));
  };

  if (!targetIdSet) {
    return collectGroup(batch.questions).slice(0, limit);
  }

  const prioritizedQuestions = batch.questions.filter((q) => targetIdSet.has(q.id));
  const primary = collectGroup(prioritizedQuestions).slice(0, limit);
  if (primary.length >= limit) {
    return primary;
  }

  const seenTitleKeys = new Set(primary.map((item) => item.key));
  const restQuestions = batch.questions.filter((q) => !targetIdSet.has(q.id));
  const supplemental = collectGroup(restQuestions, seenTitleKeys).slice(
    0,
    limit - primary.length,
  );
  return [...primary, ...supplemental];
}

export function observationTime(observation: Pick<ResearchObservation, 'collectedAt' | 'recordedAt'>): number {
  for (const value of [observation.collectedAt, observation.recordedAt]) {
    if (!value) continue;
    const exact = Date.parse(value);
    if (Number.isFinite(exact)) return exact;
    // Imported records can describe an observation window in prose. Use its
    // dated prefix for ordering while preserving the original uncertainty text.
    const prefix = value.match(
      /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/,
    );
    if (prefix) return Date.parse(`${prefix[1]}T${prefix[2] || '00:00:00'}Z`);
  }
  return Number.NEGATIVE_INFINITY;
}

export function getLatestResearchObservation(
  observations: ResearchObservation[],
): ResearchObservation | undefined {
  return observations.reduce<ResearchObservation | undefined>(
    (latest, observation) =>
      !latest || observationTime(observation) >= observationTime(latest)
        ? observation
        : latest,
    undefined,
  );
}

export function getResearchRows(
  batch: ResearchBatch,
  filters: ResearchFilter,
  options: { includeHistory?: boolean } = {},
): ResearchRow[] {
  const engines: ResearchRow['engine'][] =
    filters.engine === 'all'
      ? getBatchResearchEngines(batch)
      : [filters.engine];
  const rows: ResearchRow[] = [];

  for (const question of batch.questions) {
    const brand = isBrandQuestion(question);
    if (filters.kind === 'brand' && !brand) continue;
    if (filters.kind === 'discovery' && brand) continue;

    for (const engine of engines) {
      const prefix = `${batch.id}:${question.id}:${engine}:${filters.language}`;
      const matching = question.observations.flatMap((observation, index) =>
        observation.engine === engine &&
        observation.language === filters.language
          ? [{ key: `${prefix}:${index}`, question, engine, observation }]
          : [],
      );
      // A missing record is a display row, never a synthetic observation.
      if (matching.length) {
        // Appended observations retain their original indices for saved links.
        // Current statistics use one latest record per question/language/entry.
        const latest = getLatestResearchObservation(
          matching.map((row) => row.observation),
        );
        rows.push(
          ...(options.includeHistory
            ? matching
            : [matching.findLast((row) => row.observation === latest)!]),
        );
      } else rows.push({ key: `${prefix}:unmeasured`, question, engine });
    }
  }

  return rows.filter(
    (row) =>
      filters.result === 'all' ||
      (row.observation?.status ?? 'unmeasured') === filters.result,
  );
}

export function getResearchMetrics(rows: ResearchRow[]): {
  completed: number;
  found: number;
  unmeasured: number;
  measuredQuestions: number;
  coveredQuestions: number;
  totalQuestions: number;
  rate: number | null;
} {
  let completed = 0;
  let found = 0;
  const questions = new Set<string>();
  const measuredQuestions = new Set<string>();
  const coveredQuestions = new Set<string>();

  for (const row of rows) {
    questions.add(row.question.id);
    if (!row.observation) continue;
    completed += 1;
    measuredQuestions.add(row.question.id);
    if (row.observation.status === 'found') {
      found += 1;
      coveredQuestions.add(row.question.id);
    }
  }

  return {
    completed,
    found,
    unmeasured: rows.length - completed,
    measuredQuestions: measuredQuestions.size,
    coveredQuestions: coveredQuestions.size,
    totalQuestions: questions.size,
    rate: completed ? (found / completed) * 100 : null,
  };
}

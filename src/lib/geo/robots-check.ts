import { loadProjectSeed } from './project-data';

export interface RobotsCheckResult {
  checked: boolean;
  origin: string | null;
  robotsUrl: string | null;
  blockedBots: string[];
}

const TARGET_BOTS = [
  { token: 'oai-searchbot', label: 'OAI-SearchBot' },
  { token: 'gptbot', label: 'GPTBot' },
  { token: 'googlebot', label: 'Googlebot' },
  { token: 'google-extended', label: 'Google-Extended' },
  { token: 'perplexitybot', label: 'PerplexityBot' },
] as const;

const SHARED_PLATFORM_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'bitbucket.org',
  'npmjs.com',
  'www.npmjs.com',
  'pypi.org',
  'huggingface.co',
  'dev.to',
  'medium.com',
  'substack.com',
  'notion.site',
  'x.com',
  'twitter.com',
  'reddit.com',
  'www.reddit.com',
  'youtube.com',
  'www.youtube.com',
]);

const PRIVATE_IPV4_RE =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function isPublicWebsiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || !host.includes('.')) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return false;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || PRIVATE_IPV4_RE.test(host)) {
    return false;
  }
  if (host.includes(':') || host.startsWith('[')) return false;
  if (SHARED_PLATFORM_HOSTS.has(host)) return false;
  return true;
}

/**
 * Picks the first standalone public website origin (skipping local IPs and shared code/blog hosts).
 */
export function resolveCheckableWebsiteOrigin(urls: Array<string | undefined | null>): string | null {
  for (const raw of urls) {
    if (!raw || typeof raw !== 'string') continue;
    try {
      const parsed = new URL(raw.trim());
      if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
        continue;
      }
      if (!isPublicWebsiteHost(parsed.hostname)) continue;
      return parsed.origin;
    } catch {
      continue;
    }
  }
  return null;
}

interface RobotsGroup {
  agents: string[];
  allowRoot: boolean;
  disallowRoot: boolean;
}

function isRootPathRule(value: string): boolean {
  const clean = value.trim();
  return clean === '/' || clean === '/*';
}

/**
 * Evaluates RFC-9309 group rules to find key AI search bots explicitly blocked at root `/`.
 */
export function findBlockedAiBotsInRobotsTxt(robotsContent: string): string[] {
  const lines = robotsContent.replace(/\r/g, '').split('\n');
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let seenRuleDirective = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      if (current && seenRuleDirective) {
        groups.push(current);
        current = null;
        seenRuleDirective = false;
      }
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (current && seenRuleDirective) {
        groups.push(current);
        current = null;
        seenRuleDirective = false;
      }
      if (!current) current = { agents: [], allowRoot: false, disallowRoot: false };
      if (value) current.agents.push(value.toLowerCase());
    } else if (field === 'disallow' || field === 'allow') {
      if (!current) continue;
      seenRuleDirective = true;
      if (field === 'disallow' && isRootPathRule(value)) {
        current.disallowRoot = true;
      } else if (field === 'allow' && isRootPathRule(value)) {
        current.allowRoot = true;
      }
    }
  }
  if (current) groups.push(current);

  const wildcardGroups = groups.filter((g) => g.agents.includes('*'));
  const blocked: string[] = [];

  for (const bot of TARGET_BOTS) {
    const specificGroups = groups.filter((g) => g.agents.some((ua) => ua === bot.token));
    const applicable = specificGroups.length > 0 ? specificGroups : wildcardGroups;
    if (!applicable.length) continue;
    const allowRoot = applicable.some((g) => g.allowRoot);
    const disallowRoot = applicable.some((g) => g.disallowRoot);
    if (disallowRoot && !allowRoot) {
      blocked.push(bot.label);
    }
  }

  return blocked;
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const robotsCache = new Map<string, { at: number; result: RobotsCheckResult }>();

export async function checkProjectRobotsTxt(projectId: string): Promise<RobotsCheckResult> {
  const seed = loadProjectSeed(projectId);
  const ownedAssetUrls = seed.assets
    .filter((asset) => asset.ownership !== 'external' && asset.publicUrl)
    .map((asset) => asset.publicUrl);
  const origin = resolveCheckableWebsiteOrigin([
    seed.project.siteUrl,
    ...ownedAssetUrls,
    seed.project.repositoryUrl,
  ]);
  if (!origin) {
    return { checked: false, origin: null, robotsUrl: null, blockedBots: [] };
  }

  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.result;
  }

  let robotsUrl = `${origin}/robots.txt`;
  try {
    let response = await fetch(robotsUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(3500),
      headers: { Accept: 'text/plain,*/*;q=0.5' },
    });

    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        const resolved = new URL(location, robotsUrl).href;
        const safeOrigin = resolveCheckableWebsiteOrigin([resolved]);
        if (safeOrigin && new URL(resolved).pathname.endsWith('/robots.txt')) {
          robotsUrl = resolved;
          response = await fetch(robotsUrl, {
            redirect: 'manual',
            signal: AbortSignal.timeout(3500),
            headers: { Accept: 'text/plain,*/*;q=0.5' },
          });
        }
      }
    }

    if (!response.ok) {
      const miss: RobotsCheckResult = { checked: true, origin, robotsUrl, blockedBots: [] };
      robotsCache.set(origin, { at: Date.now(), result: miss });
      return miss;
    }

    const contentType = response.headers.get('content-type') || '';
    const text = (await response.text()).slice(0, 64 * 1024);
    if (contentType.includes('text/html') || /^\s*<(?:!doctype|html)\b/i.test(text)) {
      const htmlFallback: RobotsCheckResult = { checked: true, origin, robotsUrl, blockedBots: [] };
      robotsCache.set(origin, { at: Date.now(), result: htmlFallback });
      return htmlFallback;
    }

    const blockedBots = findBlockedAiBotsInRobotsTxt(text);
    const result: RobotsCheckResult = { checked: true, origin, robotsUrl, blockedBots };
    robotsCache.set(origin, { at: Date.now(), result });
    return result;
  } catch {
    const failed: RobotsCheckResult = { checked: false, origin, robotsUrl, blockedBots: [] };
    robotsCache.set(origin, { at: Date.now(), result: failed });
    return failed;
  }
}

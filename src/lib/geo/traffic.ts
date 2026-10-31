// This module uses Node's filesystem and is imported only by the server route.
// Client components must import traffic-types, never configuration from here.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { GeoProjectId } from './projects';
import type {
  TrafficErrorCode,
  TrafficRange,
  TrafficSnapshot,
} from './traffic-types';

const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const METRICS_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 10_000;

export type Environment = Record<string, string | undefined>;
export type Configuration = {
  url: URL;
  token: string;
  websiteId: string;
  apiVersion: 2 | 3;
};
export type TrafficOptions = {
  env?: Environment;
  fetch?: typeof fetch;
  now?: number;
};

export class TrafficRequestError extends Error {
  readonly status = 400;
}

export class TrafficProviderError extends Error {
  readonly code: TrafficErrorCode;
  constructor(code: TrafficErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function chinaDate(timestamp: number): string {
  return new Date(timestamp + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

function dateStart(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TrafficRequestError('日期请使用 YYYY-MM-DD 格式。');
  }
  const timestamp = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(timestamp) || chinaDate(timestamp) !== value) {
    throw new TrafficRequestError('日期无效。');
  }
  return timestamp;
}

/** Inclusive calendar dates in Beijing time; today's end is the request time. */
export function getTrafficRange(
  startDate?: string | null,
  endDate?: string | null,
  now = Date.now(),
): TrafficRange {
  if ((startDate == null) !== (endDate == null)) {
    throw new TrafficRequestError('请同时提供开始日期和结束日期。');
  }
  const end = endDate ?? chinaDate(now);
  const start = startDate ?? chinaDate(dateStart(end) - 29 * DAY_MS);
  const startAt = dateStart(start);
  const endDay = dateStart(end);
  if (startAt > endDay)
    throw new TrafficRequestError('开始日期不能晚于结束日期。');
  if (endDay > dateStart(chinaDate(now))) {
    throw new TrafficRequestError('结束日期不能晚于今天。');
  }
  return {
    startDate: start,
    endDate: end,
    startAt,
    endAt: Math.min(endDay + DAY_MS - 1, now),
    timezone: 'Asia/Shanghai',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidConfiguration(): never {
  throw new TrafficProviderError(
    'configuration',
    '访问统计配置无效，请检查服务端 Umami 配置。',
  );
}

export async function getConfiguration(
  projectId: GeoProjectId,
  env: Environment,
): Promise<Configuration | null> {
  const filename =
    env.OPENGEO_UMAMI_CONFIG_FILE?.trim() ||
    path.join(env.DATA_DIR || process.cwd(), 'data', 'umami.json');
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'));
    if (!isRecord(value)) invalidConfiguration();
    saved = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      invalidConfiguration();
  }

  let websiteIds: unknown = saved.websiteIds;
  if (env.OPENGEO_UMAMI_WEBSITE_IDS !== undefined) {
    try {
      websiteIds = JSON.parse(env.OPENGEO_UMAMI_WEBSITE_IDS);
    } catch {
      invalidConfiguration();
    }
  }
  if (websiteIds == null) return null;
  if (!isRecord(websiteIds)) invalidConfiguration();
  // No default website: another project must have its own explicit binding.
  if (!Object.hasOwn(websiteIds, projectId)) return null;
  const websiteId = websiteIds[projectId];
  if (
    typeof websiteId !== 'string' ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(websiteId)
  ) {
    invalidConfiguration();
  }

  const rawUrl = env.OPENGEO_UMAMI_URL ?? saved.url;
  const rawToken = env.OPENGEO_UMAMI_TOKEN ?? saved.token;
  if (rawUrl == null || rawUrl === '' || rawToken == null || rawToken === '')
    return null;
  if (typeof rawUrl !== 'string' || typeof rawToken !== 'string')
    invalidConfiguration();
  const token = rawToken.trim();
  if (!token || /\s/.test(token)) invalidConfiguration();

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    invalidConfiguration();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    invalidConfiguration();
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;

  const version = String(
    env.OPENGEO_UMAMI_API_VERSION ?? saved.apiVersion ?? 3,
  );
  if (version !== '2' && version !== '3') invalidConfiguration();
  return { url, token, websiteId, apiVersion: version === '2' ? 2 : 3 };
}

async function requestUmami(
  configuration: Configuration,
  endpoint: 'stats' | 'metrics',
  range: TrafficRange,
  requestFetch: typeof fetch,
  type?: string,
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (type) {
    params.type = type;
    params.limit = String(METRICS_LIMIT);
  }
  if (configuration.apiVersion === 3) params.eventType = '1';
  return requestUmamiEndpoint(
    configuration,
    endpoint,
    range,
    requestFetch,
    params,
  );
}

/** Shared server-only GET transport; callers choose their own event scope. */
export async function requestUmamiEndpoint(
  configuration: Configuration,
  endpoint: 'stats' | 'metrics' | 'funnels/stats' | 'event-data/values',
  range: TrafficRange,
  requestFetch: typeof fetch,
  params: Record<string, string> = {},
): Promise<unknown> {
  const url = new URL(
    `api/websites/${configuration.websiteId}/${endpoint}`,
    configuration.url,
  );
  url.searchParams.set('startAt', String(range.startAt));
  url.searchParams.set('endAt', String(range.endAt));
  url.searchParams.set('timezone', range.timezone);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);

  const response = await requestFetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${configuration.token}`,
    },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new TrafficProviderError(
      'authorization',
      'Umami 授权失效或没有该网站的读取权限。',
    );
  }
  if (!response.ok) {
    throw new TrafficProviderError(
      'upstream',
      'Umami 暂时无法返回访问统计，请稍后重试。',
    );
  }
  try {
    return await response.json();
  } catch {
    throw new TrafficProviderError(
      'invalid_response',
      'Umami 返回的数据格式无效，暂时无法显示统计。',
    );
  }
}

function invalidResponse(): never {
  throw new TrafficProviderError(
    'invalid_response',
    'Umami 返回的数据格式无效，暂时无法显示统计。',
  );
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalidResponse();
  return value;
}

function readSummary(
  value: unknown,
  version: 2 | 3,
): NonNullable<TrafficSnapshot['summary']> {
  if (!isRecord(value)) invalidResponse();
  const metric = (name: string): number => {
    const item = value[name];
    return count(version === 2 && isRecord(item) ? item.value : item);
  };
  return { pageviews: metric('pageviews'), visitors: metric('visitors') };
}

// Both v3.4.1 and v2.20.0 metrics aggregate distinct session_id, not pageviews.
function readMetrics(value: unknown): { label: string; visitors: number }[] {
  if (!Array.isArray(value)) invalidResponse();
  return value
    .map((item) => {
      if (!isRecord(item) || (typeof item.x !== 'string' && item.x !== null))
        invalidResponse();
      return { label: item.x ?? '', visitors: count(item.y) };
    })
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, METRICS_LIMIT);
}

/** Read-only snapshot; failures never become zero visits or expose upstream bodies. */
export async function getTrafficSnapshot(
  projectId: GeoProjectId,
  range: TrafficRange,
  options: TrafficOptions = {},
): Promise<TrafficSnapshot> {
  const snapshot: TrafficSnapshot = {
    projectId,
    provider: 'umami',
    status: 'not_configured',
    range,
    fetchedAt: null,
    summary: null,
    pages: [],
    referrers: [],
    limit: METRICS_LIMIT,
  };
  try {
    const configuration = await getConfiguration(
      projectId,
      options.env ?? process.env,
    );
    if (!configuration) return snapshot;
    const requestFetch = options.fetch ?? fetch;
    const [stats, pages, referrers] = await Promise.all([
      requestUmami(configuration, 'stats', range, requestFetch),
      requestUmami(
        configuration,
        'metrics',
        range,
        requestFetch,
        configuration.apiVersion === 2 ? 'url' : 'path',
      ),
      requestUmami(configuration, 'metrics', range, requestFetch, 'referrer'),
    ]);
    const summary = readSummary(stats, configuration.apiVersion);
    const pageRows = readMetrics(pages);
    const referrerRows = readMetrics(referrers);
    if (
      summary.pageviews === 0 &&
      (summary.visitors > 0 ||
        [...pageRows, ...referrerRows].some((row) => row.visitors > 0))
    ) {
      invalidResponse();
    }
    return {
      ...snapshot,
      status: summary.pageviews === 0 ? 'empty' : 'ready',
      fetchedAt: new Date(options.now ?? Date.now()).toISOString(),
      summary,
      pages: pageRows.map((row) => ({
        path: row.label,
        visitors: row.visitors,
      })),
      referrers: referrerRows.map((row) => ({
        referrer: row.label,
        visitors: row.visitors,
      })),
    };
  } catch (error) {
    const safe =
      error instanceof TrafficProviderError
        ? error
        : error instanceof Error &&
            (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? new TrafficProviderError('timeout', 'Umami 连接超时，请稍后重试。')
          : new TrafficProviderError(
              'upstream',
              '无法连接 Umami，请检查服务状态后重试。',
            );
    return {
      ...snapshot,
      status: 'error',
      error: { code: safe.code, message: safe.message },
    };
  }
}

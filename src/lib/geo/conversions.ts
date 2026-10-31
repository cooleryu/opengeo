// Server-only: credentials and upstream responses must never enter client props.
import type { GeoProjectId } from './projects';
import type { TrafficRange } from './traffic-types';
import type {
  ConversionJourney,
  ConversionSnapshot,
  ConversionSummary,
} from './conversion-types';
import {
  getConfiguration,
  requestUmamiEndpoint,
  TrafficProviderError,
  type TrafficOptions,
} from './traffic';

const GROUP_LIMIT = 10;
const PROPERTY_VALUES_LIMIT = 100;
const WINDOW_MINUTES = 30;
const CONCURRENCY = 3;
const EVENT_NAMES = ['article_view', 'github_click'] as const;
type Step = {
  type: 'event';
  value: (typeof EVENT_NAMES)[number];
  filters?: { property: string; operator: 'eq'; value: string }[];
};
type Context = Pick<ConversionJourney, 'source' | 'landingPage' | 'entryScope'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new TrafficProviderError(
    'invalid_response',
    'Umami 返回的转化数据格式无效，暂时无法显示。',
  );
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalidResponse();
  return value;
}

function steps(context?: string): Step[] {
  return EVENT_NAMES.map((value) => ({
    type: 'event',
    value,
    ...(context !== undefined && {
      filters: [
        { property: 'entry_context', operator: 'eq' as const, value: context },
      ],
    }),
  }));
}

function readFunnel(value: unknown, expected: Step[]): ConversionSummary {
  if (!Array.isArray(value) || value.length !== expected.length)
    invalidResponse();
  const visitors = value.map((row, index) => {
    const step = expected[index];
    if (!isRecord(row) || row.type !== step.type || row.value !== step.value)
      invalidResponse();
    if (step.filters) {
      if (
        !Array.isArray(row.filters) ||
        row.filters.length !== step.filters.length
      )
        invalidResponse();
      for (let i = 0; i < step.filters.length; i++) {
        const filter = row.filters[i];
        const wanted = step.filters[i];
        if (
          !isRecord(filter) ||
          filter.property !== wanted.property ||
          filter.operator !== wanted.operator ||
          filter.value !== wanted.value
        )
          invalidResponse();
      }
    }
    return count(row.visitors);
  });
  if (visitors[1] > visitors[0]) invalidResponse();
  return {
    articleVisitors: visitors[0],
    githubVisitors: visitors[1],
    conversionRate: visitors[0] > 0 ? visitors[1] / visitors[0] : null,
  };
}

function readValues(value: unknown): { value: string; total: number }[] {
  if (!Array.isArray(value)) invalidResponse();
  const seen = new Set<string>();
  return value
    .map((row) => {
      if (
        !isRecord(row) ||
        typeof row.value !== 'string' ||
        seen.has(row.value)
      )
        invalidResponse();
      seen.add(row.value);
      return { value: row.value, total: count(row.total) };
    })
    .sort((a, b) => b.total - a.total || a.value.localeCompare(b.value));
}

function readContext(value: string): Context | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [source, landingPage, entryScope] = parsed;
    if (
      typeof source !== 'string' ||
      source.length === 0 ||
      source.length > 500 ||
      typeof landingPage !== 'string' ||
      !landingPage.startsWith('/') ||
      landingPage.startsWith('//') ||
      landingPage.length > 1000 ||
      (entryScope !== 'tab-30m' && entryScope !== 'page') ||
      /[\u0000-\u001f\u007f]/.test(source + landingPage)
    )
      return null;
    return { source, landingPage, entryScope };
  } catch {
    return null;
  }
}

async function mapLimited<T, R>(
  items: T[],
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

/** Native Umami visitor funnel; no identity reconstruction or analytics writes. */
export async function getConversionSnapshot(
  projectId: GeoProjectId,
  range: TrafficRange,
  options: TrafficOptions = {},
): Promise<ConversionSnapshot> {
  const snapshot: ConversionSnapshot = {
    projectId,
    provider: 'umami',
    status: 'not_configured',
    range,
    fetchedAt: null,
    summary: null,
    journeys: [],
    limit: GROUP_LIMIT,
    windowMinutes: WINDOW_MINUTES,
    grouping: {
      rankedBy: 'article_events',
      returnedValues: 0,
      invalidValues: 0,
      truncated: false,
    },
  };
  try {
    const configuration = await getConfiguration(
      projectId,
      options.env ?? process.env,
    );
    if (!configuration) return snapshot;
    if (configuration.apiVersion !== 3)
      return { ...snapshot, status: 'unsupported' };
    const requestFetch = options.fetch ?? fetch;
    const getFunnel = async (context?: string) => {
      const requestedSteps = steps(context);
      const data = await requestUmamiEndpoint(
        configuration,
        'funnels/stats',
        range,
        requestFetch,
        {
          window: String(WINDOW_MINUTES),
          steps: JSON.stringify(requestedSteps),
        },
      );
      return readFunnel(data, requestedSteps);
    };
    const [summary, rawValues] = await Promise.all([
      getFunnel(),
      requestUmamiEndpoint(
        configuration,
        'event-data/values',
        range,
        requestFetch,
        {
          eventName: 'article_view',
          propertyName: 'entry_context',
          dataType: '1',
        },
      ),
    ]);
    const values = readValues(rawValues);
    if (summary.articleVisitors === 0 && values.some((item) => item.total > 0))
      invalidResponse();
    const valid = values.flatMap((item) => {
      const context = readContext(item.value);
      return context ? [{ ...item, context }] : [];
    });
    const journeys = await mapLimited(
      valid.slice(0, GROUP_LIMIT),
      async (item) => ({
        ...item.context,
        ...(await getFunnel(item.value)),
      }),
    );
    // These GETs are separate database reads, not a shared snapshot. Preserve
    // each valid funnel instead of rejecting it against an earlier response.
    return {
      ...snapshot,
      status: summary.articleVisitors === 0 ? 'empty' : 'ready',
      fetchedAt: new Date(options.now ?? Date.now()).toISOString(),
      summary,
      journeys,
      grouping: {
        rankedBy: 'article_events',
        returnedValues: values.length,
        invalidValues: values.length - valid.length,
        truncated:
          valid.length > GROUP_LIMIT || values.length >= PROPERTY_VALUES_LIMIT,
      },
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
              '无法连接 Umami，请稍后重试。',
            );
    return {
      ...snapshot,
      status: 'error',
      error: { code: safe.code, message: safe.message },
    };
  }
}

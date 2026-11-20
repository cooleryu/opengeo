import { plural } from '@/lib/geo/i18n';
import { type AuditedResearchRow, isAiAnswerRow, type MetricSummary } from '@/lib/geo/overview-metrics';
import type { QuestionCategory } from '@/lib/geo/question-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import type { ResearchRow } from '@/lib/geo/research-view';
import type { useUiLanguage } from '../UiLanguageContext';

export const unavailableMetric: MetricSummary = {
  rate: null,
  minimumRate: null,
  yes: 0,
  no: 0,
  unknown: 0,
  completed: 0,
  unmeasured: 0,
  questions: 0,
};

export function getPlatformName(engine: ResearchEngine, _isEn = false): string {
  if (engine === 'chatgpt') return 'ChatGPT';
  return 'Google';
}

export const categoryMessageKeys = {
  brand: 'overview.catBrand',
  positioning: 'overview.catPositioning',
  problem: 'overview.catProblem',
  content: 'overview.catContent',
  comparison: 'overview.catComparison',
  boundary: 'overview.catBoundary',
} as const satisfies Record<QuestionCategory, Parameters<ReturnType<typeof useUiLanguage>['t']>[0]>;

export const pct = (value: number | null) =>
  value === null ? '—' : `${Number(value.toFixed(1))}%`;

export function overviewObservationDates(rows: ResearchRow[], isEn = false): string {
  const dates = [
    ...new Set(
      rows.flatMap((row) => {
        const date = row.observation?.recordedAt.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        return date ? [date] : [];
      }),
    ),
  ].sort();
  return !dates.length
    ? (isEn ? 'No runs yet' : '尚无观测日期')
    : dates.length === 1
      ? dates[0]
      : `${dates[0]} — ${dates[dates.length - 1]}`;
}

/**
 * Same-denominator rate formatter:
 * Ensures e.g. `2 / 15` always displays `13.3%` (and `1 / 10` displays `10%`),
 * eliminating the confusing question-weighted `4.2%` mismatch.
 */
export function formatDirectMetric(
  metric: MetricSummary,
  metricKind: 'mention' | 'citation',
  isEn: boolean,
  options?: { unauditedCount?: number; couldNotVerifyLabel?: string },
): {
  primary: string;
  qualifier?: string;
  subline: string;
  ringCenter: string;
} {
  if (metric.completed <= 0) {
    return {
      primary: '—',
      subline: isEn ? 'No answers captured yet' : '暂未采集回答',
      ringCenter: '0/0',
    };
  }
  const hasUnaudited = (options?.unauditedCount ?? 0) > 0;
  const couldNotVerify =
    options?.couldNotVerifyLabel || (isEn ? "Couldn't verify" : '无法确认');
  const unknownBadge = hasUnaudited
    ? isEn
      ? 'analyzing'
      : '分析中'
    : couldNotVerify;
  const positiveVerb = isEn
    ? (metricKind === 'citation' ? 'cited your site' : 'mentioned your brand')
    : (metricKind === 'citation' ? '附上你的官网' : '提到你');
  const directPct = Number(((metric.yes / metric.completed) * 100).toFixed(1));
  if (metric.unknown === 0) {
    return {
      primary: `${directPct}%`,
      subline: isEn
        ? `${metric.yes} of ${metric.completed} answers ${positiveVerb}`
        : `${metric.completed} 条回答里，${metric.yes} 条${positiveVerb}`,
      ringCenter: `${metric.yes}/${metric.completed}`,
    };
  }
  if (metric.yes > 0) {
    return {
      qualifier: isEn ? 'At least' : '至少',
      primary: `${directPct}%`,
      subline: isEn
        ? `${metric.yes} of ${metric.completed} ${positiveVerb} (${metric.unknown} ${unknownBadge})`
        : `${metric.completed} 条回答里 ${metric.yes} 条${positiveVerb}（${metric.unknown} 条${unknownBadge}）`,
      ringCenter: `${metric.yes}/${metric.completed}`,
    };
  }
  const verifiedNo = metric.yes + metric.no;
  if (verifiedNo === 0) {
    if (!hasUnaudited) {
      return {
        primary: couldNotVerify,
        subline: isEn
          ? `${plural('en', metric.unknown, { one: '{n} answer', other: '{n} answers' })} could not be verified`
          : `${metric.unknown} 条回答无法确认`,
        ringCenter: '?',
      };
    }
    const unknownReason = isEn
      ? metricKind === 'citation'
        ? `Analyzing citation links in ${plural('en', metric.unknown, { one: '{n} answer', other: '{n} answers' })}`
        : `Analyzing mentions in ${plural('en', metric.unknown, { one: '{n} answer', other: '{n} answers' })}`
      : metricKind === 'citation'
        ? `正在核对 ${metric.unknown} 条回答的链接归属`
        : `正在核对 ${metric.unknown} 条回答的品牌提及`;
    return {
      primary: isEn ? 'Analyzing' : '分析中',
      subline: unknownReason,
      ringCenter: isEn ? '…' : '分析',
    };
  }
  return {
    primary: '0%',
    subline: isEn
      ? `${verifiedNo} verified not found · ${metric.unknown} ${unknownBadge}`
      : `${verifiedNo} 条确认未见 · ${metric.unknown} 条${unknownBadge}`,
    ringCenter: `0/${metric.completed}`,
  };
}

export function describeTileStatus(
  row: AuditedResearchRow | undefined,
  isEn = false,
  couldNotVerifyLabel?: string,
): {
  state: 'found' | 'absent' | 'pending' | 'unmeasured';
  statusText: string;
  dateText: string;
} {
  if (!row?.observation) {
    return { state: 'unmeasured', statusText: isEn ? 'Not captured yet' : '尚未搜索', dateText: '' };
  }
  const rawDate = (
    row.observation.collectedAt ||
    row.observation.recordedAt ||
    ''
  ).slice(0, 10);

  if (!isAiAnswerRow(row)) {
    return row.observation.status === 'found'
      ? { state: 'found', statusText: isEn ? 'Appeared in search results' : '搜索结果已出现', dateText: rawDate }
      : { state: 'absent', statusText: isEn ? 'Not in search results' : '搜索结果未出现', dateText: rawDate };
  }

  if (!row.audit) {
    return { state: 'pending', statusText: isEn ? 'Analyzing answer' : '正在分析回答', dateText: rawDate };
  }
  const mention = row.audit.mention ?? 'unknown';
  const citation = row.audit.citation ?? 'unknown';
  if (mention === 'yes' && citation === 'yes') {
    return { state: 'found', statusText: isEn ? 'Mentioned and cited' : '已提及并引用官网', dateText: rawDate };
  }
  if (mention === 'yes') {
    return { state: 'found', statusText: isEn ? 'Mentioned in answer' : '回答已提及你', dateText: rawDate };
  }
  if (mention === 'no') {
    return { state: 'absent', statusText: isEn ? 'Not mentioned in answer' : '回答未提及你', dateText: rawDate };
  }
  return {
    state: 'pending',
    statusText: couldNotVerifyLabel || (isEn ? "Couldn't verify" : '无法确认'),
    dateText: rawDate,
  };
}

export type FocusFilter =
  | 'all'
  | 'missed'
  | 'mentioned'
  | 'cited'
  | 'uncertain'
  | 'brand';

export const DEFAULT_VISIBLE_QUESTIONS = 3;

/** One platform's mention result, as shown on the platform card and in the verdict. */
export type PlatformStat = {
  engine: ResearchEngine;
  ai: boolean;
  yesCount: number;
  totalCount: number;
  rate: number | null;
  unknownCount: number;
};

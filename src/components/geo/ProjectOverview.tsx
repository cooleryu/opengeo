'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  ExternalLink,
  GitPullRequest,
  Layers3,
  Loader2,
  MessageSquarePlus,
  Minus,
  Play,
  RefreshCw,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import type { BrowserCollectJobSnapshot } from '@/lib/geo/browser-collect-types';
import { resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import type { QuestionCategory } from '@/lib/geo/question-types';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
  ResearchSource,
} from '@/lib/geo/research-types';
import {
  extractOverviewGapSources,
  extractQuestionTopWinners,
  extractTopExternalCitedSources,
  getResearchMetrics,
  getResearchRows,
  isBrandPrompt,
  type OverviewGapSourceKind,
  type ResearchFilter,
  type ResearchRow,
} from '@/lib/geo/research-view';
import {
  auditRows,
  isAiAnswerRow,
  summarizeMetric,
  type AuditedResearchRow,
  type MetricSummary,
} from '@/lib/geo/overview-metrics';
import {
  CONSUMER_RESEARCH_ENGINES,
  getBatchResearchEngines,
  RESEARCH_ENGINES,
} from '@/lib/geo/research-engines';
import type { GeoProject } from '@/lib/geo/types';
import CompetitorCandidates from './CompetitorCandidates';
import ResearchEngineIcon from './ResearchEngineIcon';
import { useUiLanguage } from './UiLanguageContext';
import './project-overview.css';

const unavailableMetric: MetricSummary = {
  rate: null,
  minimumRate: null,
  yes: 0,
  no: 0,
  unknown: 0,
  completed: 0,
  unmeasured: 0,
  questions: 0,
};

const verdictLabels = {
  zh: { yes: '已提及', no: '未提及', unknown: '分析中' },
  en: { yes: 'Mentioned', no: 'Not mentioned', unknown: 'Analyzing' },
} as const;

function getPlatformName(engine: ResearchEngine, _isEn = false): string {
  if (engine === 'chatgpt') return 'ChatGPT';
  return 'Google';
}

const categoryMessageKeys = {
  brand: 'overview.catBrand',
  positioning: 'overview.catPositioning',
  problem: 'overview.catProblem',
  content: 'overview.catContent',
  comparison: 'overview.catComparison',
  boundary: 'overview.catBoundary',
} as const satisfies Record<QuestionCategory, Parameters<ReturnType<typeof useUiLanguage>['t']>[0]>;

const pct = (value: number | null) =>
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

export function OverviewMention({
  batch,
  row,
}: {
  batch: ResearchBatch;
  row: ResearchRow;
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const audit = auditRows(batch, [row], batch.answerAudits ?? [])[0]?.audit;
  return (
    <span
      className={`pov-status ${audit?.mention === 'yes' ? 'positive' : ''}`}
    >
      {!row.observation
        ? (isEn ? 'Not run' : '未测')
        : verdictLabels[isEn ? 'en' : 'zh'][audit?.mention ?? 'unknown']}
    </span>
  );
}

function humanizeAuditEvidence(
  text: string | undefined,
  kind: 'mention' | 'citation',
  verdict: 'yes' | 'no' | 'unknown',
  isEn = false,
): string {
  const trimmed = text?.trim();
  if (!trimmed) {
    if (isEn) {
      return kind === 'mention'
        ? 'This answer has not been verified yet.'
        : 'Source citation check is pending.';
    }
    return kind === 'mention' ? '这条回答尚未复核。' : '引用关系尚未核实。';
  }
  if (/(?:nativeCitations|citationSource|citationsComplete|observedSourceHints|\bevidence\.)/i.test(trimmed)) {
    if (kind === 'citation' && verdict === 'unknown') {
      return isEn
        ? 'Checking captured source links against your project pages.'
        : '正在核对采集到的来源链接归属。';
    }
    if (kind === 'citation' && verdict === 'no') {
      return isEn
        ? 'Verified captured links: none point to your site, repository, or owned articles.'
        : '已核对回答附带的来源链接，未发现指向本项目网站、仓库或自有文章的链接。';
    }
  }
  if (isEn && /[\u4e00-\u9fff]/.test(trimmed)) {
    if (kind === 'mention') {
      if (verdict === 'no') {
        const listed = trimmed.match(/列举了\s*([^，。；]+?)\s*等/);
        const names = listed?.[1]?.replace(/\s*、\s*/g, ', ').trim();
        if (names && !/[\u4e00-\u9fff]/.test(names)) {
          return `The answer lists alternatives (${names}), with zero mention of your project or repository.`;
        }
        return 'Reviewed the full captured answer; your project name and repository were not mentioned.';
      }
      if (verdict === 'yes') {
        return 'Verified direct mention of your project in the captured answer.';
      }
      return 'Analyzing brand mention in this captured answer.';
    }
    if (verdict === 'no') {
      return 'Verified captured links: none point to your site, repository, or owned articles.';
    }
    if (verdict === 'yes') {
      return 'Confirmed a citation link pointing to your official site, repository, or authored article.';
    }
    return 'Checking captured source links against your project pages.';
  }
  return trimmed
    .replace(/[（(]\s*(?:citationSource|citationsComplete)\s*=[^）)]+[）)]/gi, '')
    .trim();
}

export function OverviewAudit({
  batch,
  row,
}: {
  batch: ResearchBatch;
  row: ResearchRow;
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const audit = auditRows(batch, [row], batch.answerAudits ?? [])[0]?.audit;
  if (!row.observation || !isAiAnswerRow(row)) return null;
  const mention = audit?.mention ?? 'unknown';
  const citation = audit?.citation ?? 'unknown';
  return (
    <div className="pov-audit-detail">
      <div>
        <strong>
          {isEn ? 'Brand mention' : '正文提及'} · {verdictLabels[isEn ? 'en' : 'zh'][mention]}
        </strong>
        <p>{humanizeAuditEvidence(audit?.mentionEvidence, 'mention', mention, isEn)}</p>
      </div>
      <div>
        <strong>
          {isEn ? 'Official citation' : '官方引用'} ·{' '}
          {citation === 'yes'
            ? (isEn ? 'Cited' : '已确认')
            : citation === 'no'
              ? (isEn ? 'Not cited' : '未引用')
              : (isEn ? 'Analyzing' : '分析中')}
        </strong>
        <p>{humanizeAuditEvidence(audit?.citationEvidence, 'citation', citation, isEn)}</p>
      </div>
    </div>
  );
}

/**
 * Symmetric Segmented Donut Ring Gauge for KPI cards.
 * Uses the exact same denominator as the adjacent fraction so visual and numbers never conflict.
 */
function DonutRing({
  yes,
  unknown,
  total,
  centerText,
}: {
  yes: number;
  unknown: number;
  total: number;
  centerText: string;
}) {
  const size = 68;
  const stroke = 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const safeTotal = Math.max(1, total);
  const yesLen = total > 0 ? (yes / safeTotal) * c : 0;
  const unknownLen = total > 0 ? (unknown / safeTotal) * c : 0;

  return (
    <span className="pov-donut" aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#eef0f3"
          strokeWidth={stroke}
        />
        {unknownLen > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#fcd34d"
            strokeWidth={stroke}
            strokeDasharray={`${unknownLen} ${c}`}
            strokeDashoffset={-yesLen}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {yesLen > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#16a34a"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${yesLen} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="pov-donut-label">{centerText}</span>
    </span>
  );
}

function AnswerPips({
  yes,
  no,
  unknown,
}: {
  yes: number;
  no: number;
  unknown: number;
}) {
  const total = yes + no + unknown;
  if (total <= 0 || total > 24) return null;
  const items: ('yes' | 'no' | 'unknown')[] = [
    ...Array<'yes'>(yes).fill('yes'),
    ...Array<'no'>(no).fill('no'),
    ...Array<'unknown'>(unknown).fill('unknown'),
  ];
  return (
    <span className="pov-pips" aria-hidden="true">
      {items.map((kind, idx) => (
        <i key={idx} className={`is-${kind}`} />
      ))}
    </span>
  );
}

/**
 * Same-denominator rate formatter:
 * Ensures e.g. `2 / 15` always displays `13.3%` (and `1 / 10` displays `10%`),
 * eliminating the confusing question-weighted `4.2%` mismatch.
 */
function formatDirectMetric(
  metric: MetricSummary,
  metricKind: 'mention' | 'citation',
  isEn: boolean,
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
        ? `${metric.yes} of ${metric.completed} ${positiveVerb} (${metric.unknown} analyzing)`
        : `${metric.completed} 条回答里 ${metric.yes} 条${positiveVerb}（${metric.unknown} 条分析中）`,
      ringCenter: `${metric.yes}/${metric.completed}`,
    };
  }
  const verifiedNo = metric.yes + metric.no;
  if (verifiedNo === 0) {
    const unknownReason = isEn
      ? metricKind === 'citation'
        ? `Analyzing citation links in ${metric.unknown} answers`
        : `Analyzing mentions in ${metric.unknown} answers`
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
      ? `${verifiedNo} verified not found · ${metric.unknown} analyzing`
      : `${verifiedNo} 条确认未见 · ${metric.unknown} 条分析中`,
    ringCenter: `0/${metric.completed}`,
  };
}

function describeTileStatus(
  row: AuditedResearchRow | undefined,
  isEn = false,
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

  const mention = row.audit?.mention ?? 'unknown';
  const citation = row.audit?.citation ?? 'unknown';
  if (mention === 'yes' && citation === 'yes') {
    return { state: 'found', statusText: isEn ? 'Mentioned and cited' : '已提及并引用官网', dateText: rawDate };
  }
  if (mention === 'yes') {
    return { state: 'found', statusText: isEn ? 'Mentioned in answer' : '回答已提及你', dateText: rawDate };
  }
  if (mention === 'no') {
    return { state: 'absent', statusText: isEn ? 'Not mentioned in answer' : '回答未提及你', dateText: rawDate };
  }
  return { state: 'pending', statusText: isEn ? 'Analyzing answer' : '正在分析回答', dateText: rawDate };
}

type Props = {
  projectOptimization?: ReactNode;
  activeOptimizationRunId?: string | null;
  latestShippedAt?: string | null;
  project?: Pick<GeoProject, 'siteUrl' | 'repositoryUrl' | 'targetLanguage'> & {
    name?: string;
  };
  previewOnly?: boolean;
  previewComparison?: ReactNode;
  batch: ResearchBatch;
  filters: ResearchFilter;
  workflow: ReactNode;
  onFilters: (patch: Partial<ResearchFilter>) => void;
  onQuestion: (
    question: ResearchQuestion,
    engine?: ResearchRow['engine'],
  ) => void;
  onSource: (source: ResearchSource, rows: ResearchRow[]) => void;
  onEvidence: (path: string) => void;
  onCompetitor: () => void;
  onQuestions: () => void;
  onRefresh?: () => void;
  onAssets?: () => void;
  onPlan?: (
    question?: ResearchQuestion,
    language?: 'zh' | 'en',
    engine?: ResearchEngine,
  ) => Promise<void> | void;
};

type FocusFilter =
  | 'all'
  | 'missed'
  | 'mentioned'
  | 'cited'
  | 'uncertain'
  | 'brand';
const DEFAULT_VISIBLE_QUESTIONS = 3;

export default function ProjectOverview({
  projectOptimization,
  activeOptimizationRunId,
  latestShippedAt,
  project,
  previewOnly = false,
  previewComparison,
  batch,
  filters,
  onFilters,
  onQuestion,
  onCompetitor,
  onQuestions,
  onRefresh,
  onPlan,
}: Props) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [collectJob, setCollectJob] = useState<BrowserCollectJobSnapshot | null>(null);
  const [startingCollect, setStartingCollect] = useState(false);
  const [collectActionError, setCollectActionError] = useState('');
  const prevCompletedRef = useRef<number>(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (previewOnly) return;
    let active = true;
    const syncCollectJob = () => {
      fetch(`/api/geo/browser-collect?project=${encodeURIComponent(batch.projectId)}`, {
        cache: 'no-store',
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((payload: { job?: BrowserCollectJobSnapshot } | null) => {
          if (!active || !payload?.job) return;
          prevCompletedRef.current = payload.job.completedCount;
          setCollectJob(payload.job);
        })
        .catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncCollectJob();
    };
    syncCollectJob();
    window.addEventListener('focus', syncCollectJob);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.removeEventListener('focus', syncCollectJob);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [batch.projectId, previewOnly]);

  useEffect(() => {
    if (previewOnly || collectJob?.status !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/geo/browser-collect?project=${encodeURIComponent(batch.projectId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as { job?: BrowserCollectJobSnapshot };
        if (!payload.job || cancelled) return;
        const prevDone = prevCompletedRef.current;
        prevCompletedRef.current = payload.job.completedCount;
        setCollectJob(payload.job);
        if (
          payload.job.completedCount > prevDone ||
          payload.job.status === 'completed'
        ) {
          onRefreshRef.current?.();
        }
      } catch {
        // Keep last state on transient polling errors
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [batch.projectId, collectJob?.status, previewOnly]);

  const startCollect = async (opts?: {
    engine?: 'all' | 'chatgpt' | 'google';
    spaceId?: number;
    force?: boolean;
    since?: string;
    optimizationRunId?: string;
  }) => {
    if (previewOnly || startingCollect) return;
    setStartingCollect(true);
    setCollectActionError('');
    const effectiveRunId = opts?.optimizationRunId ?? activeOptimizationRunId ?? undefined;
    try {
      const res = await fetch('/api/geo/browser-collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          projectId: batch.projectId,
          engine: opts?.engine ?? 'all',
          ...(opts?.force ? { force: true } : {}),
          ...(opts?.since ? { since: opts.since } : {}),
          ...(opts?.spaceId ? { spaceId: opts.spaceId } : {}),
          ...(effectiveRunId ? { optimizationRunId: effectiveRunId } : {}),
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        job?: BrowserCollectJobSnapshot;
      };
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isEn
              ? 'Could not start local browser collection.'
              : '未能启动本地浏览器采集。'),
        );
      }
      if (payload.job) {
        prevCompletedRef.current = payload.job.completedCount;
        setCollectJob(payload.job);
      }
    } catch (err) {
      setCollectActionError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Failed to start local browser collection.'
            : '启动本地浏览器采集失败。',
      );
    } finally {
      setStartingCollect(false);
    }
  };

  const stopCollect = async () => {
    if (previewOnly) return;
    try {
      const res = await fetch('/api/geo/browser-collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          projectId: batch.projectId,
        }),
      });
      const payload = (await res.json()) as { job?: BrowserCollectJobSnapshot };
      if (res.ok && payload.job) setCollectJob(payload.job);
    } catch {
      // Ignore transient stop errors
    }
  };

  const resumeCollect = (job: BrowserCollectJobSnapshot) => {
    void startCollect({
      engine: job.engine,
      spaceId: job.spaceId ?? undefined,
      force: job.force,
      since: job.force
        ? (job.batchStartedAt ?? job.startedAt ?? undefined)
        : undefined,
      optimizationRunId: job.optimizationRunId ?? undefined,
    });
  };
  const hasLangObs = (lang: 'zh' | 'en') =>
    batch.questions.some((q) =>
      q.observations.some((obs) => obs.language === lang),
    );
  const activeLanguage: 'zh' | 'en' = hasLangObs(filters.language)
    ? filters.language
    : resolveProjectTargetLanguage(project, batch);

  const scopeKey = `${batch.projectId}:${activeLanguage}:${filters.engine}`;
  const [uiState, setUiState] = useState<{
    scope: string;
    focus: FocusFilter;
    expandedQuestions: boolean;
  }>({
    scope: scopeKey,
    focus: 'all',
    expandedQuestions: false,
  });
  const [earlyRetestHours, setEarlyRetestHours] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const questionSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  const inScope = uiState.scope === scopeKey;
  const focus: FocusFilter = inScope ? uiState.focus : 'all';
  const expandedQuestions = inScope ? uiState.expandedQuestions : false;

  const patchUiState = (
    updater: (curr: {
      focus: FocusFilter;
      expandedQuestions: boolean;
    }) => Partial<{
      focus: FocusFilter;
      expandedQuestions: boolean;
    }>,
  ) => {
    setUiState((prev) => {
      const curr =
        prev.scope === scopeKey
          ? prev
          : {
              focus: 'all' as FocusFilter,
              expandedQuestions: false,
            };
      return {
        scope: scopeKey,
        focus: curr.focus,
        expandedQuestions: curr.expandedQuestions,
        ...updater(curr),
      };
    });
  };

  const setFocus = (next: FocusFilter | ((curr: FocusFilter) => FocusFilter)) =>
    patchUiState((curr) => ({
      focus: typeof next === 'function' ? next(curr.focus) : next,
    }));

  const setExpandedQuestions = (
    next: boolean | ((curr: boolean) => boolean),
  ) =>
    patchUiState((curr) => ({
      expandedQuestions:
        typeof next === 'function' ? next(curr.expandedQuestions) : next,
    }));

  const availableEngines = RESEARCH_ENGINES.filter((engine) =>
    batch.questions.some((q) =>
      q.observations.some((obs) => obs.engine === engine),
    ),
  );

  const selectedEngine: ResearchFilter['engine'] =
    filters.engine !== 'all' && availableEngines.includes(filters.engine)
      ? filters.engine
      : 'all';
  const allPlatforms = selectedEngine === 'all';
  const displayedEngines = allPlatforms
    ? availableEngines
    : [selectedEngine as ResearchEngine];

  const activeBatchEngines = getBatchResearchEngines(batch);
  const matrixEngines: ResearchEngine[] = allPlatforms
    ? activeBatchEngines
    : [selectedEngine as ResearchEngine];

  const allEngineRows = auditRows(
    batch,
    RESEARCH_ENGINES.flatMap((engine) =>
      getResearchRows(batch, {
        ...filters,
        language: activeLanguage,
        kind: 'all',
        engine,
        result: 'all',
      }),
    ),
    batch.answerAudits ?? [],
  );

  const rows = allEngineRows.filter((row) =>
    displayedEngines.includes(row.engine),
  );

  const platformStats = availableEngines.map((engine) => {
    const engineRows = allEngineRows.filter((r) => r.engine === engine);
    const measured = engineRows.filter((r) => r.observation);
    const ai = (measured.length ? measured : engineRows).some(isAiAnswerRow);
    const official = getResearchMetrics(engineRows);
    const mentionMetric =
      batch.overviewMetrics?.[`${activeLanguage}:${engine}`]?.mention ??
      summarizeMetric(engineRows, 'mention');
    const yesCount = ai ? mentionMetric.yes : official.found;
    const totalCount = ai ? mentionMetric.completed : official.completed;
    const directRate =
      totalCount > 0 && (!ai || mentionMetric.unknown === 0)
        ? Number(((yesCount / totalCount) * 100).toFixed(1))
        : null;

    return {
      engine,
      ai,
      yesCount,
      totalCount,
      rate: directRate,
      unknownCount: ai ? mentionMetric.unknown : 0,
    };
  });

  const displayedAi = rows
    .filter((r) => r.observation)
    .some(isAiAnswerRow);
  const sourceOnly = !allPlatforms && !displayedAi;
  const officialMetrics = getResearchMetrics(rows);
  const scopedMetrics =
    batch.overviewMetrics?.[`${activeLanguage}:${selectedEngine}`];
  const mention = scopedMetrics?.mention ?? unavailableMetric;
  const citation = scopedMetrics?.citation ?? unavailableMetric;

  const allQuestions = batch.questions.filter((q) =>
    rows.some((r) => r.question.id === q.id),
  );

  const questionHasMiss = (q: ResearchQuestion) => {
    const matching = rows.filter((r) => r.question.id === q.id && r.observation);
    if (!matching.length) return false;
    return matching.every((r) =>
      isAiAnswerRow(r)
        ? r.audit?.mention === 'no'
        : r.observation?.status === 'not_observed',
    );
  };

  const questionHasMention = (q: ResearchQuestion) => {
    const matching = rows.filter((r) => r.question.id === q.id && r.observation);
    return matching.some((r) =>
      isAiAnswerRow(r)
        ? r.audit?.mention === 'yes'
        : r.observation?.status === 'found',
    );
  };

  const questionHasCitation = (q: ResearchQuestion) =>
    rows.some(
      (r) =>
        r.question.id === q.id &&
        isAiAnswerRow(r) &&
        r.audit?.citation === 'yes',
    );

  const questionHasUncertain = (q: ResearchQuestion) =>
    rows.some(
      (r) =>
        r.question.id === q.id &&
        r.observation &&
        isAiAnswerRow(r) &&
        (!r.audit ||
          r.audit.mention === 'unknown' ||
          r.audit.citation === 'unknown'),
    );

  const splitCounts = (subset: ResearchRow[]) => {
    if (sourceOnly) {
      const m = getResearchMetrics(subset);
      return { yes: m.found, total: m.completed };
    }
    const m = summarizeMetric(subset, 'mention');
    return { yes: m.yes, total: m.completed };
  };
  const brandLabel = project?.name?.trim() || (isEn ? 'your brand' : '品牌名');
  const discoverySplit = splitCounts(
    rows.filter((r) => !isBrandPrompt(r.question, project?.name)),
  );
  const brandSplit = splitCounts(
    rows.filter((r) => isBrandPrompt(r.question, project?.name)),
  );
  const brandQuestionCount = allQuestions.filter((q) =>
    isBrandPrompt(q, project?.name),
  ).length;

  const missedCount = allQuestions.filter(questionHasMiss).length;
  const mentionedCount = allQuestions.filter(questionHasMention).length;
  const citedCount = allQuestions.filter(questionHasCitation).length;

  const filteredQuestions = allQuestions
    .filter((q) => {
      if (focus === 'missed') return questionHasMiss(q);
      if (focus === 'mentioned') return questionHasMention(q);
      if (focus === 'cited') return questionHasCitation(q);
      if (focus === 'uncertain') return questionHasUncertain(q);
      if (focus === 'brand') return isBrandPrompt(q, project?.name);
      return true;
    })
    .sort((a, b) => Number(questionHasMiss(b)) - Number(questionHasMiss(a)));

  const shouldCollapse =
    focus === 'all' &&
    !expandedQuestions &&
    filteredQuestions.length > DEFAULT_VISIBLE_QUESTIONS;
  const displayedQuestions = shouldCollapse
    ? filteredQuestions.slice(0, DEFAULT_VISIBLE_QUESTIONS)
    : filteredQuestions;
  const hiddenQuestionCount =
    filteredQuestions.length - DEFAULT_VISIBLE_QUESTIONS;

  const jumpFocus = (next: FocusFilter) => {
    setFocus((curr) => (curr === next ? 'all' : next));
    questionSectionRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  };

  const jumpSources = () => {
    jumpFocus(
      citation.yes > 0
        ? 'cited'
        : citation.unknown > 0
          ? 'uncertain'
          : 'missed',
    );
  };

  const collectCommand = `npm run collect -- --project ${batch.projectId}`;
  const renderBrowserCollectStatus = () => {
    if (!collectJob || collectJob.status === 'idle') return null;
    if (collectJob.status === 'running') {
      return (
        <div className="pov-collect-status is-running" role="status">
          <div className="pov-collect-status-main">
            <Loader2 size={16} className="spin" />
            <div>
              <strong>{t('overview.collectingTitle')}</strong>
              <p>
                {collectJob.totalCount > 0 && collectJob.currentQuestionId
                  ? t('overview.collectingStep', {
                      done: collectJob.completedCount,
                      total: collectJob.totalCount,
                      message:
                        collectJob.message ||
                        `${collectJob.currentEngine === 'chatgpt' ? 'ChatGPT' : 'Google'} · ${collectJob.currentQuestionId}`,
                    })
                  : collectJob.message}
              </p>
              {collectJob.currentQuery && (
                <p style={{ marginTop: 2, opacity: 0.85 }}>{collectJob.currentQuery}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            className="pov-secondary-btn"
            onClick={() => void stopCollect()}
          >
            <Square size={13} />
            {t('overview.stopCollectBtn')}
          </button>
        </div>
      );
    }
    if (collectJob.status === 'needs_handoff') {
      return (
        <div className="pov-collect-status is-handoff" role="alert">
          <div className="pov-collect-status-main">
            <AlertTriangle size={16} />
            <div>
              <strong>{t('overview.handoffTitle')}</strong>
              <p>{collectJob.error || t('overview.handoffDesc')}</p>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="pov-primary-btn"
              disabled={startingCollect}
              onClick={() => resumeCollect(collectJob)}
            >
              <RefreshCw size={14} />
              {t('overview.resumeCollectBtn')}
            </button>
            <button
              type="button"
              className="pov-secondary-btn"
              onClick={() => void stopCollect()}
            >
              <Square size={13} />
              {t('overview.stopCollectBtn')}
            </button>
          </div>
        </div>
      );
    }
    if (collectJob.status === 'failed' && collectJob.error) {
      return (
        <div className="pov-collect-status is-error" role="alert">
          <div className="pov-collect-status-main">
            <AlertTriangle size={16} />
            <div>
              <strong>{collectJob.error}</strong>
            </div>
          </div>
          <button
            type="button"
            className="pov-secondary-btn"
            disabled={startingCollect}
            onClick={() => resumeCollect(collectJob)}
          >
            <RefreshCw size={14} />
            {isEn ? 'Retry' : '重试采集'}
          </button>
        </div>
      );
    }
    return null;
  };

  if (!availableEngines.length) {
    const langLabel = t(
      activeLanguage === 'en'
        ? 'overview.targetLangEnLabel'
        : 'overview.targetLangZhLabel',
    );
    const copyCollectCommand = () => {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(collectCommand).then(() => {
          setCopiedCmd(true);
          setTimeout(() => setCopiedCmd(false), 2400);
        });
      }
    };
    return (
      <div className="pov-shell">
        <div className="pov-empty-card">
          <div className="pov-empty-head">
            <div>
              <h1>
                {t('overview.emptyReadyTitle', {
                  count: batch.questions.length,
                  langLabel,
                })}
              </h1>
              <p>{t('overview.emptyReadyDesc')}</p>
            </div>
            <button
              type="button"
              className="pov-inline-link"
              onClick={onQuestions}
            >
              {t('overview.reviewQuestionsBtn')} <ArrowRight size={14} />
            </button>
          </div>
          {collectActionError && (
            <div className="pov-collect-status is-error" role="alert">
              <div className="pov-collect-status-main">
                <AlertTriangle size={16} />
                <div>
                  <strong>{collectActionError}</strong>
                </div>
              </div>
            </div>
          )}
          {renderBrowserCollectStatus()}
          <div className="pov-empty-actions">
            {collectJob?.status === 'needs_handoff' ? (
              <button
                type="button"
                className="pov-primary-btn"
                disabled={startingCollect}
                onClick={() => resumeCollect(collectJob)}
              >
                <RefreshCw size={15} />
                {t('overview.resumeCollectBtn')}
              </button>
            ) : (
              <button
                type="button"
                className="pov-primary-btn"
                disabled={startingCollect || collectJob?.status === 'running'}
                onClick={() => void startCollect({ engine: 'all' })}
              >
                {startingCollect || collectJob?.status === 'running' ? (
                  <>
                    <Loader2 size={15} className="spin" />
                    {t('overview.startingBrowserCollectBtn')}
                  </>
                ) : (
                  <>
                    <Play size={15} />
                    {t('overview.startBrowserCollectBtn')}
                  </>
                )}
              </button>
            )}
          </div>
          <details className="pov-cli-fallback">
            <summary>{t('overview.cliFallbackSummary')}</summary>
            <div className="pov-command-box">
              <div className="pov-command-code">
                <Terminal size={15} aria-hidden="true" />
                <code>{collectCommand}</code>
              </div>
              <button
                type="button"
                className="pov-secondary-btn"
                onClick={copyCollectCommand}
              >
                {copiedCmd ? <Check size={14} /> : <Copy size={14} />}
                {copiedCmd
                  ? t('overview.copiedCommand')
                  : t('overview.copyCommand')}
              </button>
            </div>
          </details>
          {batch.questions.length > 0 && (
            <ol className="pov-empty-questions">
              {batch.questions.slice(0, 8).map((q) => (
                <li key={q.id}>
                  <span className="pov-q-cat">
                    {isBrandPrompt(q, project?.name)
                      ? t('overview.catBrand')
                      : q.category
                        ? t(categoryMessageKeys[q.category])
                        : t('overview.catProblem')}
                  </span>
                  <span>
                    {q[activeLanguage] || q.en || q.zh}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    );
  }

  const dateRange = overviewObservationDates(rows, isEn);

  const shippedMs = latestShippedAt ? Date.parse(latestShippedAt) : NaN;
  const hrsSinceShip =
    nowMs !== null && Number.isFinite(shippedMs)
      ? Math.max(0, (nowMs - shippedMs) / 3_600_000)
      : Infinity;

  const isColdZeroStage =
    !sourceOnly &&
    mention.completed > 0 &&
    mention.yes === 0 &&
    citation.yes === 0 &&
    mention.unknown === 0 &&
    citation.unknown === 0;
  const overviewTopWinners = extractTopExternalCitedSources(
    batch,
    project,
    activeLanguage,
    4,
  );
  const overviewGapSources = extractOverviewGapSources(batch, project, {
    engine: selectedEngine,
    language: activeLanguage,
    limit: 5,
  });

  // Deterministic 0-cost Peec Insights-style situation verdict
  const topLeaderNames = overviewTopWinners
    .slice(0, 2)
    .map((w) => w.label)
    .join(' & ');
  const measuredPlatforms = platformStats.filter((p) => p.rate !== null);
  const sortedByRate = [...measuredPlatforms].sort(
    (a, b) => (b.rate ?? 0) - (a.rate ?? 0),
  );
  const strongestPlatform =
    sortedByRate.length >= 2 &&
    (sortedByRate[0].rate ?? 0) > (sortedByRate[sortedByRate.length - 1].rate ?? 0)
      ? sortedByRate[0]
      : null;
  const weakestPlatform =
    strongestPlatform ? sortedByRate[sortedByRate.length - 1] : null;

  const situationVerdict = (() => {
    if (sourceOnly) {
      return {
        headline: isEn
          ? `${officialMetrics.found}/${officialMetrics.completed} web search checks included your site`
          : `网页搜索出现 ${officialMetrics.found}/${officialMetrics.completed} 次`,
        subline: isEn
          ? 'Switch to All or an AI answer engine to inspect mention and citation gaps.'
          : '切换到「全部」或 AI 回答平台查看完整提及与外部引用缺口。',
      };
    }
    if (mention.completed === 0) {
      return {
        headline: isEn ? 'Waiting for first completed measurements' : '等待首轮实测完成',
        subline: isEn
          ? 'Run local browser checks to build your real citation baseline.'
          : '运行本地浏览器实测后，这里会直接给出局势判断与高权重引用缺口。',
      };
    }
    if (mention.yes === 0) {
      const headline = topLeaderNames
        ? isEn
          ? `Not yet in AI recommendations — ${topLeaderNames} lead`
          : `当前在 AI 推荐中未上榜 — ${topLeaderNames} 领跑`
        : isEn
          ? 'Not yet appearing in AI answers'
          : '当前在 AI 回答中暂未出现提及';
      const subline =
        brandSplit.total > 0 && brandSplit.yes === 0
          ? isEn
            ? `The gap is presence: 0/${discoverySplit.total} non-branded answers mentioned you, and even direct "${brandLabel}" searches missed. Start with the AI-cited lists below.`
            : `核心瓶颈是「缺席」：${discoverySplit.total} 次非品牌拉新回答全部未提及，连直接搜「${brandLabel}」也未认出。优先抢占下方 AI 高频引用的外部榜单。`
          : isEn
            ? `The gap is presence: 0/${mention.completed} measured answers name you yet. Start by getting listed on the AI-cited sources below.`
            : `核心瓶颈是「缺席」：${mention.completed} 次实测回答暂未出现你的名字，建议优先拿下下方 AI 正在引用的外部榜单与对比页。`;
      return { headline, subline };
    }
    if (discoverySplit.total > 0 && discoverySplit.yes === 0) {
      return {
        headline: isEn
          ? `Visible on brand searches only — 0/${discoverySplit.total} non-branded prompts`
          : `仅搜「${brandLabel}」时出现 — 非品牌拉新仍为 0/${discoverySplit.total}`,
        subline: isEn
          ? 'Buyers who already know your name can find you, but category discovery still goes to competitors. Prioritize external lists and comparisons.'
          : '已经认识你的用户能搜到你，但按需求找工具的新买家全流向了竞品；优先铺设外部榜单和品类对比。',
      };
    }
    const rate = mention.rate ?? 0;
    const engineHint =
      strongestPlatform && weakestPlatform
        ? isEn
          ? ` Strongest on ${getPlatformName(strongestPlatform.engine, true)} (${pct(strongestPlatform.rate)}), weakest on ${getPlatformName(weakestPlatform.engine, true)} (${pct(weakestPlatform.rate)}).`
          : ` ${getPlatformName(strongestPlatform.engine)}表现最强（${pct(strongestPlatform.rate)}），${getPlatformName(weakestPlatform.engine)}最弱（${pct(weakestPlatform.rate)}）。`
        : '';
    if (rate < 50) {
      return {
        headline: isEn
          ? `Appearing in ${mention.yes}/${mention.completed} answers (${pct(rate)}) — not yet the default choice`
          : `已在部分回答中露面（${mention.yes}/${mention.completed}，${pct(rate)}）— 距默认首选还有差距`,
        subline: isEn
          ? `Official citations stand at ${citation.yes}/${citation.completed}.${engineHint} Close the top external list gaps below to raise presence.`
          : `官网/仓库直接引用为 ${citation.yes}/${citation.completed}。${engineHint}继续补齐下方外部高频榜单可稳定拉升曝光。`,
      };
    }
    return {
      headline: isEn
        ? `Strong AI presence (${mention.yes}/${mention.completed}, ${pct(rate)})`
        : `已进入核心推荐位（${mention.yes}/${mention.completed}，${pct(rate)}）`,
      subline: isEn
        ? `Official citations: ${citation.yes}/${citation.completed}.${engineHint}`
        : `官网/仓库直接引用 ${citation.yes}/${citation.completed}。${engineHint}`,
    };
  })();

  const gapKindLabel = (kind: OverviewGapSourceKind): string => {
    if (kind === 'awesome') return isEn ? 'Open-source directory' : '开源导航清单';
    if (kind === 'community') return isEn ? 'Community' : '社区讨论';
    if (kind === 'roundup') return isEn ? 'Listicle' : '横评指南';
    return isEn ? 'Competitor' : '竞品来源';
  };

  const mentionDisplay = sourceOnly
    ? {
        primary: pct(officialMetrics.rate),
        qualifier: undefined,
        subline: isEn
          ? `${officialMetrics.found} of ${officialMetrics.completed} search results included your site`
          : `${officialMetrics.completed} 条搜索记录中，${officialMetrics.found} 条找到官网`,
        ringCenter: `${officialMetrics.found}/${officialMetrics.completed}`,
      }
    : formatDirectMetric(mention, 'mention', isEn);

  const citationDisplay = formatDirectMetric(citation, 'citation', isEn);

  const unmeasuredConsumerEngines = CONSUMER_RESEARCH_ENGINES.filter(
    (e) => !availableEngines.includes(e),
  );

  return (
    <div className="pov-shell">
      {collectActionError && (
        <div className="pov-collect-status is-error" role="alert">
          <div className="pov-collect-status-main">
            <AlertTriangle size={16} />
            <div>
              <strong>{collectActionError}</strong>
            </div>
          </div>
        </div>
      )}
      {renderBrowserCollectStatus()}
      {/* Top Bar */}
      <header className="pov-topbar">
        <div className="pov-title-group">
          <h1>{t('overview.title')}</h1>
          <span className="pov-scope-pill">
            {t('overview.scopePill', {
              questions: allQuestions.length,
              platforms: availableEngines.length,
              dates: dateRange,
            })}
          </span>
        </div>

        <div className="pov-controls">
          {!previewOnly && allQuestions.length > 0 && (
            <button
              type="button"
              className="pov-secondary-btn pov-rerun-btn is-quiet"
              disabled={startingCollect || collectJob?.status === 'running'}
              onClick={() => {
                const targetEngine =
                  selectedEngine === 'chatgpt' || selectedEngine === 'google'
                    ? selectedEngine
                    : 'all';
                if (hrsSinceShip < 72) {
                  setEarlyRetestHours(Math.max(1, Math.round(hrsSinceShip)));
                  return;
                }
                void startCollect({
                  engine: targetEngine,
                  force: true,
                  optimizationRunId: activeOptimizationRunId ?? undefined,
                });
              }}
            >
              {startingCollect || collectJob?.status === 'running' ? (
                <>
                  <Loader2 size={14} className="spin" />
                  <span>{isEn ? 'Measuring…' : '正在实测…'}</span>
                </>
              ) : (
                <>
                  <RefreshCw size={14} />
                  <span>
                    {selectedEngine === 'chatgpt' || selectedEngine === 'google'
                      ? isEn
                        ? `Re-run ${getPlatformName(selectedEngine, isEn)}`
                        : `重新实测 ${getPlatformName(selectedEngine, isEn)}`
                      : isEn
                        ? `Re-run all (${allQuestions.length})`
                        : `重新实测全部 (${allQuestions.length}题)`}
                  </span>
                </>
              )}
            </button>
          )}
          <div
            className="pov-segmented"
            role="group"
            aria-label={isEn ? 'Platform filter' : '平台筛选'}
          >
            <button
              type="button"
              aria-pressed={allPlatforms}
              onClick={() =>
                onFilters({ engine: 'all', kind: 'all', result: 'all' })
              }
            >
              <Layers3 size={14} />
              <span>{t('overview.allPlatforms')}</span>
            </button>
            {availableEngines.map((engine) => (
              <button
                key={engine}
                type="button"
                aria-pressed={selectedEngine === engine}
                onClick={() =>
                  onFilters({ engine, kind: 'all', result: 'all' })
                }
              >
                <span className="pov-tab-brand-icon">
                  <ResearchEngineIcon engine={engine} />
                </span>
                <span>{getPlatformName(engine, isEn)}</span>
              </button>
            ))}
          </div>
        </div>
      </header>

      {earlyRetestHours !== null && (
        <div className="pov-retest-confirm" role="alert">
          <div className="pov-retest-confirm-copy">
            <AlertTriangle size={16} />
            <div>
              <strong>
                {isEn
                  ? `Updates shipped ${earlyRetestHours}h ago — re-running now will likely stay 0 → 0`
                  : `距离新内容上线仅过去 ${earlyRetestHours} 小时，现在重测大概率仍是 0 → 0`}
              </strong>
              <p>
                {isEn
                  ? 'Search engines and AI answers usually take 3–7 days to index new pages or list PRs.'
                  : '搜索引擎与 AI 索引新推的文档或榜单 PR 通常需要 3～7 天，刚推送不久时复测仍会命中旧缓存。'}
              </p>
            </div>
          </div>
          <div className="pov-retest-confirm-actions">
            <button
              type="button"
              className="pov-secondary-btn"
              onClick={() => setEarlyRetestHours(null)}
            >
              {isEn ? 'Cancel' : '暂不重测'}
            </button>
            <button
              type="button"
              className="pov-secondary-btn"
              onClick={() => {
                setEarlyRetestHours(null);
                void startCollect({
                  engine:
                    selectedEngine === 'chatgpt' || selectedEngine === 'google'
                      ? selectedEngine
                      : 'all',
                  force: true,
                  optimizationRunId: activeOptimizationRunId ?? undefined,
                });
              }}
            >
              <RefreshCw size={13} />
              <span>{isEn ? 'Re-run Anyway' : '仍要立即重测'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Layer 1: Peec Insights-Style 0-Cost Situation Verdict */}
      <section className="pov-insights-hero" aria-label={isEn ? 'AI search situation verdict' : '当前 AI 曝光局势诊断'}>
        <div className="pov-insights-copy">
          <h2>{situationVerdict.headline}</h2>
          <p>{situationVerdict.subline}</p>
        </div>

        <div className="pov-insights-metrics">
          <div className="pov-kpi-pill">
            <span>{isEn ? 'AI Mentions' : 'AI 提及'}</span>
            <strong className={mention.yes > 0 ? 'is-pos' : ''}>
              {sourceOnly
                ? `${officialMetrics.found}/${officialMetrics.completed}`
                : `${mention.yes}/${mention.completed}`}
            </strong>
          </div>
          {!sourceOnly && (
            <div className="pov-kpi-pill">
              <span>{isEn ? 'Official Cited' : '官方引用'}</span>
              <strong className={citation.yes > 0 ? 'is-pos' : ''}>
                {citation.yes}/{citation.completed}
              </strong>
            </div>
          )}
          {discoverySplit.total > 0 && (
            <div className="pov-kpi-pill">
              <span>{isEn ? 'Non-branded' : '非品牌拉新'}</span>
              <strong>
                {discoverySplit.yes}/{discoverySplit.total}
              </strong>
            </div>
          )}
          {brandSplit.total > 0 && (
            <button
              type="button"
              className={`pov-kpi-pill is-btn ${brandSplit.yes === 0 ? 'is-warn' : ''} ${focus === 'brand' ? 'is-active' : ''}`.trim()}
              onClick={() => jumpFocus(focus === 'brand' ? 'all' : 'brand')}
            >
              <span>{isEn ? `Brand "${brandLabel}"` : `搜「${brandLabel}」`}</span>
              <strong>
                {brandSplit.yes}/{brandSplit.total}
              </strong>
            </button>
          )}
          {platformStats.map((item) => (
            <button
              key={item.engine}
              type="button"
              className={`pov-kpi-pill is-btn ${selectedEngine === item.engine ? 'is-active' : ''}`.trim()}
              onClick={() =>
                onFilters({
                  engine: selectedEngine === item.engine ? 'all' : item.engine,
                  kind: 'all',
                  result: 'all',
                })
              }
            >
              <span className="pov-kpi-engine">
                <ResearchEngineIcon engine={item.engine} />
                {getPlatformName(item.engine, isEn)}
              </span>
              <strong>
                {item.yesCount}/{item.totalCount}
              </strong>
            </button>
          ))}
          <button
            type="button"
            className="pov-inline-link pov-insights-comp-link"
            onClick={onCompetitor}
          >
            {t('overview.vsCompetitor')} <ChevronRight size={13} />
          </button>
        </div>
      </section>

      {isColdZeroStage ? (
        <>
          {/* Layer 2: Crisp Monochrome Next Move Bar */}
          {projectOptimization && (
            <div className="pov-optimization-slot">{projectOptimization}</div>
          )}

          {previewOnly && previewComparison && (
            <div className="pov-competitor-slot">{previewComparison}</div>
          )}
          {!previewOnly && (
            <div className="pov-competitor-slot">
              <CompetitorCandidates
                key={`${batch.projectId}:${batch.id}`}
                projectId={batch.projectId}
                batchId={batch.id}
                revision={batch.updatedAt || batch.date}
                language={activeLanguage}
                engine={selectedEngine}
                presentation="overview"
                onOpen={onCompetitor}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {/* Row 1: 3-Card Bento Scoreboard with Symmetric Donut Rings */}
      <section className="pov-bento" aria-label={isEn ? 'Key performance' : '核心表现'}>
        {/* Card 1: AI Mention */}
        <div
          className={`pov-metric-card ${focus === 'missed' || focus === 'mentioned' || focus === 'brand' ? 'is-focused' : ''}`}
        >
          <div
            role="button"
            tabIndex={0}
            className="pov-metric-card-click"
            onClick={() =>
              jumpFocus(
                (sourceOnly ? officialMetrics.found : mention.yes) > 0
                  ? 'mentioned'
                  : 'missed',
              )
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.currentTarget.click();
              }
            }}
          >
            <div className="pov-metric-head">
              <span>
                {sourceOnly ? t('overview.searchAppear') : t('overview.aiMention')}
              </span>
            </div>

            <div className="pov-gauge-row">
              <DonutRing
                yes={sourceOnly ? officialMetrics.found : mention.yes}
                unknown={sourceOnly ? 0 : mention.unknown}
                total={sourceOnly ? officialMetrics.completed : mention.completed}
                centerText={mentionDisplay.ringCenter}
              />
              <div className="pov-gauge-copy">
                <div className="pov-metric-value">
                  {mentionDisplay.qualifier && (
                    <em className="pov-qualifier">{mentionDisplay.qualifier}</em>
                  )}
                  <strong>{mentionDisplay.primary}</strong>
                </div>
                <p className="pov-metric-sub">{mentionDisplay.subline}</p>
              </div>
            </div>
          </div>

          <div className="pov-metric-foot">
            <AnswerPips
              yes={sourceOnly ? officialMetrics.found : mention.yes}
              no={
                sourceOnly
                  ? officialMetrics.completed - officialMetrics.found
                  : mention.no
              }
              unknown={sourceOnly ? 0 : mention.unknown}
            />
            <div className="pov-metric-chips">
              {brandSplit.total > 0 && (
                <button
                  type="button"
                  className={`${mention.yes > 0 && discoverySplit.yes > 0 && brandSplit.yes > 0 ? 'is-yes' : 'is-amber'} ${focus === 'brand' ? 'is-active' : ''}`.trim()}
                  onClick={() => jumpFocus(focus === 'brand' ? 'all' : 'brand')}
                >
                  {mention.yes === 0
                    ? isEn
                      ? `Even "${brandLabel}" wasn't recognized`
                      : `直接搜「${brandLabel}」也未认出`
                    : discoverySplit.yes === 0
                      ? isEn
                        ? `Only on "${brandLabel}" (${brandSplit.yes}/${brandSplit.total})`
                        : `仅在搜「${brandLabel}」时提及 (${brandSplit.yes}/${brandSplit.total})`
                      : isEn
                        ? `Incl. "${brandLabel}" ${brandSplit.yes}/${brandSplit.total}`
                        : `其中直接搜「${brandLabel}」提及 ${brandSplit.yes}/${brandSplit.total}`}
                </button>
              )}
              {!sourceOnly && mention.unknown > 0 && (
                <span className="is-amber">
                  {mention.unknown} {isEn ? 'analyzing' : '分析中'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Card 2: Official Citation */}
        <button
          type="button"
          className={`pov-metric-card ${focus === 'cited' || focus === 'uncertain' ? 'is-focused' : ''}`}
          disabled={sourceOnly}
          onClick={jumpSources}
        >
          <div className="pov-metric-head">
            <span>{t('overview.officialCitation')}</span>
          </div>

          <div className="pov-gauge-row">
            <DonutRing
              yes={sourceOnly ? 0 : citation.yes}
              unknown={sourceOnly ? 0 : citation.unknown}
              total={sourceOnly ? 0 : citation.completed}
              centerText={sourceOnly ? '—' : citationDisplay.ringCenter}
            />
            <div className="pov-gauge-copy">
              <div className="pov-metric-value">
                {sourceOnly ? (
                  <strong className="is-muted">—</strong>
                ) : (
                  <>
                    {citationDisplay.qualifier && (
                      <em className="pov-qualifier">
                        {citationDisplay.qualifier}
                      </em>
                    )}
                    <strong>{citationDisplay.primary}</strong>
                  </>
                )}
              </div>
              <p className="pov-metric-sub">
                {sourceOnly
                  ? (isEn
                      ? 'Switch to an AI answer platform to inspect citation links'
                      : '切换到 AI 回答平台查看参考链接')
                  : citationDisplay.subline}
              </p>
            </div>
          </div>

          <div className="pov-metric-foot">
            {!sourceOnly && (
              <AnswerPips
                yes={citation.yes}
                no={citation.no}
                unknown={citation.unknown}
              />
            )}
            <div className="pov-metric-chips">
              {sourceOnly ? (
                <span>
                  {isEn
                    ? 'Web search results do not track AI answer citations'
                    : '网页搜索结果不统计回答引用'}
                </span>
              ) : (
                <>
                  <span className={citation.yes > 0 ? 'is-yes' : ''}>
                    {citation.yes} {isEn ? 'cited' : '已引用'}
                  </span>
                  <span>
                    {citation.no} {isEn ? 'not cited' : '未引用'}
                  </span>
                  {citation.unknown > 0 && (
                    <span className="is-amber">
                      {citation.unknown} {isEn ? 'analyzing' : '分析中'}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </button>

        {/* Card 3: Platform Breakdown with Colorful Brand Icons */}
        <div className="pov-platform-card">
          <div className="pov-metric-head">
            <span>{t('overview.platformBreakdown')}</span>
            <button
              type="button"
              className="pov-head-link pov-inline-link"
              onClick={onCompetitor}
            >
              {t('overview.vsCompetitor')} <ChevronRight size={13} />
            </button>
          </div>

          <div className="pov-platform-rows">
            {platformStats.map((item) => {
              const active = selectedEngine === item.engine;
              const widthPct =
                item.totalCount > 0
                  ? Math.round((item.yesCount / item.totalCount) * 100)
                  : 0;
              return (
                <button
                  key={item.engine}
                  type="button"
                  className={`pov-platform-row ${active ? 'is-selected' : ''}`}
                  onClick={() =>
                    onFilters({
                      engine: active ? 'all' : item.engine,
                      kind: 'all',
                      result: 'all',
                    })
                  }
                >
                  <span className="pov-platform-name">
                    <span className="pov-row-brand-icon">
                      <ResearchEngineIcon engine={item.engine} />
                    </span>
                    {getPlatformName(item.engine, isEn)}
                  </span>
                  <span className="pov-platform-track" aria-hidden="true">
                    <span style={{ width: `${widthPct}%` }} />
                  </span>
                  <span className="pov-platform-stat">
                    <em>
                      {item.yesCount}/{item.totalCount}
                    </em>
                    <strong>
                      {item.rate !== null
                        ? pct(item.rate)
                        : item.unknownCount > 0
                          ? (isEn ? 'Pend' : '待核')
                          : '—'}
                    </strong>
                  </span>
                </button>
              );
            })}
          </div>
          {unmeasuredConsumerEngines.length > 0 && (
            <button
              type="button"
              className="pov-unmeasured-note"
              disabled={startingCollect || collectJob?.status === 'running'}
              onClick={() =>
                void startCollect({
                  engine:
                    unmeasuredConsumerEngines.length === 1
                      ? unmeasuredConsumerEngines[0]
                      : 'all',
                })
              }
            >
              <span>
                {t('overview.unmeasuredPlatforms', {
                  platforms: unmeasuredConsumerEngines
                    .map((e) => getPlatformName(e, isEn))
                    .join(' · '),
                })}
              </span>
              <ArrowRight size={12} />
            </button>
          )}
        </div>
      </section>

      {/* Restored Competitor Reference Card */}
      {previewOnly && previewComparison && (
        <div className="pov-competitor-slot">{previewComparison}</div>
      )}
      {!previewOnly && (
        <div className="pov-competitor-slot">
          <CompetitorCandidates
            key={`${batch.projectId}:${batch.id}`}
            projectId={batch.projectId}
            batchId={batch.id}
            revision={batch.updatedAt || batch.date}
            language={activeLanguage}
            engine={selectedEngine}
            presentation="overview"
            onOpen={onCompetitor}
          />
        </div>
      )}

      {/* Row 2: Human-Guided Next-Step Optimization Card */}
      {projectOptimization && (
        <div className="pov-optimization-slot">{projectOptimization}</div>
      )}
        </>
      )}

      {/* Layer 3: Top-3 Collapsible Priority Questions + Colorful Platform Tile Matrix (Above the Fold) */}
      <section
        className="pov-questions"
        ref={questionSectionRef}
        aria-label={t('overview.buyerQuestions')}
      >
        <div className="pov-section-bar">
          <div className="pov-section-title">
            <h2>{t('overview.buyerQuestions')}</h2>
          </div>

          <div className="pov-section-tools">
            <div
              className="pov-filter-pills"
              role="tablist"
              aria-label={t('overview.buyerQuestions')}
            >
              <button
                type="button"
                role="tab"
                aria-selected={focus === 'all'}
                onClick={() => setFocus('all')}
              >
                {t('overview.filterAll')} <span>{allQuestions.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={focus === 'missed'}
                onClick={() => setFocus('missed')}
              >
                {t('overview.filterMissed')} <span>{missedCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={focus === 'mentioned'}
                onClick={() => setFocus('mentioned')}
              >
                {t('overview.filterMentioned')} <span>{mentionedCount}</span>
              </button>
              {!sourceOnly && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={focus === 'cited'}
                  onClick={() => setFocus('cited')}
                >
                  {t('overview.filterCited')} <span>{citedCount}</span>
                </button>
              )}
              {brandQuestionCount > 0 && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={focus === 'brand'}
                  onClick={() => setFocus('brand')}
                >
                  {isEn ? 'Brand' : `搜「${brandLabel}」`} <span>{brandQuestionCount}</span>
                </button>
              )}
            </div>

            <button
              type="button"
              className="pov-inline-link"
              onClick={onQuestions}
            >
              {t('overview.manageQuestions')} <ArrowRight size={13} />
            </button>
          </div>
        </div>

        {displayedQuestions.length === 0 ? (
          <div className="pov-filter-empty">
            <span>{t('overview.filterEmpty')}</span>
            <button type="button" onClick={() => setFocus('all')}>
              {t('overview.filterShowAll')}
            </button>
          </div>
        ) : (
          <>
            <div className="pov-matrix">
              {displayedQuestions.map((question) => {
                const categoryLabel = isBrandPrompt(question, project?.name)
                  ? t('overview.catBrand')
                  : question.category
                    ? t(categoryMessageKeys[question.category])
                    : null;

                const tileItems = matrixEngines.map((engine) => {
                  const cellRow = allEngineRows.find(
                    (r) =>
                      r.question.id === question.id && r.engine === engine,
                  );
                  return {
                    engine,
                    ...describeTileStatus(cellRow, isEn),
                  };
                });

                const searchedCount = tileItems.filter(
                  (item) => item.state !== 'unmeasured',
                ).length;
                const hitCount = tileItems.filter(
                  (item) => item.state === 'found',
                ).length;
                const qWinners =
                  searchedCount > 0 && hitCount === 0
                    ? extractQuestionTopWinners(
                        question,
                        matrixEngines,
                        project,
                        activeLanguage,
                        3,
                      )
                    : [];

                return (
                  <div key={question.id} className="pov-matrix-row">
                    <button
                      type="button"
                      className="pov-q-main"
                      onClick={() =>
                        onQuestion(
                          question,
                          allPlatforms
                            ? undefined
                            : (selectedEngine as ResearchEngine),
                        )
                      }
                    >
                      <div className="pov-q-heading">
                        {categoryLabel && (
                          <span className="pov-q-cat">{categoryLabel}</span>
                        )}
                        <span className="pov-q-text">
                          {question[activeLanguage] || question.en || question.zh}
                        </span>
                      </div>
                      {qWinners.length > 0 && (
                        <div className="pov-q-winners">
                          <span>{isEn ? 'AI cited:' : 'AI 引用了：'}</span>
                          <b>{qWinners.map((w) => w.label).join(' · ')}</b>
                        </div>
                      )}
                    </button>

                    {/* Proud Platform Icon-Badge Matrix + Hit Counter */}
                    <div className="pov-tile-group">
                      <div className="pov-tile-icons">
                        {tileItems.map((item) => (
                          <button
                            key={item.engine}
                            type="button"
                            className={`pov-platform-tile is-${item.state}`}
                            aria-label={`${getPlatformName(item.engine, isEn)} · ${item.statusText}`}
                            onClick={() => onQuestion(question, item.engine)}
                          >
                            <ResearchEngineIcon engine={item.engine} />
                            <span
                              className="pov-tile-badge"
                              aria-hidden="true"
                            >
                              {item.state === 'found' ? (
                                <Check size={10} strokeWidth={2.8} />
                              ) : item.state === 'absent' ? (
                                <X size={10} strokeWidth={2.5} />
                              ) : item.state === 'pending' ? (
                                <b>?</b>
                              ) : (
                                <Minus size={10} strokeWidth={2.5} />
                              )}
                            </span>
                            <span
                              className="pov-tile-tooltip"
                              role="tooltip"
                            >
                              <strong>{getPlatformName(item.engine, isEn)}</strong>
                              <span>
                                {item.statusText}
                                {item.dateText ? ` · ${item.dateText}` : ''}
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>

                      <button
                        type="button"
                        className={`pov-tile-total ${hitCount > 0 ? 'has-found' : ''}`}
                        title={
                          isEn
                            ? `${searchedCount} platforms tested, ${hitCount} mentioned you`
                            : `已测 ${searchedCount} 个平台，${hitCount} 个提到你`
                        }
                        onClick={() =>
                          onQuestion(
                            question,
                            allPlatforms
                              ? undefined
                              : (selectedEngine as ResearchEngine),
                          )
                        }
                      >
                        <strong>{searchedCount ? hitCount : '—'}</strong>
                        <span>/ {searchedCount}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {focus === 'all' &&
              filteredQuestions.length > DEFAULT_VISIBLE_QUESTIONS && (
                <button
                  type="button"
                  className="pov-expand-bar"
                  onClick={() => setExpandedQuestions((v) => !v)}
                >
                  {expandedQuestions ? (
                    <>
                      {t('overview.collapseQuestions', {
                        count: DEFAULT_VISIBLE_QUESTIONS,
                      })}
                      <ChevronUp size={15} />
                    </>
                  ) : (
                    <>
                      {t('overview.expandRemaining', {
                        hidden: hiddenQuestionCount,
                        total: filteredQuestions.length,
                      })}
                      <ChevronDown size={15} />
                    </>
                  )}
                </button>
              )}
          </>
        )}
      </section>

      {/* Layer 4: External Pages AI Cites Without You (Plain-Language Listing Opportunities) */}
      {overviewGapSources.length > 0 && (
        <section
          className="pov-gap-card"
          aria-labelledby="pov-gap-heading"
        >
          <div className="pov-section-bar">
            <div className="pov-section-title pov-gap-title-wrap">
              <h2 id="pov-gap-heading">
                {isEn
                  ? 'External pages AI cites without you'
                  : 'AI 引用但尚未收录你的外部页面'}
              </h2>
              <span className="pov-gap-sub">
                {isEn
                  ? 'Already cited by AI answers — submit a listing PR to open-source directories or join cited discussions'
                  : '这些外部清单与讨论帖已被 AI 回答直接引用——可向开源导航清单提 PR 申请收录，或参与社区讨论'}
              </span>
            </div>
            <div className="pov-section-tools">
              <button
                type="button"
                className="pov-inline-link"
                onClick={() => void onPlan?.()}
              >
                {isEn ? 'Open Action Plan' : '查看全部优化方案'} <ArrowRight size={13} />
              </button>
            </div>
          </div>

          <div
            className="pov-gap-table-wrap"
            tabIndex={0}
            role="region"
            aria-labelledby="pov-gap-heading"
          >
            <table
              className="pov-gap-table"
              style={
                {
                  '--col-type': JSON.stringify(isEn ? 'Type' : '类型'),
                  '--col-engines': JSON.stringify(isEn ? 'Engines' : '引用平台'),
                  '--col-prompts': JSON.stringify(isEn ? 'Prompts' : '出现题数'),
                  '--col-action': JSON.stringify(isEn ? 'Next move' : '推荐动作'),
                } as React.CSSProperties
              }
            >
              <thead>
                <tr>
                  <th scope="col">{isEn ? 'Source URL / Repo' : '页面 / 仓库'}</th>
                  <th scope="col">{isEn ? 'Type' : '类型'}</th>
                  <th scope="col">{isEn ? 'Engines' : '引用平台'}</th>
                  <th scope="col" className="is-num">
                    {isEn ? 'Prompts' : '出现题数'}
                  </th>
                  <th scope="col" className="is-action">
                    {isEn ? 'Next move' : '推荐动作'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {overviewGapSources.map((src) => (
                  <tr key={src.key}>
                    <th scope="row">
                      <a
                        href={src.url}
                        target="_blank"
                        rel="noreferrer"
                        className="pov-gap-source-link"
                      >
                        <strong>{src.title}</strong>
                        <span>
                          {src.subtitle === 'web'
                            ? isEn
                              ? 'Cited web page'
                              : 'AI 引用网页'
                            : src.subtitle}
                        </span>
                      </a>
                    </th>
                    <td>
                      <span className={`pov-gap-badge is-${src.kind}`}>
                        {gapKindLabel(src.kind)}
                      </span>
                    </td>
                    <td>
                      <div className="pov-gap-engines">
                        {src.engines.map((eng) => (
                          <span
                            key={eng}
                            className="pov-gap-engine-dot"
                            title={getPlatformName(eng, isEn)}
                          >
                            <ResearchEngineIcon engine={eng} />
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="is-num">
                      <span className="pov-gap-count">
                        {src.questionCount}
                        {isEn ? 'q' : ' 题'}
                      </span>
                    </td>
                    <td className="is-action">
                      {src.actionHint === 'submit_pr' ? (
                        <button
                          type="button"
                          className="pov-gap-action-btn is-primary"
                          onClick={() => void onPlan?.()}
                        >
                          <GitPullRequest size={12} />
                          <span>{isEn ? 'Submit listing PR' : '提 PR 申请收录'}</span>
                        </button>
                      ) : src.actionHint === 'community_draft' ? (
                        <button
                          type="button"
                          className="pov-gap-action-btn"
                          onClick={() => void onPlan?.()}
                        >
                          <MessageSquarePlus size={12} />
                          <span>{isEn ? 'Draft note' : '去发声'}</span>
                        </button>
                      ) : (
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noreferrer"
                          className="pov-gap-action-btn"
                        >
                          <span>{isEn ? 'Inspect' : '查看'}</span>
                          <ExternalLink size={11} />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

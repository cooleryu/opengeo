'use client';

import { useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Layers3,
  Minus,
  Terminal,
  X,
} from 'lucide-react';
import { resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import type { QuestionCategory } from '@/lib/geo/question-types';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
  ResearchSource,
} from '@/lib/geo/research-types';
import {
  getResearchMetrics,
  getResearchRows,
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
import { getBatchResearchEngines, RESEARCH_ENGINES } from '@/lib/geo/research-engines';
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
  zh: { yes: '已提及', no: '未提及', unknown: '待核实' },
  en: { yes: 'Mentioned', no: 'Not mentioned', unknown: 'Pending' },
} as const;

function getPlatformName(engine: ResearchEngine, isEn: boolean): string {
  if (engine === 'chatgpt') return 'ChatGPT';
  if (engine === 'google') return 'Google';
  if (engine === 'deepseek') return 'DeepSeek';
  if (engine === 'qwen') return isEn ? 'Qwen' : '千问';
  return isEn ? 'Doubao' : '豆包';
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
        ? 'Only visible links were captured in this run; full platform citation metadata is not yet verified.'
        : '本次采集仅保存了页面可见链接，尚未获取可确证的平台原生引用清单，是否附上你的官网链接暂待核实。';
    }
    if (kind === 'citation' && verdict === 'no') {
      return isEn
        ? 'Verified full platform citation list: no link pointing to your site or repository was found.'
        : '已核对完整平台原生引用清单，未发现指向你官网或仓库的链接。';
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
      return 'Brand mention verification is still pending for this answer.';
    }
    if (verdict === 'no') {
      return 'Verified full platform citation list: no link pointing to your site or repository was found.';
    }
    if (verdict === 'yes') {
      return 'Confirmed a direct citation link pointing to your official site or repository.';
    }
    return 'Only visible links were captured in this run; full platform citation metadata is not yet verified.';
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
              : (isEn ? 'Pending' : '待核实')}
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
        ? `${metric.yes} of ${metric.completed} ${positiveVerb} (${metric.unknown} pending)`
        : `${metric.completed} 条回答里 ${metric.yes} 条${positiveVerb}（${metric.unknown} 条待核实）`,
      ringCenter: `${metric.yes}/${metric.completed}`,
    };
  }
  const verifiedNo = metric.yes + metric.no;
  if (verifiedNo === 0) {
    const unknownReason = isEn
      ? metricKind === 'citation'
        ? `${metric.unknown} answers pending source link verification`
        : `${metric.unknown} answers pending verification`
      : metricKind === 'citation'
        ? `${metric.unknown} 条回答尚未核实原生引用`
        : `${metric.unknown} 条回答尚未完成审核`;
    return {
      primary: isEn ? 'Pending' : '待核实',
      subline: unknownReason,
      ringCenter: isEn ? 'Pend' : '待核',
    };
  }
  return {
    primary: '0%',
    subline: isEn
      ? `${verifiedNo} verified not found · ${metric.unknown} pending`
      : `${verifiedNo} 条确认未见 · ${metric.unknown} 条待核实`,
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
  return { state: 'pending', statusText: isEn ? 'Pending answer review' : '待核实回答内容', dateText: rawDate };
}

type Props = {
  projectOptimization?: ReactNode;
  project?: Pick<GeoProject, 'siteUrl' | 'repositoryUrl' | 'targetLanguage'>;
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
  onAssets?: () => void;
  onPlan?: (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine: ResearchEngine,
  ) => Promise<void>;
};

type FocusFilter = 'all' | 'missed' | 'mentioned' | 'cited' | 'uncertain';
const DEFAULT_VISIBLE_QUESTIONS = 3;

export default function ProjectOverview({
  projectOptimization,
  project,
  previewOnly = false,
  previewComparison,
  batch,
  filters,
  onFilters,
  onQuestion,
  onCompetitor,
  onQuestions,
}: Props) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [copiedCmd, setCopiedCmd] = useState(false);
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
  const questionSectionRef = useRef<HTMLElement>(null);

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

  const missedCount = allQuestions.filter(questionHasMiss).length;
  const mentionedCount = allQuestions.filter(questionHasMention).length;
  const citedCount = allQuestions.filter(questionHasCitation).length;

  const filteredQuestions = allQuestions
    .filter((q) => {
      if (focus === 'missed') return questionHasMiss(q);
      if (focus === 'mentioned') return questionHasMention(q);
      if (focus === 'cited') return questionHasCitation(q);
      if (focus === 'uncertain') return questionHasUncertain(q);
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

  if (!availableEngines.length) {
    const collectCommand = `npm run collect -- --project ${batch.projectId}`;
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
          <div className="pov-command-box">
            <div className="pov-command-code">
              <Terminal size={15} aria-hidden="true" />
              <code>{collectCommand}</code>
            </div>
            <button
              type="button"
              className="pov-primary-btn"
              onClick={copyCollectCommand}
            >
              {copiedCmd ? <Check size={15} /> : <Copy size={15} />}
              {copiedCmd
                ? t('overview.copiedCommand')
                : t('overview.copyCommand')}
            </button>
          </div>
          {batch.questions.length > 0 && (
            <ol className="pov-empty-questions">
              {batch.questions.slice(0, 8).map((q) => (
                <li key={q.id}>
                  <span className="pov-q-cat">
                    {q.category ? t(categoryMessageKeys[q.category]) : t('overview.catProblem')}
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

  return (
    <div className="pov-shell">
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

      {/* Row 1: 3-Card Bento Scoreboard with Symmetric Donut Rings */}
      <section className="pov-bento" aria-label={isEn ? 'Key performance' : '核心表现'}>
        {/* Card 1: AI Mention */}
        <button
          type="button"
          className={`pov-metric-card ${focus === 'missed' || focus === 'mentioned' ? 'is-focused' : ''}`}
          onClick={() =>
            jumpFocus(
              (sourceOnly ? officialMetrics.found : mention.yes) > 0
                ? 'mentioned'
                : 'missed',
            )
          }
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
              {sourceOnly ? (
                <>
                  <span className={officialMetrics.found > 0 ? 'is-yes' : ''}>
                    {officialMetrics.found} {isEn ? 'found' : '已出现'}
                  </span>
                  <span>
                    {officialMetrics.completed - officialMetrics.found} {isEn ? 'absent' : '未出现'}
                  </span>
                </>
              ) : (
                <>
                  <span className={mention.yes > 0 ? 'is-yes' : ''}>
                    {mention.yes} {isEn ? 'mentioned' : '已提及'}
                  </span>
                  <span>
                    {mention.no} {isEn ? 'missed' : '未提及'}
                  </span>
                  {mention.unknown > 0 && (
                    <span className="is-amber">
                      {mention.unknown} {isEn ? 'pending' : '待核实'}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </button>

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
                      {citation.unknown} {isEn ? 'pending' : '待核实'}
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
          {availableEngines.length < RESEARCH_ENGINES.length && (
            <button
              type="button"
              className="pov-unmeasured-note"
              onClick={onQuestions}
            >
              <span>
                {t('overview.unmeasuredPlatforms', {
                  platforms: RESEARCH_ENGINES.filter(
                    (e) => !availableEngines.includes(e),
                  )
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

      {/* Row 3: Top-3 Collapsible Priority Questions + Colorful Platform Tile Matrix */}
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
                const categoryLabel = question.category
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
    </div>
  );
}

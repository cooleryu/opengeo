'use client';

import type { ReactNode } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type {
  CompetitorCandidate,
  CompetitorCandidates,
  CompetitorComparison,
} from '@/lib/geo/competitor-types';
import type { MetricSummary } from '@/lib/geo/overview-metrics';
import type { ResearchEngine } from '@/lib/geo/research-types';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import { comparableCompetitorMention } from '@/lib/geo/competitor-presentation';
import { useUiLanguage } from './UiLanguageContext';
import './overview-competitor-card.css';

type Props = {
  data: CompetitorCandidates;
  comparison?: CompetitorComparison;
  candidate?: CompetitorCandidate;
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  pending: string | null;
  status: ReactNode;
  onSelect: (candidate: CompetitorCandidate) => void;
  onOpen?: () => void;
};

function percent(value: number) {
  return `${Number(value.toFixed(1))}%`;
}

function directAnswerRate(metric?: MetricSummary): number | null {
  if (!metric || metric.rate === null || metric.completed <= 0) return null;
  return (metric.yes / metric.completed) * 100;
}

function MentionValue({
  name,
  metric,
  isEn,
}: {
  name: string;
  metric?: MetricSummary;
  isEn: boolean;
}) {
  const rate = directAnswerRate(metric);
  if (!metric || rate === null) return null;
  const value = percent(rate);
  return (
    <div className="oc-mention-value">
      <dt data-i18n-skip="">{name}</dt>
      <dd>
        <strong>{value}</strong>
        <span>
          {isEn
            ? `${metric.yes} / ${metric.completed} answers`
            : `${metric.yes} / ${metric.completed} 条回答提及`}
        </span>
      </dd>
    </div>
  );
}

function gapReason(own: MetricSummary, target: MetricSummary, isEn: boolean) {
  const ownRate = directAnswerRate(own) ?? own.rate!;
  const targetRate = directAnswerRate(target) ?? target.rate!;
  const gap = targetRate - ownRate;
  const pts = Number(Math.abs(gap).toFixed(1));
  if (gap === 0) {
    return isEn
      ? 'Your mention rate matches this competitor on this prompt set.'
      : '在这组问题中，你们的提及率相同。';
  }
  return isEn
    ? `Your mention rate is ${pts} percentage points ${gap > 0 ? 'behind' : 'ahead'} on this prompt set.`
    : `在这组问题中，你的提及率${gap > 0 ? '落后' : '领先'} ${pts} 个百分点。`;
}

export default function OverviewCompetitorCard({
  data,
  comparison,
  candidate,
  language,
  engine,
  pending,
  status,
  onSelect,
  onOpen,
}: Props) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const selected = !!data.target;
  const displayedCandidate = selected ? data.selectedCandidate : candidate;
  const name = data.target?.name || displayedCandidate?.name;
  const performance = selected
    ? comparison?.performance || displayedCandidate?.performance
    : displayedCandidate?.performance;
  const comparisonScope = comparableCompetitorMention(performance, language, engine);
  const mention = comparisonScope?.metric;
  const measuredAt = comparisonScope?.scope.measuredAt;
  const date = measuredAt ? new Date(measuredAt) : null;
  const recommendation = data.ranking?.scope.language === language && data.ranking.scope.engine === engine
    ? displayedCandidate?.recommendation : undefined;
  // No unreviewed candidate is promoted by its position in an internal list.
  if (!selected && !recommendation?.evidence) return null;
  const reason = selected && mention
    ? gapReason(mention.own, mention.target, isEn)
    : recommendation?.evidence
      ? isEn
        ? `${RESEARCH_ENGINE_NAMES[recommendation.evidence.engine]} mentioned it in "${recommendation.evidence.question}".`
        : `${RESEARCH_ENGINE_NAMES[recommendation.evidence.engine]} 在「${recommendation.evidence.question}」的回答中提到了它。`
      : displayedCandidate?.analysis?.reason || '';
  const description = displayedCandidate?.analysis?.description || displayedCandidate?.description;

  return (
    <section
      className={`oc-card${selected ? ' has-target' : ''}${mention ? '' : ' without-comparison'}`}
      aria-label={
        selected
          ? isEn
            ? 'Benchmark competitor'
            : '当前参照竞品'
          : isEn
            ? 'Competitor candidate'
            : '参照竞品候选'
      }
    >
      {name ? (
        <div className="oc-main">
          <div className="oc-identity">
            <span className="oc-label">
              {selected ? (
                <>
                  <Check size={12} />
                  {isEn ? 'Benchmark' : '当前参照'}
                </>
              ) : isEn ? (
                'Suggested benchmark'
              ) : (
                '推荐参照'
              )}
            </span>
            <h2 data-i18n-skip="">{name}</h2>
            {description && <p className="oc-description">{description}</p>}
            <p className="oc-reason">{reason}</p>
          </div>
          {mention && comparisonScope && (
            <div
              className="oc-performance"
              aria-label={
                isEn ? 'Measured AI mention comparison' : '双方实测 AI 提及率'
              }
            >
              <div className="oc-scope">
                <span>
                  {isEn ? 'AI mention rate · ' : 'AI 提及率 · '}
                  {language === 'zh'
                    ? isEn
                      ? 'Chinese'
                      : '中文'
                    : isEn
                      ? 'English'
                      : '英文'}{' '}
                  ·{' '}
                  {comparisonScope.engine === 'all'
                    ? isEn
                      ? 'All platforms'
                      : '全部平台'
                    : RESEARCH_ENGINE_NAMES[comparisonScope.engine]}
                </span>
                {date && Number.isFinite(date.getTime()) && (
                  <time dateTime={measuredAt}>
                    {date.toLocaleDateString(isEn ? 'en-US' : 'zh-CN', {
                      month: 'numeric',
                      day: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </time>
                )}
              </div>
              <dl className="oc-mentions">
                <MentionValue
                  name={
                    performance?.ownName ||
                    comparison?.own.name ||
                    (isEn ? 'You' : '我们')
                  }
                  metric={mention?.own}
                  isEn={isEn}
                />
                <MentionValue name={name} metric={mention?.target} isEn={isEn} />
              </dl>
            </div>
          )}
          <div className="oc-actions">
            {!selected && displayedCandidate && (
              <button
                type="button"
                className="cc-button primary"
                disabled={!!pending}
                onClick={() => onSelect(displayedCandidate)}
              >
                {pending === displayedCandidate.id
                  ? isEn
                    ? 'Saving…'
                    : '正在保存…'
                  : isEn
                    ? 'Set as benchmark'
                    : '以它为参照'}
                <ArrowRight size={13} />
              </button>
            )}
            {onOpen && (
              <button type="button" className="cx-text-button" onClick={onOpen}>
                {isEn ? 'View details' : '查看详情'} <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="oc-empty">
          <h2>{isEn ? 'Benchmark competitor' : '参照竞品'}</h2>
          {data.analysis.status === 'ready' && !data.analysis.stale && (
            <p>
              {isEn
                ? 'Not enough captured answers yet to recommend a benchmark competitor.'
                : '当前搜索依据还不足以推荐参照竞品。'}
            </p>
          )}
          {onOpen && (
            <button type="button" className="cx-text-button" onClick={onOpen}>
              {isEn ? 'View details' : '查看详情'} <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
      {!name && status}
    </section>
  );
}

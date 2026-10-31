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

function MentionValue({
  name,
  metric,
}: {
  name: string;
  metric?: MetricSummary;
}) {
  if (!metric || metric.rate === null) return null;
  const value = percent(metric.rate);
  return (
    <div className="oc-mention-value">
      <dt>{name}</dt>
      <dd>
        <strong>
          {value}
        </strong>
        <span>
          {metric.yes} / {metric.completed} 条回答提及
        </span>
      </dd>
    </div>
  );
}

function gapReason(own: MetricSummary, target: MetricSummary) {
  const gap = target.rate! - own.rate!;
  return gap === 0
    ? '在这组问题中，你们的提及率相同。'
    : `在这组问题中，你的提及率${gap > 0 ? '落后' : '领先'} ${Number(Math.abs(gap).toFixed(1))} 个百分点。`;
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
    ? gapReason(mention.own, mention.target)
    : recommendation?.evidence
      ? `${RESEARCH_ENGINE_NAMES[recommendation.evidence.engine]} 在「${recommendation.evidence.question}」的回答中提到了它。`
      : displayedCandidate?.analysis?.reason || '';
  const description = displayedCandidate?.analysis?.description || displayedCandidate?.description;

  return (
    <section
      className={`oc-card${selected ? ' has-target' : ''}${mention ? '' : ' without-comparison'}`}
      aria-label={selected ? '当前参照竞品' : '参照竞品候选'}
    >
      {name ? (
        <div className="oc-main">
          <div className="oc-identity">
            <span className="oc-label">
              {selected ? (
                <>
                  <Check size={12} />
                  当前参照
                </>
              ) : '推荐参照'}
            </span>
            <h2>{name}</h2>
            {description && <p className="oc-description">{description}</p>}
            <p className="oc-reason">{reason}</p>
          </div>
          {mention && comparisonScope && <div className="oc-performance" aria-label="双方实测 AI 提及率">
            <div className="oc-scope">
              <span>
                AI 提及率 · {language === 'zh' ? '中文' : '英文'} ·{' '}
                {comparisonScope.engine === 'all' ? '全部平台' : RESEARCH_ENGINE_NAMES[comparisonScope.engine]}
              </span>
              {date && Number.isFinite(date.getTime()) && (
                <time dateTime={measuredAt}>
                  {date.toLocaleDateString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                  })}
                </time>
              )}
            </div>
            <dl className="oc-mentions">
              <MentionValue
                name={performance?.ownName || comparison?.own.name || '我们'}
                metric={mention?.own}
              />
              <MentionValue name={name} metric={mention?.target} />
            </dl>
          </div>}
          <div className="oc-actions">
            {!selected && displayedCandidate && (
              <button
                type="button"
                className="cc-button primary"
                disabled={!!pending}
                onClick={() => onSelect(displayedCandidate)}
              >
                {pending === displayedCandidate.id ? '正在保存…' : '以它为参照'}
                <ArrowRight size={13} />
              </button>
            )}
            {onOpen && (
              <button type="button" className="cx-text-button" onClick={onOpen}>
                查看详情 <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="oc-empty">
          <h2>参照竞品</h2>
          {data.analysis.status === 'ready' && !data.analysis.stale && (
            <p>当前搜索依据还不足以推荐参照竞品。</p>
          )}
          {onOpen && (
            <button type="button" className="cx-text-button" onClick={onOpen}>
              查看详情 <ArrowRight size={13} />
            </button>
          )}
        </div>
      )}
      {!name && status}
    </section>
  );
}

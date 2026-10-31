import { ChevronDown } from 'lucide-react';
import type { CompetitorPerformanceData } from '@/lib/geo/competitor-types';
import type { MetricSummary } from '@/lib/geo/overview-metrics';
import type { ResearchEngine } from '@/lib/geo/research-types';
import { RESEARCH_ENGINE_NAMES } from '@/lib/geo/research-engines';
import { comparableCompetitorMention } from '@/lib/geo/competitor-presentation';
import './competitor-performance.css';

type Props = {
  performance?: CompetitorPerformanceData;
  ownName?: string;
  targetName: string;
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  verifiedOnly?: boolean;
};

function percent(value: number) {
  return `${Number(value.toFixed(1))}%`;
}

function MetricValue({
  metric,
  side,
  limitations,
  showPending = true,
}: {
  metric: MetricSummary;
  side: 'own' | 'target';
  limitations?: string[];
  showPending?: boolean;
}) {
  const measured = metric.completed > 0;
  const exact = measured && metric.rate !== null;
  const lowerBound =
    measured && !exact && (metric.minimumRate ?? 0) > 0
      ? metric.minimumRate
      : null;
  const value = exact ? metric.rate : lowerBound;
  const label = !measured
    ? '未测'
    : exact
      ? percent(metric.rate!)
      : lowerBound !== null
        ? `至少 ${percent(lowerBound)}`
        : '待核实';
  return (
    <div role="cell" className={`cp-value is-${side}`}>
      <strong className={value === null ? 'is-unresolved' : undefined}>
        {label}
      </strong>
      <div
        className={`cp-track${value === null ? ' is-unresolved' : ''}${lowerBound !== null ? ' is-lower-bound' : ''}`}
        aria-hidden="true"
      >
        {value !== null && (
          <i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
        )}
      </div>
      <p>
        {measured
          ? `${metric.yes} / ${metric.completed} 条确认命中`
          : '尚无已测记录'}
        {metric.unknown > 0 && <span> · {metric.unknown} 条待核实</span>}
        {showPending && metric.unmeasured > 0 && <span> · {metric.unmeasured} 条未测</span>}
      </p>
      {metric.unknown > 0 && !!limitations?.length && (
        <details className="cp-citation-limitations">
          <summary>为什么还无法判断？</summary>
          {limitations.map((reason) => <p key={reason}>{reason}</p>)}
        </details>
      )}
    </div>
  );
}

function difference(own: MetricSummary, target: MetricSummary) {
  if (
    !own.completed ||
    !target.completed ||
    own.rate === null ||
    target.rate === null
  )
    return null;
  const gap = own.rate - target.rate;
  if (gap === 0) return '双方持平';
  return `我们${gap > 0 ? '领先' : '落后'} ${Number(Math.abs(gap).toFixed(1))} 个百分点`;
}

export default function CompetitorPerformance({
  performance,
  ownName,
  targetName,
  language,
  engine,
  verifiedOnly = false,
}: Props) {
  const comparison = verifiedOnly ? comparableCompetitorMention(performance, language, engine) : null;
  const displayEngine = comparison?.engine || engine;
  const scope = comparison?.scope || performance?.scopes[`${language}:${engine}`];
  const metrics = verifiedOnly ? scope?.metrics.filter((metric) =>
    metric.own.rate !== null && metric.target.rate !== null && metric.own.unknown === 0 && metric.target.unknown === 0 &&
    metric.own.completed > 0 && metric.own.completed === metric.target.completed && metric.own.questions === metric.target.questions,
  ) : scope?.metrics;
  const measuredAt = scope?.measuredAt;
  const date = measuredAt ? new Date(measuredAt) : null;
  if (verifiedOnly && !metrics?.length) return null;
  return (
    <section className="cp-performance" aria-label="双方实测表现对比">
      <div className="cp-heading">
        <h4>实测表现{verifiedOnly && ` · ${displayEngine === 'all' ? '全部平台' : RESEARCH_ENGINE_NAMES[displayEngine]} · ${language === 'zh' ? '中文' : '英文'}`}</h4>
        {date && Number.isFinite(date.getTime()) && (
          <time dateTime={measuredAt}>
            截至{' '}
            {date.toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        )}
      </div>
      <div role="table" aria-label="同题实测指标" className="cp-table">
        <div role="row" className="cp-table-heading">
          <span role="columnheader">指标</span>
          <div role="columnheader" className="cp-identity is-own">
            <span>我们</span>
            <strong>{performance?.ownName || ownName || '我方'}</strong>
          </div>
          <div role="columnheader" className="cp-identity is-target">
            <span>竞品</span>
            <strong>{performance?.targetName || targetName}</strong>
          </div>
        </div>
        {metrics?.length ? (
          metrics.map((metric) => {
            const gap = difference(metric.own, metric.target);
            return (
              <div role="row" className="cp-metric-row" key={metric.id}>
                <div role="rowheader" className="cp-metric-name">
                  <strong>{metric.label}</strong>
                  {gap && <span>{gap}</span>}
                </div>
                <MetricValue metric={metric.own} side="own" showPending={!verifiedOnly} />
                <MetricValue metric={metric.target} side="target" limitations={metric.targetLimitations} showPending={!verifiedOnly} />
              </div>
            );
          })
        ) : (
          <div role="row" className="cp-metric-row cp-performance-empty">
            <span role="rowheader">当前范围</span>
            <strong role="cell">未测</strong>
            <strong role="cell">未测</strong>
          </div>
        )}
      </div>
      <details className="cp-method">
        <summary>
          数据口径
          <ChevronDown size={12} />
        </summary>
        <p>
          {language === 'zh' ? '中文' : '英文'} ·{' '}
          {displayEngine === 'all' ? '全部平台' : RESEARCH_ENGINE_NAMES[displayEngine]}。
          与概览使用相同的最近已存结果，先在每题内计算，再对问题等权平均。计数为回答或搜索结果的实测条数。
        </p>
        <p>
          AI
          提及与官方引用分别统计；竞品提及核对已保存完整正文中的名称或官方入口。官方引用须出现在平台原生引用中，且链接属于该竞品；仅出现在搜索来源或正文中的普通网址不算引用。Google
          搜索和 DeepSeek 来源命中不计入 AI 提及率。
        </p>
        <p>
          未测不记零，待核实保留在已测分母中。“至少”是确认命中的下限；仅双方比例都已核实时显示差值。
        </p>
      </details>
    </section>
  );
}

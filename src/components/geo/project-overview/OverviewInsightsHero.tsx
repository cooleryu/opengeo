'use client';

import { ChevronRight } from 'lucide-react';
import type { JSX } from 'react';
import type { MetricSummary } from '@/lib/geo/overview-metrics';
import type { ResearchEngine } from '@/lib/geo/research-types';
import type { getResearchMetrics, ResearchFilter } from '@/lib/geo/research-view';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import { type FocusFilter, getPlatformName, type PlatformStat } from './overview-format';

type OverviewInsightsHeroProps = {
  situationVerdict: { headline: string | JSX.Element; subline: string | JSX.Element };
  mention: MetricSummary;
  sourceOnly: boolean;
  officialMetrics: ReturnType<typeof getResearchMetrics>;
  citation: MetricSummary;
  discoverySplit: { yes: number; total: number };
  brandSplit: { yes: number; total: number };
  focus: FocusFilter;
  jumpFocus: (next: FocusFilter) => void;
  brandLabel: string;
  platformStats: PlatformStat[];
  selectedEngine: 'all' | ResearchEngine;
  onFilters: (patch: Partial<ResearchFilter>) => void;
  onCompetitor: () => void;
};

export function OverviewInsightsHero({
  situationVerdict,
  mention,
  sourceOnly,
  officialMetrics,
  citation,
  discoverySplit,
  brandSplit,
  focus,
  jumpFocus,
  brandLabel,
  platformStats,
  selectedEngine,
  onFilters,
  onCompetitor,
}: OverviewInsightsHeroProps) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
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
            <span>
              {isEn ? (
                <>
                  Brand &ldquo;<span data-i18n-skip="">{brandLabel}</span>&rdquo;
                </>
              ) : (
                <>
                  搜「<span data-i18n-skip="">{brandLabel}</span>」
                </>
              )}
            </span>
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
  );
}

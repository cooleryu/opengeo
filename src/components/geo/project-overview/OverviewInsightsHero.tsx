'use client';

import { useMemo, type JSX } from 'react';
import { ChevronRight } from 'lucide-react';
import { buildObservedCompetitorSnapshot } from '@/lib/geo/observed-competitors';
import type { MetricSummary } from '@/lib/geo/overview-metrics';
import type { ResearchBatch, ResearchEngine } from '@/lib/geo/research-types';
import type { getResearchMetrics, ResearchFilter } from '@/lib/geo/research-view';
import type { GeoProject } from '@/lib/geo/types';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import { type FocusFilter, getPlatformName, type PlatformStat } from './overview-format';

type OverviewInsightsHeroProps = {
  batch: ResearchBatch;
  project?: Pick<GeoProject, 'siteUrl' | 'repositoryUrl' | 'targetLanguage'> & {
    name?: string;
  };
  activeLanguage: 'zh' | 'en';
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
  batch,
  project,
  activeLanguage,
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

  const snapshotProject = useMemo(
    () => ({
      name: project?.name?.trim() || '',
      repositoryUrl: project?.repositoryUrl ?? '',
      siteUrl: project?.siteUrl ?? '',
      targetLanguage: project?.targetLanguage,
    }),
    [
      project?.name,
      project?.repositoryUrl,
      project?.siteUrl,
      project?.targetLanguage,
    ],
  );

  const allEngineSnapshot = useMemo(
    () =>
      buildObservedCompetitorSnapshot(batch, snapshotProject, {
        language: activeLanguage,
        engine: 'all',
        maxCompetitors: 5,
      }),
    [batch, snapshotProject, activeLanguage],
  );

  const competitorSnapshot = useMemo(
    () =>
      selectedEngine === 'all'
        ? allEngineSnapshot
        : buildObservedCompetitorSnapshot(batch, snapshotProject, {
            language: activeLanguage,
            engine: selectedEngine,
            maxCompetitors: 5,
          }),
    [allEngineSnapshot, batch, snapshotProject, activeLanguage, selectedEngine],
  );

  const perEngineSnapshot = allEngineSnapshot.perEngine;
  const showScoreboard =
    !sourceOnly &&
    competitorSnapshot.measuredAnswers > 0 &&
    competitorSnapshot.totalQuestions > 0;

  return (
    <section
      className="pov-insights-hero"
      aria-label={isEn ? 'AI search situation verdict' : '当前 AI 曝光局势诊断'}
    >
      <div className="pov-insights-grid">
        <div className="pov-insights-main">
        <div className="pov-insights-copy">
          <h2>{situationVerdict.headline}</h2>
          <p>{situationVerdict.subline}</p>
        </div>

        <div className="pov-insights-metrics">
          {!showScoreboard && (
            <>
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
            </>
          )}
          {discoverySplit.total > 0 && (
            <div className="pov-kpi-pill">
              <span>{isEn ? 'Non-branded' : '非品牌拉新'}</span>
              <strong className={discoverySplit.yes > 0 ? 'is-pos' : ''}>
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
          {!showScoreboard &&
            platformStats.map((item) => (
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
      </div>

      {showScoreboard && (
        <div
          className="pov-insights-score"
          aria-label={isEn ? 'Current performance metrics' : '我方当前表现数字'}
        >
          <div className="pov-hero-stats">
            <div className="pov-hero-stat">
              <span
                className={`pov-hero-num ${competitorSnapshot.ownCoveredQuestions > 0 ? 'is-pos' : ''}`.trim()}
              >
                {competitorSnapshot.ownCoveredQuestions}
                <small>/{competitorSnapshot.totalQuestions}</small>
              </span>
              <span className="pov-hero-stat-label">
                {isEn ? 'Prompts mentioned' : '题已被提及'}
              </span>
            </div>
            <div className="pov-hero-stat">
              <span
                className={`pov-hero-num ${competitorSnapshot.ownCitationYes > 0 ? 'is-pos' : ''}`.trim()}
              >
                {competitorSnapshot.ownCitationYes}
                <small>/{competitorSnapshot.measuredAnswers}</small>
              </span>
              <span className="pov-hero-stat-label">{t('term.siteCited')}</span>
            </div>
          </div>

          {perEngineSnapshot.length > 0 && (
            <div className="pov-hero-engines">
              {perEngineSnapshot.map((item) => (
                <button
                  key={item.engine}
                  type="button"
                  className={`pov-hero-engine-row ${selectedEngine === item.engine ? 'is-active' : ''}`.trim()}
                  onClick={() =>
                    onFilters({
                      engine: selectedEngine === item.engine ? 'all' : item.engine,
                      kind: 'all',
                      result: 'all',
                    })
                  }
                >
                  <span className="pov-hero-engine-label">
                    <span className="pov-hero-engine-icon">
                      <ResearchEngineIcon engine={item.engine} />
                    </span>
                    {getPlatformName(item.engine, isEn)}
                  </span>
                  <span className="pov-hero-engine-val">
                    {isEn
                      ? `You ${item.ownMentionYes}/${item.measured}`
                      : `我方 ${item.ownMentionYes}/${item.measured}`}
                    {item.topWinner && (
                      <em>
                        {isEn ? (
                          <>
                            {' '}
                            · Top:{' '}
                            <span data-i18n-skip="">{item.topWinner.label}</span> (
                            {item.topWinner.questionCount}q)
                          </>
                        ) : (
                          <>
                            {' '}
                            · 领跑：
                            <span data-i18n-skip="">{item.topWinner.label}</span>（
                            {item.topWinner.questionCount} 题）
                          </>
                        )}
                      </em>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </section>
  );
}

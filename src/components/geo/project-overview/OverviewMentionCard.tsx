'use client';

import type { MetricSummary } from '@/lib/geo/overview-metrics';
import type { getResearchMetrics } from '@/lib/geo/research-view';
import { useUiLanguage } from '../UiLanguageContext';
import type { FocusFilter } from './overview-format';
import { AnswerPips, DonutRing } from './OverviewCharts';

type OverviewMentionCardProps = {
  focus: FocusFilter;
  jumpFocus: (next: FocusFilter) => void;
  sourceOnly: boolean;
  officialMetrics: ReturnType<typeof getResearchMetrics>;
  mention: MetricSummary;
  mentionDisplay: { primary: string; qualifier?: string; subline: string; ringCenter: string };
  brandSplit: { yes: number; total: number };
  discoverySplit: { yes: number; total: number };
  brandLabel: string;
};

export function OverviewMentionCard({
  focus,
  jumpFocus,
  sourceOnly,
  officialMetrics,
  mention,
  mentionDisplay,
  brandSplit,
  discoverySplit,
  brandLabel,
}: OverviewMentionCardProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
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
  );
}

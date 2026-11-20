'use client';

import type { MetricSummary } from '@/lib/geo/overview-metrics';
import { useUiLanguage } from '../UiLanguageContext';
import type { FocusFilter } from './overview-format';
import { AnswerPips, DonutRing } from './OverviewCharts';

type OverviewCitationCardProps = {
  focus: FocusFilter;
  sourceOnly: boolean;
  jumpSources: () => void;
  citation: MetricSummary;
  citationDisplay: { primary: string; qualifier?: string; subline: string; ringCenter: string };
};

export function OverviewCitationCard({
  focus,
  sourceOnly,
  jumpSources,
  citation,
  citationDisplay,
}: OverviewCitationCardProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
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
  );
}

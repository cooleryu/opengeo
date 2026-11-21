'use client';

import { ArrowRight, ChevronRight } from 'lucide-react';
import type { StartCollectOptions } from '@/components/geo/project-overview/useBrowserCollect';
import type { BrowserCollectJobSnapshot } from '@/lib/geo/browser-collect-types';
import type { ResearchEngine } from '@/lib/geo/research-types';
import type { ResearchFilter } from '@/lib/geo/research-view';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import { getPlatformName, pct, type PlatformStat } from './overview-format';

type OverviewPlatformCardProps = {
  onCompetitor: () => void;
  platformStats: PlatformStat[];
  selectedEngine: 'all' | ResearchEngine;
  onFilters: (patch: Partial<ResearchFilter>) => void;
  unmeasuredConsumerEngines: ('chatgpt' | 'google')[];
  startingCollect: boolean;
  collectJob: BrowserCollectJobSnapshot | null;
  startCollect: (opts?: StartCollectOptions) => Promise<void>;
};

export function OverviewPlatformCard({
  onCompetitor,
  platformStats,
  selectedEngine,
  onFilters,
  unmeasuredConsumerEngines,
  startingCollect,
  collectJob,
  startCollect,
}: OverviewPlatformCardProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
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
  );
}

'use client';

import { Layers3, Loader2, RefreshCw } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { StartCollectOptions } from '@/components/geo/project-overview/useBrowserCollect';
import type { BrowserCollectJobSnapshot } from '@/lib/geo/browser-collect-types';
import type { ResearchEngine, ResearchQuestion } from '@/lib/geo/research-types';
import type { ResearchFilter } from '@/lib/geo/research-view';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import { getPlatformName } from './overview-format';

type OverviewTopbarProps = {
  allQuestions: ResearchQuestion[];
  availableEngines: ('chatgpt' | 'google')[];
  dateRange: string;
  previewOnly: boolean;
  startingCollect: boolean;
  collectJob: BrowserCollectJobSnapshot | null;
  selectedEngine: 'all' | ResearchEngine;
  hrsSinceShip: number;
  setEarlyRetestHours: Dispatch<SetStateAction<number | null>>;
  startCollect: (opts?: StartCollectOptions) => Promise<void>;
  activeOptimizationRunId: string | null | undefined;
  allPlatforms: boolean;
  onFilters: (patch: Partial<ResearchFilter>) => void;
};

export function OverviewTopbar({
  allQuestions,
  availableEngines,
  dateRange,
  previewOnly,
  startingCollect,
  collectJob,
  selectedEngine,
  hrsSinceShip,
  setEarlyRetestHours,
  startCollect,
  activeOptimizationRunId,
  allPlatforms,
  onFilters,
}: OverviewTopbarProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <header className="pov-topbar">
      <div className="pov-title-group">
        <h1>{t('term.overview')}</h1>
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
  );
}

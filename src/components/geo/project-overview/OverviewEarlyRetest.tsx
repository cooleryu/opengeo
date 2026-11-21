'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { StartCollectOptions } from '@/components/geo/project-overview/useBrowserCollect';
import type { ResearchEngine } from '@/lib/geo/research-types';
import { useUiLanguage } from '../UiLanguageContext';

type OverviewEarlyRetestProps = {
  earlyRetestHours: number;
  setEarlyRetestHours: Dispatch<SetStateAction<number | null>>;
  startCollect: (opts?: StartCollectOptions) => Promise<void>;
  selectedEngine: 'all' | ResearchEngine;
  activeOptimizationRunId: string | null | undefined;
};

export function OverviewEarlyRetest({
  earlyRetestHours,
  setEarlyRetestHours,
  startCollect,
  selectedEngine,
  activeOptimizationRunId,
}: OverviewEarlyRetestProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <div className="pov-retest-confirm" role="alert">
      <div className="pov-retest-confirm-copy">
        <AlertTriangle size={16} />
        <div>
          <strong>
            {isEn
              ? `Updates shipped ${earlyRetestHours}h ago — re-running now will likely stay 0 → 0`
              : `距离新内容上线仅过去 ${earlyRetestHours} 小时，现在重测大概率仍是 0 → 0`}
          </strong>
          <p>
            {isEn
              ? 'Search engines and AI answers usually take 3–7 days to index new pages or list PRs.'
              : '搜索引擎与 AI 索引新推的文档或榜单 PR 通常需要 3～7 天，刚推送不久时复测仍会命中旧缓存。'}
          </p>
        </div>
      </div>
      <div className="pov-retest-confirm-actions">
        <button
          type="button"
          className="pov-secondary-btn"
          onClick={() => setEarlyRetestHours(null)}
        >
          {isEn ? 'Cancel' : '暂不重测'}
        </button>
        <button
          type="button"
          className="pov-secondary-btn"
          onClick={() => {
            setEarlyRetestHours(null);
            void startCollect({
              engine:
                selectedEngine === 'chatgpt' || selectedEngine === 'google'
                  ? selectedEngine
                  : 'all',
              force: true,
              optimizationRunId: activeOptimizationRunId ?? undefined,
            });
          }}
        >
          <RefreshCw size={13} />
          <span>{isEn ? 'Re-run Anyway' : '仍要立即重测'}</span>
        </button>
      </div>
    </div>
  );
}

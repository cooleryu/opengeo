'use client';

import { AlertTriangle, Loader2, RefreshCw, Square } from 'lucide-react';
import type { BrowserCollectJobSnapshot } from '@/lib/geo/browser-collect-types';
import { useUiLanguage } from '../UiLanguageContext';

type OverviewCollectStatusProps = {
  collectJob: BrowserCollectJobSnapshot | null;
  stopCollect: () => Promise<void>;
  startingCollect: boolean;
  resumeCollect: (job: BrowserCollectJobSnapshot) => void;
};

export function OverviewCollectStatus({
  collectJob,
  stopCollect,
  startingCollect,
  resumeCollect,
}: OverviewCollectStatusProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  if (!collectJob || collectJob.status === 'idle') return null;
  if (collectJob.status === 'running') {
    return (
      <div className="pov-collect-status is-running" role="status">
        <div className="pov-collect-status-main">
          <Loader2 size={16} className="spin" />
          <div>
            <strong>{t('overview.collectingTitle')}</strong>
            <p>
              {collectJob.totalCount > 0 && collectJob.currentQuestionId
                ? t('overview.collectingStep', {
                    done: collectJob.completedCount,
                    total: collectJob.totalCount,
                    message:
                      collectJob.message ||
                      `${collectJob.currentEngine === 'chatgpt' ? 'ChatGPT' : 'Google'} · ${collectJob.currentQuestionId}`,
                  })
                : collectJob.message}
            </p>
            {collectJob.currentQuery && (
              <p style={{ marginTop: 2, opacity: 0.85 }}>{collectJob.currentQuery}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          className="pov-secondary-btn"
          onClick={() => void stopCollect()}
        >
          <Square size={13} />
          {t('overview.stopCollectBtn')}
        </button>
      </div>
    );
  }
  if (collectJob.status === 'needs_handoff') {
    return (
      <div className="pov-collect-status is-handoff" role="alert">
        <div className="pov-collect-status-main">
          <AlertTriangle size={16} />
          <div>
            <strong>{t('overview.handoffTitle')}</strong>
            <p>{collectJob.error || t('overview.handoffDesc')}</p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="pov-primary-btn"
            disabled={startingCollect}
            onClick={() => resumeCollect(collectJob)}
          >
            <RefreshCw size={14} />
            {t('overview.resumeCollectBtn')}
          </button>
          <button
            type="button"
            className="pov-secondary-btn"
            onClick={() => void stopCollect()}
          >
            <Square size={13} />
            {t('overview.stopCollectBtn')}
          </button>
        </div>
      </div>
    );
  }
  if (collectJob.status === 'failed' && collectJob.error) {
    return (
      <div className="pov-collect-status is-error" role="alert">
        <div className="pov-collect-status-main">
          <AlertTriangle size={16} />
          <div>
            <strong>{collectJob.error}</strong>
          </div>
        </div>
        <button
          type="button"
          className="pov-secondary-btn"
          disabled={startingCollect}
          onClick={() => resumeCollect(collectJob)}
        >
          <RefreshCw size={14} />
          {isEn ? 'Retry' : '重试采集'}
        </button>
      </div>
    );
  }
  return null;
}

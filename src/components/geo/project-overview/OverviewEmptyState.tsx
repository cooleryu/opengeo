'use client';

import { AlertTriangle, ArrowRight, Check, Copy, Loader2, Play, RefreshCw, Terminal } from 'lucide-react';
import type { StartCollectOptions } from '@/components/geo/project-overview/useBrowserCollect';
import type { BrowserCollectJobSnapshot } from '@/lib/geo/browser-collect-types';
import type { ResearchBatch } from '@/lib/geo/research-types';
import { isBrandPrompt } from '@/lib/geo/research-view';
import type { GeoProject } from '@/lib/geo/types';
import { useUiLanguage } from '../UiLanguageContext';
import { categoryMessageKeys } from './overview-format';
import { OverviewCollectStatus } from './OverviewCollectStatus';

type OverviewEmptyStateProps = {
  batch: ResearchBatch;
  langLabel: string;
  onQuestions: () => void;
  collectActionError: string;
  collectJob: BrowserCollectJobSnapshot | null;
  stopCollect: () => Promise<void>;
  startingCollect: boolean;
  resumeCollect: (job: BrowserCollectJobSnapshot) => void;
  startCollect: (opts?: StartCollectOptions) => Promise<void>;
  collectCommand: string;
  copyCollectCommand: () => void;
  copiedCmd: boolean;
  project: (Pick<GeoProject, 'siteUrl' | 'repositoryUrl' | 'targetLanguage'> & { name?: string }) | undefined;
  activeLanguage: 'en' | 'zh';
};

export function OverviewEmptyState({
  batch,
  langLabel,
  onQuestions,
  collectActionError,
  collectJob,
  stopCollect,
  startingCollect,
  resumeCollect,
  startCollect,
  collectCommand,
  copyCollectCommand,
  copiedCmd,
  project,
  activeLanguage,
}: OverviewEmptyStateProps) {
  const { t } = useUiLanguage();
  return (
    <div className="pov-shell">
      <div className="pov-empty-card">
        <div className="pov-empty-head">
          <div>
            <h1>
              {t('overview.emptyReadyTitle', {
                count: batch.questions.length,
                langLabel,
              })}
            </h1>
            <p>{t('overview.emptyReadyDesc')}</p>
          </div>
          <button
            type="button"
            className="pov-inline-link"
            onClick={onQuestions}
          >
            {t('overview.reviewQuestionsBtn')} <ArrowRight size={14} />
          </button>
        </div>
        {collectActionError && (
          <div className="pov-collect-status is-error" role="alert">
            <div className="pov-collect-status-main">
              <AlertTriangle size={16} />
              <div>
                <strong>{collectActionError}</strong>
              </div>
            </div>
          </div>
        )}
        <OverviewCollectStatus
          collectJob={collectJob}
          stopCollect={stopCollect}
          startingCollect={startingCollect}
          resumeCollect={resumeCollect}
        />
        <div className="pov-empty-actions">
          {collectJob?.status === 'needs_handoff' ? (
            <button
              type="button"
              className="pov-primary-btn"
              disabled={startingCollect}
              onClick={() => resumeCollect(collectJob)}
            >
              <RefreshCw size={15} />
              {t('overview.resumeCollectBtn')}
            </button>
          ) : (
            <button
              type="button"
              className="pov-primary-btn"
              disabled={startingCollect || collectJob?.status === 'running'}
              onClick={() => void startCollect({ engine: 'all' })}
            >
              {startingCollect || collectJob?.status === 'running' ? (
                <>
                  <Loader2 size={15} className="spin" />
                  {t('overview.startingBrowserCollectBtn')}
                </>
              ) : (
                <>
                  <Play size={15} />
                  {t('overview.startBrowserCollectBtn')}
                </>
              )}
            </button>
          )}
        </div>
        <details className="pov-cli-fallback">
          <summary>{t('overview.cliFallbackSummary')}</summary>
          <div className="pov-command-box">
            <div className="pov-command-code">
              <Terminal size={15} aria-hidden="true" />
              <code>{collectCommand}</code>
            </div>
            <button
              type="button"
              className="pov-secondary-btn"
              onClick={copyCollectCommand}
            >
              {copiedCmd ? <Check size={14} /> : <Copy size={14} />}
              {copiedCmd
                ? t('overview.copiedCommand')
                : t('overview.copyCommand')}
            </button>
          </div>
        </details>
        {batch.questions.length > 0 && (
          <ol className="pov-empty-questions">
            {batch.questions.slice(0, 8).map((q) => (
              <li key={q.id}>
                <span className="pov-q-cat">
                  {isBrandPrompt(q, project?.name)
                    ? t('overview.catBrand')
                    : q.category
                      ? t(categoryMessageKeys[q.category])
                      : t('overview.catProblem')}
                </span>
                <span>
                  {q[activeLanguage] || q.en || q.zh}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

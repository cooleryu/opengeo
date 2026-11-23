'use client';

import { Archive, ArrowLeft, Clock, Loader2, Square } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { PageAuditRecord } from '@/lib/geo/optimization/page-audit';
import { useUiLanguage } from '../UiLanguageContext';
import { formatElapsedWindow, type ShippedHistoryEntry } from './studio-format';

type StudioTopbarProps = {
  onBackOverview: () => void;
  pageAudit: PageAuditRecord | null;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  shippedItems: ShippedHistoryEntry[];
  elapsedHoursSinceOnline: number | null;
  isWorking: boolean;
  cancellingRun: boolean;
  handleCancelRun: () => Promise<void>;
};

export function StudioTopbar({
  onBackOverview,
  pageAudit,
  setHistoryOpen,
  shippedItems,
  elapsedHoursSinceOnline,
  isWorking,
  cancellingRun,
  handleCancelRun,
}: StudioTopbarProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <header className="ost-topbar oap-topbar">
      <div className="oap-header-left">
        <div className="ost-title-left">
          <button type="button" className="ost-back-btn" onClick={onBackOverview}>
            <ArrowLeft size={15} />
            <span>{t('nav.overview')}</span>
          </button>
          <span className="ost-title-divider" aria-hidden="true">
            /
          </span>
          <h1>{t('term.actionPlan')}</h1>
        </div>
        {!pageAudit && (
          <p className="oap-header-sub">{t('actionPlan.subtitle')}</p>
        )}
      </div>

      <div className="oap-header-right">
        <button
          type="button"
          className="oap-ledger-pill"
          onClick={() => setHistoryOpen(true)}
          title={t('actionPlan.historyDrawerDesc')}
        >
          {shippedItems.length > 0 && elapsedHoursSinceOnline !== null ? (
            <>
              <Clock size={13} />
              <span>
                {t('actionPlan.ledgerPillBtn', {
                  count: shippedItems.length,
                  elapsed: formatElapsedWindow(elapsedHoursSinceOnline, isEn),
                })}
              </span>
            </>
          ) : (
            <>
              <Archive size={13} />
              <span>{t('actionPlan.ledgerEmptyBtn')}</span>
            </>
          )}
        </button>

        {isWorking && (
          <button
            type="button"
            className="oap-stop-btn"
            disabled={cancellingRun}
            onClick={() => void handleCancelRun()}
          >
            {cancellingRun ? (
              <Loader2 size={13} className="ost-spin" />
            ) : (
              <Square size={12} />
            )}
            <span>
              {cancellingRun
                ? t('actionPlan.stoppingGeneratingBtn')
                : t('actionPlan.stopGeneratingBtn')}
            </span>
          </button>
        )}
      </div>
    </header>
  );
}

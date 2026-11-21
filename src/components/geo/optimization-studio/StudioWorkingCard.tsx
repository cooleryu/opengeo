'use client';

import { Check, Loader2, Square } from 'lucide-react';
import type { HumanProgressStep } from '@/lib/agent-hub';
import type { OptimizationRun } from '@/lib/geo/optimization/types';
import { useUiLanguage } from '../UiLanguageContext';

type StudioWorkingCardProps = {
  latestProgress: HumanProgressStep;
  latestRun: OptimizationRun | null;
  cancellingRun: boolean;
  handleCancelRun: () => Promise<void>;
  progressSteps: HumanProgressStep[];
};

export function StudioWorkingCard({
  latestProgress,
  latestRun,
  cancellingRun,
  handleCancelRun,
  progressSteps,
}: StudioWorkingCardProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <section className="ost-working-card" aria-live="polite">
      <div className="ost-working-head">
        <div className="oap-working-lead">
          <Loader2 size={18} className="ost-spin" />
          <div>
            <h2>{t('actionPlan.generatingBtn')}</h2>
            <p>
              {latestProgress?.message ||
                latestRun?.statusMessage ||
                (isEn
                  ? 'Drafting concise repo updates and multi-angle articles…'
                  : '正在结合真实回答撰写新版内容与配图，请稍候…')}
            </p>
          </div>
        </div>
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
      </div>
      {progressSteps.length > 1 && (
        <ul className="ost-working-log">
          {progressSteps.slice(-4).map((step, i) => (
            <li key={`${step.at}-${i}`}>
              <Check size={13} />
              <span>{step.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

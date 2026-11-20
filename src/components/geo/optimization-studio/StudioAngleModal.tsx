'use client';

import { Sparkles, X } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useUiLanguage } from '../UiLanguageContext';
import type { AngleOptionKey } from './studio-format';

type StudioAngleModalProps = {
  setAngleModalOpen: Dispatch<SetStateAction<boolean>>;
  selectedAngleKey: AngleOptionKey;
  setSelectedAngleKey: Dispatch<SetStateAction<AngleOptionKey>>;
  customAngleText: string;
  setCustomAngleText: Dispatch<SetStateAction<string>>;
  includeChineseCompanion: boolean;
  setIncludeChineseCompanion: (next: boolean) => void;
  canStartSelectedAngle: boolean;
  handleConfirmAngleDraft: () => void;
};

export function StudioAngleModal({
  setAngleModalOpen,
  selectedAngleKey,
  setSelectedAngleKey,
  customAngleText,
  setCustomAngleText,
  includeChineseCompanion,
  setIncludeChineseCompanion,
  canStartSelectedAngle,
  handleConfirmAngleDraft,
}: StudioAngleModalProps) {
  const { t, uiLanguage } = useUiLanguage();
  return (
    <div
      className="oap-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('actionPlan.angleModalTitle')}
      onClick={() => setAngleModalOpen(false)}
    >
      <section
        className="oap-angle-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="oap-modal-head">
          <div>
            <h2>{t('actionPlan.angleModalTitle')}</h2>
            <p>{t('actionPlan.angleModalDesc')}</p>
          </div>
          <button
            type="button"
            className="oap-drawer-close"
            aria-label={t('actionPlan.readerDrawerClose')}
            onClick={() => setAngleModalOpen(false)}
          >
            <X size={18} />
          </button>
        </header>

        <div className="oap-angle-list">
          {(
            [
              {
                key: 'comparison',
                title: t('actionPlan.angleOptComparisonTitle'),
                desc: t('actionPlan.angleOptComparisonDesc'),
              },
              {
                key: 'collision',
                title: t('actionPlan.angleOptCollisionTitle'),
                desc: t('actionPlan.angleOptCollisionDesc'),
              },
              {
                key: 'workflow',
                title: t('actionPlan.angleOptWorkflowTitle'),
                desc: t('actionPlan.angleOptWorkflowDesc'),
              },
              {
                key: 'custom',
                title: t('actionPlan.angleOptCustomTitle'),
                desc: null,
              },
            ] as const
          ).map((opt) => {
            const active = selectedAngleKey === opt.key;
            return (
              <label
                key={opt.key}
                className={`oap-angle-item ${active ? 'is-selected' : ''}`}
              >
                <input
                  type="radio"
                  name="oap-angle-choice"
                  checked={active}
                  onChange={() => setSelectedAngleKey(opt.key)}
                />
                <div className="oap-angle-copy">
                  <strong>{opt.title}</strong>
                  {opt.desc && <p>{opt.desc}</p>}
                  {opt.key === 'custom' && active && (
                    <textarea
                      rows={3}
                      maxLength={500}
                      className="oap-angle-textarea"
                      value={customAngleText}
                      onChange={(e) => setCustomAngleText(e.target.value)}
                      placeholder={t('actionPlan.angleOptCustomPlaceholder')}
                      autoFocus
                    />
                  )}
                </div>
              </label>
            );
          })}
        </div>

        {uiLanguage === 'zh' && (
          <label className="oap-modal-zh-opt">
            <input
              type="checkbox"
              checked={includeChineseCompanion}
              onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
            />
            <span>{t('actionPlan.angleIncludeZhLabel')}</span>
          </label>
        )}

        <footer className="oap-modal-footer">
          <button
            type="button"
            className="ost-btn-secondary is-sm"
            onClick={() => setAngleModalOpen(false)}
          >
            {t('actionPlan.angleCancelBtn')}
          </button>
          <button
            type="button"
            className="ost-btn-primary is-sm"
            disabled={!canStartSelectedAngle}
            onClick={handleConfirmAngleDraft}
          >
            <Sparkles size={14} />
            <span>{t('actionPlan.angleConfirmBtn')}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}

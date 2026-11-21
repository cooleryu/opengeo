'use client';

import { ArrowRight, Check, Loader2, Search } from 'lucide-react';
import type { GeoLanguage } from '@/lib/geo/i18n';
import type { QuestionCandidate } from '@/lib/geo/question-types';
import type { GeoState } from '@/lib/geo/types';
import { useUiLanguage } from '../UiLanguageContext';
import type { Page } from './pages';

type OverviewEmptyCardProps = {
  readyCandidates: QuestionCandidate[];
  langLabel: string;
  navigate: (nextPage: Page, taskId?: string, batchId?: string, hash?: string) => void;
  targetLang: GeoLanguage;
  busy: string;
  genActive: boolean;
  act: (action: string, payload?: Record<string, unknown>, message?: string) => Promise<GeoState | null>;
  data: GeoState;
};

export function OverviewEmptyCard({
  readyCandidates,
  langLabel,
  navigate,
  targetLang,
  busy,
  genActive,
  act,
  data,
}: OverviewEmptyCardProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <div className="pov-shell">
      <div className="pov-empty-card">
        <div className="pov-empty-head">
          <div>
            <h1>{t('overview.firstSetupTitle')}</h1>
            <p>
              {readyCandidates.length > 0
                ? t('overview.firstSetupDesc', { langLabel })
                : t('overview.firstSetupNoQuestions')}
            </p>
          </div>
          {readyCandidates.length > 0 && (
            <button
              type="button"
              className="pov-inline-link"
              onClick={() => navigate('question-plan')}
            >
              {t('overview.reviewQuestionsBtn')} <ArrowRight size={14} />
            </button>
          )}
        </div>
        {readyCandidates.length > 0 ? (
          <>
            <ol className="pov-empty-questions">
              {readyCandidates.slice(0, 8).map((c) => (
                <li key={c.id}>
                  <span className="pov-q-cat">
                    {c.category === 'brand'
                      ? t('overview.catBrand')
                      : t('overview.catProblem')}
                  </span>
                  <span lang={targetLang}>
                    {targetLang === 'en' ? c.queryEn || c.query : c.query || c.queryEn}
                  </span>
                </li>
              ))}
            </ol>
            <div className="pov-empty-actions">
              <button
                type="button"
                className="pov-primary-btn"
                disabled={!!busy || genActive}
                onClick={() =>
                  void act(
                    'confirm_questions',
                    {
                      planId: data.questionPlan.id,
                      revision: data.questionPlan.revision,
                    },
                    isEn
                      ? 'Buyer questions confirmed and ready for collection'
                      : '已确认本批核心问题，可直接开始采集',
                  )
                }
              >
                {busy === 'confirm_questions' ? (
                  <>
                    <Loader2 size={15} className="spin" />
                    {t('overview.confirmingQuestionsBtn')}
                  </>
                ) : (
                  <>
                    <Check size={15} />
                    {t('overview.confirmQuestionsBtn', {
                      count: readyCandidates.length,
                    })}
                  </>
                )}
              </button>
            </div>
          </>
        ) : (
          <div className="pov-empty-actions">
            <button
              type="button"
              className="pov-primary-btn"
              disabled={!!busy || genActive}
              onClick={() =>
                void act(
                  'generate_questions',
                  {
                    planId: data.questionPlan.id,
                    revision: data.questionPlan.revision,
                    positioning:
                      data.questionPlan.positioning ||
                      data.project.description,
                  },
                  isEn
                    ? 'Generated and reviewed recommended questions'
                    : '已生成并审核推荐问题',
                )
              }
            >
              {busy === 'generate_questions' || genActive ? (
                <>
                  <Loader2 size={15} className="spin" />
                  {t('overview.generatingQuestionsBtn')}
                </>
              ) : (
                <>
                  <Search size={15} />
                  {t('overview.generateQuestionsBtn')}
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

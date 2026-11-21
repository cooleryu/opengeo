'use client';

import { ArrowRight } from 'lucide-react';
import type { ResearchQuestion } from '@/lib/geo/research-types';
import { useUiLanguage } from '../UiLanguageContext';
import type { FocusFilter } from './overview-format';

type OverviewQuestionFiltersProps = {
  focus: FocusFilter;
  setFocus: (next: FocusFilter | ((curr: FocusFilter) => FocusFilter)) => void;
  allQuestions: ResearchQuestion[];
  missedCount: number;
  mentionedCount: number;
  sourceOnly: boolean;
  citedCount: number;
  brandQuestionCount: number;
  brandLabel: string;
  onQuestions: () => void;
};

export function OverviewQuestionFilters({
  focus,
  setFocus,
  allQuestions,
  missedCount,
  mentionedCount,
  sourceOnly,
  citedCount,
  brandQuestionCount,
  brandLabel,
  onQuestions,
}: OverviewQuestionFiltersProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <div className="pov-section-bar">
      <div className="pov-section-title">
        <h2>{t('overview.buyerQuestions')}</h2>
      </div>

      <div className="pov-section-tools">
        <div
          className="pov-filter-pills"
          role="tablist"
          aria-label={t('overview.buyerQuestions')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={focus === 'all'}
            onClick={() => setFocus('all')}
          >
            {t('overview.filterAll')} <span>{allQuestions.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={focus === 'missed'}
            onClick={() => setFocus('missed')}
          >
            {t('overview.filterMissed')} <span>{missedCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={focus === 'mentioned'}
            onClick={() => setFocus('mentioned')}
          >
            {t('overview.filterMentioned')} <span>{mentionedCount}</span>
          </button>
          {!sourceOnly && (
            <button
              type="button"
              role="tab"
              aria-selected={focus === 'cited'}
              onClick={() => setFocus('cited')}
            >
              {t('overview.filterCited')} <span>{citedCount}</span>
            </button>
          )}
          {brandQuestionCount > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={focus === 'brand'}
              onClick={() => setFocus('brand')}
            >
              {isEn ? (
                'Brand'
              ) : (
                <>
                  搜「<span data-i18n-skip="">{brandLabel}</span>」
                </>
              )}{' '}
              <span>{brandQuestionCount}</span>
            </button>
          )}
        </div>

        <button
          type="button"
          className="pov-inline-link"
          onClick={onQuestions}
        >
          {t('overview.manageQuestions')} <ArrowRight size={13} />
        </button>
      </div>
    </div>
  );
}

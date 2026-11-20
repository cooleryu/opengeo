'use client';

import { Check, Minus, X } from 'lucide-react';
import type { AuditedResearchRow } from '@/lib/geo/overview-metrics';
import type { ResearchEngine, ResearchQuestion } from '@/lib/geo/research-types';
import { extractQuestionTopWinners, isBrandPrompt, type ResearchRow } from '@/lib/geo/research-view';
import type { GeoProject } from '@/lib/geo/types';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import { categoryMessageKeys, describeTileStatus, getPlatformName } from './overview-format';

type OverviewQuestionMatrixProps = {
  displayedQuestions: ResearchQuestion[];
  project: (Pick<GeoProject, 'siteUrl' | 'repositoryUrl' | 'targetLanguage'> & { name?: string }) | undefined;
  matrixEngines: ResearchEngine[];
  allEngineRows: AuditedResearchRow[];
  couldNotVerifyLabel: string;
  activeLanguage: 'en' | 'zh';
  onQuestion: (question: ResearchQuestion, engine?: ResearchRow['engine']) => void;
  allPlatforms: boolean;
  selectedEngine: 'all' | ResearchEngine;
};

export function OverviewQuestionMatrix({
  displayedQuestions,
  project,
  matrixEngines,
  allEngineRows,
  couldNotVerifyLabel,
  activeLanguage,
  onQuestion,
  allPlatforms,
  selectedEngine,
}: OverviewQuestionMatrixProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <div className="pov-matrix">
      {displayedQuestions.map((question) => {
        const categoryLabel = isBrandPrompt(question, project?.name)
          ? t('overview.catBrand')
          : question.category
            ? t(categoryMessageKeys[question.category])
            : null;

        const tileItems = matrixEngines.map((engine) => {
          const cellRow = allEngineRows.find(
            (r) =>
              r.question.id === question.id && r.engine === engine,
          );
          return {
            engine,
            ...describeTileStatus(cellRow, isEn, couldNotVerifyLabel),
          };
        });

        const searchedCount = tileItems.filter(
          (item) => item.state !== 'unmeasured',
        ).length;
        const hitCount = tileItems.filter(
          (item) => item.state === 'found',
        ).length;
        const qWinners =
          searchedCount > 0 && hitCount === 0
            ? extractQuestionTopWinners(
                question,
                matrixEngines,
                project,
                activeLanguage,
                3,
              )
            : [];

        return (
          <div key={question.id} className="pov-matrix-row">
            <button
              type="button"
              className="pov-q-main"
              onClick={() =>
                onQuestion(
                  question,
                  allPlatforms
                    ? undefined
                    : (selectedEngine as ResearchEngine),
                )
              }
            >
              <div className="pov-q-heading">
                {categoryLabel && (
                  <span className="pov-q-cat">{categoryLabel}</span>
                )}
                <span
                  className="pov-q-text"
                  lang={
                    question[activeLanguage]
                      ? activeLanguage
                      : question.en
                        ? 'en'
                        : 'zh'
                  }
                >
                  {question[activeLanguage] || question.en || question.zh}
                </span>
              </div>
              {qWinners.length > 0 && (
                <div className="pov-q-winners">
                  <span>{isEn ? 'AI cited:' : 'AI 引用了：'}</span>
                  <b data-i18n-skip="">
                    {qWinners.map((w) => w.label).join(' · ')}
                  </b>
                </div>
              )}
            </button>

            {/* Proud Platform Icon-Badge Matrix + Hit Counter */}
            <div className="pov-tile-group">
              <div className="pov-tile-icons">
                {tileItems.map((item) => (
                  <button
                    key={item.engine}
                    type="button"
                    className={`pov-platform-tile is-${item.state}`}
                    aria-label={`${getPlatformName(item.engine, isEn)} · ${item.statusText}`}
                    onClick={() => onQuestion(question, item.engine)}
                  >
                    <ResearchEngineIcon engine={item.engine} />
                    <span
                      className="pov-tile-badge"
                      aria-hidden="true"
                    >
                      {item.state === 'found' ? (
                        <Check size={10} strokeWidth={2.8} />
                      ) : item.state === 'absent' ? (
                        <X size={10} strokeWidth={2.5} />
                      ) : item.state === 'pending' ? (
                        <b>?</b>
                      ) : (
                        <Minus size={10} strokeWidth={2.5} />
                      )}
                    </span>
                    <span
                      className="pov-tile-tooltip"
                      role="tooltip"
                    >
                      <strong>{getPlatformName(item.engine, isEn)}</strong>
                      <span>
                        {item.statusText}
                        {item.dateText ? ` · ${item.dateText}` : ''}
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                className={`pov-tile-total ${hitCount > 0 ? 'has-found' : ''}`}
                title={
                  isEn
                    ? `${searchedCount} platforms tested, ${hitCount} mentioned you`
                    : `已测 ${searchedCount} 个平台，${hitCount} 个提到你`
                }
                onClick={() =>
                  onQuestion(
                    question,
                    allPlatforms
                      ? undefined
                      : (selectedEngine as ResearchEngine),
                  )
                }
              >
                <strong>{searchedCount ? hitCount : '—'}</strong>
                <span>/ {searchedCount}</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

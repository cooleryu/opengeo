'use client';

import type { Dispatch, SetStateAction } from 'react';
import { plural } from '@/lib/geo/i18n';
import type { OptimizationDeliverable, OptimizationRun } from '@/lib/geo/optimization/types';
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import { estimateReadingMinutes, getDeliverableRoleLabel } from '../DeliverableArticleView';
import { useUiLanguage } from '../UiLanguageContext';
import type { OutreachModalState, ReaderState } from './studio-format';

type StudioOptionalStripProps = {
  optionalTotalCount: number;
  communityOutreach: OutreachActionRecord[];
  setOutreachModal: Dispatch<SetStateAction<OutreachModalState>>;
  pendingDeliverables: OptimizationDeliverable[];
  activeDocsRun: OptimizationRun | null;
  setReadingTab: Dispatch<SetStateAction<'after' | 'before'>>;
  setLangVariant: Dispatch<SetStateAction<string>>;
  setReaderState: Dispatch<SetStateAction<ReaderState>>;
};

export function StudioOptionalStrip({
  optionalTotalCount,
  communityOutreach,
  setOutreachModal,
  pendingDeliverables,
  activeDocsRun,
  setReadingTab,
  setLangVariant,
  setReaderState,
}: StudioOptionalStripProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <details className="oap-optional-strip">
      <summary>
        <span>
          {isEn
            ? `Optional when you have time · ${plural('en', optionalTotalCount, {
                    one: '{n} community / article draft',
                    other: '{n} community / article drafts',
                  })} (no rush — click to inspect or copy)`
            : `有空再发 · ${optionalTotalCount} 条社区讨论 / 新内容草稿（不着急，点开即可查看或复制）`}
        </span>
      </summary>
      <div className="oap-optional-grid">
        {communityOutreach.map((item) => (
          <div key={item.id} className="oap-optional-row">
            <div className="oap-optional-copy">
              <strong data-i18n-skip="">{item.title}</strong>
              <span>{item.subtitle}</span>
            </div>
            <button
              type="button"
              className="ost-btn-secondary is-sm"
              onClick={() => setOutreachModal({ mode: 'community_item', actionId: item.id })}
            >
              {isEn ? 'Open draft ›' : '打开草稿 ›'}
            </button>
          </div>
        ))}
        {pendingDeliverables.map((d) => {
          const roleLabel = getDeliverableRoleLabel(d, uiLanguage);
          const mins = estimateReadingMinutes(d.afterContent);
          return (
            <div key={d.id} className="oap-optional-row">
              <div className="oap-optional-copy">
                <strong data-i18n-skip="">{d.title}</strong>
                <span>
                  {roleLabel} ·{' '}
                  {isEn
                    ? `${d.questionIds.length} prompts · ~${mins} min`
                    : `回应 ${d.questionIds.length} 题 · 约 ${mins} 分钟`}
                </span>
              </div>
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                onClick={() => {
                  if (!activeDocsRun) return;
                  setReadingTab('after');
                  setLangVariant('default');
                  setReaderState({ runId: activeDocsRun.id, deliverable: d });
                }}
              >
                {isEn ? 'Open article ›' : '打开成稿 ›'}
              </button>
            </div>
          );
        })}
      </div>
    </details>
  );
}

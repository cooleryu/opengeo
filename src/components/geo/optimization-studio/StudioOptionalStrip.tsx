'use client';

import { ExternalLink } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { plural } from '@/lib/geo/i18n';
import type { OptimizationDeliverable, OptimizationRun } from '@/lib/geo/optimization/types';
import { resolveActionListingType } from '@/lib/geo/outreach/external-page-meta';
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
  const hasEditorialRoundups = communityOutreach.some(
    (item) =>
      item.kind === 'directory_listing' &&
      resolveActionListingType(item) === 'editorial_roundup',
  );

  return (
    <details className="oap-optional-strip">
      <summary>
        <span>
          {isEn
            ? `Optional when you have time · ${plural('en', optionalTotalCount, {
                    one: '{n} item',
                    other: '{n} items',
                  })}${hasEditorialRoundups ? ' (third-party comparison articles to pitch / Show HN / drafts)' : ' (launch posts & standalone drafts)'}`
            : `有空再做 · ${optionalTotalCount} 项可选外联与草稿${hasEditorialRoundups ? '（第三方测评文章联系编辑 / Show HN / 扩展文章，回复率较低可按需挑着发）' : '（不着急，点开即可查看或复制）'}`}
        </span>
      </summary>
      <div className="oap-optional-grid">
        {communityOutreach.map((item) => {
          const isEditorial =
            item.kind === 'directory_listing' &&
            resolveActionListingType(item) === 'editorial_roundup';
          const firstPrompt = item.citedPrompts?.[0];
          const openUrl =
            item.listingDraft?.submitUrl || item.postDraft?.submitUrl || item.targetUrl;
          return (
            <div key={item.id} className="oap-optional-row">
              <div className="oap-optional-copy">
                <strong data-i18n-skip="">{item.title}</strong>
                <span>
                  {firstPrompt
                    ? isEn
                      ? `Cited for: ${firstPrompt}`
                      : `触发问题：${firstPrompt}`
                    : item.subtitle}
                </span>
              </div>
              <div className="oap-optional-actions">
                {isEditorial && (
                  <a
                    href={openUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ost-btn-secondary is-sm"
                  >
                    <span>{isEn ? 'Open' : '原文'}</span>
                    <ExternalLink size={12} />
                  </a>
                )}
                <button
                  type="button"
                  className="ost-btn-secondary is-sm"
                  onClick={() =>
                    setOutreachModal({
                      mode: isEditorial ? 'external_item' : 'community_item',
                      actionId: item.id,
                    })
                  }
                >
                  {isEditorial
                    ? isEn
                      ? 'Pitch email ›'
                      : '准备自荐信 ›'
                    : isEn
                      ? 'Open draft ›'
                      : '打开草稿 ›'}
                </button>
              </div>
            </div>
          );
        })}
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

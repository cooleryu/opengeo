'use client';

import { Check, ExternalLink, Loader2, Sparkles, Upload, X } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import type { DeliverableCompanionFile, OptimizationDeliverable } from '@/lib/geo/optimization/types';
import type { ResearchBatch } from '@/lib/geo/research-types';
import DeliverableArticleView, { getDeliverableRoleLabel } from '../DeliverableArticleView';
import { useUiLanguage } from '../UiLanguageContext';
import type { ReaderState } from './studio-format';

type StudioReaderDrawerProps = {
  deliverable: OptimizationDeliverable;
  setReaderState: Dispatch<SetStateAction<ReaderState>>;
  setMarkingPublishedDocId: Dispatch<SetStateAction<string | null>>;
  setPublishedUrlInput: Dispatch<SetStateAction<string>>;
  isPendingRepo: boolean;
  busyDocId: string | null;
  handleOneClickPushToGitHub: (runId: string, deliverable: OptimizationDeliverable) => Promise<void>;
  runId: string;
  isPendingExternal: boolean;
  setError: Dispatch<SetStateAction<string>>;
  handleOpenExternalInEgo: (deliverable: OptimizationDeliverable) => Promise<void>;
  busyDocOp: string | null;
  markingPublishedDocId: string | null;
  publishedUrlInput: string;
  handleMarkDocPublished: (runId: string, deliverable: OptimizationDeliverable, publishedUrl: string) => Promise<void>;
  companions: DeliverableCompanionFile[];
  readingTab: 'after' | 'before';
  setReadingTab: Dispatch<SetStateAction<'after' | 'before'>>;
  langVariant: string;
  setLangVariant: Dispatch<SetStateAction<string>>;
  isExt: boolean;
  hasZhComp: boolean;
  generatingZhId: string | null;
  handleGenerateZhCompanion: (runId: string, deliverableId: string) => Promise<void>;
  projectId: string;
  projectName: string;
  siteUrl: string | undefined;
  batch: ResearchBatch | null | undefined;
  repositoryUrl: string | undefined;
  contentOverride: string | undefined;
  destinationOverride: string;
};

export function StudioReaderDrawer({
  deliverable,
  setReaderState,
  setMarkingPublishedDocId,
  setPublishedUrlInput,
  isPendingRepo,
  busyDocId,
  handleOneClickPushToGitHub,
  runId,
  isPendingExternal,
  setError,
  handleOpenExternalInEgo,
  busyDocOp,
  markingPublishedDocId,
  publishedUrlInput,
  handleMarkDocPublished,
  companions,
  readingTab,
  setReadingTab,
  langVariant,
  setLangVariant,
  isExt,
  hasZhComp,
  generatingZhId,
  handleGenerateZhCompanion,
  projectId,
  projectName,
  siteUrl,
  batch,
  repositoryUrl,
  contentOverride,
  destinationOverride,
}: StudioReaderDrawerProps) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <div
      className="oap-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={deliverable.title}
      onClick={() => {
        setReaderState(null);
        setMarkingPublishedDocId(null);
        setPublishedUrlInput('');
      }}
    >
      <aside
        className="oap-drawer is-reader"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="oap-drawer-head">
          <div className="oap-drawer-title-wrap">
            <span className="oap-kind-pill is-doc">
              {getDeliverableRoleLabel(deliverable, uiLanguage)}
            </span>
            <h2>{deliverable.title}</h2>
          </div>
          <div className="oap-drawer-head-actions">
            {isPendingRepo && (
              <button
                type="button"
                className="ost-btn-primary is-sm"
                disabled={Boolean(busyDocId)}
                onClick={() => void handleOneClickPushToGitHub(runId, deliverable)}
              >
                {busyDocId === deliverable.id ? (
                  <Loader2 size={14} className="ost-spin" />
                ) : (
                  <Upload size={14} />
                )}
                <span>
                  {busyDocId === deliverable.id
                    ? t('actionPlan.pushingGithubBtn')
                    : t('actionPlan.pushGithubOneStepBtn')}
                </span>
              </button>
            )}
            {isPendingExternal && (
              <>
                <button
                  type="button"
                  className="ost-btn-secondary is-sm"
                  disabled={Boolean(busyDocId)}
                  onClick={() => {
                    setMarkingPublishedDocId(deliverable.id);
                    setPublishedUrlInput(deliverable.appliedRecord?.publishedUrl ?? '');
                    setError('');
                  }}
                >
                  <Check size={13} />
                  <span>{t('actionPlan.confirmPublishedBtn')}</span>
                </button>
                <button
                  type="button"
                  className="ost-btn-primary is-sm"
                  disabled={Boolean(busyDocId)}
                  onClick={() => void handleOpenExternalInEgo(deliverable)}
                >
                  {busyDocId === deliverable.id && busyDocOp === 'ego' ? (
                    <Loader2 size={14} className="ost-spin" />
                  ) : (
                    <ExternalLink size={14} />
                  )}
                  <span>{t('actionPlan.openPublishPageBtn')}</span>
                </button>
              </>
            )}
            <button
              type="button"
              className="oap-drawer-close"
              aria-label={t('actionPlan.readerDrawerClose')}
              onClick={() => {
                setReaderState(null);
                setMarkingPublishedDocId(null);
                setPublishedUrlInput('');
              }}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {isPendingExternal && markingPublishedDocId === deliverable.id && (
          <div className="oap-mark-sent-box oap-drawer-publish-bar">
            <input
              type="url"
              value={publishedUrlInput}
              onChange={(e) => setPublishedUrlInput(e.target.value)}
              placeholder={
                isEn
                  ? 'Required: paste the live published article URL (https://...)'
                  : '必填：粘贴文章发布后的公开网址（https://...），复测时用于识别你的外链文章'
              }
            />
            <div className="oap-mark-sent-btns">
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                onClick={() => {
                  setMarkingPublishedDocId(null);
                  setPublishedUrlInput('');
                }}
              >
                {isEn ? 'Cancel' : '取消'}
              </button>
              <button
                type="button"
                className="ost-btn-primary is-sm"
                disabled={
                  Boolean(busyDocId) || !/^https?:\/\/\S+/i.test(publishedUrlInput.trim())
                }
                onClick={() =>
                  void handleMarkDocPublished(runId, deliverable, publishedUrlInput)
                }
              >
                {busyDocId === deliverable.id && busyDocOp === 'mark' ? (
                  <Loader2 size={13} className="ost-spin" />
                ) : (
                  <Check size={13} />
                )}
                <span>{t('actionPlan.confirmPublishedBtn')}</span>
              </button>
            </div>
          </div>
        )}

        {(Boolean(deliverable.beforeContent.trim()) ||
          companions.length > 0 ||
          (readingTab === 'after' && uiLanguage === 'zh')) && (
          <div className="oap-drawer-toolbar">
            {Boolean(deliverable.beforeContent.trim()) && (
              <div className="ost-compare-toggle" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={readingTab === 'after'}
                  onClick={() => setReadingTab('after')}
                >
                  {isEn ? 'Updated draft' : '修改后新稿'}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={readingTab === 'before'}
                  onClick={() => setReadingTab('before')}
                >
                  {isEn ? 'Original version' : '修改前原文'}
                </button>
              </div>
            )}

            {readingTab === 'after' && companions.length > 0 && (
              <div className="ost-compare-toggle" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={langVariant === 'default'}
                  onClick={() => setLangVariant('default')}
                >
                  {isExt || companions.every((c) => c.reviewOnly)
                    ? isEn
                      ? 'English'
                      : 'English 原稿'
                    : `English (${deliverable.destination.split('/').pop()})`}
                </button>
                {companions.map((comp) => (
                  <button
                    key={comp.lang}
                    type="button"
                    role="tab"
                    aria-selected={langVariant === comp.lang}
                    onClick={() => setLangVariant(comp.lang)}
                  >
                    {comp.reviewOnly
                      ? isEn
                        ? 'Chinese companion'
                        : '中文对照'
                      : `${comp.label} (${comp.path.split('/').pop()})`}
                  </button>
                ))}
              </div>
            )}

            {readingTab === 'after' && !hasZhComp && uiLanguage === 'zh' && (
              <button
                type="button"
                className="ost-gen-zh-btn"
                disabled={generatingZhId === deliverable.id}
                onClick={() =>
                  void handleGenerateZhCompanion(runId, deliverable.id)
                }
              >
                {generatingZhId === deliverable.id ? (
                  <Loader2 size={14} className="ost-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                <span>
                  {generatingZhId === deliverable.id
                    ? isEn
                      ? 'Generating Chinese companion…'
                      : '正在生成中文版…'
                    : isEn
                      ? 'Generate Chinese companion'
                      : '生成中文对照版'}
                </span>
              </button>
            )}
          </div>
        )}

        <div className="oap-drawer-body">
          <DeliverableArticleView
            projectId={projectId}
            projectName={projectName}
            siteUrl={siteUrl}
            batch={batch}
            deliverable={deliverable}
            repositoryUrl={repositoryUrl}
            showMetaStrip={readingTab === 'after'}
            hideCopyButton={false}
            externalExportMode={isExt && readingTab === 'after'}
            branch={deliverable.appliedRecord?.branch || 'main'}
            contentOverride={contentOverride}
            destinationOverride={destinationOverride}
          />
        </div>
      </aside>
    </div>
  );
}

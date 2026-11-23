'use client';

import { ArrowRight, ExternalLink, GitPullRequest, Loader2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { plural } from '@/lib/geo/i18n';
import {
  describeExternalListingCopy,
  formatExternalPackCopy,
  resolveActionListingType,
} from '@/lib/geo/outreach/external-page-meta';
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import ResearchEngineIcon from '../ResearchEngineIcon';
import { useUiLanguage } from '../UiLanguageContext';
import type { OutreachModalState } from './studio-format';

type StudioExternalListingsCardProps = {
  outreachLoading: boolean;
  selectedExternalCount: number;
  primaryExternalListings: OutreachActionRecord[];
  externalPackTitle: string;
  externalPackDesc: string;
  selectedExternalIds: Set<string>;
  toggleExternalSelection: (actionId: string) => void;
  setOutreachModal: Dispatch<SetStateAction<OutreachModalState>>;
  allAwesomeExternal: boolean;
  preparingExternalPack: boolean;
  handlePrepareExternalPack: () => Promise<void>;
  allDirectoryExternal: boolean;
};

export function StudioExternalListingsCard({
  outreachLoading,
  selectedExternalCount,
  primaryExternalListings,
  externalPackTitle,
  externalPackDesc,
  selectedExternalIds,
  toggleExternalSelection,
  setOutreachModal,
  allAwesomeExternal,
  preparingExternalPack,
  handlePrepareExternalPack,
}: StudioExternalListingsCardProps) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const packCopy = formatExternalPackCopy(primaryExternalListings, isEn);
  const directBrowseMode = !primaryExternalListings.some((i) => i.kind === 'awesome_pr');

  return (
    <section
      className="oap-lp-card"
      aria-label={isEn ? 'Direct external visibility actions' : '可直接落地的外部渠道'}
    >
      <div className="oap-lp-head">
        {!outreachLoading && !directBrowseMode && (
          <div className="oap-lp-head-top">
            <span className="oap-lp-count">
              {isEn
                ? `${selectedExternalCount} / ${primaryExternalListings.length} selected`
                : `已选 ${selectedExternalCount} / ${primaryExternalListings.length} 项`}
            </span>
          </div>
        )}
        <h2 className="oap-lp-title">
          {outreachLoading && primaryExternalListings.length === 0
            ? isEn
              ? 'Scanning AI-cited external pages…'
              : '正在扫描 AI 引用的外部页面…'
            : externalPackTitle}
        </h2>
        <p className="oap-lp-desc">{externalPackDesc}</p>
      </div>

      <div className="oap-lp-body">
        {outreachLoading && primaryExternalListings.length === 0 ? (
          <div className="oap-lp-empty">
            <Loader2 size={18} className="ost-spin" />
            <p>{t('actionPlan.outreachLoading')}</p>
          </div>
        ) : directBrowseMode ? (
          <div className="oap-lp-ext-list">
            {primaryExternalListings.map((item) => {
              const engines = item.citedEngines ?? [];
              const firstPrompt = item.citedPrompts?.[0];
              const isThread = item.kind === 'community_post';
              const isRepoMeta = item.kind === 'repo_meta';
              const listingType =
                item.kind === 'directory_listing' ? resolveActionListingType(item) : null;
              const badgeLabel = isThread
                ? isEn
                  ? 'Cited community thread'
                  : 'AI 引用的社区求助帖'
                : isRepoMeta
                  ? isEn
                    ? 'GitHub About & Topics'
                    : '仓库门面元信息'
                  : describeExternalListingCopy(item, isEn).badge;
              const openLabel = isThread
                ? isEn
                  ? 'Open thread'
                  : '打开原帖看看'
                : isRepoMeta
                  ? isEn
                    ? 'Open repo'
                    : '查看仓库'
                  : listingType === 'editorial_roundup'
                    ? isEn
                      ? 'Open article'
                      : '打开原文看看'
                    : isEn
                      ? 'Open directory'
                      : '打开目录页';
              const draftBtnLabel = isThread
                ? isEn
                  ? 'Draft reply'
                  : '准备回复草稿'
                : isRepoMeta
                  ? isEn
                    ? 'Review & sync'
                    : '核对并同步'
                  : listingType === 'editorial_roundup'
                    ? isEn
                      ? 'Draft pitch'
                      : '准备自荐信'
                    : isEn
                      ? 'Submission note'
                      : '准备提交资料';
              const targetUrl =
                item.postDraft?.submitUrl || item.listingDraft?.submitUrl || item.targetUrl;

              return (
                <div key={item.id} className="oap-lp-ext-row is-direct">
                  <div className="oap-lp-ext-copy">
                    <div className="oap-lp-ext-top">
                      <strong data-i18n-skip="">{item.title}</strong>
                    </div>
                    {firstPrompt && (
                      <p className="oap-lp-ext-prompt">
                        {isEn ? 'Cited for: ' : '触发问题：'}
                        <span data-i18n-skip="">{firstPrompt}</span>
                      </p>
                    )}
                    <div className="oap-lp-ext-meta">
                      <span>{badgeLabel}</span>
                      {engines.map((eng) => (
                        <span key={eng} className="oap-evidence-engine-tag">
                          <ResearchEngineIcon engine={eng} />
                          <span>{eng === 'chatgpt' ? 'ChatGPT' : 'Google'}</span>
                        </span>
                      ))}
                    </div>
                    <div className="oap-lp-ext-actions">
                      <a
                        href={targetUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ost-btn-secondary is-sm"
                      >
                        <span>{openLabel}</span>
                        <ExternalLink size={12} />
                      </a>
                      <button
                        type="button"
                        className="ost-btn-primary is-sm"
                        onClick={() =>
                          setOutreachModal({
                            mode: isThread ? 'community_item' : 'external_item',
                            actionId: item.id,
                          })
                        }
                      >
                        {draftBtnLabel}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="oap-lp-ext-list">
            {primaryExternalListings.map((item, idx) => {
              const checked = selectedExternalIds.has(item.id);
              const engines = item.citedEngines ?? [];
              const firstPrompt = item.citedPrompts?.[0];
              const kindMeta =
                item.kind === 'awesome_pr'
                  ? isEn
                    ? 'Open-source list PR'
                    : '开源清单 · 提 PR'
                  : item.kind === 'directory_listing'
                    ? describeExternalListingCopy(item, isEn).compactTag
                    : item.kind === 'community_post'
                      ? isEn
                        ? 'Cited community thread'
                        : '社区求助帖 · 补充回复'
                      : isEn
                        ? 'GitHub About & Topics'
                        : '仓库门面元信息';
              return (
                <label
                  key={item.id}
                  className={`oap-lp-ext-row ${checked ? '' : 'is-off'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleExternalSelection(item.id)}
                  />
                  <div className="oap-lp-ext-copy">
                    <div className="oap-lp-ext-top">
                      <strong data-i18n-skip="">{item.title}</strong>
                      {idx === 0 && (
                        <span className="oap-lp-top-tag">
                          {isEn ? 'Top priority' : '优先处理'}
                        </span>
                      )}
                    </div>
                    {firstPrompt && (
                      <p className="oap-lp-ext-prompt">
                        {isEn ? 'Cited for: ' : '触发问题：'}
                        <span data-i18n-skip="">{firstPrompt}</span>
                      </p>
                    )}
                    <div className="oap-lp-ext-meta">
                      <span>{kindMeta}</span>
                      {Boolean(item.citedCount) && (
                        <span>
                          ·{' '}
                          {isEn
                            ? `Cited in ${plural('en', item.citedCount ?? 0, {
                                      one: '{n} prompt',
                                      other: '{n} prompts',
                                    })}`
                            : `被 AI 引用 ${item.citedCount} 题`}
                        </span>
                      )}
                      {engines.map((eng) => (
                        <span key={eng} className="oap-evidence-engine-tag">
                          <ResearchEngineIcon engine={eng} />
                          <span>{eng === 'chatgpt' ? 'ChatGPT' : 'Google'}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {!directBrowseMode && (
        <div className="oap-lp-footer">
          <button
            type="button"
            className="ost-btn-secondary is-sm"
            disabled={primaryExternalListings.length === 0}
            onClick={() => setOutreachModal({ mode: 'external_pack' })}
          >
            {allAwesomeExternal
              ? isEn
                ? 'Inspect PR entries'
                : '细看插入内容'
              : isEn
                ? 'Inspect details'
                : '查看逐项说明'}
          </button>
          <button
            type="button"
            className="ost-btn-primary is-sm"
            disabled={selectedExternalCount === 0 || preparingExternalPack}
            onClick={() => void handlePrepareExternalPack()}
          >
            {preparingExternalPack ? (
              <Loader2 size={14} className="ost-spin" />
            ) : allAwesomeExternal ? (
              <GitPullRequest size={14} />
            ) : (
              <ArrowRight size={14} />
            )}
            <span>
              {preparingExternalPack
                ? isEn
                  ? 'Preparing drafts…'
                  : '正在备好插入行…'
                : packCopy.primaryCtaLabel(selectedExternalCount)}
            </span>
          </button>
        </div>
      )}
    </section>
  );
}

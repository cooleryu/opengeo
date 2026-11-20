'use client';

import { GitPullRequest, Globe, Loader2 } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { plural } from '@/lib/geo/i18n';
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
  allDirectoryExternal,
}: StudioExternalListingsCardProps) {
  const { uiLanguage, t } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <section
      className="oap-lp-card"
      aria-label={isEn ? 'External listings' : '外部高权收录'}
    >
      <div className="oap-lp-head">
        {!outreachLoading && (
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
              ? 'Scanning AI-cited external lists…'
              : '正在扫描 AI 引用的外部榜单…'
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
        ) : (
          <div className="oap-lp-ext-list">
            {primaryExternalListings.map((item, idx) => {
              const checked = selectedExternalIds.has(item.id);
              const engines = item.citedEngines ?? [];
              const kindMeta =
                item.kind === 'awesome_pr'
                  ? isEn
                    ? 'Open-source list PR'
                    : '开源清单 · 提 PR'
                  : item.kind === 'directory_listing'
                    ? isEn
                      ? 'Directory submission'
                      : '外部目录 · 申请收录'
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
                          {isEn ? 'Top priority' : '最优先'}
                        </span>
                      )}
                    </div>
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
              : '细看提交材料'}
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
            <Globe size={14} />
          )}
          <span>
            {preparingExternalPack
              ? isEn
                ? 'Preparing drafts…'
                : '正在备好插入行…'
              : allAwesomeExternal
                ? isEn
                  ? `Prepare & review ${plural('en', selectedExternalCount, { one: '{n} PR', other: '{n} PRs' })}`
                  : `准备并核对已选 ${selectedExternalCount} 个 PR`
                : allDirectoryExternal
                  ? isEn
                    ? `Copy & open ${plural('en', selectedExternalCount, { one: '{n} directory', other: '{n} directories' })}`
                    : `复制已选 ${selectedExternalCount} 份收录材料`
                  : isEn
                    ? `Review & ship ${plural('en', selectedExternalCount, { one: '{n} item', other: '{n} items' })}`
                    : `核对并推进已选 ${selectedExternalCount} 项`}
          </span>
        </button>
      </div>
    </section>
  );
}

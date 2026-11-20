'use client';

import { BookOpen, ExternalLink, GitCommit, GitPullRequest, Globe, MessageSquarePlus, Settings2, X } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { getDeliverableRoleLabel } from '../DeliverableArticleView';
import { useUiLanguage } from '../UiLanguageContext';
import { formatShortDate, type ShippedHistoryEntry, type ReaderState } from './studio-format';

type StudioHistoryDrawerProps = {
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  shippedItems: ShippedHistoryEntry[];
  setReadingTab: Dispatch<SetStateAction<'after' | 'before'>>;
  setLangVariant: Dispatch<SetStateAction<string>>;
  setReaderState: Dispatch<SetStateAction<ReaderState>>;
};

export function StudioHistoryDrawer({
  setHistoryOpen,
  shippedItems,
  setReadingTab,
  setLangVariant,
  setReaderState,
}: StudioHistoryDrawerProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  return (
    <div
      className="oap-drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('actionPlan.historyDrawerTitle')}
      onClick={() => setHistoryOpen(false)}
    >
      <aside
        className="oap-drawer is-history"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="oap-drawer-head">
          <div>
            <h2>{t('actionPlan.historyDrawerTitle')}</h2>
            <p className="oap-drawer-desc">{t('actionPlan.historyDrawerDesc')}</p>
          </div>
          <button
            type="button"
            className="oap-drawer-close"
            aria-label={t('actionPlan.readerDrawerClose')}
            onClick={() => setHistoryOpen(false)}
          >
            <X size={18} />
          </button>
        </header>

        <div className="oap-drawer-body">
          {shippedItems.length === 0 ? (
            <p className="oap-history-empty">{t('actionPlan.historyEmpty')}</p>
          ) : (
            <ul className="oap-history-list">
              {shippedItems.map((entry) => (
                <li key={entry.key} className="oap-history-row">
                  <div className="oap-history-top">
                    <span className={`oap-kind-pill is-${entry.sourceKind}`}>
                      {entry.sourceKind === 'awesome_pr' ? (
                        <GitPullRequest size={11} />
                      ) : entry.sourceKind === 'directory_listing' || entry.sourceKind === 'page_audit' ? (
                        <Globe size={11} />
                      ) : entry.sourceKind === 'repo_meta' ? (
                        <Settings2 size={11} />
                      ) : entry.sourceKind === 'community_post' ? (
                        <MessageSquarePlus size={11} />
                      ) : (
                        <GitCommit size={11} />
                      )}
                      {entry.sourceKind === 'awesome_pr'
                        ? t('actionPlan.awesomeBadge')
                        : entry.sourceKind === 'directory_listing'
                          ? isEn
                            ? 'External directory'
                            : '外部目录收录'
                          : entry.sourceKind === 'page_audit'
                            ? isEn
                              ? 'Suggested edit'
                              : '修改建议'
                            : entry.sourceKind === 'repo_meta'
                              ? t('actionPlan.repoMetaBadge')
                              : entry.sourceKind === 'community_post'
                                ? t('actionPlan.communityBadge')
                                : entry.sourceKind === 'article'
                                  ? getDeliverableRoleLabel(entry.deliverable!, uiLanguage)
                                  : isEn
                                    ? 'Repo Doc'
                                    : '仓库文档'}
                    </span>
                    <time>{formatShortDate(entry.at, isEn)}</time>
                  </div>

                  <strong>{entry.title}</strong>
                  <p>{entry.subtitle}</p>

                  <div className="oap-history-links">
                    {entry.liveUrl && (
                      <a href={entry.liveUrl} target="_blank" rel="noreferrer">
                        {t('actionPlan.openLiveLinkBtn')} <ExternalLink size={11} />
                      </a>
                    )}
                    {entry.deliverable && entry.run && (
                      <button
                        type="button"
                        className="oap-snapshot-btn"
                        onClick={() => {
                          setHistoryOpen(false);
                          setReadingTab('after');
                          setLangVariant('default');
                          setReaderState({
                            runId: entry.run!.id,
                            deliverable: entry.deliverable!,
                          });
                        }}
                      >
                        <BookOpen size={12} />
                        <span>{t('actionPlan.viewSnapshotBtn')}</span>
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

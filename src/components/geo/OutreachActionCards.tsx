'use client';

import { useEffect, useState } from 'react';
import {
  Check,
  ExternalLink,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { GeoLanguage } from '@/lib/geo/i18n';
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import ResearchEngineIcon from './ResearchEngineIcon';
import { useUiLanguage } from './UiLanguageContext';

export interface OutreachActionCardsProps {
  projectId: string;
  lang: GeoLanguage;
  actions: OutreachActionRecord[];
  loading: boolean;
  highlightFirst?: boolean;
  onActionsUpdated: (nextActions: OutreachActionRecord[]) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

interface AwesomeEditDraft {
  insertedLine: string;
  prTitle: string;
}

interface PostEditDraft {
  draftTitle: string;
  draftBody: string;
}

interface RepoMetaEditDraft {
  description: string;
  homepage: string;
  topicsText: string;
}

export default function OutreachActionCards({
  projectId,
  lang,
  actions,
  loading,
  highlightFirst = false,
  onActionsUpdated,
  onError,
  onNotice,
}: OutreachActionCardsProps) {
  const { t } = useUiLanguage();
  const isEn = lang === 'en';
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [awesomeEdits, setAwesomeEdits] = useState<Record<string, AwesomeEditDraft>>({});
  const [postEdits, setPostEdits] = useState<Record<string, PostEditDraft>>({});
  const [repoMetaEdit, setRepoMetaEdit] = useState<RepoMetaEditDraft>({
    description: '',
    homepage: '',
    topicsText: '',
  });
  const [markingSentId, setMarkingSentId] = useState<string | null>(null);
  const [sentUrlInput, setSentUrlInput] = useState('');

  useEffect(() => {
    const nextAwesome: Record<string, AwesomeEditDraft> = {};
    const nextPosts: Record<string, PostEditDraft> = {};
    for (const item of actions) {
      if (item.kind === 'awesome_pr' && item.awesomePrDraft) {
        nextAwesome[item.id] = {
          insertedLine: item.awesomePrDraft.insertedLine,
          prTitle: item.awesomePrDraft.prTitle,
        };
      }
      if (item.kind === 'community_post' && item.postDraft) {
        nextPosts[item.id] = {
          draftTitle: item.postDraft.draftTitle,
          draftBody: item.postDraft.draftBody,
        };
      }
      if (item.kind === 'repo_meta' && item.repoMetaDraft) {
        setRepoMetaEdit({
          description: item.repoMetaDraft.suggestedDescription,
          homepage: item.repoMetaDraft.suggestedHomepage,
          topicsText: item.repoMetaDraft.suggestedTopics.join(', '),
        });
      }
    }
    setAwesomeEdits((prev) => ({ ...nextAwesome, ...prev }));
    setPostEdits((prev) => ({ ...nextPosts, ...prev }));
  }, [actions]);

  const callOutreach = async (
    actionId: string,
    opLabel: string,
    body: Record<string, unknown>,
  ) => {
    if (busyId) return null;
    setBusyId(actionId);
    setBusyOp(opLabel);
    onError('');
    try {
      const res = await fetch('/api/geo/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          lang,
          actionId,
          ...body,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        record?: OutreachActionRecord;
        actions?: OutreachActionRecord[];
        openedUrl?: string;
      };
      if (!res.ok) {
        throw new Error(payload.error || (isEn ? 'Action failed.' : '操作未完成，请稍后重试。'));
      }
      if (payload.actions) {
        onActionsUpdated(payload.actions);
      }
      return payload;
    } catch (err) {
      onError(err instanceof Error ? err.message : isEn ? 'Action failed.' : '操作未完成，请稍后重试。');
      return null;
    } finally {
      setBusyId(null);
      setBusyOp(null);
    }
  };

  if (loading && actions.length === 0) {
    return (
      <div className="oap-outreach-empty">
        <Loader2 size={16} className="ost-spin" />
        <span>{t('actionPlan.outreachLoading')}</span>
      </div>
    );
  }

  if (actions.length === 0) {
    return (
      <div className="oap-outreach-empty">
        <Check size={16} />
        <span>{t('actionPlan.outreachAllDone')}</span>
      </div>
    );
  }

  const renderEvidenceBox = (item: OutreachActionRecord) => {
    const engines = item.citedEngines ?? [];
    return (
      <div className="oap-evidence-box">
        <div className="oap-evidence-head">
          <span className="oap-evidence-kicker">
            {isEn ? 'Evidence' : '证据'}
          </span>
          {engines.length > 0 && (
            <span className="oap-evidence-engines">
              {engines.map((eng) => (
                <span key={eng} className="oap-evidence-engine-tag">
                  <ResearchEngineIcon engine={eng} />
                  <span>{eng === 'chatgpt' ? 'ChatGPT' : 'Google'}</span>
                </span>
              ))}
            </span>
          )}
        </div>
        <p className="oap-evidence-text">{item.subtitle}</p>
      </div>
    );
  };

  const renderCard = (item: OutreachActionRecord, isTopPriority: boolean) => {
    const isBusy = busyId === item.id;

        if (item.kind === 'repo_meta' && item.repoMetaDraft) {
          return (
            <article key={item.id} className="oap-action-card is-meta">
              <div className="oap-card-top">
                <div className="oap-badges">
                  {isTopPriority && (
                    <span className="oap-priority-pill">
                      {isEn ? 'Do this next' : '最优先一步'}
                    </span>
                  )}
                  <span className="oap-kind-pill is-meta">
                    <Settings2 size={12} />
                    {t('actionPlan.repoMetaBadge')}
                  </span>
                </div>
                <a
                  href={item.targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="oap-ext-link"
                >
                  {t('actionPlan.inspectRepoLink')} <ExternalLink size={11} />
                </a>
              </div>

              <h3>{item.title}</h3>
              {renderEvidenceBox(item)}

              <div className="oap-inline-fields">
                <label className="oap-field">
                  <span>{t('actionPlan.repoDescLabel')}</span>
                  <textarea
                    rows={2}
                    value={repoMetaEdit.description}
                    onChange={(e) =>
                      setRepoMetaEdit((prev) => ({ ...prev, description: e.target.value }))
                    }
                  />
                </label>
                <div className="oap-field-row">
                  <label className="oap-field">
                    <span>{t('actionPlan.repoHomeLabel')}</span>
                    <input
                      type="url"
                      value={repoMetaEdit.homepage}
                      onChange={(e) =>
                        setRepoMetaEdit((prev) => ({ ...prev, homepage: e.target.value }))
                      }
                      placeholder="https://github.com/..."
                    />
                  </label>
                  <label className="oap-field">
                    <span>{t('actionPlan.repoTopicsLabel')}</span>
                    <input
                      type="text"
                      value={repoMetaEdit.topicsText}
                      onChange={(e) =>
                        setRepoMetaEdit((prev) => ({ ...prev, topicsText: e.target.value }))
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="oap-card-actions">
                <button
                  type="button"
                  className="ost-btn-secondary is-sm"
                  disabled={Boolean(busyId)}
                  onClick={() => void callOutreach(item.id, 'skip', { action: 'skip' })}
                >
                  {t('actionPlan.skipCardBtn')}
                </button>
                <button
                  type="button"
                  className="ost-btn-primary is-sm"
                  disabled={Boolean(busyId)}
                  onClick={async () => {
                    const res = await callOutreach(item.id, 'sync', {
                      action: 'update_repo_meta',
                      description: repoMetaEdit.description,
                      homepage: repoMetaEdit.homepage,
                      topics: repoMetaEdit.topicsText
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    });
                    if (res) {
                      onNotice(
                        isEn
                          ? 'Updated GitHub repository description, homepage, and topics.'
                          : '已同步更新 GitHub 仓库简介、主页链接与 Topics，并记入已上线记录。',
                      );
                    }
                  }}
                >
                  {isBusy && busyOp === 'sync' ? (
                    <Loader2 size={14} className="ost-spin" />
                  ) : (
                    <Check size={14} />
                  )}
                  <span>
                    {isBusy && busyOp === 'sync'
                      ? t('actionPlan.syncingMetaBtn')
                      : t('actionPlan.syncGithubMetaBtn')}
                  </span>
                </button>
              </div>
            </article>
          );
        }

        if (item.kind === 'awesome_pr') {
          const draft = item.awesomePrDraft;
          const edit = awesomeEdits[item.id] ?? {
            insertedLine: draft?.insertedLine ?? '',
            prTitle: draft?.prTitle ?? '',
          };

          return (
            <article key={item.id} className={`oap-action-card ${draft ? 'is-ready' : ''}`}>
              <div className="oap-card-top">
                <div className="oap-badges">
                  {isTopPriority && (
                    <span className="oap-priority-pill">
                      {isEn ? 'Do this next' : '最优先一步'}
                    </span>
                  )}
                  <span className="oap-kind-pill is-pr">
                    <GitPullRequest size={12} />
                    {t('actionPlan.awesomeBadge')}
                  </span>
                  {Boolean(item.citedCount) && (
                    <span className="oap-cited-pill">
                      {t('actionPlan.citedBadge', { count: item.citedCount ?? 1 })}
                    </span>
                  )}
                </div>
                <a
                  href={item.targetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="oap-ext-link"
                >
                  {t('actionPlan.inspectRepoLink')} <ExternalLink size={11} />
                </a>
              </div>

              <h3>{item.title}</h3>
              {renderEvidenceBox(item)}

              {draft && (
                <div className="oap-diff-wrap">
                  <div className="oap-diff-head">
                    <span>{draft.sectionHeading}</span>
                    <code>{draft.defaultBranch}</code>
                  </div>
                  <pre className="oap-diff-pre">
                    {draft.contextSnippet.split('\n').map((line, i) => (
                      <span
                        key={i}
                        className={line.startsWith('+') ? 'is-add' : 'is-ctx'}
                      >
                        {line}
                      </span>
                    ))}
                  </pre>

                  <div className="oap-inline-fields">
                    <label className="oap-field">
                      <span>{t('actionPlan.prTitleLabel')}</span>
                      <input
                        type="text"
                        value={edit.prTitle}
                        onChange={(e) =>
                          setAwesomeEdits((prev) => ({
                            ...prev,
                            [item.id]: { ...edit, prTitle: e.target.value },
                          }))
                        }
                      />
                    </label>
                    <label className="oap-field">
                      <span>{t('actionPlan.prDiffLabel')}</span>
                      <input
                        type="text"
                        value={edit.insertedLine}
                        onChange={(e) =>
                          setAwesomeEdits((prev) => ({
                            ...prev,
                            [item.id]: { ...edit, insertedLine: e.target.value },
                          }))
                        }
                      />
                    </label>
                  </div>
                </div>
              )}

              <div className="oap-card-actions">
                <button
                  type="button"
                  className="ost-btn-secondary is-sm"
                  disabled={Boolean(busyId)}
                  onClick={() => void callOutreach(item.id, 'skip', { action: 'skip' })}
                >
                  {t('actionPlan.skipCardBtn')}
                </button>

                {!draft ? (
                  <button
                    type="button"
                    className="ost-btn-primary is-sm"
                    disabled={Boolean(busyId)}
                    onClick={() =>
                      void callOutreach(item.id, 'prepare', { action: 'prepare_awesome_pr' })
                    }
                  >
                    {isBusy && busyOp === 'prepare' ? (
                      <Loader2 size={14} className="ost-spin" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    <span>
                      {isBusy && busyOp === 'prepare'
                        ? t('actionPlan.preparingBtn')
                        : t('actionPlan.prepareDiffBtn')}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ost-btn-primary is-sm"
                    disabled={Boolean(busyId)}
                    onClick={async () => {
                      const res = await callOutreach(item.id, 'submit', {
                        action: 'submit_awesome_pr',
                        insertedLine: edit.insertedLine,
                        prTitle: edit.prTitle,
                      });
                      if (res?.record?.resultUrl) {
                        onNotice(
                          isEn
                            ? `Submitted PR cleanly: ${res.record.resultUrl}`
                            : `PR 已提交成功并记入已上线记录：${res.record.resultUrl}`,
                        );
                      }
                    }}
                  >
                    {isBusy && busyOp === 'submit' ? (
                      <Loader2 size={14} className="ost-spin" />
                    ) : (
                      <GitPullRequest size={14} />
                    )}
                    <span>
                      {isBusy && busyOp === 'submit'
                        ? t('actionPlan.submittingPrBtn')
                        : t('actionPlan.submitPrBtn')}
                    </span>
                  </button>
                )}
              </div>
            </article>
          );
        }

        // Community / Multi-angle Post Card
        const postDraft = item.postDraft;
        const edit = postEdits[item.id] ?? {
          draftTitle: postDraft?.draftTitle ?? '',
          draftBody: postDraft?.draftBody ?? '',
        };
        const isMarking = markingSentId === item.id;

        return (
          <article key={item.id} className={`oap-action-card ${postDraft ? 'is-ready' : ''}`}>
            <div className="oap-card-top">
              <div className="oap-badges">
                {isTopPriority && (
                  <span className="oap-priority-pill">
                    {isEn ? 'Do this next' : '最优先一步'}
                  </span>
                )}
                <span className="oap-kind-pill is-post">
                  <MessageSquarePlus size={12} />
                  {t('actionPlan.communityBadge')}
                </span>
                {Boolean(item.citedCount) && (
                  <span className="oap-cited-pill">
                    {t('actionPlan.citedBadge', { count: item.citedCount ?? 1 })}
                  </span>
                )}
              </div>
              <a
                href={item.targetUrl}
                target="_blank"
                rel="noreferrer"
                className="oap-ext-link"
              >
                {t('actionPlan.openThreadLink')} <ExternalLink size={11} />
              </a>
            </div>

            <h3>{item.title}</h3>
            {renderEvidenceBox(item)}

            {postDraft && (
              <div className="oap-inline-fields">
                <label className="oap-field">
                  <span>{t('actionPlan.draftTitleLabel')}</span>
                  <input
                    type="text"
                    value={edit.draftTitle}
                    onChange={(e) =>
                      setPostEdits((prev) => ({
                        ...prev,
                        [item.id]: { ...edit, draftTitle: e.target.value },
                      }))
                    }
                  />
                </label>
                <label className="oap-field">
                  <span>{t('actionPlan.draftBodyLabel')}</span>
                  <textarea
                    rows={4}
                    value={edit.draftBody}
                    onChange={(e) =>
                      setPostEdits((prev) => ({
                        ...prev,
                        [item.id]: { ...edit, draftBody: e.target.value },
                      }))
                    }
                  />
                </label>
              </div>
            )}

            {isMarking && (
              <div className="oap-mark-sent-box">
                <input
                  type="url"
                  value={sentUrlInput}
                  onChange={(e) => setSentUrlInput(e.target.value)}
                  placeholder={t('actionPlan.publishedUrlPromptLabel')}
                />
                <div className="oap-mark-sent-btns">
                  <button
                    type="button"
                    className="ost-btn-secondary is-sm"
                    onClick={() => {
                      setMarkingSentId(null);
                      setSentUrlInput('');
                    }}
                  >
                    {t('actionPlan.readerDrawerClose')}
                  </button>
                  <button
                    type="button"
                    className="ost-btn-primary is-sm"
                    disabled={Boolean(busyId)}
                    onClick={async () => {
                      const res = await callOutreach(item.id, 'mark', {
                        action: 'mark_completed',
                        resultUrl: sentUrlInput.trim() || undefined,
                      });
                      if (res) {
                        setMarkingSentId(null);
                        setSentUrlInput('');
                        onNotice(
                          isEn
                            ? 'Archived to Shipped Log.'
                            : '已记入「已上线记录」。',
                        );
                      }
                    }}
                  >
                    <Check size={13} />
                    <span>{t('actionPlan.markSentBtn')}</span>
                  </button>
                </div>
              </div>
            )}

            <div className="oap-card-actions">
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                disabled={Boolean(busyId)}
                onClick={() => void callOutreach(item.id, 'skip', { action: 'skip' })}
              >
                {t('actionPlan.skipCardBtn')}
              </button>

              <button
                type="button"
                className="ost-btn-secondary is-sm"
                disabled={Boolean(busyId)}
                onClick={() =>
                  void callOutreach(item.id, 'draft', { action: 'prepare_post' })
                }
              >
                {isBusy && busyOp === 'draft' ? (
                  <Loader2 size={13} className="ost-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                <span>
                  {isBusy && busyOp === 'draft'
                    ? t('actionPlan.preparingDraftBtn')
                    : postDraft
                      ? t('actionPlan.regenerateDraftBtn')
                      : t('actionPlan.prepareDraftBtn')}
                </span>
              </button>

              {postDraft && (
                <>
                  {!isMarking && (
                    <button
                      type="button"
                      className="ost-btn-secondary is-sm"
                      disabled={Boolean(busyId)}
                      onClick={() => {
                        setMarkingSentId(item.id);
                        setSentUrlInput('');
                      }}
                    >
                      <Check size={13} />
                      <span>{t('actionPlan.markSentBtn')}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ost-btn-primary is-sm"
                    disabled={Boolean(busyId)}
                    onClick={async () => {
                      const clipboardText = edit.draftTitle
                        ? `${edit.draftTitle}\n\n${edit.draftBody}`
                        : edit.draftBody;
                      await navigator.clipboard?.writeText(clipboardText).catch(() => {});
                      const res = await callOutreach(item.id, 'ego', {
                        action: 'open_ego',
                        targetUrl: postDraft.submitUrl || item.targetUrl,
                        draftTitle: edit.draftTitle,
                        draftBody: edit.draftBody,
                        draftUrl: postDraft.draftUrl,
                      });
                      if (res) {
                        onNotice(
                          isEn
                            ? 'Copied draft and opened the page in Ego Lite—review and click send, then Mark Sent.'
                            : '已复制草稿并在 Ego Lite 打开目标页；检查发送后点击「记为已发」即可入账。',
                        );
                      }
                    }}
                  >
                    {isBusy && busyOp === 'ego' ? (
                      <Loader2 size={14} className="ost-spin" />
                    ) : (
                      <ExternalLink size={14} />
                    )}
                    <span>
                      {isBusy && busyOp === 'ego'
                        ? t('actionPlan.openingEgoBtn')
                        : t('actionPlan.copyAndOpenEgoBtn')}
                    </span>
                  </button>
                </>
              )}
            </div>
          </article>
        );
  };

  const primaryActions = actions.filter((a) => a.kind !== 'community_post');
  const communityActions = actions.filter((a) => a.kind === 'community_post');
  const firstActionId = highlightFirst ? actions[0]?.id : null;

  return (
    <div className="oap-outreach-groups">
      {primaryActions.length > 0 && (
        <div className="oap-outreach-subgroup">
          {communityActions.length > 0 && (
            <div className="oap-sub-heading">
              <span>{isEn ? 'GitHub lists & repo metadata' : 'GitHub 榜单 PR 与仓库元信息'}</span>
              <em>{primaryActions.length}</em>
            </div>
          )}
          <div className="oap-card-grid">
            {primaryActions.map((item) =>
              renderCard(item, item.id === firstActionId),
            )}
          </div>
        </div>
      )}

      {communityActions.length > 0 && (
        <div className="oap-outreach-subgroup">
          {primaryActions.length > 0 && (
            <div className="oap-sub-heading">
              <span>{isEn ? 'Community threads & launch posts' : '社区高引用讨论与发布渠道'}</span>
              <em>{communityActions.length}</em>
            </div>
          )}
          <div className="oap-card-grid">
            {communityActions.map((item) =>
              renderCard(item, item.id === firstActionId),
            )}
          </div>
        </div>
      )}
    </div>
  );
}

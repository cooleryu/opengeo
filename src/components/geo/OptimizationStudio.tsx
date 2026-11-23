'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import type { HumanProgressStep } from '@/lib/agent-hub';
import type { OptimizationRunStatus } from '@/lib/geo/db/schema';
import type { GeoLanguage } from '@/lib/geo/i18n';
import { buildExternalMarkdown } from '@/lib/geo/optimization/external-export';
import {
  fetchOptimizationSnapshot,
  readCachedOptimizationSnapshot,
  writeCachedOptimizationSnapshot,
} from '@/lib/geo/optimization-client-cache';
import type {
  OptimizationDeliverable,
  OptimizationRun,
  OptimizationRunViewModel,
} from '@/lib/geo/optimization/types';
import type { ActionBoardCard, ActionBoardRecord } from '@/lib/geo/optimization/action-board-catalog';
import type { PageAuditRecord } from '@/lib/geo/optimization/page-audit';
import type { ResearchBatch } from '@/lib/geo/research-types';
import { useChineseCompanionPreference, useUiLanguage } from './UiLanguageContext';
import './optimization-studio.css';
import {
  type ReaderState,
  type ShippedHistoryEntry,
  isExternalArticleDeliverable,
  isRepoDocDestinationPath,
} from './optimization-studio/studio-format';
import { StudioTopbar } from './optimization-studio/StudioTopbar';
import { StudioWorkingCard } from './optimization-studio/StudioWorkingCard';
import { StudioReaderDrawer } from './optimization-studio/StudioReaderDrawer';
import { StudioHistoryDrawer } from './optimization-studio/StudioHistoryDrawer';
import { ActionBoardView } from './action-board/ActionBoardView';

export interface OptimizationStudioProps {
  projectId: string;
  projectName: string;
  repositoryUrl?: string;
  siteUrl?: string;
  selectedRunId?: string;
  targetLanguage?: GeoLanguage;
  batch?: ResearchBatch | null;
  onBackOverview: () => void;
  onOpenQuestions: () => void;
  onSelectRun?: (runId: string) => void;
  onStatusChange?: (viewModel: OptimizationRunViewModel | null) => void;
  onRefresh?: () => void;
}

export default function OptimizationStudio({
  projectId,
  projectName,
  repositoryUrl,
  siteUrl,
  selectedRunId,
  batch,
  targetLanguage,
  onBackOverview,
  onSelectRun,
  onStatusChange,
  onRefresh,
}: OptimizationStudioProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [includeChineseCompanion] = useChineseCompanionPreference();

  const initialSnap = readCachedOptimizationSnapshot(projectId, uiLanguage, selectedRunId);
  const [viewModel, setViewModel] = useState<OptimizationRunViewModel | null>(
    initialSnap?.viewModel ?? null,
  );
  const [runs, setRuns] = useState<OptimizationRun[]>(initialSnap?.runs ?? []);
  const [pageAudit, setPageAudit] = useState<PageAuditRecord | null>(
    initialSnap?.pageAudit ?? null,
  );
  const [actionBoard, setActionBoard] = useState<ActionBoardRecord | null>(
    initialSnap?.actionBoard ?? null,
  );
  const [loading, setLoading] = useState(!initialSnap?.viewModel);
  const [renderedAtMs, setRenderedAtMs] = useState<number | null>(null);

  // Streaming / doc action states
  const [submitting, setSubmitting] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<OptimizationRunStatus | null>(null);
  const [streamingSteps, setStreamingSteps] = useState<HumanProgressStep[]>([]);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [busyDocOp, setBusyDocOp] = useState<string | null>(null);
  const [markingPublishedDocId, setMarkingPublishedDocId] = useState<string | null>(null);
  const [publishedUrlInput, setPublishedUrlInput] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [notice, setNotice] = useState('');

  // Slide-over drawers & angle picker modal
  const [readerState, setReaderState] = useState<ReaderState>(null);
  const [readingTab, setReadingTab] = useState<'after' | 'before'>('after');
  const [langVariant, setLangVariant] = useState<string>('default');
  const [generatingZhId, setGeneratingZhId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cancellingRun, setCancellingRun] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;

  const hasRepoSlug = Boolean(
    repositoryUrl && /github\.com\/[^/]+\/[^/]+/i.test(repositoryUrl),
  );

  const loadOptimization = useCallback(
    async (isCancelled?: () => boolean, force = false) => {
      if (!projectId) return;
      try {
        const payload = await fetchOptimizationSnapshot(projectId, uiLanguage, {
          runId: selectedRunId,
          force,
        });
        if (!payload || isCancelled?.()) return;
        const nextVm = payload.viewModel ?? null;
        setViewModel(nextVm);
        setRuns(payload.runs ?? []);
        setPageAudit(payload.pageAudit ?? null);
        if (payload.actionBoard !== undefined) setActionBoard(payload.actionBoard ?? null);
        statusCallbackRef.current?.(nextVm);
      } finally {
        if (!isCancelled?.()) setLoading(false);
      }
    },
    [projectId, selectedRunId, uiLanguage],
  );

  useEffect(() => {
    const cached = readCachedOptimizationSnapshot(projectId, uiLanguage, selectedRunId);
    if (cached?.viewModel) {
      setViewModel(cached.viewModel);
      setRuns(cached.runs ?? []);
      setPageAudit(cached.pageAudit ?? null);
      if (cached.actionBoard !== undefined) setActionBoard(cached.actionBoard ?? null);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError('');
    setNotice('');
    setReaderState(null);
    setHistoryOpen(false);
    let cancelled = false;
    void loadOptimization(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadOptimization, projectId, selectedRunId, uiLanguage]);

  const latestRun = viewModel?.run ?? null;
  const effectiveStatus = streamingStatus ?? latestRun?.status ?? null;
  const isWorking =
    submitting ||
    (effectiveStatus !== null &&
      ['planning', 'drafting', 'reviewing', 'implementing', 'remeasuring'].includes(
        effectiveStatus,
      ));

  useEffect(() => {
    if (!isWorking || submitting) return;
    const timer = setInterval(() => {
      void loadOptimization(undefined, true);
    }, 3000);
    return () => clearInterval(timer);
  }, [isWorking, submitting, loadOptimization]);

  useEffect(() => {
    if (!readerState && !historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (readerState) setReaderState(null);
        else setHistoryOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [readerState, historyOpen]);

  // Single source of truth: shipped ledger mirrors completed cards on the current action board.
  const shippedItems = useMemo<ShippedHistoryEntry[]>(() => {
    const kindToSource = (kind: ActionBoardCard['kind']): ShippedHistoryEntry['sourceKind'] => {
      if (kind === 'page_diff') return 'page_audit';
      if (kind === 'doc_draft') return 'doc';
      if (kind === 'pr_patch') return 'awesome_pr';
      if (kind === 'community_reply') return 'community_post';
      return 'directory_listing';
    };
    return (actionBoard?.cards ?? [])
      .filter((card): card is ActionBoardCard & { completedAt: string } => Boolean(card.completedAt))
      .map((card) => ({
        key: `board-${card.id}`,
        at: card.completedAt,
        title: card.target.label,
        sourceKind: kindToSource(card.kind),
        subtitle: card.why?.[uiLanguage] || card.why?.en || card.publishedUrl || card.target.label,
        liveUrl: card.publishedUrl || card.target.url,
      }))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [actionBoard, uiLanguage]);

  const latestOnlineMs = useMemo(() => {
    const timestamps = shippedItems
      .map((item) => Date.parse(item.at))
      .filter((ms) => Number.isFinite(ms));
    return timestamps.length > 0 ? Math.max(...timestamps) : null;
  }, [shippedItems]);

  useEffect(() => {
    setRenderedAtMs(Date.now());
  }, [latestOnlineMs, shippedItems.length]);

  const elapsedHoursSinceOnline =
    latestOnlineMs !== null && renderedAtMs !== null
      ? Math.max(0, Math.floor((renderedAtMs - latestOnlineMs) / 3_600_000))
      : null;

  // Sync open reader deliverable if `runs` updates after push / companion gen
  const activeReaderDeliverable = useMemo(() => {
    if (!readerState) return null;
    for (const r of runs) {
      const found = r.deliverables.find((d) => d.id === readerState.deliverable.id);
      if (found) return { runId: r.id, deliverable: found };
    }
    return readerState;
  }, [readerState, runs]);

  const executeStreamAction = async (
    action: 'start' | 'retry',
    targetRunId?: string,
    opts?: { mode?: 'focus' | 'deep'; onlyNewContent?: boolean; angleBrief?: string },
  ) => {
    if (submitting || !projectId) return;
    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    setSubmitting(true);
    setError('');
    setErrorCode('');
    setNotice('');
    setStreamingSteps([]);
    setStreamingStatus(action === 'retry' ? 'drafting' : 'planning');

    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        signal: abortController.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({
          projectId,
          action,
          mode: opts?.mode ?? (opts?.onlyNewContent ? 'focus' : 'deep'),
          onlyNewContent: opts?.onlyNewContent,
          angleBrief: opts?.angleBrief,
          includeChineseCompanion: uiLanguage === 'zh' ? includeChineseCompanion : false,
          ...(targetRunId ? { runId: targetRunId } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const fallback = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (typeof fallback.code === 'string') setErrorCode(fallback.code);
        throw new Error(
          fallback.error || (isEn ? 'Failed to draft new plan.' : '启动内容生成失败，请稍后重试。'),
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const raw of lines) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const evt = JSON.parse(trimmed) as
            | {
                type: 'progress';
                step: HumanProgressStep;
                runStatus: OptimizationRunStatus;
              }
            | {
                type: 'result';
                viewModel: OptimizationRunViewModel;
                runs?: OptimizationRun[];
              }
            | {
                type: 'cancelled';
                viewModel?: OptimizationRunViewModel;
                runs?: OptimizationRun[];
              }
            | { type: 'error'; error: string };

          if (evt.type === 'progress') {
            setStreamingStatus(evt.runStatus);
            setStreamingSteps((prev) => [...prev.slice(-6), evt.step]);
          } else if (evt.type === 'result') {
            setViewModel(evt.viewModel);
            if (evt.runs) setRuns(evt.runs);
            statusCallbackRef.current?.(evt.viewModel);
            setStreamingStatus(null);
            if (evt.viewModel.run?.id) onSelectRun?.(evt.viewModel.run.id);
          } else if (evt.type === 'cancelled') {
            if (evt.viewModel) {
              setViewModel(evt.viewModel);
              statusCallbackRef.current?.(evt.viewModel);
            }
            if (evt.runs) setRuns(evt.runs);
            setStreamingStatus(null);
            setStreamingSteps([]);
            setNotice(t('actionPlan.cancelledNotice'));
          } else if (evt.type === 'error') {
            setError(evt.error);
          }
        }
      }
      await loadOptimization(undefined, true);
    } catch (err) {
      if (
        abortController.signal.aborted ||
        (err instanceof DOMException && err.name === 'AbortError')
      ) {
        return;
      }
      setError(
        err instanceof Error ? err.message : isEn ? 'Generation failed.' : '生成中断，请稍后重试。',
      );
    } finally {
      if (streamAbortRef.current === abortController) {
        streamAbortRef.current = null;
      }
      setSubmitting(false);
      setStreamingStatus(null);
    }
  };

  const handleCancelRun = async () => {
    if (cancellingRun || !projectId) return;
    setCancellingRun(true);
    setError('');
    streamAbortRef.current?.abort();
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'cancel',
          runId: latestRun?.id,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        viewModel?: OptimizationRunViewModel;
        runs?: OptimizationRun[];
      };
      if (!res.ok) {
        throw new Error(
          payload.error || (isEn ? 'Failed to stop drafting.' : '终止生成失败，请重试。'),
        );
      }
      if (payload.viewModel) {
        setViewModel(payload.viewModel);
        statusCallbackRef.current?.(payload.viewModel);
      }
      if (payload.runs) setRuns(payload.runs);
      setSubmitting(false);
      setStreamingStatus(null);
      setStreamingSteps([]);
      setNotice(t('actionPlan.cancelledNotice'));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : isEn ? 'Failed to stop drafting.' : '终止生成失败。',
      );
    } finally {
      setCancellingRun(false);
    }
  };

  const applyDeliverableDecision = async (
    runId: string,
    deliverableId: string,
    action: 'apply' | 'skip',
    opts?: { writeLocalFile?: boolean; publishedUrl?: string },
  ) => {
    const res = await fetch('/api/geo/optimization', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId,
        action: 'apply',
        runId,
        decisions: [
          {
            deliverableId,
            action,
            ...(opts?.writeLocalFile !== undefined ? { writeLocalFile: opts.writeLocalFile } : {}),
            ...(opts?.publishedUrl ? { publishedUrl: opts.publishedUrl } : {}),
          },
        ],
      }),
    });
    const payload = (await res.json().catch(() => ({}))) as {
      error?: string;
      viewModel?: OptimizationRunViewModel;
      runs?: OptimizationRun[];
    };
    if (!res.ok) {
      throw new Error(
        payload.error || (isEn ? 'Failed to save decision.' : '保存决策失败，请重试。'),
      );
    }
    if (payload.viewModel) {
      setViewModel(payload.viewModel);
      statusCallbackRef.current?.(payload.viewModel);
    }
    if (payload.runs) setRuns(payload.runs);
    return payload;
  };

  const handleOneClickPushToGitHub = async (
    runId: string,
    deliverable: OptimizationDeliverable,
  ) => {
    if (busyDocId) return;
    setBusyDocId(deliverable.id);
    setBusyDocOp('push');
    setError('');
    setNotice('');
    try {
      if (deliverable.status === 'ready') {
        await applyDeliverableDecision(runId, deliverable.id, 'apply', {
          writeLocalFile: true,
        });
      }
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'push_github',
          runId,
          deliverableIds: [deliverable.id],
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        viewModel?: OptimizationRunViewModel;
        runs?: OptimizationRun[];
      };
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isEn ? 'Failed to push to GitHub.' : '推送 GitHub 失败，请检查本机 Git 登录状态。'),
        );
      }
      if (payload.viewModel) {
        setViewModel(payload.viewModel);
        statusCallbackRef.current?.(payload.viewModel);
      }
      if (payload.runs) setRuns(payload.runs);
      setNotice(
        isEn
          ? `Pushed "${deliverable.title}" to GitHub and logged under Published.`
          : `已将《${deliverable.title}》推送到 GitHub 默认分支，并自动归档进「已发布」。`,
      );
      if (readerState?.deliverable.id === deliverable.id) {
        setReaderState(null);
      }
      onRefresh?.();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Failed to push to GitHub.'
            : '推送 GitHub 失败，请重试。',
      );
    } finally {
      setBusyDocId(null);
      setBusyDocOp(null);
    }
  };

  const handleOpenExternalInEgo = async (deliverable: OptimizationDeliverable) => {
    if (busyDocId) return;
    setError('');
    setNotice('');
    const branch =
      deliverable.appliedRecord?.branch ||
      runs
        .flatMap((r) => r.deliverables)
        .find((d) => d.appliedRecord?.branch)?.appliedRecord?.branch ||
      'main';
    const content = buildExternalMarkdown({
      markdown: deliverable.afterContent,
      destination: deliverable.destination,
      repositoryUrl,
      branch,
    });
    const opened = window.open('https://dev.to/new', '_blank', 'noopener,noreferrer');
    let copied = false;
    try {
      await navigator.clipboard?.writeText(content);
      copied = true;
    } catch {
      copied = false;
    }
    setNotice(
      opened
        ? isEn
          ? `${copied ? 'Copied full Markdown and opened' : 'Opened'} dev.to/new in a new tab — paste, publish, then click Mark Published.`
          : `${copied ? '已复制外发 Markdown 并在新标签页打开' : '已在新标签页打开'} dev.to/new；粘贴发布后回来点「记为已发布」即可入账。`
        : isEn
          ? 'Your browser blocked the new tab popup — Markdown is copied, please allow popups or open dev.to/new manually.'
          : '浏览器拦截了新标签页弹窗（Markdown 已复制），请允许弹窗或手动打开 dev.to/new 粘贴发布。',
    );
  };

  const handleMarkDocPublished = async (
    runId: string,
    deliverable: OptimizationDeliverable,
    publishedUrl: string,
  ) => {
    if (busyDocId) return;
    const cleanUrl = publishedUrl.trim();
    if (!/^https?:\/\/\S+/i.test(cleanUrl)) {
      setError(
        isEn
          ? 'Please paste the live article URL (starting with http:// or https://) so retesting can recognize your post.'
          : '请粘贴文章发布后的真实公开网址（以 http:// 或 https:// 开头），复测时系统才能识别这是你的文章。',
      );
      return;
    }
    setBusyDocId(deliverable.id);
    setBusyDocOp('mark');
    setError('');
    try {
      await applyDeliverableDecision(runId, deliverable.id, 'apply', {
        writeLocalFile: false,
        publishedUrl: cleanUrl,
      });
      setMarkingPublishedDocId(null);
      setPublishedUrlInput('');
      setNotice(
        isEn
          ? `Archived "${deliverable.title}" (${cleanUrl}) to Published.`
          : `已将《${deliverable.title}》及公开链接记入「已发布」。`,
      );
      if (readerState?.deliverable.id === deliverable.id) {
        setReaderState(null);
      }
      onRefresh?.();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : isEn ? 'Failed to save.' : '记录失败，请重试。',
      );
    } finally {
      setBusyDocId(null);
      setBusyDocOp(null);
    }
  };

  const handleGenerateZhCompanion = async (runId: string, deliverableId: string) => {
    if (generatingZhId) return;
    setGeneratingZhId(deliverableId);
    setError('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'generate_zh_companion',
          runId,
          deliverableId,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        viewModel?: OptimizationRunViewModel;
        runs?: OptimizationRun[];
      };
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isEn ? 'Failed to generate Chinese companion.' : '生成中文对照版失败，请稍后重试。'),
        );
      }
      if (payload.viewModel) {
        setViewModel(payload.viewModel);
        statusCallbackRef.current?.(payload.viewModel);
      }
      if (payload.runs) setRuns(payload.runs);
      setReadingTab('after');
      setLangVariant('zh-CN');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Failed to generate Chinese companion.'
            : '生成中文对照版失败。',
      );
    } finally {
      setGeneratingZhId(null);
    }
  };

  if (loading && !viewModel) {
    return (
      <div className="ost-shell">
        <div className="ost-loading">
          <Loader2 size={20} className="ost-spin" />
          <span>{t('actionPlan.loading')}</span>
        </div>
      </div>
    );
  }

  const progressSteps = streamingSteps.length ? streamingSteps : (latestRun?.progress ?? []);
  const latestProgress = progressSteps[progressSteps.length - 1] ?? null;
  const showPausedBanner = !isWorking && latestRun?.status === 'failed';

  return (
    <div className="ost-shell oap-shell">
      {/* Clean Action Plan Header */}
      <StudioTopbar
        onBackOverview={onBackOverview}
        pageAudit={pageAudit}
        setHistoryOpen={setHistoryOpen}
        shippedItems={shippedItems}
        elapsedHoursSinceOnline={elapsedHoursSinceOnline}
        isWorking={isWorking}
        cancellingRun={cancellingRun}
        handleCancelRun={handleCancelRun}
      />

      {error && (
        <div className="ost-alert" role="alert">
          <span>{error}</span>
          {errorCode === 'model_not_configured' && (
            <a
              className="ost-alert-link"
              href={`/?view=settings&project=${encodeURIComponent(projectId)}#model`}
            >
              {isEn ? 'Open Settings' : '打开设置'}
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              setError('');
              setErrorCode('');
            }}
          >
            {isEn ? 'Dismiss' : '知道了'}
          </button>
        </div>
      )}

      {notice && (
        <div className="ost-alert is-success" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice('')}>
            {isEn ? 'Dismiss' : '知道了'}
          </button>
        </div>
      )}

      {/* Live Working Banner when generating a new angle package */}
      {isWorking && (
        <StudioWorkingCard
          latestProgress={latestProgress}
          latestRun={latestRun}
          cancellingRun={cancellingRun}
          handleCancelRun={handleCancelRun}
          progressSteps={progressSteps}
        />
      )}

      {/* Resumable banner only if the very latest run paused mid-draft */}
      {showPausedBanner && latestRun && (
        <section className="ost-decision-banner is-warn">
          <div className="ost-decision-copy">
            <strong>{t('actionPlan.pausedTitle')}</strong>
            <p>{latestRun.errorMessage || (isEn ? 'Click to continue.' : '点击右侧继续生成。')}</p>
          </div>
          <button
            type="button"
            className="ost-btn-primary is-sm"
            onClick={() => void executeStreamAction('retry', latestRun.id)}
          >
            <RotateCcw size={14} />
            <span>{t('actionPlan.pausedBtn')}</span>
          </button>
        </section>
      )}

      <ActionBoardView
        key={projectId}
        projectId={projectId}
        board={actionBoard}
        pageAudit={pageAudit}
        onBoardChange={(nextBoard) => {
          setActionBoard(nextBoard);
          writeCachedOptimizationSnapshot(projectId, uiLanguage, { actionBoard: nextBoard }, selectedRunId);
        }}
        onPageAuditChange={(nextAudit) => {
          setPageAudit(nextAudit);
          writeCachedOptimizationSnapshot(projectId, uiLanguage, { pageAudit: nextAudit }, selectedRunId);
        }}
        onError={setError}
        onNotice={setNotice}
      />

      {/* DRAWER A: Right Slide-Over Full Article / Snapshot Reader */}
      {activeReaderDeliverable && (() => {
        const { runId, deliverable } = activeReaderDeliverable;
        const companions = deliverable.companionFiles ?? [];
        const activeComp =
          langVariant !== 'default'
            ? companions.find((c) => c.lang === langVariant)
            : undefined;
        const hasZhComp = companions.some((c) => c.lang.toLowerCase().startsWith('zh'));
        const contentOverride =
          readingTab === 'before'
            ? deliverable.beforeContent
            : activeComp
              ? activeComp.content
              : undefined;
        const destinationOverride = activeComp ? activeComp.path : deliverable.destination;
        const isExt = isExternalArticleDeliverable(deliverable);
        const isPendingRepo =
          (deliverable.status === 'ready' ||
            deliverable.appliedRecord?.mode === 'local_file') &&
          !isExt &&
          hasRepoSlug &&
          isRepoDocDestinationPath(deliverable.destination);
        const isPendingExternal =
          (deliverable.status === 'ready' ||
            deliverable.appliedRecord?.mode === 'local_file') &&
          !isPendingRepo;

        return (
          <StudioReaderDrawer
            deliverable={deliverable}
            setReaderState={setReaderState}
            setMarkingPublishedDocId={setMarkingPublishedDocId}
            setPublishedUrlInput={setPublishedUrlInput}
            isPendingRepo={isPendingRepo}
            busyDocId={busyDocId}
            handleOneClickPushToGitHub={handleOneClickPushToGitHub}
            runId={runId}
            isPendingExternal={isPendingExternal}
            setError={setError}
            handleOpenExternalInEgo={handleOpenExternalInEgo}
            busyDocOp={busyDocOp}
            markingPublishedDocId={markingPublishedDocId}
            publishedUrlInput={publishedUrlInput}
            handleMarkDocPublished={handleMarkDocPublished}
            companions={companions}
            readingTab={readingTab}
            setReadingTab={setReadingTab}
            langVariant={langVariant}
            setLangVariant={setLangVariant}
            isExt={isExt}
            hasZhComp={hasZhComp}
            generatingZhId={generatingZhId}
            handleGenerateZhCompanion={handleGenerateZhCompanion}
            projectId={projectId}
            projectName={projectName}
            siteUrl={siteUrl}
            batch={batch}
            repositoryUrl={repositoryUrl}
            contentOverride={contentOverride}
            destinationOverride={destinationOverride}
          />
        );
      })()}

      {/* DRAWER B: Right Slide-Over Automatic Shipped History Drawer */}
      {historyOpen && (
        <StudioHistoryDrawer
          setHistoryOpen={setHistoryOpen}
          shippedItems={shippedItems}
          setReadingTab={setReadingTab}
          setLangVariant={setLangVariant}
          setReaderState={setReaderState}
        />
      )}

    </div>
  );
}

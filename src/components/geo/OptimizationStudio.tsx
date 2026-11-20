'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import type { HumanProgressStep } from '@/lib/agent-hub';
import type { OptimizationRunStatus } from '@/lib/geo/db/schema';
import type { GeoLanguage } from '@/lib/geo/i18n';
import { buildExternalMarkdown } from '@/lib/geo/optimization/external-export';
import type {
  OptimizationDeliverable,
  OptimizationRun,
  OptimizationRunViewModel,
} from '@/lib/geo/optimization/types';
import type { PageAuditRecord, PageAuditTargetOption } from '@/lib/geo/optimization/page-audit';
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import type { ResearchBatch } from '@/lib/geo/research-types';
import PageAuditSection from './PageAuditSection';
import { useChineseCompanionPreference, useUiLanguage } from './UiLanguageContext';
import './optimization-studio.css';
import {
  type AngleOptionKey,
  type OutreachModalState,
  type ReaderState,
  type ShippedHistoryEntry,
  buildPresetAngleBrief,
  isExternalArticleDeliverable,
  isRepoDocDestinationPath,
} from './optimization-studio/studio-format';
import { StudioTopbar } from './optimization-studio/StudioTopbar';
import { StudioWorkingCard } from './optimization-studio/StudioWorkingCard';
import { StudioExternalListingsCard } from './optimization-studio/StudioExternalListingsCard';
import { StudioOptionalStrip } from './optimization-studio/StudioOptionalStrip';
import { StudioOutreachDialog } from './optimization-studio/StudioOutreachDialog';
import { StudioReaderDrawer } from './optimization-studio/StudioReaderDrawer';
import { StudioHistoryDrawer } from './optimization-studio/StudioHistoryDrawer';
import { StudioAngleModal } from './optimization-studio/StudioAngleModal';

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
  onOpenQuestions,
  onSelectRun,
  onStatusChange,
  onRefresh,
}: OptimizationStudioProps) {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [includeChineseCompanion, setIncludeChineseCompanion] =
    useChineseCompanionPreference();

  const [viewModel, setViewModel] = useState<OptimizationRunViewModel | null>(null);
  const [runs, setRuns] = useState<OptimizationRun[]>([]);
  const [pageAudit, setPageAudit] = useState<PageAuditRecord | null>(null);
  const [auditTargets, setAuditTargets] = useState<PageAuditTargetOption[]>([]);
  const [outreachActions, setOutreachActions] = useState<OutreachActionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [outreachLoading, setOutreachLoading] = useState(true);
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

  // Launchpad External Pack + Outreach Review Modal state
  const [selectedExternalIds, setSelectedExternalIds] = useState<Set<string>>(new Set());
  const [preparingExternalPack, setPreparingExternalPack] = useState(false);
  const [outreachModal, setOutreachModal] = useState<OutreachModalState>(null);
  const outreachDialogRef = useRef<HTMLDialogElement | null>(null);

  // Slide-over drawers & angle picker modal
  const [readerState, setReaderState] = useState<ReaderState>(null);
  const [readingTab, setReadingTab] = useState<'after' | 'before'>('after');
  const [langVariant, setLangVariant] = useState<string>('default');
  const [generatingZhId, setGeneratingZhId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [angleModalOpen, setAngleModalOpen] = useState(false);
  const [selectedAngleKey, setSelectedAngleKey] = useState<AngleOptionKey>('comparison');
  const [customAngleText, setCustomAngleText] = useState('');
  const [cancellingRun, setCancellingRun] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);

  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;

  const hasRepoSlug = Boolean(
    repositoryUrl && /github\.com\/[^/]+\/[^/]+/i.test(repositoryUrl),
  );

  const loadOptimization = useCallback(
    async (signal?: AbortSignal) => {
      if (!projectId) return;
      try {
        const params = new URLSearchParams({ project: projectId });
        if (selectedRunId) params.set('runId', selectedRunId);
        const res = await fetch(`/api/geo/optimization?${params.toString()}`, {
          cache: 'no-store',
          signal,
        });
        if (!res.ok) return;
        const payload = (await res.json()) as {
          viewModel?: OptimizationRunViewModel;
          runs?: OptimizationRun[];
          pageAudit?: PageAuditRecord | null;
          auditTargets?: PageAuditTargetOption[];
        };
        if (signal?.aborted) return;
        const nextVm = payload.viewModel ?? null;
        setViewModel(nextVm);
        setRuns(payload.runs ?? []);
        setPageAudit(payload.pageAudit ?? null);
        setAuditTargets(payload.auditTargets ?? []);
        statusCallbackRef.current?.(nextVm);
      } catch {
        // Keep last state cleanly on transient error
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId, selectedRunId],
  );

  const loadOutreach = useCallback(
    async (signal?: AbortSignal) => {
      if (!projectId) return;
      try {
        const params = new URLSearchParams({ project: projectId, lang: uiLanguage });
        const res = await fetch(`/api/geo/outreach?${params.toString()}`, {
          cache: 'no-store',
          signal,
        });
        if (!res.ok) return;
        const payload = (await res.json()) as { actions?: OutreachActionRecord[] };
        if (signal?.aborted) return;
        setOutreachActions(payload.actions ?? []);
      } catch {
        // Non-fatal
      } finally {
        if (!signal?.aborted) setOutreachLoading(false);
      }
    },
    [projectId, uiLanguage],
  );

  useEffect(() => {
    setLoading(true);
    setOutreachLoading(true);
    setError('');
    setNotice('');
    setReaderState(null);
    setHistoryOpen(false);
    setAngleModalOpen(false);
    const controller = new AbortController();
    void loadOptimization(controller.signal);
    void loadOutreach(controller.signal);
    return () => controller.abort();
  }, [loadOptimization, loadOutreach]);

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
      void loadOptimization();
    }, 3000);
    return () => clearInterval(timer);
  }, [isWorking, submitting, loadOptimization]);

  useEffect(() => {
    if (!readerState && !historyOpen && !angleModalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (angleModalOpen) setAngleModalOpen(false);
        else if (readerState) setReaderState(null);
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
  }, [readerState, historyOpen, angleModalOpen]);

  // Select latest valid non-failed run for pending Action Cards (ignoring empty failed runs)
  const activeDocsRun = useMemo(() => {
    if (latestRun && latestRun.status !== 'failed') return latestRun;
    return (
      runs.find((r) => r.status !== 'failed' && r.deliverables.length > 0) ?? null
    );
  }, [latestRun, runs]);

  const activeDeliverables = useMemo(
    () => activeDocsRun?.deliverables ?? [],
    [activeDocsRun],
  );

  const pendingDeliverables = useMemo(
    () =>
      activeDeliverables.filter(
        (d) =>
          d.status === 'ready' ||
          (d.status === 'applied' && d.appliedRecord?.mode === 'local_file'),
      ),
    [activeDeliverables],
  );

  const activeOutreach = useMemo(
    () =>
      outreachActions.filter(
        (a) => a.status !== 'completed' && a.status !== 'skipped',
      ),
    [outreachActions],
  );

  // Universal Bucket 2 (Right Launchpad Card): AI-cited Awesome PRs, external directories, and repo metadata
  const primaryExternalListings = useMemo(
    () => activeOutreach.filter((a) => a.kind !== 'community_post'),
    [activeOutreach],
  );

  // Universal Bucket 3 (Quiet Bottom Strip): Community posts & Show HN drafts
  const communityOutreach = useMemo(
    () => activeOutreach.filter((a) => a.kind === 'community_post'),
    [activeOutreach],
  );

  // Keep selectedExternalIds synced with primaryExternalListings (all selected by default)
  const externalIdsKey = primaryExternalListings.map((a) => a.id).join('|');
  useEffect(() => {
    setSelectedExternalIds((prev) => {
      const next = new Set<string>();
      for (const item of primaryExternalListings) {
        if (prev.size === 0 || prev.has(item.id)) next.add(item.id);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalIdsKey]);

  // Sync native <dialog> for External Listings / Community Review Modal
  useEffect(() => {
    const dlg = outreachDialogRef.current;
    if (!dlg) return;
    if (outreachModal && !dlg.open) {
      dlg.showModal();
    } else if (!outreachModal && dlg.open) {
      dlg.close();
    }
  }, [outreachModal]);

  // Aggregate all shipped items (pushed docs + external articles + completed outreach)
  const shippedItems = useMemo<ShippedHistoryEntry[]>(() => {
    const entries: ShippedHistoryEntry[] = [];
    const seenDocKeys = new Set<string>();

    for (const r of runs) {
      if (r.status === 'failed') continue;
      for (const d of r.deliverables) {
        if (d.status !== 'applied' || !d.appliedRecord) continue;
        if (d.appliedRecord.mode === 'local_file') continue;
        const dedupKey = `${d.appliedRecord.destination}:${d.appliedRecord.commitHash || d.id}`;
        if (seenDocKeys.has(dedupKey)) continue;
        seenDocKeys.add(dedupKey);
        const isExt = isExternalArticleDeliverable(d);
        entries.push({
          key: `deliv-${d.id}`,
          at: d.appliedRecord.appliedAt || d.updatedAt,
          title: d.title,
          sourceKind: isExt ? 'article' : 'doc',
          subtitle:
            d.appliedRecord.note ||
            (d.appliedRecord.commitHash
              ? `${d.appliedRecord.destination} · ${d.appliedRecord.commitHash}`
              : d.appliedRecord.destination),
          liveUrl: d.appliedRecord.publishedUrl,
          run: r,
          deliverable: d,
        });
      }
    }

    for (const a of outreachActions) {
      if (a.status !== 'completed') continue;
      entries.push({
        key: `outreach-${a.id}`,
        at: a.completedAt || a.updatedAt,
        title: a.title,
        sourceKind: a.kind,
        subtitle: a.note || a.subtitle,
        liveUrl: a.resultUrl || (a.kind === 'repo_meta' ? a.targetUrl : undefined),
      });
    }

    for (const rec of pageAudit?.shippedRecords ?? []) {
      const previewTitles = rec.findingTitles.slice(0, 2).join(isEn ? '; ' : '；');
      entries.push({
        key: `page-audit-${rec.id}`,
        at: rec.shippedAt,
        title: rec.targetLabel,
        sourceKind: 'page_audit',
        subtitle:
          rec.note ||
          (isEn
            ? `${rec.findingTitles.length} page updates: ${previewTitles}`
            : `已上线 ${rec.findingTitles.length} 处修改：${previewTitles}`),
        liveUrl: rec.liveUrl,
      });
    }

    return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [isEn, outreachActions, pageAudit, runs]);

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
      await loadOptimization();
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

  const resolvedCustomAngle = customAngleText.trim();
  const canStartSelectedAngle =
    selectedAngleKey !== 'custom' || resolvedCustomAngle.length > 0;

  const handleConfirmAngleDraft = () => {
    if (!canStartSelectedAngle) return;
    const angleBrief =
      selectedAngleKey === 'custom'
        ? resolvedCustomAngle
        : buildPresetAngleBrief(selectedAngleKey, projectName);
    setAngleModalOpen(false);
    void executeStreamAction('start', undefined, {
      mode: 'focus',
      onlyNewContent: true,
      angleBrief,
    });
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

  const toggleExternalSelection = (actionId: string) => {
    setSelectedExternalIds((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) next.delete(actionId);
      else next.add(actionId);
      return next;
    });
  };

  const handlePrepareExternalPack = async () => {
    if (preparingExternalPack) return;
    const chosen = primaryExternalListings.filter((item) => selectedExternalIds.has(item.id));
    if (!chosen.length) return;

    const unpreparedAwesome = chosen.filter(
      (item) => item.kind === 'awesome_pr' && !item.awesomePrDraft,
    );

    if (unpreparedAwesome.length > 0) {
      setPreparingExternalPack(true);
      setError('');
      try {
        let latestActions: OutreachActionRecord[] | null = null;
        for (const item of unpreparedAwesome) {
          const res = await fetch('/api/geo/outreach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId,
              lang: uiLanguage,
              actionId: item.id,
              action: 'prepare_awesome_pr',
            }),
          });
          const payload = (await res.json().catch(() => ({}))) as {
            actions?: OutreachActionRecord[];
            error?: string;
          };
          if (res.ok && payload.actions) {
            latestActions = payload.actions;
          }
        }
        if (latestActions) setOutreachActions(latestActions);
        setNotice(
          isEn
            ? `Prepared ${unpreparedAwesome.length} listing PR draft(s)—review below and click Submit.`
            : `已为 ${unpreparedAwesome.length} 个开源清单生成插入行与 PR 草稿，确认无误后在下方提交即可。`,
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : isEn
              ? 'Could not prepare PR drafts.'
              : '生成榜单 PR 草稿失败，请稍后重试。',
        );
      } finally {
        setPreparingExternalPack(false);
      }
      setOutreachModal({ mode: 'external_pack' });
      return;
    }

    const onlyDirectories = chosen.every((item) => item.kind === 'directory_listing');
    if (onlyDirectories) {
      const bundleText = chosen
        .map(
          (item, i) =>
            `## ${i + 1}. ${item.title}\nURL: ${item.targetUrl}\n${item.listingDraft?.submissionPitch ?? item.subtitle}`,
        )
        .join('\n\n');
      await navigator.clipboard?.writeText(bundleText).catch(() => {});
      setNotice(
        isEn
          ? `Copied submission details for ${chosen.length} external directories—open each below to submit.`
          : `已复制 ${chosen.length} 份外部目录提交材料到剪贴板，可在下方直接打开目录页提交。`,
      );
    }

    setOutreachModal({ mode: 'external_pack' });
  };

  const handleOpenExternalInEgo = async (deliverable: OptimizationDeliverable) => {
    if (busyDocId) return;
    setBusyDocId(deliverable.id);
    setBusyDocOp('ego');
    setError('');
    setNotice('');
    try {
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
      await navigator.clipboard?.writeText(content).catch(() => {});
      const res = await fetch('/api/geo/outreach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'open_ego',
          targetUrl: 'https://dev.to/new',
          draftTitle: deliverable.title,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isEn ? 'Could not open the publish page.' : '无法打开发布页。'),
        );
      }
      setNotice(
        isEn
          ? 'Copied full Markdown and opened the publish page—paste, publish, then click Mark Published.'
          : '已复制外发 Markdown 并打开写作页；粘贴发布后回来点「记为已发布」即可入账。',
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Could not open the publish page.'
            : '打开发布页失败。',
      );
    } finally {
      setBusyDocId(null);
      setBusyDocOp(null);
    }
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

  const questionTotal = batch?.questions.length ?? 0;
  const progressSteps = streamingSteps.length ? streamingSteps : (latestRun?.progress ?? []);
  const latestProgress = progressSteps[progressSteps.length - 1] ?? null;
  const showPausedBanner = !isWorking && latestRun?.status === 'failed';

  const hasRightLaunchCard = outreachLoading || primaryExternalListings.length > 0;
  const selectedExternalCount = primaryExternalListings.filter((item) =>
    selectedExternalIds.has(item.id),
  ).length;
  const allAwesomeExternal =
    primaryExternalListings.length > 0 &&
    primaryExternalListings.every((item) => item.kind === 'awesome_pr');
  const allDirectoryExternal =
    primaryExternalListings.length > 0 &&
    primaryExternalListings.every((item) => item.kind === 'directory_listing');

  const externalPackTitle = allAwesomeExternal
    ? isEn
      ? `Submit listing PRs to ${primaryExternalListings.length} open-source lists`
      : `向 ${primaryExternalListings.length} 个开源导航清单提收录 PR`
    : allDirectoryExternal
      ? isEn
        ? `Get listed on ${primaryExternalListings.length} AI-cited directories`
        : `入驻 ${primaryExternalListings.length} 个高频引用的外部目录站`
      : isEn
        ? `Ship ${primaryExternalListings.length} high-authority external listings`
        : `推进 ${primaryExternalListings.length} 项外部高权清单与收录`;

  const externalPackDesc = allAwesomeExternal
    ? isEn
      ? 'Curated open-source directories already cited in your live AI answers — review and submit PRs.'
      : '这些开源工具目录已被 ChatGPT / Google 直接引用，AI 已为你核对分类与插入行。'
    : allDirectoryExternal
      ? isEn
        ? 'External directories and roundups already cited by AI answers — submission materials are pre-filled.'
        : '这些外部目录/对比清单已被 AI 回答直接引用，提交材料已自动按你的真实信息备好。'
      : isEn
        ? 'AI-cited lists, external directories, and repo facade signals ranked by citation leverage.'
        : '从实测 AI 引用中挑出的高权重外部榜单、目录收录与门面补全，按投入产出排序。';

  const optionalTotalCount = communityOutreach.length + pendingDeliverables.length;

  const modalOutreachItems =
    outreachModal?.mode === 'external_pack'
      ? primaryExternalListings.filter(
          (item) => selectedExternalIds.size === 0 || selectedExternalIds.has(item.id),
        )
      : outreachModal?.mode === 'community_item'
        ? communityOutreach.filter((item) => item.id === outreachModal.actionId)
        : [];

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
        questionTotal={questionTotal}
        setAngleModalOpen={setAngleModalOpen}
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

      {/* MAIN STAGE: 1-Screen Dual Launchpad (Universal Track 1 + Track 2 via CSS Subgrid) */}
      <div className={`oap-lp-grid ${hasRightLaunchCard ? '' : 'is-single'}`}>
        {/* TRACK 1 (Left Card): Own Page / README Surgical Audit + Idea B Continuous Modal */}
        <PageAuditSection
          key={projectId}
          projectId={projectId}
          questionTotal={questionTotal}
          initialAudit={pageAudit}
          targets={auditTargets}
          onOpenQuestions={onOpenQuestions}
          onAuditUpdated={(nextAudit) => {
            setPageAudit(nextAudit);
            onRefresh?.();
          }}
          onNotice={(msg) => setNotice(msg)}
          onError={(msg) => setError(msg)}
        />

        {/* TRACK 2 (Right Card): High-Authority External Listings (Awesome PRs + SaaS Directories) */}
        {hasRightLaunchCard && (
          <StudioExternalListingsCard
            outreachLoading={outreachLoading}
            selectedExternalCount={selectedExternalCount}
            primaryExternalListings={primaryExternalListings}
            externalPackTitle={externalPackTitle}
            externalPackDesc={externalPackDesc}
            selectedExternalIds={selectedExternalIds}
            toggleExternalSelection={toggleExternalSelection}
            setOutreachModal={setOutreachModal}
            allAwesomeExternal={allAwesomeExternal}
            preparingExternalPack={preparingExternalPack}
            handlePrepareExternalPack={handlePrepareExternalPack}
            allDirectoryExternal={allDirectoryExternal}
          />
        )}
      </div>

      {/* QUIET BUCKET 3: Optional Community Discussions & New Articles (Collapsed by Default) */}
      {optionalTotalCount > 0 && (
        <StudioOptionalStrip
          optionalTotalCount={optionalTotalCount}
          communityOutreach={communityOutreach}
          setOutreachModal={setOutreachModal}
          pendingDeliverables={pendingDeliverables}
          activeDocsRun={activeDocsRun}
          setReadingTab={setReadingTab}
          setLangVariant={setLangVariant}
          setReaderState={setReaderState}
        />
      )}

      {/* NATIVE MODAL: External Listings / Community Draft Review (wraps full OutreachActionCards) */}
      <StudioOutreachDialog
        outreachDialogRef={outreachDialogRef}
        setOutreachModal={setOutreachModal}
        outreachModal={outreachModal}
        externalPackTitle={externalPackTitle}
        projectId={projectId}
        modalOutreachItems={modalOutreachItems}
        setOutreachActions={setOutreachActions}
        setError={setError}
        setNotice={setNotice}
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

      {/* MODAL: Explicit Angle Selection Before Drafting a New Standalone Article */}
      {angleModalOpen && (
        <StudioAngleModal
          setAngleModalOpen={setAngleModalOpen}
          selectedAngleKey={selectedAngleKey}
          setSelectedAngleKey={setSelectedAngleKey}
          customAngleText={customAngleText}
          setCustomAngleText={setCustomAngleText}
          includeChineseCompanion={includeChineseCompanion}
          setIncludeChineseCompanion={setIncludeChineseCompanion}
          canStartSelectedAngle={canStartSelectedAngle}
          handleConfirmAngleDraft={handleConfirmAngleDraft}
        />
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Check,
  Clock,
  ExternalLink,
  GitCommit,
  GitPullRequest,
  Globe,
  Loader2,
  MessageSquarePlus,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Upload,
  X,
} from 'lucide-react';
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
import DeliverableArticleView, {
  estimateReadingMinutes,
  getDeliverableRoleLabel,
} from './DeliverableArticleView';
import OutreachActionCards from './OutreachActionCards';
import PageAuditSection from './PageAuditSection';
import ResearchEngineIcon from './ResearchEngineIcon';
import { useChineseCompanionPreference, useUiLanguage } from './UiLanguageContext';
import './optimization-studio.css';

const REPO_DOC_PATH_RE =
  /^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html))$/i;

type AngleOptionKey = 'comparison' | 'collision' | 'workflow' | 'custom';

/** Project-agnostic preset article angles (parameterized by projectName — zero domain overfitting). */
function buildPresetAngleBrief(key: Exclude<AngleOptionKey, 'custom'>, projectName: string): string {
  const name = projectName.trim() || 'this product';
  switch (key) {
    case 'comparison':
      return `Write a balanced, factual buyer comparison showing how ${name} differs from the top alternatives cited in real AI answers, covering pricing model, setup trade-offs, and best-fit scenarios.`;
    case 'collision':
      return `Write a clear, authoritative explainer defining what ${name} is, who it is built for, and how it differs from similarly named or adjacent tools, grounded strictly in verified product facts.`;
    case 'workflow':
      return `Write a hands-on getting-started and workflow guide showing real users how to adopt ${name} step by step to solve the core buyer questions surfaced in monitoring.`;
  }
}

function isRepoDocDestinationPath(destination?: string | null): boolean {
  const trimmed = (destination || '').trim();
  if (!trimmed) return false;
  const blobMatch = trimmed.match(
    /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/i,
  );
  const candidate = blobMatch ? decodeURIComponent(blobMatch[1]) : trimmed.replace(/^\/+/, '');
  return REPO_DOC_PATH_RE.test(candidate);
}

function isExternalArticleDeliverable(d: OptimizationDeliverable): boolean {
  return (
    d.kind === 'new_content' &&
    getDeliverableRoleLabel(d, 'zh') === '公开获客文章'
  );
}

function formatShortDate(iso: string | undefined, isEn: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  if (isEn) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatElapsedWindow(hours: number, isEn: boolean): string {
  if (hours < 1) return isEn ? '<1h ago' : '不到 1 小时';
  if (hours < 24) return isEn ? `${hours}h ago` : `第 ${hours} 小时`;
  const days = Math.floor(hours / 24);
  return isEn ? `Day ${days}` : `第 ${days} 天`;
}

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

interface ShippedHistoryEntry {
  key: string;
  at: string;
  title: string;
  sourceKind:
    | 'doc'
    | 'article'
    | 'page_audit'
    | 'repo_meta'
    | 'awesome_pr'
    | 'directory_listing'
    | 'community_post';
  subtitle: string;
  liveUrl?: string;
  run?: OptimizationRun;
  deliverable?: OptimizationDeliverable;
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
  const [outreachModal, setOutreachModal] = useState<
    null | { mode: 'external_pack' } | { mode: 'community_item'; actionId: string }
  >(null);
  const outreachDialogRef = useRef<HTMLDialogElement | null>(null);

  // Slide-over drawers & angle picker modal
  const [readerState, setReaderState] = useState<{
    runId: string;
    deliverable: OptimizationDeliverable;
  } | null>(null);
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
          ? `Pushed "${deliverable.title}" to GitHub and logged under Shipped Log.`
          : `已将《${deliverable.title}》推送到 GitHub 默认分支，并自动归档进「已上线记录」。`,
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
            (isEn ? 'Could not open Ego Lite.' : '无法打开 Ego Lite 发布页。'),
        );
      }
      setNotice(
        isEn
          ? 'Copied full Markdown and opened Dev.to in Ego Lite—paste, publish, then click Mark Published.'
          : '已复制外发 Markdown 并在 Ego Lite 打开写作页；粘贴发布后回来点「记为已发布」即可入账。',
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Could not open Ego Lite.'
            : '打开 Ego Lite 失败。',
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
          ? `Archived "${deliverable.title}" (${cleanUrl}) to Shipped Log.`
          : `已将《${deliverable.title}》及公开链接记入「已上线记录」。`,
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
      <header className="ost-topbar oap-topbar">
        <div className="oap-header-left">
          <div className="ost-title-left">
            <button type="button" className="ost-back-btn" onClick={onBackOverview}>
              <ArrowLeft size={15} />
              <span>{t('nav.overview')}</span>
            </button>
            <span className="ost-title-divider" aria-hidden="true">
              /
            </span>
            <h1>{t('term.actionPlan')}</h1>
          </div>
          <p className="oap-header-sub">
            {pageAudit
              ? isEn
                ? `Grounded in ${pageAudit.shardStats.totalAnswers} live AI answers · Organized into ${hasRightLaunchCard ? '2 main tracks' : '1 focused track'}`
                : `基于 ${pageAudit.shardStats.totalAnswers} 条真实 AI 回答核对 · 已整理为 ${hasRightLaunchCard ? '2 项主线动作' : '1 项主线动作'}`
              : t('actionPlan.subtitle')}
          </p>
        </div>

        <div className="oap-header-right">
          <button
            type="button"
            className="oap-ledger-pill"
            onClick={() => setHistoryOpen(true)}
            title={t('actionPlan.historyDrawerDesc')}
          >
            {shippedItems.length > 0 && elapsedHoursSinceOnline !== null ? (
              <>
                <Clock size={13} />
                <span>
                  {t('actionPlan.ledgerPillBtn', {
                    count: shippedItems.length,
                    elapsed: formatElapsedWindow(elapsedHoursSinceOnline, isEn),
                  })}
                </span>
              </>
            ) : (
              <>
                <Archive size={13} />
                <span>{t('actionPlan.ledgerEmptyBtn')}</span>
              </>
            )}
          </button>

          {isWorking ? (
            <button
              type="button"
              className="oap-stop-btn"
              disabled={cancellingRun}
              onClick={() => void handleCancelRun()}
            >
              {cancellingRun ? (
                <Loader2 size={13} className="ost-spin" />
              ) : (
                <Square size={12} />
              )}
              <span>
                {cancellingRun
                  ? t('actionPlan.stoppingGeneratingBtn')
                  : t('actionPlan.stopGeneratingBtn')}
              </span>
            </button>
          ) : (
            questionTotal > 0 && (
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                onClick={() => setAngleModalOpen(true)}
              >
                <Plus size={14} />
                <span>{t('actionPlan.newAngleBtn')}</span>
              </button>
            )
          )}
        </div>
      </header>

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
        <section className="ost-working-card" aria-live="polite">
          <div className="ost-working-head">
            <div className="oap-working-lead">
              <Loader2 size={18} className="ost-spin" />
              <div>
                <h2>{t('actionPlan.generatingBtn')}</h2>
                <p>
                  {latestProgress?.message ||
                    latestRun?.statusMessage ||
                    (isEn
                      ? 'Drafting concise repo updates and multi-angle articles…'
                      : '正在结合真实回答撰写新版内容与配图，请稍候…')}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="oap-stop-btn"
              disabled={cancellingRun}
              onClick={() => void handleCancelRun()}
            >
              {cancellingRun ? (
                <Loader2 size={13} className="ost-spin" />
              ) : (
                <Square size={12} />
              )}
              <span>
                {cancellingRun
                  ? t('actionPlan.stoppingGeneratingBtn')
                  : t('actionPlan.stopGeneratingBtn')}
              </span>
            </button>
          </div>
          {progressSteps.length > 1 && (
            <ul className="ost-working-log">
              {progressSteps.slice(-4).map((step, i) => (
                <li key={`${step.at}-${i}`}>
                  <Check size={13} />
                  <span>{step.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
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
          <section
            className="oap-lp-card"
            aria-label={isEn ? 'Track 2 · External High-Authority Listings' : '主线 2 · 抢外部高权收录'}
          >
            <div className="oap-lp-head">
              <div className="oap-lp-head-top">
                <span className="oap-lp-kicker is-blue">
                  {isEn ? 'Track 2 · External Listings' : '主线 2 · 抢外部高权收录'}
                </span>
                {!outreachLoading && (
                  <span className="oap-lp-count">
                    {isEn
                      ? `${selectedExternalCount} / ${primaryExternalListings.length} selected`
                      : `已选 ${selectedExternalCount} / ${primaryExternalListings.length} 项`}
                  </span>
                )}
              </div>
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
                            <strong>{item.title}</strong>
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
                                  ? `Cited in ${item.citedCount} prompt${item.citedCount === 1 ? '' : 's'}`
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
                        ? `Prepare & review ${selectedExternalCount} PRs`
                        : `准备并核对已选 ${selectedExternalCount} 个 PR`
                      : allDirectoryExternal
                        ? isEn
                          ? `Copy & open ${selectedExternalCount} directories`
                          : `复制已选 ${selectedExternalCount} 份收录材料`
                        : isEn
                          ? `Review & ship ${selectedExternalCount} items`
                          : `核对并推进已选 ${selectedExternalCount} 项`}
                </span>
              </button>
            </div>
          </section>
        )}
      </div>

      {/* QUIET BUCKET 3: Optional Community Discussions & New Articles (Collapsed by Default) */}
      {optionalTotalCount > 0 && (
        <details className="oap-optional-strip">
          <summary>
            <span>
              {isEn
                ? `Optional when you have time · ${optionalTotalCount} community / article draft${optionalTotalCount === 1 ? '' : 's'} (no rush — click to inspect or copy)`
                : `有空再发 · ${optionalTotalCount} 条社区讨论 / 新内容草稿（不着急，点开即可查看或复制）`}
            </span>
          </summary>
          <div className="oap-optional-grid">
            {communityOutreach.map((item) => (
              <div key={item.id} className="oap-optional-row">
                <div className="oap-optional-copy">
                  <strong>{item.title}</strong>
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
                    <strong>{d.title}</strong>
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
      )}

      {/* NATIVE MODAL: External Listings / Community Draft Review (wraps full OutreachActionCards) */}
      <dialog
        ref={outreachDialogRef}
        className="oap-clean-modal"
        aria-labelledby="oap-outreach-modal-title"
        onClose={() => setOutreachModal(null)}
        onClick={(e) => {
          if (e.target === outreachDialogRef.current) setOutreachModal(null);
        }}
      >
        {outreachModal && (
          <>
            <header className="oap-modal-head">
              <div className="oap-modal-head-copy">
                <h2 id="oap-outreach-modal-title">
                  {outreachModal.mode === 'external_pack'
                    ? externalPackTitle
                    : isEn
                      ? 'Community Post Draft'
                      : '社区补充草稿'}
                </h2>
                <p>
                  {outreachModal.mode === 'external_pack'
                    ? isEn
                      ? 'Inspect and edit each entry before submitting PRs or opening directory forms.'
                      : '提交前可逐项核对或微调插入行与提交材料，一切由你确认后才发出。'
                    : isEn
                      ? 'Edit freely, copy to clipboard, and open directly in Ego Lite.'
                      : '可按需微调措辞，一键复制并在 Ego Lite 打开目标页面。'}
                </p>
              </div>
              <button
                type="button"
                className="oap-modal-close-btn"
                aria-label={isEn ? 'Close' : '关闭'}
                onClick={() => setOutreachModal(null)}
              >
                <X size={15} />
                <span>{isEn ? 'Close' : '关闭'}</span>
              </button>
            </header>

            <div className="oap-modal-body oap-modal-outreach-pad">
              <OutreachActionCards
                projectId={projectId}
                lang={uiLanguage}
                actions={modalOutreachItems}
                loading={false}
                highlightFirst={outreachModal.mode === 'external_pack'}
                onActionsUpdated={(nextActions) => {
                  setOutreachActions(nextActions);
                  const stillLeft =
                    outreachModal.mode === 'community_item'
                      ? nextActions.some(
                          (a) =>
                            a.id === outreachModal.actionId &&
                            a.status !== 'completed' &&
                            a.status !== 'skipped',
                        )
                      : nextActions.some(
                          (a) =>
                            a.kind !== 'community_post' &&
                            a.status !== 'completed' &&
                            a.status !== 'skipped',
                        );
                  if (!stillLeft) setOutreachModal(null);
                }}
                onError={setError}
                onNotice={setNotice}
              />
            </div>
          </>
        )}
      </dialog>

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
                        {generatingZhId === deliverable.id ? '正在生成中文版…' : '生成中文对照版'}
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
      })()}

      {/* DRAWER B: Right Slide-Over Automatic Shipped History Drawer */}
      {historyOpen && (
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
                                  ? 'Page update'
                                  : '页面改稿'
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
      )}

      {/* MODAL: Explicit Angle Selection Before Drafting a New Standalone Article */}
      {angleModalOpen && (
        <div
          className="oap-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={t('actionPlan.angleModalTitle')}
          onClick={() => setAngleModalOpen(false)}
        >
          <section
            className="oap-angle-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="oap-modal-head">
              <div>
                <h2>{t('actionPlan.angleModalTitle')}</h2>
                <p>{t('actionPlan.angleModalDesc')}</p>
              </div>
              <button
                type="button"
                className="oap-drawer-close"
                aria-label={t('actionPlan.readerDrawerClose')}
                onClick={() => setAngleModalOpen(false)}
              >
                <X size={18} />
              </button>
            </header>

            <div className="oap-angle-list">
              {(
                [
                  {
                    key: 'comparison',
                    title: t('actionPlan.angleOptComparisonTitle'),
                    desc: t('actionPlan.angleOptComparisonDesc'),
                  },
                  {
                    key: 'collision',
                    title: t('actionPlan.angleOptCollisionTitle'),
                    desc: t('actionPlan.angleOptCollisionDesc'),
                  },
                  {
                    key: 'workflow',
                    title: t('actionPlan.angleOptWorkflowTitle'),
                    desc: t('actionPlan.angleOptWorkflowDesc'),
                  },
                  {
                    key: 'custom',
                    title: t('actionPlan.angleOptCustomTitle'),
                    desc: null,
                  },
                ] as const
              ).map((opt) => {
                const active = selectedAngleKey === opt.key;
                return (
                  <label
                    key={opt.key}
                    className={`oap-angle-item ${active ? 'is-selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="oap-angle-choice"
                      checked={active}
                      onChange={() => setSelectedAngleKey(opt.key)}
                    />
                    <div className="oap-angle-copy">
                      <strong>{opt.title}</strong>
                      {opt.desc && <p>{opt.desc}</p>}
                      {opt.key === 'custom' && active && (
                        <textarea
                          rows={3}
                          maxLength={500}
                          className="oap-angle-textarea"
                          value={customAngleText}
                          onChange={(e) => setCustomAngleText(e.target.value)}
                          placeholder={t('actionPlan.angleOptCustomPlaceholder')}
                          autoFocus
                        />
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            {uiLanguage === 'zh' && (
              <label className="oap-modal-zh-opt">
                <input
                  type="checkbox"
                  checked={includeChineseCompanion}
                  onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
                />
                <span>{t('actionPlan.angleIncludeZhLabel')}</span>
              </label>
            )}

            <footer className="oap-modal-footer">
              <button
                type="button"
                className="ost-btn-secondary is-sm"
                onClick={() => setAngleModalOpen(false)}
              >
                {t('actionPlan.angleCancelBtn')}
              </button>
              <button
                type="button"
                className="ost-btn-primary is-sm"
                disabled={!canStartSelectedAngle}
                onClick={handleConfirmAngleDraft}
              >
                <Sparkles size={14} />
                <span>{t('actionPlan.angleConfirmBtn')}</span>
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  Clock,
  ExternalLink,
  GitCommit,
  GitPullRequest,
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
import type { OutreachActionRecord } from '@/lib/geo/outreach/outreach-store';
import type { ResearchBatch } from '@/lib/geo/research-types';
import DeliverableArticleView, {
  estimateReadingMinutes,
  extractDeliverablePurpose,
  getDeliverableRoleLabel,
} from './DeliverableArticleView';
import OutreachActionCards from './OutreachActionCards';
import { useChineseCompanionPreference, useUiLanguage } from './UiLanguageContext';
import './optimization-studio.css';

const REPO_DOC_PATH_RE =
  /^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html))$/i;

type AngleOptionKey = 'comparison' | 'collision' | 'workflow' | 'custom';

const PRESET_ANGLE_BRIEFS: Record<Exclude<AngleOptionKey, 'custom'>, string> = {
  comparison:
    'Write a practical buyer-guide & engineering comparison explaining why raw LLM API visibility scores do not match live ChatGPT Search & Google AI Overview browser citations, and how teams can verify real web citations locally.',
  collision:
    'Write a hands-on guide for open-source maintainers and indie founders on diagnosing brand-name homonym collisions in AI search answers and building authoritative third-party list & community citations.',
  workflow:
    'Write a practical zero-subscription workflow tutorial showing indie developers how to benchmark 8 real buyer prompts, inspect cited competitor pages, and ship high-signal documentation updates.',
};

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
  sourceKind: 'doc' | 'article' | 'repo_meta' | 'awesome_pr' | 'community_post';
  subtitle: string;
  liveUrl?: string;
  run?: OptimizationRun;
  deliverable?: OptimizationDeliverable;
}

export default function OptimizationStudio({
  projectId,
  repositoryUrl,
  selectedRunId,
  batch,
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
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // External article "Mark Published" inline prompt
  const [markingDocId, setMarkingDocId] = useState<string | null>(null);
  const [docPublishedUrl, setDocPublishedUrl] = useState('');

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
        };
        if (signal?.aborted) return;
        const nextVm = payload.viewModel ?? null;
        setViewModel(nextVm);
        setRuns(payload.runs ?? []);
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
        liveUrl: a.resultUrl || a.targetUrl,
      });
    }

    return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }, [outreachActions, runs]);

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
        const fallback = (await res.json().catch(() => ({}))) as { error?: string };
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
        : PRESET_ANGLE_BRIEFS[selectedAngleKey];
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
  ) => {
    if (busyDocId) return;
    setBusyDocId(deliverable.id);
    setBusyDocOp('mark');
    setError('');
    try {
      await applyDeliverableDecision(runId, deliverable.id, 'apply', {
        writeLocalFile: false,
        publishedUrl: docPublishedUrl.trim() || undefined,
      });
      setMarkingDocId(null);
      setDocPublishedUrl('');
      setNotice(
        isEn
          ? `Archived "${deliverable.title}" to Shipped Log.`
          : `已将《${deliverable.title}》记入「已上线记录」。`,
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

  const handleSkipDoc = async (runId: string, deliverableId: string) => {
    if (busyDocId) return;
    setBusyDocId(deliverableId);
    setBusyDocOp('skip');
    setError('');
    try {
      await applyDeliverableDecision(runId, deliverableId, 'skip');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : isEn ? 'Failed to skip.' : '跳过失败，请重试。',
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
  const showEmptyDocsPrompt = !isWorking && !activeDocsRun && !showPausedBanner;
  const showDocsSection = showEmptyDocsPrompt || pendingDeliverables.length > 0;

  return (
    <div className="ost-shell oap-shell">
      {/* Clean Action Plan Header (no Run 1/2/3 dropdown, no fake stepper) */}
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
            <h1>{t('actionPlan.title')}</h1>
          </div>
          <p className="oap-header-sub">{t('actionPlan.subtitle')}</p>
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
          <button type="button" onClick={() => setError('')}>
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

      {/* SECTION 1: Pending Repo Docs & Multi-Angle Articles (only shown when empty or pending drafts exist) */}
      {showDocsSection && (
        <section className="oap-section" aria-label={t('actionPlan.docsSectionTitle')}>
          <div className="oap-section-head">
            <h2>{t('actionPlan.docsSectionTitle')}</h2>
          </div>

          {showEmptyDocsPrompt ? (
            <div className="oap-empty-docs-card">
              <div>
                <strong>{t('actionPlan.emptyDocsTitle')}</strong>
                <p>{t('actionPlan.emptyDocsDesc')}</p>
              </div>
              {questionTotal > 0 ? (
                <button
                  type="button"
                  className="ost-btn-primary is-sm"
                  onClick={() => void executeStreamAction('start')}
                >
                  <Sparkles size={14} />
                  <span>{t('actionPlan.startFirstBtn')}</span>
                  <ArrowRight size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className="ost-btn-primary is-sm"
                  onClick={onOpenQuestions}
                >
                  <span>{t('actionPlan.needQuestionsBtn')}</span>
                  <ArrowRight size={14} />
                </button>
              )}
            </div>
          ) : (
            <div className="oap-card-grid">
              {pendingDeliverables.map((d) => {
                const roleLabel = getDeliverableRoleLabel(d, uiLanguage);
                const mins = estimateReadingMinutes(d.afterContent);
                const purpose = extractDeliverablePurpose(d, isEn ? 110 : 68);
                const isExt = isExternalArticleDeliverable(d);
                const isRepoDoc =
                  !isExt &&
                  hasRepoSlug &&
                  isRepoDocDestinationPath(d.appliedRecord?.destination || d.destination);
                const isBusy = busyDocId === d.id;
                const isMarking = markingDocId === d.id;
                const runIdForDoc = activeDocsRun!.id;

                return (
                  <article key={d.id} className="oap-action-card is-ready">
                    <div className="oap-card-top">
                      <div className="oap-badges">
                        <span className="oap-kind-pill is-doc">
                          <BookOpen size={12} />
                          {roleLabel}
                        </span>
                        <span className="oap-cited-pill">
                          {isEn
                            ? `${d.questionIds.length} prompts · ~${mins} min`
                            : `回应 ${d.questionIds.length} 题 · 约 ${mins} 分钟`}
                        </span>
                      </div>
                      <code className="oap-dest-code">{d.destination}</code>
                    </div>

                    <h3>{d.title}</h3>
                    {purpose && <p className="oap-card-sub">{purpose}</p>}

                    {isMarking && (
                      <div className="oap-mark-sent-box">
                        <input
                          type="url"
                          value={docPublishedUrl}
                          onChange={(e) => setDocPublishedUrl(e.target.value)}
                          placeholder={t('actionPlan.publishedUrlPromptLabel')}
                        />
                        <div className="oap-mark-sent-btns">
                          <button
                            type="button"
                            className="ost-btn-secondary is-sm"
                            onClick={() => {
                              setMarkingDocId(null);
                              setDocPublishedUrl('');
                            }}
                          >
                            {t('actionPlan.readerDrawerClose')}
                          </button>
                          <button
                            type="button"
                            className="ost-btn-primary is-sm"
                            disabled={Boolean(busyDocId)}
                            onClick={() => void handleMarkDocPublished(runIdForDoc, d)}
                          >
                            <Check size={13} />
                            <span>{t('actionPlan.confirmPublishedBtn')}</span>
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="oap-card-actions">
                      <button
                        type="button"
                        className="ost-btn-secondary is-sm"
                        disabled={Boolean(busyDocId)}
                        onClick={() => void handleSkipDoc(runIdForDoc, d.id)}
                      >
                        {t('actionPlan.skipCardBtn')}
                      </button>

                      <button
                        type="button"
                        className="ost-btn-secondary is-sm"
                        onClick={() => {
                          setReadingTab('after');
                          setLangVariant('default');
                          setReaderState({ runId: runIdForDoc, deliverable: d });
                        }}
                      >
                        <BookOpen size={13} />
                        <span>
                          {isExt
                            ? t('actionPlan.previewArticleBtn')
                            : t('actionPlan.previewDocBtn')}
                        </span>
                      </button>

                      {isRepoDoc ? (
                        <button
                          type="button"
                          className="ost-btn-primary is-sm"
                          disabled={Boolean(busyDocId)}
                          onClick={() => void handleOneClickPushToGitHub(runIdForDoc, d)}
                        >
                          {isBusy && busyDocOp === 'push' ? (
                            <Loader2 size={14} className="ost-spin" />
                          ) : (
                            <Upload size={14} />
                          )}
                          <span>
                            {isBusy && busyDocOp === 'push'
                              ? t('actionPlan.pushingGithubBtn')
                              : t('actionPlan.pushGithubOneStepBtn')}
                          </span>
                        </button>
                      ) : (
                        <>
                          {!isMarking && (
                            <button
                              type="button"
                              className="ost-btn-secondary is-sm"
                              disabled={Boolean(busyDocId)}
                              onClick={() => {
                                setMarkingDocId(d.id);
                                setDocPublishedUrl('');
                              }}
                            >
                              <Check size={13} />
                              <span>{t('actionPlan.confirmPublishedBtn')}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            className="ost-btn-primary is-sm"
                            disabled={Boolean(busyDocId)}
                            onClick={() => void handleOpenExternalInEgo(d)}
                          >
                            {isBusy && busyDocOp === 'ego' ? (
                              <Loader2 size={14} className="ost-spin" />
                            ) : (
                              <ExternalLink size={14} />
                            )}
                            <span>
                              {isBusy && busyDocOp === 'ego'
                                ? t('actionPlan.openingPublishPageBtn')
                                : t('actionPlan.openPublishPageBtn')}
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* SECTION 2: High-Leverage Outreach & AI-Cited Lists (promoted to top when pending docs = 0) */}
      <section className="oap-section" aria-label={t('actionPlan.outreachSectionTitle')}>
        <div className="oap-section-head">
          <h2>{t('actionPlan.outreachSectionTitle')}</h2>
          <p>{t('actionPlan.outreachSectionDesc')}</p>
        </div>

        <OutreachActionCards
          projectId={projectId}
          lang={uiLanguage}
          actions={activeOutreach}
          loading={outreachLoading}
          highlightFirst={!showDocsSection && activeOutreach.length > 0}
          onActionsUpdated={setOutreachActions}
          onError={setError}
          onNotice={setNotice}
        />
      </section>

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

        return (
          <div
            className="oap-drawer-backdrop"
            role="dialog"
            aria-modal="true"
            aria-label={deliverable.title}
            onClick={() => setReaderState(null)}
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
                  <button
                    type="button"
                    className="oap-drawer-close"
                    aria-label={t('actionPlan.readerDrawerClose')}
                    onClick={() => setReaderState(null)}
                  >
                    <X size={18} />
                  </button>
                </div>
              </header>

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
                          ) : entry.sourceKind === 'repo_meta' ? (
                            <Settings2 size={11} />
                          ) : entry.sourceKind === 'community_post' ? (
                            <MessageSquarePlus size={11} />
                          ) : (
                            <GitCommit size={11} />
                          )}
                          {entry.sourceKind === 'awesome_pr'
                            ? t('actionPlan.awesomeBadge')
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

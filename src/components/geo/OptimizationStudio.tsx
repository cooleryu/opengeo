'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Globe,
  Loader2,
  MessageSquareQuote,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import type { HumanProgressStep } from '@/lib/agent-hub';
import type { OptimizationRunStatus } from '@/lib/geo/db/schema';
import type {
  OptimizationDeliverable,
  OptimizationRun,
  OptimizationRunViewModel,
} from '@/lib/geo/optimization/types';
import {
  buildExternalMarkdown,
  buildExternalRichHtml,
  copyRichHtmlToClipboard,
  extractArticleTitle,
} from '@/lib/geo/optimization/external-export';
import { auditRows, isAiAnswerRow } from '@/lib/geo/overview-metrics';
import { RESEARCH_ENGINES } from '@/lib/geo/research-engines';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
} from '@/lib/geo/research-types';
import { getResearchRows } from '@/lib/geo/research-view';
import AnswerText from './AnswerText';
import DeliverableArticleView, {
  estimateReadingMinutes,
  getDeliverableRoleLabel,
} from './DeliverableArticleView';
import GeoSelect from './GeoSelect';
import ResearchEngineIcon from './ResearchEngineIcon';
import { useChineseCompanionPreference, useUiLanguage } from './UiLanguageContext';
import './optimization-studio.css';

function getPlatformName(engine: ResearchEngine, isEn = false): string {
  if (engine === 'qwen') return isEn ? 'Qwen' : '千问';
  if (engine === 'doubao') return isEn ? 'Doubao' : '豆包';
  if (engine === 'chatgpt') return 'ChatGPT';
  if (engine === 'google') return 'Google';
  return 'DeepSeek';
}

const REPO_DOC_PATH_RE = /^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html))$/i;

function isRepoDocDestinationPath(destination?: string | null): boolean {
  const trimmed = (destination || '').trim();
  if (!trimmed) return false;
  const blobMatch = trimmed.match(/^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/i);
  const candidate = blobMatch ? decodeURIComponent(blobMatch[1]) : trimmed.replace(/^\/+/, '');
  return REPO_DOC_PATH_RE.test(candidate);
}

function formatIndexingWindow(isoDate?: string): string {
  const base = isoDate ? new Date(isoDate) : new Date();
  const validBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const start = new Date(validBase.getTime() + 3 * 24 * 60 * 60 * 1000);
  const end = new Date(validBase.getTime() + 7 * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${fmt(start)}—${fmt(end)}`;
}

function verdictBadgeText(v: 'yes' | 'no' | 'unknown' | 'unmeasured'): string {
  if (v === 'yes') return '已提及';
  if (v === 'no') return '未提及';
  if (v === 'unknown') return '待核实';
  return '未测';
}

export interface OptimizationStudioProps {
  projectId: string;
  projectName: string;
  repositoryUrl?: string;
  selectedRunId?: string;
  batch?: ResearchBatch | null;
  onBackOverview: () => void;
  onOpenQuestions: () => void;
  onSelectRun?: (runId: string) => void;
  onStatusChange?: (viewModel: OptimizationRunViewModel | null) => void;
}

export default function OptimizationStudio({
  projectId,
  projectName,
  repositoryUrl,
  selectedRunId,
  batch,
  onBackOverview,
  onOpenQuestions,
  onSelectRun,
  onStatusChange,
}: OptimizationStudioProps) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [includeChineseCompanion, setIncludeChineseCompanion] =
    useChineseCompanionPreference();
  const [viewModel, setViewModel] = useState<OptimizationRunViewModel | null>(null);
  const [runs, setRuns] = useState<OptimizationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDelivIdx, setActiveDelivIdx] = useState(0);
  const [readingTab, setReadingTab] = useState<'after' | 'before'>('after');
  const [langVariant, setLangVariant] = useState<'default' | string>('default');
  const [copied, setCopied] = useState(false);
  const [copiedExtraKind, setCopiedExtraKind] = useState<'none' | 'title' | 'rich'>('none');
  const [generatingZhId, setGeneratingZhId] = useState<string | null>(null);

  // Streaming / action states
  const [submitting, setSubmitting] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState<OptimizationRunStatus | null>(null);
  const [streamingSteps, setStreamingSteps] = useState<HumanProgressStep[]>([]);
  const [error, setError] = useState('');
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  // Publish / Adopt modal states
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [applyChoice, setApplyChoice] = useState<'project_doc' | 'github_push' | 'external'>('project_doc');
  const [publishedUrl, setPublishedUrl] = useState('');
  const [applyNote, setApplyNote] = useState('');
  const [applying, setApplying] = useState(false);
  const [pushingGithub, setPushingGithub] = useState(false);
  const [pushBannerNote, setPushBannerNote] = useState('');

  // Retest states
  const [showRetestManual, setShowRetestManual] = useState(false);
  const [retestMode, setRetestMode] = useState<'live' | 'paste'>('live');
  const [liveProvider, setLiveProvider] = useState<'qwen' | 'doubao'>('qwen');
  const [pasteQuestionId, setPasteQuestionId] = useState('');
  const [pasteEngine, setPasteEngine] = useState<ResearchEngine>('chatgpt');
  const [pasteAnswer, setPasteAnswer] = useState('');
  const [pasteUrl, setPasteUrl] = useState('');
  const [retesting, setRetesting] = useState(false);

  // Original AI Answer inspection modal
  const [inspectedQuestion, setInspectedQuestion] = useState<ResearchQuestion | null>(null);

  const statusCallbackRef = useRef(onStatusChange);
  statusCallbackRef.current = onStatusChange;
  const initializedRunIdRef = useRef<string | null>(null);

  const loadData = useCallback(
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
        const nextRunId = nextVm?.run?.id ?? null;
        if (nextRunId && initializedRunIdRef.current !== nextRunId) {
          initializedRunIdRef.current = nextRunId;
          const firstReadyIdx =
            nextVm?.run?.deliverables.findIndex((d) => d.status === 'ready') ?? -1;
          setActiveDelivIdx(firstReadyIdx >= 0 ? firstReadyIdx : 0);
        }
        setViewModel(nextVm);
        setRuns(payload.runs ?? []);
        statusCallbackRef.current?.(nextVm);
      } catch {
        // Keep last state on transient error
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [projectId, selectedRunId],
  );

  useEffect(() => {
    initializedRunIdRef.current = null;
    setLoading(true);
    setError('');
    setActiveDelivIdx(0);
    setReadingTab('after');
    setLangVariant('default');
    setPushBannerNote('');
    setShowRetestManual(false);
    setConfirmRegenerate(false);
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  const run = viewModel?.run ?? null;
  const effectiveStatus = streamingStatus ?? run?.status ?? null;
  const isWorking =
    submitting ||
    (effectiveStatus !== null &&
      ['planning', 'drafting', 'reviewing', 'implementing', 'remeasuring'].includes(
        effectiveStatus,
      ));

  useEffect(() => {
    if (!isWorking || submitting || retesting || applying) return;
    const timer = setInterval(() => {
      void loadData();
    }, 3000);
    return () => clearInterval(timer);
  }, [isWorking, submitting, retesting, applying, loadData]);

  useEffect(() => {
    if (!applyModalOpen && !inspectedQuestion) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setApplyModalOpen(false);
        setInspectedQuestion(null);
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [applyModalOpen, inspectedQuestion]);

  const deliverables = run?.deliverables ?? [];
  const repoBranch =
    deliverables.find((d) => d.appliedRecord?.branch)?.appliedRecord?.branch || 'main';
  const activeDeliverable: OptimizationDeliverable | null =
    deliverables[activeDelivIdx] ?? deliverables[0] ?? null;
  const isExternalArticle = activeDeliverable
    ? activeDeliverable.kind === 'new_content' &&
      getDeliverableRoleLabel(activeDeliverable, 'zh') === '公开获客文章'
    : false;
  const isExternalExportActive = isExternalArticle && readingTab === 'after';
  const activeCompanions = activeDeliverable?.companionFiles ?? [];
  const repoSyncCompanions = activeCompanions.filter((c) => !c.reviewOnly);
  const hasZhCompanion = activeCompanions.some((c) => c.lang.toLowerCase().startsWith('zh'));
  const activeCompanion =
    langVariant !== 'default'
      ? activeCompanions.find((c) => c.lang === langVariant)
      : undefined;
  const isViewingZhCompanion = Boolean(
    activeCompanion && activeCompanion.lang.toLowerCase().startsWith('zh'),
  );
  const copyButtonLabel = copied
    ? isExternalExportActive
      ? isEn
        ? 'Markdown Copied'
        : isViewingZhCompanion
          ? '已复制中文 Markdown'
          : '已复制外发 Markdown'
      : isEn
        ? 'Copied'
        : isViewingZhCompanion
          ? '已复制中文版'
          : '已复制本篇'
    : isExternalExportActive
      ? isEn
        ? 'Copy Markdown'
        : isViewingZhCompanion
          ? '一键复制中文 Markdown'
          : '一键复制外发 Markdown'
      : isEn
        ? 'Copy Markdown'
        : isViewingZhCompanion
          ? '复制中文全文'
          : '复制本篇全文';
  const previewContent =
    readingTab === 'before'
      ? activeDeliverable?.beforeContent
      : activeCompanion
        ? activeCompanion.content
        : undefined;
  const previewDestination = activeCompanion
    ? activeCompanion.path
    : activeDeliverable?.destination;
  const hasRepoSlug = Boolean(
    repositoryUrl && /github\.com\/[^/]+\/[^/]+/i.test(repositoryUrl),
  );
  const activeIsRepoDoc = Boolean(
    activeDeliverable &&
      isRepoDocDestinationPath(
        activeDeliverable.appliedRecord?.destination || activeDeliverable.destination,
      ),
  );

  // Map covered questions with audited observations from batch
  const allAuditedRows = useMemo(() => {
    if (!batch) return [];
    return auditRows(
      batch,
      RESEARCH_ENGINES.flatMap((engine) =>
        getResearchRows(batch, {
          language: 'zh',
          kind: 'all',
          engine,
          result: 'all',
        }),
      ),
      batch.answerAudits ?? [],
    );
  }, [batch]);

  const coveredQuestions = useMemo(() => {
    if (!batch || !activeDeliverable) return [];
    const idSet = new Set(activeDeliverable.questionIds);
    return batch.questions.filter((q) => idSet.has(q.id));
  }, [batch, activeDeliverable]);

  useEffect(() => {
    if (!pasteQuestionId && coveredQuestions.length > 0) {
      setPasteQuestionId(coveredQuestions[0].id);
    }
  }, [coveredQuestions, pasteQuestionId]);

  const executeStreamAction = async (action: 'start' | 'retry', targetRunId?: string) => {
    if (submitting || !projectId) return;
    setSubmitting(true);
    setConfirmRegenerate(false);
    setError('');
    setStreamingSteps([]);
    setStreamingStatus(action === 'retry' ? 'drafting' : 'planning');

    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify({
          projectId,
          action,
          mode: 'deep',
          includeChineseCompanion: uiLanguage === 'zh' ? includeChineseCompanion : false,
          ...(targetRunId ? { runId: targetRunId } : {}),
        }),
      });

      if (!res.ok || !res.body) {
        const fallback = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(fallback.error || '启动内容准备失败，请稍后重试。');
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
            | { type: 'error'; error: string };

          if (evt.type === 'progress') {
            setStreamingStatus(evt.runStatus);
            setStreamingSteps((prev) => [...prev.slice(-8), evt.step]);
          } else if (evt.type === 'result') {
            setViewModel(evt.viewModel);
            if (evt.runs) setRuns(evt.runs);
            statusCallbackRef.current?.(evt.viewModel);
            setStreamingStatus(null);
            if (evt.viewModel.run?.id) onSelectRun?.(evt.viewModel.run.id);
          } else if (evt.type === 'error') {
            setError(evt.error);
          }
        }
      }
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : '内容生成中断，请稍后重试。');
    } finally {
      setSubmitting(false);
      setStreamingStatus(null);
    }
  };

  const getActiveExportOptions = () => {
    const raw = activeCompanion
      ? activeCompanion.content
      : readingTab === 'before'
        ? activeDeliverable?.beforeContent || ''
        : activeDeliverable?.afterContent || '';
    return {
      markdown: raw,
      destination: previewDestination || activeDeliverable?.destination || '',
      repositoryUrl,
      branch: repoBranch,
    };
  };

  const handleCopyFullArticle = async () => {
    if (!activeDeliverable) return;
    try {
      const opts = getActiveExportOptions();
      const contentToCopy = isExternalExportActive
        ? buildExternalMarkdown(opts)
        : opts.markdown;
      await navigator.clipboard.writeText(contentToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleCopyTitle = async () => {
    if (!activeDeliverable) return;
    try {
      const opts = getActiveExportOptions();
      await navigator.clipboard.writeText(
        extractArticleTitle(opts.markdown, activeDeliverable.title),
      );
      setCopiedExtraKind('title');
      setTimeout(() => setCopiedExtraKind('none'), 2200);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleCopyRichText = async () => {
    if (!activeDeliverable) return;
    try {
      const opts = getActiveExportOptions();
      const html = buildExternalRichHtml(opts);
      const plain = buildExternalMarkdown(opts);
      await copyRichHtmlToClipboard(html, plain);
      setCopiedExtraKind('rich');
      setTimeout(() => setCopiedExtraKind('none'), 2200);
    } catch {
      // Ignore clipboard restriction
    }
  };

  const handleGenerateZhCompanion = async (deliverableId: string) => {
    if (!run || generatingZhId) return;
    setGeneratingZhId(deliverableId);
    setError('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'generate_zh_companion',
          runId: run.id,
          deliverableId,
        }),
      });
      const payload = (await res.json()) as {
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
            : '生成中文对照版失败，请稍后重试。',
      );
    } finally {
      setGeneratingZhId(null);
    }
  };

  const handlePushToGitHub = async (targetIds?: string[]) => {
    if (!run || pushingGithub) return false;
    setPushingGithub(true);
    setError('');
    setPushBannerNote('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'push_github',
          runId: run.id,
          ...(targetIds?.length ? { deliverableIds: targetIds } : {}),
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        viewModel?: OptimizationRunViewModel;
        runs?: OptimizationRun[];
      };
      if (!res.ok) {
        throw new Error(payload.error || '推送到 GitHub 未能成功，请检查本机 Git/GitHub 登录状态。');
      }
      if (payload.viewModel) {
        setViewModel(payload.viewModel);
        statusCallbackRef.current?.(payload.viewModel);
        const latestNote = payload.viewModel.run?.deliverables
          .find((d) => d.appliedRecord?.mode === 'github_pushed')
          ?.appliedRecord?.note;
        if (latestNote) setPushBannerNote(latestNote);
      }
      if (payload.runs) setRuns(payload.runs);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '推送 GitHub 失败，请稍后重试。');
      return false;
    } finally {
      setPushingGithub(false);
    }
  };

  const sendSingleDecision = async (decision: {
    deliverableId: string;
    action: 'apply' | 'skip';
    writeLocalFile?: boolean;
    publishedUrl?: string;
    note?: string;
  }) => {
    if (!run || applying) return false;
    setApplying(true);
    setError('');
    try {
      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          action: 'apply',
          runId: run.id,
          decisions: [decision],
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        viewModel?: OptimizationRunViewModel;
        runs?: OptimizationRun[];
      };
      if (!res.ok) {
        throw new Error(payload.error || '保存决定时未能成功，请重试。');
      }
      if (payload.viewModel) {
        setViewModel(payload.viewModel);
        statusCallbackRef.current?.(payload.viewModel);
      }
      if (payload.runs) setRuns(payload.runs);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请重试。');
      return false;
    } finally {
      setApplying(false);
    }
  };

  const handleConfirmApply = async () => {
    if (!activeDeliverable) return;
    const writeLocal = applyChoice === 'project_doc' || applyChoice === 'github_push';
    const ok = await sendSingleDecision({
      deliverableId: activeDeliverable.id,
      action: 'apply',
      writeLocalFile: writeLocal,
      ...(publishedUrl.trim() ? { publishedUrl: publishedUrl.trim() } : {}),
      ...(applyNote.trim() ? { note: applyNote.trim() } : {}),
    });
    if (ok) {
      setApplyModalOpen(false);
      setPublishedUrl('');
      setApplyNote('');
      if (applyChoice === 'github_push') {
        await handlePushToGitHub([activeDeliverable.id]);
      }
    }
  };

  const handleSkipDeliverable = async () => {
    if (!activeDeliverable) return;
    await sendSingleDecision({
      deliverableId: activeDeliverable.id,
      action: 'skip',
    });
  };

  const handleRunRetest = async () => {
    if (!run || retesting) return;
    if (retestMode === 'paste' && !pasteAnswer.trim()) {
      setError('请先粘贴 AI 平台给出的最新回答正文。');
      return;
    }
    setRetesting(true);
    setError('');
    try {
      const bodyPayload =
        retestMode === 'live'
          ? {
              projectId,
              action: 'retest',
              runId: run.id,
              liveProvider,
            }
          : {
              projectId,
              action: 'retest',
              runId: run.id,
              capturedAnswers: [
                {
                  questionId:
                    pasteQuestionId ||
                    coveredQuestions[0]?.id ||
                    batch?.questions[0]?.id ||
                    '',
                  engine: pasteEngine,
                  language: 'zh' as const,
                  answerText: pasteAnswer.trim(),
                  citations: pasteUrl.trim()
                    ? [{ title: pasteUrl.trim(), url: pasteUrl.trim() }]
                    : [],
                  citationSource: pasteUrl.trim() ? ('native' as const) : ('none' as const),
                  citationsComplete: Boolean(pasteUrl.trim()),
                },
              ],
            };

      const res = await fetch('/api/geo/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload),
      });
      const payload = (await res.json()) as {
        error?: string;
        viewModel?: OptimizationRunViewModel;
        runs?: OptimizationRun[];
      };
      if (!res.ok) {
        throw new Error(payload.error || '原题重测未能完成，请检查平台配置或稍后重试。');
      }
      if (payload.viewModel) {
        setViewModel(payload.viewModel);
        statusCallbackRef.current?.(payload.viewModel);
      }
      if (payload.runs) setRuns(payload.runs);
      setPasteAnswer('');
      setPasteUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '重测异常，请稍后重试。');
    } finally {
      setRetesting(false);
    }
  };

  const hasAnyApplied = deliverables.some((d) => d.status === 'applied');
  const appliedCount = deliverables.filter((d) => d.status === 'applied').length;
  const localUnpushedRepoDocs = deliverables.filter(
    (d) =>
      d.status === 'applied' &&
      d.appliedRecord?.mode === 'local_file' &&
      isRepoDocDestinationPath(d.appliedRecord.destination || d.destination),
  );
  const localUnpushedCount = localUnpushedRepoDocs.length;
  const pushedOrExternalApplied = deliverables.filter(
    (d) =>
      d.status === 'applied' &&
      (d.appliedRecord?.mode === 'github_pushed' ||
        d.appliedRecord?.mode === 'external_published'),
  );
  const latestOnlineAt = pushedOrExternalApplied
    .map((d) => d.appliedRecord?.appliedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
  const allLocalOnly = localUnpushedCount > 0 && pushedOrExternalApplied.length === 0;
  const nextReadyIdx = deliverables.findIndex(
    (d, idx) => idx !== activeDelivIdx && d.status === 'ready',
  );
  const showRetestWorkbench =
    !isWorking &&
    Boolean(run) &&
    (showRetestManual ||
      (effectiveStatus === 'awaiting_retest' && pushedOrExternalApplied.length > 0));

  // Determine 3-stage journey index
  const journeyStage: 1 | 2 | 3 | 4 =
    effectiveStatus === 'completed'
      ? 4
      : showRetestWorkbench || effectiveStatus === 'remeasuring'
        ? 3
        : effectiveStatus === 'implementing' || hasAnyApplied
          ? 2
          : 1;

  if (loading && !viewModel) {
    return (
      <div className="ost-shell">
        <div className="ost-loading">
          <Loader2 size={20} className="ost-spin" />
          <span>{isEn ? 'Loading optimization workbench…' : '正在打开改进内容工作台…'}</span>
        </div>
      </div>
    );
  }

  const progressSteps = streamingSteps.length ? streamingSteps : (run?.progress ?? []);
  const latestProgress = progressSteps[progressSteps.length - 1] ?? null;
  const retestSummary = viewModel?.retestComparison ?? null;
  const questionTotal = batch?.questions.length ?? 0;

  return (
    <div className="ost-shell">
      {/* Top Studio Header + Clean 3-Step Human Journey */}
      <header className="ost-topbar">
        <div className="ost-title-left">
          <button
            type="button"
            className="ost-back-btn"
            onClick={onBackOverview}
          >
            <ArrowLeft size={15} />
            <span>{isEn ? 'Overview' : '概览'}</span>
          </button>
          <span className="ost-title-divider" aria-hidden="true">
            /
          </span>
          <h1>{isEn ? 'Improvements & Tracking' : '改进与追踪'}</h1>

          {runs.length > 1 && run && (
            <div className="ost-run-picker">
              <GeoSelect
                label={isEn ? 'Switch run' : '切换改进轮次'}
                value={run.id}
                onChange={(nextId) => onSelectRun?.(nextId)}
                options={runs.map((item, idx) => ({
                  value: item.id,
                  label: isEn
                    ? `Run ${runs.length - idx} · ${item.deliverables[0]?.title?.slice(0, 18) || 'Optimization'}`
                    : `第 ${runs.length - idx} 轮 · ${item.deliverables[0]?.title?.slice(0, 16) || '内容改进'}`,
                }))}
              />
            </div>
          )}
        </div>

        {run && (
          <ol className="ost-journey" aria-label={isEn ? '3-step optimization progress' : '改进三步进度'}>
            <li
              className={
                journeyStage > 1 ? 'is-done' : journeyStage === 1 ? 'is-current' : ''
              }
            >
              <span className="ost-j-dot">
                {journeyStage > 1 ? <Check size={11} strokeWidth={3} /> : '1'}
              </span>
              <span>{isEn ? 'Review drafts' : '审阅成稿'}</span>
            </li>
            <li className="ost-j-line" aria-hidden="true" />
            <li
              className={
                journeyStage > 2 ? 'is-done' : journeyStage === 2 ? 'is-current' : ''
              }
            >
              <span className="ost-j-dot">
                {journeyStage > 2 ? <Check size={11} strokeWidth={3} /> : '2'}
              </span>
              <span>{isEn ? 'Adopt & publish' : '采用发布'}</span>
            </li>
            <li className="ost-j-line" aria-hidden="true" />
            <li
              className={
                journeyStage > 3 ? 'is-done' : journeyStage === 3 ? 'is-current' : ''
              }
            >
              <span className="ost-j-dot">
                {journeyStage > 3 ? <Check size={11} strokeWidth={3} /> : '3'}
              </span>
              <span>{isEn ? 'Re-audit' : '原题重测'}</span>
            </li>
          </ol>
        )}
      </header>

      {error && (
        <div className="ost-alert" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError('')}>
            {isEn ? 'Dismiss' : '知道了'}
          </button>
        </div>
      )}

      {/* CASE 1: No optimization run yet */}
      {!run && !isWorking && (
        <section className="ost-empty-hero">
          <div className="ost-empty-badge">
            <Sparkles size={14} />
            <span>{isEn ? 'From visibility gaps to cited content' : '从曝光缺口到获客内容'}</span>
          </div>
          <h2>
            {isEn
              ? 'Generate drafts built around what AI currently misses'
              : '先为你准备一篇能让 AI 找到并推荐你的图文内容'}
          </h2>
          <p>
            {isEn
              ? 'We analyze real ChatGPT and Google AI Overview answers, spot what competitors explain clearly that your public docs miss, and prepare complementary drafts for review. Nothing changes without approval.'
              : '我们会结合客户常问问题的真实回答，找出你目前公开介绍里缺失的一环，写好一篇图文并茂的成稿供你审阅。未经你确认，不会改动任何现有内容。'}
          </p>
          {questionTotal > 0 ? (
            <div className="ost-empty-actions">
              <button
                type="button"
                className="ost-btn-primary is-lg"
                onClick={() => void executeStreamAction('start')}
              >
                <span>{isEn ? 'Generate improvement drafts' : '开始准备第一篇改进内容'}</span>
                <ArrowRight size={16} />
              </button>
              {uiLanguage === 'zh' && (
                <label className="ost-companion-toggle">
                  <input
                    type="checkbox"
                    checked={includeChineseCompanion}
                    onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
                  />
                  <span>同时生成中文对照版</span>
                </label>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="ost-btn-primary is-lg"
              onClick={onOpenQuestions}
            >
              <span>{isEn ? 'Confirm customer prompts first' : '先去确认客户常问的问题'}</span>
              <ArrowRight size={16} />
            </button>
          )}
        </section>
      )}

      {/* CASE 2: Live Working Progress */}
      {isWorking && (
        <section className="ost-working-card" aria-live="polite">
          <div className="ost-working-head">
            <Loader2 size={18} className="ost-spin" />
            <div>
              <h2>
                {effectiveStatus === 'remeasuring'
                  ? '正在用原来的问题重新询问 AI，并对比前后变化…'
                  : '正在为你撰写并核对图文成稿，请稍候…'}
              </h2>
              <p>
                {latestProgress?.message ||
                  run?.statusMessage ||
                  '正在梳理真实问答依据与配图，完成后将自动展开全文。'}
              </p>
            </div>
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

      {/* CASE 3: Failed / Paused */}
      {!isWorking && effectiveStatus === 'failed' && run && (
        <section className="ost-decision-banner is-warn">
          <div className="ost-decision-copy">
            <strong>
              {isEn
                ? 'Generation paused mid-run — completed drafts were preserved'
                : '刚才的内容准备中途停下了，已完成的部分已自动保留'}
            </strong>
            <p>
              {run.errorMessage ||
                (isEn
                  ? 'Temporary timeout occurred. Click the button on the right to continue.'
                  : '网络响应暂时超时，直接点右侧按钮就能接着往下完成。')}
            </p>
          </div>
          <div className="ost-decision-actions">
            {uiLanguage === 'zh' && (
              <label className="ost-companion-toggle">
                <input
                  type="checkbox"
                  checked={includeChineseCompanion}
                  onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
                />
                <span>同时生成中文对照版</span>
              </label>
            )}
            <button
              type="button"
              className="ost-btn-primary"
              onClick={() => void executeStreamAction('retry', run.id)}
            >
              <RotateCcw size={15} />
              <span>{isEn ? 'Continue from last step' : '接着刚才的进度继续'}</span>
            </button>
          </div>
        </section>
      )}

      {/* TOP PACKAGE PIECE CARDS: Crisp 1-click switcher when multiple complementary pieces exist */}
      {!isWorking && deliverables.length > 1 && (
        <section
          className="ost-piece-strip"
          role="tablist"
          aria-label={isEn ? 'Deliverable package drafts' : '本轮配套改进方案篇目'}
        >
          {deliverables.map((d, idx) => {
            const isSelected = idx === activeDelivIdx;
            const roleLabel = getDeliverableRoleLabel(d, uiLanguage);
            const mins = estimateReadingMinutes(d.afterContent);
            const statusText =
              d.status === 'applied'
                ? d.appliedRecord?.mode === 'local_file'
                  ? (isEn ? 'Pending push' : '待推送上线')
                  : d.appliedRecord?.mode === 'github_pushed'
                    ? (isEn ? 'Pushed' : '已推送上线')
                    : (isEn ? 'Published' : '已发布')
                : d.status === 'skipped'
                  ? (isEn ? 'Skipped' : '暂不采用')
                  : (isEn ? 'Ready' : '待审阅');
            return (
              <button
                key={d.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                className={`ost-piece-card ${isSelected ? 'is-active' : ''} is-status-${d.status}`}
                onClick={() => {
                  setActiveDelivIdx(idx);
                  setReadingTab('after');
                  setLangVariant('default');
                }}
              >
                <div className="ost-piece-top">
                  <span className="ost-piece-role">
                    <b>{idx + 1}</b>
                    <span>{roleLabel}</span>
                  </span>
                  <span className={`ost-piece-badge is-${d.status}`}>
                    {d.status === 'applied' && <Check size={11} strokeWidth={2.8} />}
                    <span>{statusText}</span>
                  </span>
                </div>
                <strong className="ost-piece-title">{d.title}</strong>
                <span className="ost-piece-meta">
                  {isEn
                    ? `Addresses ${d.questionIds.length} prompts · ~${mins} min read`
                    : `回应 ${d.questionIds.length} 道客户问题 · 约 ${mins} 分钟读完`}
                </span>
              </button>
            );
          })}
        </section>
      )}

      {/* PER-PIECE DECISION BAR: Non-coercive, always lets user adopt or skip THIS piece independently */}
      {!isWorking &&
        run &&
        activeDeliverable &&
        (effectiveStatus === 'awaiting_approval' ||
          effectiveStatus === 'awaiting_retest' ||
          effectiveStatus === 'completed') && (
          <section className="ost-decision-banner" aria-label={isEn ? 'Draft actions' : '当前篇目操作栏'}>
            {activeDeliverable.status === 'ready' ? (
              <>
                <div className="ost-decision-copy">
                  <strong>
                    {deliverables.length > 1
                      ? isEn
                        ? `Reviewing draft #${activeDelivIdx + 1}: adopt individually whenever ready`
                        : `正在看第 ${activeDelivIdx + 1} 篇：觉得合适可单独采用，不必一次全发`
                      : isEn
                        ? 'Read the full draft below and adopt when ready'
                        : '先通读下面的图文全文，觉得合适就可以采用发布'}
                  </strong>
                  <p>
                    {isEn
                      ? `Addresses ${coveredQuestions.length || activeDeliverable.questionIds.length} unmentioned prompts · Nothing changes without your confirmation`
                      : `回应 ${coveredQuestions.length || activeDeliverable.questionIds.length} 道未提及的客户问题 · 未经你确认不会改动任何现有内容`}
                  </p>
                </div>
                <div className="ost-decision-actions">
                  <button
                    type="button"
                    className="ost-btn-secondary"
                    onClick={() => void handleCopyFullArticle()}
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />}
                    <span>{copyButtonLabel}</span>
                  </button>
                  {deliverables.length > 1 && (
                    <button
                      type="button"
                      className="ost-btn-secondary"
                      disabled={applying}
                      onClick={() => void handleSkipDeliverable()}
                    >
                      <span>{isEn ? 'Skip for now' : '这篇暂不采用'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ost-btn-primary"
                    disabled={applying}
                    onClick={() => {
                      setApplyChoice(isExternalArticle ? 'external' : 'project_doc');
                      setApplyModalOpen(true);
                    }}
                  >
                    <span>
                      {deliverables.length > 1
                        ? (isEn ? 'Adopt this draft' : '采用这一篇')
                        : (isEn ? 'Confirm & adopt' : '确认采用这篇内容')}
                    </span>
                    <ArrowRight size={15} />
                  </button>
                </div>
              </>
            ) : activeDeliverable.status === 'applied' ? (
              activeDeliverable.appliedRecord?.mode === 'local_file' ? (
                <>
                  <div className="ost-decision-copy">
                    <strong>
                      {isEn
                        ? `✓ Draft #${activeDelivIdx + 1} saved locally · Pending push to GitHub`
                        : `✓ 第 ${activeDelivIdx + 1} 篇已保存至本机文件 · 尚未推送到 GitHub 线上仓库`}
                    </strong>
                    <p>
                      {isEn
                        ? `Written to ${activeDeliverable.appliedRecord.destination}${repoSyncCompanions.length > 0 ? ` (with ${repoSyncCompanions.map((c) => c.path).join(', ')})` : ''}. Push to the default branch so search engines and AI can index the update.`
                        : `已写入本机 ${activeDeliverable.appliedRecord.destination}${repoSyncCompanions.length > 0 ? `（含 ${repoSyncCompanions.map((c) => c.path).join('、')}）` : ''}。本机改动不会自动上线，推送到 GitHub 默认分支后搜索引擎与 AI 才能抓取。`}
                    </p>
                  </div>
                  <div className="ost-decision-actions">
                    <button
                      type="button"
                      className="ost-btn-secondary"
                      onClick={() => void handleCopyFullArticle()}
                    >
                      {copied ? <Check size={15} /> : <Copy size={15} />}
                      <span>{copyButtonLabel}</span>
                    </button>
                    {nextReadyIdx >= 0 && (
                      <button
                        type="button"
                        className="ost-btn-secondary"
                        onClick={() => {
                          setActiveDelivIdx(nextReadyIdx);
                          setReadingTab('after');
                          setLangVariant('default');
                        }}
                      >
                        <span>{isEn ? 'Next draft' : '看下一篇待审稿'}</span>
                      </button>
                    )}
                    {hasRepoSlug && localUnpushedCount > 0 && (
                      <button
                        type="button"
                        className="ost-btn-primary"
                        disabled={pushingGithub}
                        onClick={() =>
                          void handlePushToGitHub(localUnpushedRepoDocs.map((d) => d.id))
                        }
                      >
                        {pushingGithub ? (
                          <Loader2 size={15} className="ost-spin" />
                        ) : (
                          <Upload size={15} />
                        )}
                        <span>
                          {pushingGithub
                            ? (isEn ? 'Pushing to GitHub…' : '正在推送到 GitHub…')
                            : isEn
                              ? `Push ${localUnpushedCount} doc set(s) to GitHub`
                              : `一键推送已采用的 ${localUnpushedCount} 套文档到 GitHub`}
                        </span>
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="ost-decision-copy">
                    <strong>
                      {activeDeliverable.appliedRecord?.mode === 'github_pushed'
                        ? isEn
                          ? `✓ Draft #${activeDelivIdx + 1} pushed · Waiting for search re-indexing`
                          : `✓ 第 ${activeDelivIdx + 1} 篇已推送上线 · 正在等待搜索引擎重新抓取收录`
                        : isEn
                          ? `✓ Draft #${activeDelivIdx + 1} marked published · Waiting for indexing`
                          : `✓ 第 ${activeDelivIdx + 1} 篇已登记公开发布 · 等待搜索引擎抓取收录`}
                    </strong>
                    <p>
                      {activeDeliverable.appliedRecord?.mode === 'github_pushed'
                        ? isEn
                          ? `Committed to GitHub ${activeDeliverable.appliedRecord.branch || 'main'} branch${activeDeliverable.appliedRecord.commitHash ? ` (${activeDeliverable.appliedRecord.commitHash})` : ''}. `
                          : `已提交至 GitHub ${activeDeliverable.appliedRecord.branch || 'main'} 分支${activeDeliverable.appliedRecord.commitHash ? `（${activeDeliverable.appliedRecord.commitHash}）` : ''}。`
                        : activeDeliverable.appliedRecord?.publishedUrl
                          ? isEn
                            ? `Published URL: ${activeDeliverable.appliedRecord.publishedUrl}. `
                            : `已登记发布地址：${activeDeliverable.appliedRecord.publishedUrl}。`
                          : ''}
                      {isEn
                        ? `Re-indexing usually takes 3–7 days — recommended re-audit around ${formatIndexingWindow(activeDeliverable.appliedRecord?.appliedAt)}.`
                        : `AI 搜索重建索引通常需要 3～7 天，建议 ${formatIndexingWindow(activeDeliverable.appliedRecord?.appliedAt)} 回来按原题复测；当下立刻重测多半仍命中旧缓存。`}
                    </p>
                  </div>
                  <div className="ost-decision-actions">
                    {activeDeliverable.appliedRecord?.publishedUrl ? (
                      <a
                        className="ost-btn-secondary"
                        href={activeDeliverable.appliedRecord.publishedUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <ExternalLink size={15} />
                        <span>{isEn ? 'Open live page' : '查看线上页面'}</span>
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="ost-btn-secondary"
                        onClick={() => void handleCopyFullArticle()}
                      >
                        {copied ? <Check size={15} /> : <Copy size={15} />}
                        <span>{copyButtonLabel}</span>
                      </button>
                    )}
                    {nextReadyIdx >= 0 && (
                      <button
                        type="button"
                        className="ost-btn-secondary"
                        onClick={() => {
                          setActiveDelivIdx(nextReadyIdx);
                          setReadingTab('after');
                          setLangVariant('default');
                        }}
                      >
                        <span>{isEn ? 'Next draft' : '看下一篇待审稿'}</span>
                      </button>
                    )}
                    {!showRetestWorkbench && (
                      <button
                        type="button"
                        className="ost-btn-secondary"
                        onClick={() => setShowRetestManual(true)}
                      >
                        <Clock size={15} />
                        <span>{isEn ? 'Re-audit early' : '仍要提前展开复测'}</span>
                      </button>
                    )}
                  </div>
                </>
              )
            ) : (
              <>
                <div className="ost-decision-copy">
                  <strong>
                    {isEn
                      ? `Draft #${activeDelivIdx + 1} skipped for now`
                      : `第 ${activeDelivIdx + 1} 篇已标为「暂不采用」`}
                  </strong>
                  <p>
                    {isEn
                      ? 'No changes made — the draft stays available if you want to adopt it later.'
                      : '未做任何改动，成稿草稿仍为你保留，随时可以改主意重新采用。'}
                  </p>
                </div>
                <div className="ost-decision-actions">
                  {nextReadyIdx >= 0 && (
                    <button
                      type="button"
                      className="ost-btn-secondary"
                      onClick={() => {
                        setActiveDelivIdx(nextReadyIdx);
                        setReadingTab('after');
                        setLangVariant('default');
                      }}
                    >
                      <span>{isEn ? 'Next draft' : '看下一篇待审稿'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="ost-btn-primary"
                    disabled={applying}
                    onClick={() => {
                      setApplyChoice(isExternalArticle ? 'external' : 'project_doc');
                      setApplyModalOpen(true);
                    }}
                  >
                    <span>{isEn ? 'Adopt now' : '重新采用这篇'}</span>
                  </button>
                </div>
              </>
            )}
          </section>
        )}

      {pushBannerNote && (
        <div className="ost-alert is-success" role="status">
          <span>✓ GitHub 推送完成：{pushBannerNote}</span>
          <button type="button" onClick={() => setPushBannerNote('')}>
            知道了
          </button>
        </div>
      )}

      {/* STAGE 3 WORKBENCH: Content adopted & published, observe 3-7 day indexing window before retest */}
      {showRetestWorkbench && run && (
        <section className="ost-retest-panel" aria-label="原题重测面板">
          <div className="ost-retest-top">
            <div>
              <span className="ost-pill-emerald">
                <Clock size={12} />{' '}
                {allLocalOnly
                  ? `已采用 ${appliedCount} 篇（尚未推送线上）`
                  : `已上线 ${pushedOrExternalApplied.length} 篇 · 建议 ${formatIndexingWindow(latestOnlineAt)} 复测`}
              </span>
              <h2>等搜索引擎收录生效后，再用原来的问题对比重测</h2>
              <p>
                {allLocalOnly
                  ? '提示：你采用的文档目前仅保存在本机，AI 搜索尚抓不到改动；建议先推送到 GitHub 再来重测。'
                  : `网页更新被搜索引擎与 AI 抓取建索引通常需要 3～7 天（建议 ${formatIndexingWindow(latestOnlineAt)} 来测）；保持与改进前一致的提问方式对比变化。`}
              </p>
            </div>

            <div className="ost-mode-tabs" role="tablist" aria-label="重测方式">
              <button
                type="button"
                role="tab"
                aria-selected={retestMode === 'live'}
                onClick={() => setRetestMode('live')}
              >
                联网平台一键重测
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={retestMode === 'paste'}
                onClick={() => setRetestMode('paste')}
              >
                粘贴网页端新回答
              </button>
            </div>
          </div>

          {retestMode === 'live' ? (
            <div className="ost-retest-live">
              <div className="ost-field-inline">
                <span>选择联网问答平台</span>
                <div className="ost-select-box">
                  <GeoSelect<'qwen' | 'doubao'>
                    label="联网重测平台"
                    value={liveProvider}
                    onChange={setLiveProvider}
                    options={[
                      { value: 'qwen', label: '千问（自动提问并核对引用）' },
                      { value: 'doubao', label: '豆包（自动提问并核对引用）' },
                    ]}
                  />
                </div>
              </div>
              <button
                type="button"
                className="ost-btn-primary"
                disabled={retesting}
                onClick={() => void handleRunRetest()}
              >
                {retesting ? (
                  <Loader2 size={15} className="ost-spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                <span>{retesting ? '正在逐题重测…' : '开始同题重测'}</span>
              </button>
            </div>
          ) : (
            <div className="ost-retest-paste">
              <div className="ost-paste-row">
                <label className="ost-field">
                  <span>哪道客户问题</span>
                  <GeoSelect
                    label="重测问题"
                    value={pasteQuestionId}
                    onChange={setPasteQuestionId}
                    options={(coveredQuestions.length
                      ? coveredQuestions
                      : (batch?.questions ?? [])
                    ).map((q) => ({
                      value: q.id,
                      label: q.zh || q.en,
                    }))}
                  />
                </label>
                <label className="ost-field is-narrow">
                  <span>在哪个平台问的</span>
                  <GeoSelect<ResearchEngine>
                    label="回答平台"
                    value={pasteEngine}
                    onChange={setPasteEngine}
                    options={[
                      { value: 'chatgpt', label: 'ChatGPT' },
                      { value: 'google', label: 'Google' },
                      { value: 'deepseek', label: 'DeepSeek' },
                      { value: 'qwen', label: '千问' },
                      { value: 'doubao', label: '豆包' },
                    ]}
                  />
                </label>
              </div>
              <label className="ost-field">
                <span>AI 给出的最新回答全文（建议用无痕窗口提问后粘贴）</span>
                <textarea
                  rows={4}
                  value={pasteAnswer}
                  onChange={(e) => setPasteAnswer(e.target.value)}
                  placeholder="把 AI 的最新回答直接粘贴到这里，系统会自动核对是否真实提到你…"
                />
              </label>
              <div className="ost-paste-foot">
                <input
                  type="url"
                  value={pasteUrl}
                  onChange={(e) => setPasteUrl(e.target.value)}
                  placeholder="选填：如果回答里附上了你的网站链接，粘贴在这里"
                />
                <button
                  type="button"
                  className="ost-btn-primary"
                  disabled={retesting || !pasteAnswer.trim()}
                  onClick={() => void handleRunRetest()}
                >
                  {retesting ? (
                    <Loader2 size={15} className="ost-spin" />
                  ) : (
                    <Check size={15} />
                  )}
                  <span>提交回答并查看前后对比</span>
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* STAGE 4 SCOREBOARD: Completed Before -> After Comparison */}
      {!isWorking && effectiveStatus === 'completed' && retestSummary && (
        <section className="ost-scoreboard" aria-label="改进前后对比结果">
          <div className="ost-score-head">
            <div>
              <span className="ost-pill-emerald">
                <Check size={12} /> 已完成同题对比
              </span>
              <h2>改进前后的 AI 回答变化</h2>
            </div>
            <button
              type="button"
              className="ost-btn-secondary"
              onClick={() => void executeStreamAction('start')}
            >
              <Sparkles size={14} />
              <span>针对其余问题开启下一轮</span>
            </button>
          </div>

          <div className="ost-score-kpis">
            <div className="ost-score-tile">
              <span>AI 回答提及</span>
              <div className="ost-score-nums">
                <em>改进前 {retestSummary.beforeMentionYes} 条</em>
                <ArrowRight size={15} />
                <strong>改进后 {retestSummary.afterMentionYes} 条</strong>
              </div>
            </div>
            <div className="ost-score-tile">
              <span>官网链接引用</span>
              <div className="ost-score-nums">
                <em>改进前 {retestSummary.beforeCitationYes} 条</em>
                <ArrowRight size={15} />
                <strong>改进后 {retestSummary.afterCitationYes} 条</strong>
              </div>
            </div>
          </div>

          <div className="ost-score-list">
            {retestSummary.items.map((item, idx) => (
              <div key={`${item.questionId}-${item.engine}-${idx}`} className="ost-score-row">
                <div className="ost-score-q">
                  <span className="ost-engine-chip">
                    <ResearchEngineIcon engine={item.engine} />
                    {getPlatformName(item.engine, isEn)}
                  </span>
                  <strong>{item.query}</strong>
                </div>
                <div className="ost-score-delta">
                  <span className={`ost-v-pill is-${item.beforeMention}`}>
                    前：{verdictBadgeText(item.beforeMention)}
                  </span>
                  <ArrowRight size={13} />
                  <span className={`ost-v-pill is-${item.afterMention}`}>
                    后：{verdictBadgeText(item.afterMention)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* MAIN 2-COLUMN EDITORIAL STUDIO: Left Paper Sheet + Right Human Context Rail */}
      {activeDeliverable && !isWorking && (
        <div className="ost-studio-grid">
          {/* Left Main Column: Magazine-Grade Article Sheet */}
          <div className="ost-paper-col">
            {(Boolean(activeDeliverable.beforeContent.trim()) ||
              activeCompanions.length > 0 ||
              (readingTab === 'after' && uiLanguage === 'zh')) && (
              <div className="ost-paper-toolbar">
                {Boolean(activeDeliverable.beforeContent.trim()) ? (
                  <div className="ost-compare-toggle" role="tablist" aria-label={isEn ? 'Compare draft vs original' : '对比版本'}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={readingTab === 'after'}
                      onClick={() => setReadingTab('after')}
                    >
                      {isEn ? 'Updated draft' : '阅读修改后新稿'}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={readingTab === 'before'}
                      onClick={() => setReadingTab('before')}
                    >
                      {isEn ? 'Original version' : '查看修改前原文'}
                    </button>
                  </div>
                ) : (
                  <span />
                )}
                {readingTab === 'after' && activeCompanions.length > 0 && (
                  <div className="ost-compare-toggle" role="tablist" aria-label={isEn ? 'Document language' : '文档语言版本'}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={langVariant === 'default'}
                      onClick={() => setLangVariant('default')}
                    >
                      {isExternalArticle || activeCompanions.every((c) => c.reviewOnly)
                        ? (isEn ? 'English' : 'English 原稿')
                        : `English（${activeDeliverable.destination.split('/').pop()}）`}
                    </button>
                    {activeCompanions.map((comp) => (
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
                            : '中文对照（审阅 / 中文平台另发）'
                          : `${comp.label}（${comp.path.split('/').pop()}）`}
                      </button>
                    ))}
                  </div>
                )}
                {readingTab === 'after' && !hasZhCompanion && uiLanguage === 'zh' && (
                  <button
                    type="button"
                    className="ost-gen-zh-btn"
                    disabled={generatingZhId === activeDeliverable.id}
                    onClick={() => void handleGenerateZhCompanion(activeDeliverable.id)}
                  >
                    {generatingZhId === activeDeliverable.id ? (
                      <Loader2 size={14} className="ost-spin" />
                    ) : (
                      <Sparkles size={14} />
                    )}
                    <span>
                      {generatingZhId === activeDeliverable.id ? '正在生成中文版…' : '生成中文对照版'}
                    </span>
                  </button>
                )}
              </div>
            )}

            <div className="ost-paper-sheet">
              <DeliverableArticleView
                projectId={projectId}
                deliverable={activeDeliverable}
                repositoryUrl={repositoryUrl}
                onNavigateRelativeDoc={(repoPath) => {
                  const normalizedTarget = repoPath.replace(/^\/+/, '').toLowerCase();
                  const directIdx = deliverables.findIndex(
                    (d) =>
                      d.destination.replace(/^\/+/, '').toLowerCase() === normalizedTarget,
                  );
                  if (directIdx >= 0) {
                    setActiveDelivIdx(directIdx);
                    setReadingTab('after');
                    setLangVariant('default');
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                    return true;
                  }
                  for (let idx = 0; idx < deliverables.length; idx += 1) {
                    const compMatch = deliverables[idx].companionFiles?.find(
                      (c) => c.path.replace(/^\/+/, '').toLowerCase() === normalizedTarget,
                    );
                    if (compMatch) {
                      setActiveDelivIdx(idx);
                      setReadingTab('after');
                      setLangVariant(compMatch.lang);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                      return true;
                    }
                  }
                  return false;
                }}
                showMetaStrip={readingTab === 'after'}
                hideCopyButton={false}
                externalExportMode={isExternalExportActive}
                branch={repoBranch}
                contentOverride={previewContent}
                destinationOverride={previewDestination}
              />
            </div>
          </div>

          {/* Right Sticky Column: Human Context & Original AI Answers */}
          <aside className="ost-rail" aria-label={isEn ? 'Writing context and related prompts' : '创作背景与关联问题'}>
            {/* Card 1: Why we wrote this */}
            <section className="ost-rail-card">
              <h3>{isEn ? 'Why this deliverable?' : '为什么要写这篇？'}</h3>
              <p className="ost-rail-prose">
                {(() => {
                  const goal = activeDeliverable.audienceAndGoal || run?.summary || '';
                  if (isEn) {
                    if (goal && !/[\u4e00-\u9fff]/.test(goal)) return goal;
                    return `Closes missing buyer-intent coverage for ${activeDeliverable.destination} with factual, verified product details so AI assistants can cite your official pages cleanly.`;
                  }
                  return (
                    goal ||
                    '针对潜在客户在 AI 搜索里的真实提问，补齐你当前公开渠道里缺少的实用解答，让 AI 有据可引。'
                  );
                })()}
              </p>

              <ul className="ost-trust-list">
                <li>
                  <CheckCircle2 size={14} />
                  <span>
                    {isEn
                      ? 'Facts & screenshots captured directly from real answers'
                      : '事实与截图均来自真实记录，无夸大虚构'}
                  </span>
                </li>
                <li>
                  <CheckCircle2 size={14} />
                  <span>
                    {isEn
                      ? 'Objective comparisons without disparaging competitors'
                      : '客观讲解方法与价值，不贬低同行'}
                  </span>
                </li>
                <li>
                  <CheckCircle2 size={14} />
                  <span>
                    {isEn
                      ? 'Structured for developer & reader workflows'
                      : '站在读者实操视角撰写，通俗好读'}
                  </span>
                </li>
              </ul>
            </section>

            {/* Card 2: Covered customer questions + click to read original AI answers */}
            {coveredQuestions.length > 0 && (
              <section className="ost-rail-card">
                <div className="ost-rail-head">
                  <h3>
                    {isEn
                      ? `Addresses ${coveredQuestions.length} prompts`
                      : `回应的 ${coveredQuestions.length} 道客户问题`}
                  </h3>
                  <span>{isEn ? 'Click to view AI answers' : '点题目看当时 AI 怎么答'}</span>
                </div>

                <div className="ost-q-list">
                  {coveredQuestions.map((q) => {
                    const qRows = allAuditedRows.filter(
                      (r) => r.question.id === q.id && r.observation,
                    );
                    return (
                      <button
                        key={q.id}
                        type="button"
                        className="ost-q-item"
                        onClick={() => setInspectedQuestion(q)}
                      >
                        <span className="ost-q-title">
                          {isEn ? q.en || q.zh : q.zh || q.en}
                        </span>
                        <span className="ost-q-badges">
                          {qRows.map((r) => {
                            const hit = isAiAnswerRow(r)
                              ? r.audit?.mention === 'yes'
                              : r.observation?.status === 'found';
                            return (
                              <span
                                key={r.engine}
                                className={`ost-mini-engine ${hit ? 'is-hit' : 'is-miss'}`}
                                title={
                                  isEn
                                    ? `${getPlatformName(r.engine, true)}: ${hit ? 'Mentioned' : 'Not mentioned'}`
                                    : `${getPlatformName(r.engine, false)}：${hit ? '已提及' : '未提及'}`
                                }
                              >
                                <ResearchEngineIcon engine={r.engine} />
                                <i>{hit ? '✓' : '×'}</i>
                              </span>
                            );
                          })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* Card 3: Gentle regenerate option */}
            <section className="ost-rail-card is-subtle">
              {!confirmRegenerate ? (
                <div className="ost-regen-prompt">
                  <span>{isEn ? 'Try another editorial angle?' : '如果想换个选题角度？'}</span>
                  <button
                    type="button"
                    className="ost-text-link"
                    onClick={() => setConfirmRegenerate(true)}
                  >
                    {isEn ? 'Regenerate drafts' : '重新生成一版'}
                  </button>
                </div>
              ) : (
                <div className="ost-regen-confirm">
                  <p>
                    {isEn
                      ? 'Regenerating creates a new run from current answers while keeping this round in history.'
                      : '重新生成会根据当前问题另起一篇新草稿（保留本轮记录可随时切回）。'}
                  </p>
                  {uiLanguage === 'zh' && (
                    <label className="ost-companion-toggle is-compact">
                      <input
                        type="checkbox"
                        checked={includeChineseCompanion}
                        onChange={(e) => setIncludeChineseCompanion(e.target.checked)}
                      />
                      <span>同时生成中文对照版</span>
                    </label>
                  )}
                  <div className="ost-regen-btns">
                    <button
                      type="button"
                      className="ost-btn-secondary is-sm"
                      onClick={() => setConfirmRegenerate(false)}
                    >
                      {isEn ? 'Cancel' : '先不用'}
                    </button>
                    <button
                      type="button"
                      className="ost-btn-primary is-sm"
                      onClick={() => void executeStreamAction('start')}
                    >
                      {isEn ? 'Confirm regenerate' : '确认生成新稿'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </aside>
        </div>
      )}

      {/* MODAL 1: Human-Friendly Confirm & Publish Sheet */}
      {applyModalOpen && activeDeliverable && (
        <div
          className="ost-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="确认采用这篇内容"
          onClick={() => !applying && setApplyModalOpen(false)}
        >
          <div className="ost-modal" onClick={(e) => e.stopPropagation()}>
            <header className="ost-modal-head">
              <div>
                <h2>打算怎么使用这第 {activeDelivIdx + 1} 篇内容？</h2>
                <p>《{activeDeliverable.title}》 · 只作用于当前这一篇，确认后不会强迫发布其余篇目</p>
              </div>
              <button
                type="button"
                className="ost-icon-close"
                aria-label="关闭"
                onClick={() => !applying && setApplyModalOpen(false)}
              >
                <X size={18} />
              </button>
            </header>

            <div className="ost-modal-body">
              <div className="ost-choice-list" role="radiogroup" aria-label="发布方式">
                {isExternalArticle ? (
                  <>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={applyChoice === 'external'}
                      className={`ost-choice-card ${applyChoice === 'external' ? 'is-selected' : ''}`}
                      onClick={() => setApplyChoice('external')}
                    >
                      <span className="ost-radio-circle" />
                      <div>
                        <strong>
                          我自己复制发到 Dev.to、Medium、知乎专栏或掘金 <em>推荐</em>
                        </strong>
                        <p>
                          外部高收录社区更容易在「怎么做、怎么选」问题下被 AI 搜索抓到并提到你，文末附上仓库地址即可把引用导回主页。
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      role="radio"
                      aria-checked={applyChoice === 'project_doc'}
                      className={`ost-choice-card ${applyChoice === 'project_doc' ? 'is-selected' : ''}`}
                      onClick={() => setApplyChoice('project_doc')}
                    >
                      <span className="ost-radio-circle" />
                      <div>
                        <strong>同步存一份到仓库 docs/ 目录留档</strong>
                        <p>
                          作为项目内的官方原文永久链接，方便你在外部社区发文时回链引用。
                        </p>
                      </div>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={applyChoice === 'project_doc'}
                      className={`ost-choice-card ${applyChoice === 'project_doc' ? 'is-selected' : ''}`}
                      onClick={() => setApplyChoice('project_doc')}
                    >
                      <span className="ost-radio-circle" />
                      <div>
                        <strong>
                          先写入本机项目文档，稍后一起推送上线 <em>推荐</em>
                        </strong>
                        <p>
                          {repoSyncCompanions.length > 0
                            ? `将英/中双语共 ${1 + repoSyncCompanions.length} 份文件保存到本机目录，方便你先核对或等其余篇目一起一键推送到 GitHub。`
                            : '把新内容保存到本机项目目录中，之后可在页面顶部一键推送到 GitHub。'}
                        </p>
                      </div>
                    </button>

                    {hasRepoSlug && activeIsRepoDoc && (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={applyChoice === 'github_push'}
                        className={`ost-choice-card ${applyChoice === 'github_push' ? 'is-selected' : ''}`}
                        onClick={() => setApplyChoice('github_push')}
                      >
                        <span className="ost-radio-circle" />
                        <div>
                          <strong>保存本机并立即推送到 GitHub 默认分支</strong>
                          <p>
                            同步落盘后直接只把本套文档提交到 GitHub 线上仓库（不会触碰你其他未提交的代码改动）。
                          </p>
                        </div>
                      </button>
                    )}

                    <button
                      type="button"
                      role="radio"
                      aria-checked={applyChoice === 'external'}
                      className={`ost-choice-card ${applyChoice === 'external' ? 'is-selected' : ''}`}
                      onClick={() => setApplyChoice('external')}
                    >
                      <span className="ost-radio-circle" />
                      <div>
                        <strong>
                          {activeDeliverable.kind === 'update_asset'
                            ? '我自己复制去后台或主页手动更新'
                            : '我自己复制发到公众号、知乎或博客'}
                        </strong>
                        <p>
                          不改动本地项目，直接复制这篇内容发到你常用的平台，下方可顺手记下发布链接。
                        </p>
                      </div>
                    </button>
                  </>
                )}
              </div>

              {applyChoice === 'external' && (
                <div className="ost-external-extra">
                  <div className="ost-external-copy-row">
                    <button
                      type="button"
                      className="ost-btn-secondary"
                      onClick={() => void handleCopyTitle()}
                    >
                      {copiedExtraKind === 'title' ? <Check size={14} /> : <Copy size={14} />}
                      <span>{copiedExtraKind === 'title' ? '已复制标题' : '复制标题'}</span>
                    </button>
                    <button
                      type="button"
                      className="ost-btn-secondary"
                      onClick={() => void handleCopyFullArticle()}
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      <span>{copyButtonLabel}</span>
                    </button>
                    <button
                      type="button"
                      className="ost-btn-secondary"
                      onClick={() => void handleCopyRichText()}
                    >
                      {copiedExtraKind === 'rich' ? <Check size={14} /> : <Copy size={14} />}
                      <span>{copiedExtraKind === 'rich' ? '已复制富文本' : '复制富文本'}</span>
                    </button>
                  </div>

                  <label className="ost-field">
                    <span>
                      <Globe size={13} /> 已发布的文章网址（选填）
                    </span>
                    <input
                      type="url"
                      value={publishedUrl}
                      onChange={(e) => setPublishedUrl(e.target.value)}
                      placeholder="https://dev.to/..."
                    />
                  </label>
                </div>
              )}

              <label className="ost-field">
                <span>备注（选填）</span>
                <input
                  type="text"
                  value={applyNote}
                  onChange={(e) => setApplyNote(e.target.value)}
                  placeholder="例如：已同步发到官网专栏 / 公众号"
                />
              </label>
            </div>

            <footer className="ost-modal-foot">
              <button
                type="button"
                className="ost-btn-secondary"
                disabled={applying}
                onClick={() => setApplyModalOpen(false)}
              >
                再看看全文
              </button>
              <button
                type="button"
                className="ost-btn-primary"
                disabled={applying || pushingGithub}
                onClick={() => void handleConfirmApply()}
              >
                {applying || pushingGithub ? (
                  <Loader2 size={15} className="ost-spin" />
                ) : (
                  <Check size={15} />
                )}
                <span>
                  {applyChoice === 'github_push'
                    ? '保存并推送到 GitHub'
                    : '确认采用这一篇'}
                </span>
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* MODAL 2: Original AI Answer Evidence Drawer */}
      {inspectedQuestion && (
        <div
          className="ost-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`当时 AI 的原始回答：${inspectedQuestion.zh}`}
          onClick={() => setInspectedQuestion(null)}
        >
          <div className="ost-modal is-wide" onClick={(e) => e.stopPropagation()}>
            <header className="ost-modal-head">
              <div>
                <span className="ost-modal-kicker">
                  <MessageSquareQuote size={13} /> 改进前的真实回答记录
                </span>
                <h2>{inspectedQuestion.zh || inspectedQuestion.en}</h2>
              </div>
              <button
                type="button"
                className="ost-icon-close"
                aria-label="关闭"
                onClick={() => setInspectedQuestion(null)}
              >
                <X size={18} />
              </button>
            </header>

            <div className="ost-modal-body is-scroll">
              {allAuditedRows
                .filter((r) => r.question.id === inspectedQuestion.id && r.observation)
                .map((r) => {
                  const obs = r.observation!;
                  const hit = isAiAnswerRow(r)
                    ? r.audit?.mention === 'yes'
                    : obs.status === 'found';
                  return (
                    <div key={r.key} className="ost-obs-card">
                      <div className="ost-obs-head">
                        <span className="ost-obs-engine">
                          <ResearchEngineIcon engine={r.engine} />
                          <strong>{getPlatformName(r.engine, isEn)}</strong>
                        </span>
                        <span className={`ost-obs-verdict ${hit ? 'is-yes' : 'is-no'}`}>
                          {hit ? '提到了你' : '未提到你'}
                        </span>
                      </div>

                      {r.audit?.mentionEvidence && (
                        <p className="ost-obs-note">{r.audit.mentionEvidence}</p>
                      )}

                      {obs.answerPath || obs.evidencePath ? (
                        <div className="ost-obs-answer">
                          <AnswerText
                            projectId={projectId}
                            path={obs.answerPath || obs.evidencePath}
                            projectNames={[projectName]}
                          />
                        </div>
                      ) : (
                        obs.summary && <p className="ost-obs-summary">{obs.summary}</p>
                      )}

                      {obs.sources.length > 0 && (
                        <div className="ost-obs-sources">
                          <span>当时参考的网页：</span>
                          <div>
                            {obs.sources.slice(0, 5).map((s) => (
                              <a
                                key={s.url}
                                href={s.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {s.title || s.url}
                                <ExternalLink size={11} />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  FileText,
  Loader2,
  X,
} from 'lucide-react';
import type { GeoAsset, GeoState } from '@/lib/geo/types';
import { getBatchResearchEngines } from '@/lib/geo/research-engines';
import { auditRows, isAiAnswerRow } from '@/lib/geo/overview-metrics';
import {
  extractTopExternalCitedSources,
  getResearchRows,
  type TopExternalCitedSource,
} from '@/lib/geo/research-view';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
} from '@/lib/geo/research-types';
import VisibilityPanel from './VisibilityPanel';
import {
  getTaskWorkspaceGroups,
  isHistoricalTask,
} from './TaskWorkspace';
import OptimizationHeroCard from './OptimizationHeroCard';
import OptimizationStudio from './OptimizationStudio';
import { fetchOptimizationSnapshot } from '@/lib/geo/optimization-client-cache';
import type { OptimizationRunViewModel } from '@/lib/geo/optimization/types';
import { readQuestionGenerationStream } from './question-generation-stream';
import type { QuestionGenerationProgress } from '@/lib/geo/question-types';
import QuestionManagementPanel from './QuestionManagementPanel';
import ResearchPanel, { clearResearchDetailParams } from './ResearchPanel';
import ObservedCompetitorView from './ObservedCompetitorView';
import TrafficPanel from './TrafficPanel';
import ConnectionSettingsPanel from './ConnectionSettingsPanel';
import DevI18nLeakHighlighter from './DevI18nLeakHighlighter';
import { normalizeQuestionMonitoringUrl } from './question-monitoring-url';
import { resolveProjectTargetLanguage } from '@/lib/geo/i18n';
import {
  UiLanguageProvider,
  useUiLanguage,
} from './UiLanguageContext';
import { MENU_ITEMS, PAGE_IDS, PAGES, type Page } from './open-geo-app/pages';
import './opengeo.css';
import './app-shell.css';
import { Modal } from './open-geo-app/Modal';
import { MarkdownBody } from './open-geo-app/MarkdownBody';
import { shortPath } from './open-geo-app/asset-labels';
import { AppSidebar } from './open-geo-app/AppSidebar';
import { AppPageHeader } from './open-geo-app/AppPageHeader';
import { OverviewEmptyCard } from './open-geo-app/OverviewEmptyCard';
import { type Dialog, QuestionSetupDialog } from './open-geo-app/QuestionSetupDialog';
import { AssetDialog } from './open-geo-app/AssetDialog';

function OpenGeoAppInner() {
  const { t, uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const isEnRef = useRef(isEn);
  isEnRef.current = isEn;
  const [projectId, setProjectId] = useState('');
  const projectRef = useRef(projectId);
  const refreshVersion = useRef(0);
  const refreshRequest = useRef<AbortController | null>(null);
  const actionError = useRef('');
  const [questionGenerationProgress, setQuestionGenerationProgress] = useState<QuestionGenerationProgress>();
  const [optViewModel, setOptViewModel] = useState<OptimizationRunViewModel | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectButton = useRef<HTMLButtonElement>(null);
  const [storedData, setData] = useState<GeoState | null>(null),
    [page, setPage] = useState<Page>('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [toast, setToast] = useState(''),
    [toastCode, setToastCode] = useState('');
  const [robotsNotice, setRobotsNotice] = useState<{
    checked: boolean;
    origin: string | null;
    robotsUrl: string | null;
    blockedBots: string[];
  } | null>(null);
  const [dismissedRobotsOrigin, setDismissedRobotsOrigin] = useState<string | null>(null);
  const robotsProjectId = storedData?.project.id || '';

  useEffect(() => {
    if (!robotsProjectId) {
      setRobotsNotice(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/geo/robots-check?project=${encodeURIComponent(robotsProjectId)}`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          payload: {
            check?: {
              checked: boolean;
              origin: string | null;
              robotsUrl: string | null;
              blockedBots: string[];
            };
          } | null,
        ) => {
          if (!controller.signal.aborted) {
            setRobotsNotice(payload?.check ?? null);
          }
        },
      )
      .catch(() => {
        // Silent best-effort check; never block the workspace.
      });
    return () => controller.abort();
  }, [robotsProjectId]);
  // Keep internal development records in storage, outside all customer views.
  const data = useMemo(
    () =>
      storedData
        ? {
            ...storedData,
            tasks: storedData.tasks.filter((task) => !isHistoricalTask(task)),
          }
        : null,
    [storedData],
  );
  const [selectedTask, setSelectedTask] = useState(''),
    [dialog, setDialog] = useState<Dialog>(null),
    [asset, setAsset] = useState<GeoAsset | null>(null),
    [evidence, setEvidence] = useState<{
      path: string;
      content: string;
      format: string;
    } | null>(null);
  const refresh = useCallback(
    async (options?: { signal?: AbortSignal; onSuccess?: () => void }) => {
      const requestedProject = projectRef.current;
      const lang = isEnRef.current ? 'en' : 'zh';
      if (options?.signal?.aborted) return;
      refreshRequest.current?.abort();
      const controller = new AbortController();
      refreshRequest.current = controller;
      const cancel = () => controller.abort();
      options?.signal?.addEventListener('abort', cancel, { once: true });
      const version = ++refreshVersion.current;
      const isCurrent = () =>
        !controller.signal.aborted &&
        version === refreshVersion.current &&
        projectRef.current === requestedProject &&
        (new URLSearchParams(window.location.search).get('project') ||
          '') === requestedProject;
      try {
        const res = await fetch(
          `/api/geo?project=${encodeURIComponent(requestedProject)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        if (!res.ok) {
          throw new Error(
            lang === 'en'
              ? 'Could not load project right now. Please try again.'
              : '暂时无法读取项目，请重试。',
          );
        }
        const next: GeoState = await res.json();
        if (!isCurrent()) return;
        if (requestedProject && next.project.id !== requestedProject) {
          throw new Error(
            lang === 'en'
              ? 'Loaded project does not match the current URL. Please reload.'
              : '项目内容与当前地址不一致，请重新加载。',
          );
        }
        // Let the server resolve its configured default before caching an identity.
        if (!requestedProject) {
          const url = new URL(window.location.href);
          url.searchParams.set('project', next.project.id);
          window.history.replaceState(null, '', url);
          projectRef.current = next.project.id;
          setProjectId(next.project.id);
        }
        setData(next);
        setError('');
        options?.onSuccess?.();
      } catch (e) {
        if (isCurrent()) {
          setError(
            e instanceof Error
              ? e.message
              : lang === 'en'
                ? 'Failed to load'
                : '读取失败',
          );
        }
      } finally {
        options?.signal?.removeEventListener('abort', cancel);
        if (refreshRequest.current === controller)
          refreshRequest.current = null;
      }
    },
    [],
  );
  useEffect(() => {
    const readLocation = () => {
      const currentUrl = new URL(window.location.href);
      if (normalizeQuestionMonitoringUrl(currentUrl))
        window.history.replaceState(window.history.state, '', currentUrl);
      const params = currentUrl.searchParams;
      if (params.get('view') === 'history') {
        params.set('view', 'tasks');
        params.delete('task');
        const url = new URL(window.location.href);
        url.search = params.toString();
        window.history.replaceState(null, '', url);
      }
      const requestedPage = params.get('view') as Page;
      const requestedProject = params.get('project') || '';
      const projectChanged = projectRef.current !== requestedProject;
      if (projectChanged) {
        refreshVersion.current += 1;
        projectRef.current = requestedProject;
        setData(null);
        setProjectId(requestedProject);
        setError('');
        setToast('');
        setQuestionGenerationProgress(undefined);
      }
      setPage(PAGE_IDS.includes(requestedPage) ? requestedPage : 'overview');
      setSelectedTask(params.get('task') ?? '');
      setDialog(requestedPage === 'question-plan' && params.get('setup') === 'questions' ? 'questions' : null);
      setAsset(null);
      setEvidence(null);
      setProjectMenuOpen(false);
      return projectChanged;
    };
    const restoreLocation = () => {
      if (readLocation()) void refresh();
    };
    const restorePage = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      readLocation();
      void refresh();
    };
    readLocation();
    void refresh();
    window.addEventListener('popstate', restoreLocation);
    window.addEventListener('pageshow', restorePage);
    return () => {
      refreshVersion.current += 1;
      refreshRequest.current?.abort();
      window.removeEventListener('popstate', restoreLocation);
      window.removeEventListener('pageshow', restorePage);
    };
  }, [refresh]);
  useEffect(() => {
    if (page !== 'overview' || !projectId) return;
    let active = true;
    let checking = false;
    let forcePending = false;
    let lastVersion: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const visible = () => active && document.visibilityState === 'visible';
    const checkVersion = async (forceRefresh = false) => {
      if (!visible()) return;
      if (checking) {
        forcePending ||= forceRefresh;
        return;
      }
      checking = true;
      clearTimeout(timer);
      const request = new AbortController();
      controller = request;
      try {
        const response = await fetch(
          `/api/geo/overview-version?project=${encodeURIComponent(projectId)}`,
          { cache: 'no-store', signal: request.signal },
        );
        if (!response.ok) return;
        const result: { projectId?: string; version?: string } =
          await response.json();
        if (
          !visible() ||
          request.signal.aborted ||
          projectRef.current !== projectId ||
          result.projectId !== projectId ||
          typeof result.version !== 'string'
        )
          return;
        // The first response must refresh too: the state and version requests
        // can straddle a completed background run.
        if (forceRefresh || lastVersion !== result.version) {
          await refresh({
            signal: request.signal,
            onSuccess: () => {
              lastVersion = result.version;
            },
          });
        }
      } catch {
        // Retry a failed lightweight read on the next visible check.
      } finally {
        checking = false;
        if (controller === request) controller = null;
        if (visible()) {
          if (forcePending) {
            forcePending = false;
            void checkVersion(true);
          } else
            timer = setTimeout(() => {
              void checkVersion();
            }, 10_000);
        }
      }
    };
    const onVisible = () => {
      if (visible()) void checkVersion(true);
      else {
        clearTimeout(timer);
        controller?.abort();
      }
    };
    const onFocus = () => {
      if (visible()) void checkVersion(true);
    };
    void checkVersion();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [page, projectId, refresh]);
  useEffect(() => {
    if (!projectId) {
      setOptViewModel(null);
      return;
    }
    let active = true;
    void fetchOptimizationSnapshot(projectId, uiLanguage).then((payload) => {
      if (active && payload) setOptViewModel(payload.viewModel ?? null);
    });
    return () => {
      active = false;
    };
  }, [projectId, uiLanguage]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!(event.target as Element).closest('.og-project-picker'))
        setProjectMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProjectMenuOpen(false);
        projectButton.current?.focus();
      }
    };
    document.addEventListener('click', dismiss);
    document.addEventListener('keydown', escape);
    document
      .querySelector<HTMLButtonElement>(
        '#og-project-menu [aria-checked="true"]',
      )
      ?.focus();
    return () => {
      document.removeEventListener('click', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [projectMenuOpen]);
  useEffect(() => {
    if (
      page === 'overview' ||
      !data?.tasks.some((t) =>
        ['investigating', 'monitoring'].includes(t.status),
      )
    )
      return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [data?.tasks, page, projectId, refresh]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(
        () => {
          setToast('');
          setToastCode('');
        },
        toastCode === 'model_not_configured' ? 10000 : 4500,
      );
      return () => clearTimeout(id);
    }
  }, [toast, toastCode]);
  useEffect(() => {
    if (!['queued', 'running'].includes(data?.questionGeneration?.status ?? '')) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [data?.questionGeneration?.status, projectId, refresh]);
  const questionRequest = useRef<{ key: string; id: string } | null>(null);
  const task = data?.tasks.find((t) => t.id === selectedTask);
  const groups = getTaskWorkspaceGroups(data?.tasks ?? []);
  const navigate = (nextPage: Page, taskId = '', batchId?: string, hash = '') => {
    const url = new URL(window.location.href);
    clearResearchDetailParams(url);
    if (
      (url.searchParams.get('project') || '') !== projectRef.current
    ) {
      [
        'questionSearch',
        'questionCategory',
        'questionScope',
        'search',
        'group',
        'kind',
        'result',
        'compare',
        'compareScroll',
      ].forEach((key) => url.searchParams.delete(key));
    }
    url.searchParams.set('view', nextPage);
    url.searchParams.set('project', projectRef.current);
    if (batchId) url.searchParams.set('batch', batchId);
    if (taskId) url.searchParams.set('task', taskId);
    else url.searchParams.delete('task');
    url.hash = hash;
    if (url.href !== window.location.href) {
      window.history.pushState(null, '', url);
    }
    setPage(nextPage);
    setSelectedTask(taskId);
    if (nextPage === page) window.dispatchEvent(new PopStateEvent('popstate'));
    if (hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  };
  const openModelSettings = () => {
    setToast('');
    setToastCode('');
    setDialog(null);
    navigate('settings', '', undefined, '#model');
  };
  const switchProject = (id: string) => {
    if (busy) return;
    setProjectMenuOpen(false);
    if (id === projectRef.current) return;
    refreshVersion.current += 1;
    projectRef.current = id;
    setProjectId(id);
    setData(null);
    setError('');
    setToast('');
    setDialog(null);
    setAsset(null);
    setEvidence(null);
    setSelectedTask('');
    navigate('overview');
    void refresh();
    projectButton.current?.focus();
  };
  const act = async (
    action: string,
    payload: Record<string, unknown> = {},
    message?: string,
  ) => {
    const actionProject = projectRef.current;
    const defaultSavedMsg = isEn ? 'Saved' : '已保存';
    actionError.current = '';
    setBusy(action);
    if (action === 'generate_questions') {
      setQuestionGenerationProgress({
        stage: 'preparing',
        message: isEn ? 'Preparing project context…' : '正在准备产品资料。',
      });
    }
    try {
      const res = await fetch('/api/geo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(action === 'generate_questions' ? { Accept: 'application/x-ndjson' } : {}) },
        body: JSON.stringify({
          action,
          projectId: actionProject,
          ...(task ? { taskId: task.id } : {}),
          ...payload,
        }),
      });
      const result = action === 'generate_questions' && res.headers.get('content-type')?.includes('application/x-ndjson')
        ? await readQuestionGenerationStream(
            res,
            (progress) => {
              if (projectRef.current === actionProject) setQuestionGenerationProgress(progress);
            },
            uiLanguage,
          )
        : await res.json();
      if (!res.ok) {
        const err = new Error(
          result.error ??
            (isEn ? 'Action did not complete. Please try again.' : '操作未完成，请重试。'),
        ) as Error & { code?: string };
        if (typeof result.code === 'string') err.code = result.code;
        throw err;
      }
      if (projectRef.current !== actionProject) return null;
      setData(result);
      setToastCode('');
      setToast(message ?? defaultSavedMsg);
      return result as GeoState;
    } catch (e) {
      actionError.current =
        e instanceof Error ? e.message : isEn ? 'Action failed' : '操作失败';
      const code =
        e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
          ? (e as { code: string }).code
          : '';
      setToastCode(code);
      setToast(actionError.current);
      return null;
    } finally {
      setBusy('');
      if (action === 'generate_questions') setQuestionGenerationProgress(undefined);
    }
  };
  const openTask = (id?: string) => {
    navigate('tasks', id ?? '');
  };
  const autoConfirmedPlanKeyRef = useRef<string>('');
  useEffect(() => {
    if (
      page !== 'overview' ||
      !data ||
      data.latestResearch ||
      data.questions.length > 0 ||
      busy
    ) {
      return;
    }
    const genActive =
      data.questionGeneration?.status === 'queued' ||
      data.questionGeneration?.status === 'running';
    const readyCandidates = data.questionPlan.candidates.filter(
      (c) => c.selected && c.review.decision !== 'exclude',
    );
    if (genActive || readyCandidates.length === 0) return;
    const planKey = `${data.project.id}:${data.questionPlan.id}:${data.questionPlan.revision}`;
    if (autoConfirmedPlanKeyRef.current === planKey) return;
    autoConfirmedPlanKeyRef.current = planKey;
    void act(
      'confirm_questions',
      {
        planId: data.questionPlan.id,
        revision: data.questionPlan.revision,
      },
      uiLanguage === 'en'
        ? 'Buyer questions ready for browser collection'
        : '核心问题已就绪，可直接开始采集',
    );
  }, [page, data, busy, uiLanguage]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page]);
  const openEvidence = async (path: string) => {
    const evidenceProject = projectRef.current;
    setEvidence({
      path,
      content: isEn ? 'Loading evidence…' : '正在读取依据…',
      format: 'text',
    });
    try {
      const res = await fetch(
        `/api/geo/evidence?project=${encodeURIComponent(evidenceProject)}&path=${encodeURIComponent(path)}`,
      );
      const result = await res.json();
      if (!res.ok) {
        throw new Error(
          result.error ??
            (isEn ? 'Unable to load this file.' : '无法读取这份材料'),
        );
      }
      if (projectRef.current === evidenceProject) setEvidence(result);
    } catch (e) {
      if (projectRef.current !== evidenceProject) return;
      setEvidence({
        path,
        format: 'text',
        content:
          e instanceof Error
            ? e.message
            : isEn
              ? 'Failed to load'
              : '读取失败',
      });
    }
  };
  const evidenceLinks = (paths: string[]) => (
    <div className="og-evidence-links">
      {paths.map((path) => (
        <button key={path} onClick={() => openEvidence(path)}>
          <FileText size={13} />
          {shortPath(path)}
          <ArrowUpRight size={12} />
        </button>
      ))}
    </div>
  );
  const openActionPlanRef = useRef<() => void>(() => {});
  openActionPlanRef.current = () => navigate('tasks');

  const routeLegacyImprovementToActionPlan = () => {
    navigate('tasks');
  };
  useEffect(() => {
    const handler = () => openActionPlanRef.current();
    window.addEventListener('geo-competitor-improve', handler);
    return () => window.removeEventListener('geo-competitor-improve', handler);
  }, []);
  useEffect(() => {
    if (page === 'assets') {
      openActionPlanRef.current();
    }
  }, [page]);
  const openQuestionDetail = (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine: 'all' | ResearchEngine = 'all',
    record?: { batch: ResearchBatch; recordKey: string },
  ) => {
    if (!data) return;
    if (record) {
      if (record.batch.projectId !== data.project.id) return;
      setData((current) =>
        current?.project.id === record.batch.projectId
          ? { ...current, latestResearch: record.batch }
          : current,
      );
    }
    const url = new URL(window.location.href);
    clearResearchDetailParams(url);
    url.searchParams.set('project', data.project.id);
    const returnTo = url.pathname + url.search;
    url.searchParams.set('returnTo', returnTo);
    url.searchParams.set(
      'batch',
      record?.batch.id || data.latestResearch?.id || '',
    );
    url.searchParams.set('view', page);
    url.searchParams.set('question', question.id);
    url.searchParams.set('language', language);
    url.searchParams.set('engine', engine);
    [
      'source',
      'record',
      'collection',
      'directory',
      'evidence',
      'detail',
      'search',
      'group',
      'kind',
      'result',
    ].forEach((key) => url.searchParams.delete(key));
    if (record) url.searchParams.set('record', record.recordKey);
    window.history.pushState(
      {
        opengeoDetail: true,
        opengeoDetailScroll: {
          x: window.scrollX,
          y: window.scrollY,
        },
      },
      '',
      url,
    );
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  const optStatus = optViewModel?.run?.status ?? null;
  const activeOptimizationRunId =
    optViewModel?.run &&
    ['awaiting_retest', 'remeasuring', 'completed'].includes(optViewModel.run.status)
      ? optViewModel.run.id
      : null;
  const latestDeliverableShippedAt =
    (optViewModel?.run?.deliverables ?? [])
      .filter((d) => d.status === 'applied' && d.appliedRecord?.mode !== 'local_file')
      .map((d) => d.appliedRecord?.appliedAt || d.updatedAt)
      .filter((iso): iso is string => Boolean(iso && Number.isFinite(Date.parse(iso))))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const optNavBadge =
    optStatus === 'awaiting_approval'
      ? { label: t('status.awaitingApproval'), tone: 'emerald' }
      : optStatus === 'awaiting_retest'
        ? { label: t('status.awaitingRetest'), tone: 'amber' }
        : optStatus &&
            ['planning', 'drafting', 'reviewing', 'implementing', 'remeasuring'].includes(
              optStatus,
            )
          ? { label: t('status.running'), tone: 'live' }
          : null;

  const navGroups = [
    {
      id: 'primary',
      label: null,
      items: MENU_ITEMS.map((item) => ({ ...item, label: t(item.label) })),
    },
  ];
  const pageInfo = PAGES[page];
  const sidebarPage = pageInfo.activeMenu ?? page;
  // Pages with a title use the shared page header; the rest draw their own full canvas.
  const customCanvasPage = !pageInfo.title;
  const overviewMissedCount = useMemo(() => {
    const b = data?.latestResearch;
    if (!b) return 0;
    const activeLang = resolveProjectTargetLanguage(data?.project, b);
    const engines = getBatchResearchEngines(b);
    const audited = auditRows(
      b,
      engines.flatMap((engine) =>
        getResearchRows(b, { language: activeLang, kind: 'all', engine, result: 'all' }),
      ),
      b.answerAudits ?? [],
    );
    return b.questions.filter((q) => {
      const m = audited.filter((r) => r.question.id === q.id && r.observation);
      if (!m.length) return false;
      return m.every((r) =>
        isAiAnswerRow(r)
          ? r.audit?.mention === 'no'
          : r.observation?.status === 'not_observed',
      );
    }).length;
  }, [data?.latestResearch, data?.project]);
  const topCitedSources = useMemo<TopExternalCitedSource[]>(() => {
    const b = data?.latestResearch;
    if (!b || !data?.project) return [];
    const activeLang = resolveProjectTargetLanguage(data.project, b);
    return extractTopExternalCitedSources(b, data.project, activeLang, 4);
  }, [data?.latestResearch, data?.project]);
  return (
    <div
      className={`og-app og-redesigned og-research-workspace ${!customCanvasPage ? 'og-b-workspace' : ''}`}
    >
      <AppSidebar
        projectId={projectId}
        projectButton={projectButton}
        projectMenuOpen={projectMenuOpen}
        data={data}
        busy={busy}
        setProjectMenuOpen={setProjectMenuOpen}
        switchProject={switchProject}
        navGroups={navGroups}
        sidebarPage={sidebarPage}
        navigate={navigate}
        optNavBadge={optNavBadge}
        openModelSettings={openModelSettings}
        page={page}
      />
      <main className="og-main">
        {error && (
          <div className="og-error-banner" role="alert">
            {error}
            <button
              onClick={() => {
                void refresh();
              }}
            >
              {isEn ? 'Reload' : '重新加载'}
            </button>
          </div>
        )}
        {robotsNotice &&
          robotsNotice.blockedBots.length > 0 &&
          dismissedRobotsOrigin !== robotsNotice.origin && (
            <div className="og-robots-notice" role="status">
              <div className="og-robots-notice-main">
                <AlertTriangle size={15} aria-hidden="true" />
                <span>
                  {uiLanguage === 'en'
                    ? `${robotsNotice.origin || 'Your site'} robots.txt blocks ${robotsNotice.blockedBots.join(', ')} at /.`
                    : `${robotsNotice.origin || '官网'} 的 robots.txt 拦截了 ${robotsNotice.blockedBots.join('、')} 访问根目录。`}
                </span>
                {robotsNotice.robotsUrl && (
                  <a
                    href={robotsNotice.robotsUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    robots.txt
                  </a>
                )}
              </div>
              <button
                type="button"
                aria-label={uiLanguage === 'en' ? 'Dismiss' : '关闭提示'}
                onClick={() =>
                  setDismissedRobotsOrigin(robotsNotice.origin ?? '__dismissed__')
                }
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        {!data ? (
          <div className="og-loading">
            <Loader2 className="spin" size={24} />
            <p>{uiLanguage === 'en' ? 'Loading project…' : '正在读取项目…'}</p>
          </div>
        ) : (
          <>
            {!customCanvasPage && (
              <AppPageHeader
                projectId={projectId}
                pageInfo={pageInfo}
                page={page}
                data={data}
                openEvidence={openEvidence}
              />
            )}
            <div
              className={
                !customCanvasPage
                  ? 'og-workspace-body'
                  : undefined
              }
            >
              {data.latestResearch && pageInfo.workspace === 'research' && (
                  <ResearchPanel
                    key={`research-${data.project.id}`}
                    hideHeader={page === 'overview'}
                    projectOptimization={
                      <OptimizationHeroCard
                        key={data.project.id}
                        projectId={data.project.id}
                        questionCount={data.latestResearch.questions.length}
                        missedQuestionCount={overviewMissedCount}
                        topCitedSources={topCitedSources}
                        hideCitedStrip={page === 'overview'}
                        onOpenStudio={(runId) => navigate('tasks', runId ?? '')}
                        onOpenQuestions={() => navigate('question-plan')}
                        onStatusChange={setOptViewModel}
                      />
                    }
                    batch={data.latestResearch}
                    project={data.project}
                    activeOptimizationRunId={activeOptimizationRunId}
                    latestShippedAt={latestDeliverableShippedAt}
                    view={page === 'overview' ? 'overview' : 'questions'}
                    detailsOnly={
                      page === 'question-plan' || page === 'competitor'
                    }
                    tasks={groups.tasks}
                    onTask={openTask}
                    onRefresh={() => {
                      void refresh();
                    }}
                    onCompetitor={() =>
                      navigate('competitor', '', data.latestResearch?.id)
                    }
                    onEvidence={openEvidence}
                    onQuestions={() => navigate('question-plan')}
                    onOverview={() => navigate('overview')}
                    onAssets={() => navigate('tasks')}
                    onReview={() => navigate('question-plan')}
                    onImprove={routeLegacyImprovementToActionPlan}
                    onPlan={async () => {
                      routeLegacyImprovementToActionPlan();
                    }}
                    claimReviews={data.claimReviews ?? []}
                    onClaimReview={async (review) => {
                      const result = await act(
                        'save_claim_review',
                        { review },
                        isEn
                          ? 'Saved manual review and evidence'
                          : '已保存人工核查与依据',
                      );
                      if (!result) {
                        throw new Error(
                          isEn
                            ? 'Review was not saved. Check the message and try again.'
                            : '核查未保存，请查看提示后重试。',
                        );
                      }
                    }}
                  />
                )}
              {page === 'overview' && !data.latestResearch && data.questions.length === 0 && (() => {
                const targetLang = resolveProjectTargetLanguage(data.project, null);
                const langLabel = t(
                  targetLang === 'en'
                    ? 'overview.targetLangEnLabel'
                    : 'overview.targetLangZhLabel',
                );
                const readyCandidates = data.questionPlan.candidates.filter(
                  (c) => c.selected && c.review.decision !== 'exclude',
                );
                const genActive =
                  data.questionGeneration?.status === 'queued' ||
                  data.questionGeneration?.status === 'running';
                return (
                  <OverviewEmptyCard
                    readyCandidates={readyCandidates}
                    langLabel={langLabel}
                    navigate={navigate}
                    targetLang={targetLang}
                    busy={busy}
                    genActive={genActive}
                    act={act}
                    data={data}
                  />
                );
              })()}
              {page === 'overview' && !data.latestResearch && data.questions.length > 0 && (
                <VisibilityPanel
                  data={data}
                  onQuestions={() => navigate('question-plan')}
                  onTask={() => openTask()}
                  onAsset={setAsset}
                  onEvidence={openEvidence}
                />
              )}
              {page === 'settings' && (
                <ConnectionSettingsPanel
                  projectId={data.project.id}
                  research={data.latestResearch}
                  onSaved={() => {
                    void refresh();
                  }}
                  onOpenTraffic={() => navigate('traffic')}
                  onRecords={(engine) => {
                    const url = new URL(window.location.href);
                    clearResearchDetailParams(url);
                    ['search', 'questionSearch', 'questionScope', 'group', 'kind', 'result', 'collection'].forEach(
                      (key) => url.searchParams.delete(key),
                    );
                    url.searchParams.set('view', 'question-plan');
                    url.searchParams.set('project', projectId);
                    url.searchParams.set('engine', engine);
                    if (data.latestResearch)
                      url.searchParams.set('batch', data.latestResearch.id);
                    const preferred =
                      url.searchParams.get('language') === 'en' ? 'en' : 'zh';
                    const records =
                      data.latestResearch?.questions
                        .flatMap((question) => question.observations)
                        .filter(
                          (observation) => observation.engine === engine,
                        ) ?? [];
                    url.searchParams.set(
                      'language',
                      records.some((record) => record.language === preferred)
                        ? preferred
                        : (records[0]?.language ?? preferred),
                    );
                    window.history.pushState(null, '', url);
                    setPage('question-plan');
                    setSelectedTask('');
                  }}
                />
              )}
              {page === 'competitor' && (
                <ObservedCompetitorView
                  key={data.project.id}
                  project={data.project}
                  batch={data.latestResearch}
                  onOpenOverview={() => navigate('overview')}
                  onOpenQuestions={() => navigate('question-plan')}
                  onOpenActionPlan={() => navigate('tasks')}
                />
              )}
              {page === 'traffic' && (
                <TrafficPanel projectId={data.project.id} />
              )}
              {page === 'question-plan' && (
                <QuestionManagementPanel
                  onRefresh={refresh}
                  onEvidence={openEvidence}
                  key={data.project.id}
                  data={data}
                  busy={!!busy}
                  onLegacy={() => setDialog('questions')}
                  onAction={async (action, fields) => {
                    const result = await act(
                      action,
                      fields,
                      action === 'save_question'
                        ? isEn
                          ? 'Saved new question'
                          : '已保存新问题'
                        : action === 'review_question'
                          ? isEn
                            ? 'Question status updated'
                            : '问题状态已更新'
                          : action === 'audit_question'
                            ? isEn
                              ? 'AI review saved'
                              : 'AI 复评已保存'
                            : action === 'confirm_questions'
                              ? isEn
                                ? 'Buyer questions confirmed'
                                : '当前监测问题已确认'
                              : isEn
                                ? 'Question selection saved'
                                : '监测问题选择已保存',
                    );
                    if (!result) {
                      const message =
                        actionError.current ||
                        (isEn
                          ? 'Change was not saved. Please try again.'
                          : '操作未保存，请重试。');
                      await refresh();
                      throw new Error(message);
                    }
                    return true;
                  }}
                  onResult={(question, language, engine = 'all', record) =>
                    openQuestionDetail(question, language, engine, record)
                  }
                />
              )}
              {page === 'question-plan' && dialog === 'questions' && (
                <QuestionSetupDialog
                  setDialog={setDialog}
                  data={data}
                  busy={busy}
                  questionGenerationProgress={questionGenerationProgress}
                  setAsset={setAsset}
                  openModelSettings={openModelSettings}
                  act={act}
                  actionError={actionError}
                  projectId={projectId}
                  questionRequest={questionRequest}
                  navigate={navigate}
                />
              )}
              {pageInfo.workspace === 'action-plan' && (
                <OptimizationStudio
                  key={`studio-${data.project.id}`}
                  projectId={data.project.id}
                  projectName={data.project.name}
                  repositoryUrl={data.project.repositoryUrl}
                  siteUrl={data.project.siteUrl}
                  selectedRunId={selectedTask || undefined}
                  batch={data.latestResearch}
                  targetLanguage={resolveProjectTargetLanguage(
                    data.project,
                    data.latestResearch,
                  )}
                  onRefresh={() => {
                    void refresh();
                  }}
                  onBackOverview={() => navigate('overview')}
                  onOpenQuestions={() => navigate('question-plan')}
                  onSelectRun={(runId) => navigate('tasks', runId)}
                  onStatusChange={setOptViewModel}
                />
              )}
            </div>
          </>
        )}
      </main>
      {toast && (
        <div className="og-toast" role="status">
          <Check size={17} />
          <span>{toast}</span>
          {toastCode === 'model_not_configured' && (
            <button
              type="button"
              className="og-toast-action"
              onClick={openModelSettings}
            >
              {isEn ? 'Open Settings' : '打开设置'}
            </button>
          )}
          <button
            onClick={() => {
              setToast('');
              setToastCode('');
            }}
            aria-label={isEn ? 'Dismiss notification' : '关闭提示'}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {asset && (
        <AssetDialog
          asset={asset}
          setAsset={setAsset}
          evidenceLinks={evidenceLinks}
        />
      )}
      {evidence && (
        <Modal
          title={isEn ? 'View evidence' : '查看依据'}
          description={shortPath(evidence.path)}
          onClose={() => setEvidence(null)}
          wide
        >
          <div className="og-document-body">
            {evidence.format === 'markdown' ? (
              <MarkdownBody
                content={evidence.content}
                evidencePath={evidence.path}
                onEvidence={openEvidence}
              />
            ) : (
              <pre className="og-evidence-pre">{evidence.content}</pre>
            )}
            <p className="og-small-note">
              {isEn
                ? 'Local audit evidence · Third-party text from raw search captures is shown for verification only'
                : '本地审计材料 · 原始搜索中的第三方文字仅供核对'}
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function OpenGeoApp() {
  return (
    <UiLanguageProvider>
      <OpenGeoAppInner />
      <DevI18nLeakHighlighter />
    </UiLanguageProvider>
  );
}

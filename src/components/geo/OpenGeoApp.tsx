'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown from 'markdown-to-jsx';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronDown,
  LayoutDashboard,
  Check,
  CheckCheck,
  FileText,
  ListChecks,
  Loader2,
  Play,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  GitCompareArrows,
  MousePointer2,
  X,
} from 'lucide-react';
import type { GeoAsset, GeoState } from '@/lib/geo/types';
import {
  getBatchResearchEngines,
  RESEARCH_ENGINES,
} from '@/lib/geo/research-engines';
import { auditRows, isAiAnswerRow } from '@/lib/geo/overview-metrics';
import {
  extractTopExternalCitedSources,
  getResearchRows,
  type TopExternalCitedSource,
} from '@/lib/geo/research-view';
import type { ResearchBatch } from '@/lib/geo/research-types';
import VisibilityPanel from './VisibilityPanel';
import ContentPanel from './ContentPanel';
import {
  getTaskWorkspaceGroups,
  isHistoricalTask,
} from './TaskWorkspace';
import OptimizationHeroCard from './OptimizationHeroCard';
import OptimizationStudio from './OptimizationStudio';
import type { OptimizationRunViewModel } from '@/lib/geo/optimization/types';
import ImplementationRecordForm from './ImplementationRecordForm';
import QuestionPlanPanel from './QuestionPlanPanel';
import { readQuestionGenerationStream } from './question-generation-stream';
import type { QuestionGenerationProgress } from '@/lib/geo/question-types';
import QuestionManagementPanel from './QuestionManagementPanel';
import ResearchPanel, { clearResearchDetailParams } from './ResearchPanel';
import CompetitorPanel from './CompetitorPanel';
import TrafficPanel from './TrafficPanel';
import ConnectionSettingsPanel from './ConnectionSettingsPanel';
import GeoSelect from './GeoSelect';
import { normalizeQuestionMonitoringUrl } from './question-monitoring-url';
import {
  resolveProjectTargetLanguage,
  resolveProjectUiLanguage,
} from '@/lib/geo/i18n';
import {
  UiLanguageProvider,
  useUiLanguage,
} from './UiLanguageContext';
import OpenGeoBrandMark from './OpenGeoBrandMark';
import './opengeo.css';
import './app-shell.css';

type Page =
  | 'overview'
  | 'question-plan'
  | 'competitor'
  | 'traffic'
  | 'assets'
  | 'tasks'
  | 'monitor'
  | 'settings';
const pages: Page[] = [
  'overview',
  'question-plan',
  'competitor',
  'traffic',
  'assets',
  'tasks',
  'monitor',
  'settings',
];
type Dialog =
  | 'implementation'
  | 'monitor'
  | 'live'
  | 'questions'
  | null;
const assetTypeLabel = (type: string) =>
  (
    ({
      article: '文章',
      guide: '实用指南',
      research: '研究',
      homepage: '项目首页',
      social_article: '社媒长文',
      social_post: '社媒发布',
    }) as Record<string, string>
  )[type] ?? type;
const assetStatusLabel = (status: string) =>
  (
    ({ published: '已发布', draft: '草稿', archived: '已归档' }) as Record<
      string,
      string
    >
  )[status] ?? status;
const shortPath = (path: string) => path.split('/').slice(-2).join('/');

function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`og-tag ${tone}`}>{children}</span>;
}
function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = previous;
    };
  }, [onClose]);
  return (
    <div className="og-modal-backdrop" onClick={onClose}>
      <section
        className={`og-modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button
            className="og-icon-button"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function MarkdownBody({
  content,
  evidencePath,
  onEvidence,
}: {
  content: string;
  evidencePath?: string;
  onEvidence?: (path: string) => void;
}) {
  return (
    <div className="og-markdown">
      <Markdown
        options={{
          disableParsingRawHTML: true,
          overrides: {
            a: {
              component: ({
                href = '',
                children,
              }: {
                href?: string;
                children?: ReactNode;
              }) => {
                if (
                  evidencePath &&
                  onEvidence &&
                  href &&
                  !href.startsWith('#') &&
                  !/^[a-z][a-z0-9+.-]*:/i.test(href) &&
                  !href.startsWith('//')
                ) {
                  const resolved = new URL(
                    href,
                    `https://local-evidence.invalid/${evidencePath}`,
                  ).pathname.slice(1);
                  return (
                    <button
                      className="og-text-button"
                      onClick={() => onEvidence(decodeURIComponent(resolved))}
                    >
                      {children}
                    </button>
                  );
                }
                return (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                );
              },
            },
          },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

function OpenGeoAppInner() {
  const { t, uiLanguage, setUiLanguage } = useUiLanguage();
  const [projectId, setProjectId] = useState('');
  const projectRef = useRef(projectId);
  const refreshVersion = useRef(0);
  const refreshRequest = useRef<AbortController | null>(null);
  const actionError = useRef('');
  const [questionGenerationProgress, setQuestionGenerationProgress] = useState<QuestionGenerationProgress>();
  const [optViewModel, setOptViewModel] = useState<OptimizationRunViewModel | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [detailsNavOpen, setDetailsNavOpen] = useState(false);
  const projectButton = useRef<HTMLButtonElement>(null);
  const [storedData, setData] = useState<GeoState | null>(null),
    [page, setPage] = useState<Page>('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [toast, setToast] = useState('');
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
  const [implementationKind, setImplementationKind] = useState<
      'rehearsal' | 'user_confirmed'
    >('rehearsal'),
    [note, setNote] = useState(''),
    [implementationUrl, setImplementationUrl] = useState(''),
    [implementationOccurredAt, setImplementationOccurredAt] = useState(''),
    [implementationRevision, setImplementationRevision] = useState<
      number | undefined
    >();
  const [monitorMode, setMonitorMode] = useState<'replay' | 'live'>('replay'),
    [monitorTime, setMonitorTime] = useState('09:00'),
    [monitorDays, setMonitorDays] = useState(7),
    [monitorBudget, setMonitorBudget] = useState(1),
    [monitorEnabled, setMonitorEnabled] = useState(true),
    [costConsent, setCostConsent] = useState(false);
  const refresh = useCallback(
    async (options?: { signal?: AbortSignal; onSuccess?: () => void }) => {
      const requestedProject = projectRef.current;
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
        if (!res.ok) throw new Error('暂时无法读取项目，请重试。');
        const next: GeoState = await res.json();
        if (!isCurrent()) return;
        if (requestedProject && next.project.id !== requestedProject)
          throw new Error('项目内容与当前地址不一致，请重新加载。');
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
        if (isCurrent()) setError(e instanceof Error ? e.message : '读取失败');
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
      setPage(pages.includes(requestedPage) ? requestedPage : 'overview');
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
    const project = storedData?.project;
    if (!project) return;
    const urlUi =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('ui')
        : null;
    if (urlUi === 'en' || urlUi === 'zh') {
      if (uiLanguage !== urlUi) {
        setUiLanguage(urlUi);
      }
      return;
    }
    const locked = resolveProjectUiLanguage({
      uiLanguage: project.uiLanguage,
      summaryOrDescription: project.description,
    });
    if (uiLanguage !== locked) {
      setUiLanguage(locked);
    }
  }, [storedData?.project, uiLanguage, setUiLanguage]);
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
    const controller = new AbortController();
    fetch(`/api/geo/optimization?project=${encodeURIComponent(projectId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: { viewModel?: OptimizationRunViewModel } | null) => {
        if (!controller.signal.aborted && payload) {
          setOptViewModel(payload.viewModel ?? null);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [projectId]);

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
      const id = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  useEffect(() => {
    if (!['queued', 'running'].includes(data?.questionGeneration?.status ?? '')) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [data?.questionGeneration?.status, projectId, refresh]);
  const questionRequest = useRef<{ key: string; id: string } | null>(null);
  const task = data?.tasks.find((t) => t.id === selectedTask);
  const groups = getTaskWorkspaceGroups(data?.tasks ?? []);
  const navigate = (nextPage: Page, taskId = '', batchId?: string) => {
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
    if (url.href !== window.location.href) {
      window.history.pushState(null, '', url);
    }
    setPage(nextPage);
    setSelectedTask(taskId);
    if (nextPage === page) window.dispatchEvent(new PopStateEvent('popstate'));
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
  const taskProvider =
    task?.workflow?.collection?.provider ??
    task?.collectionProvider ??
    'chatgpt';
  const providerOptions = data?.settings.collectionProviders ?? [];
  const taskProviderStatus = providerOptions.find((p) => p.id === taskProvider);
  const taskProviderLabel =
    taskProviderStatus?.label ??
    (taskProvider === 'google' ? 'Google' : 'ChatGPT');
  const taskProviderConfigured = taskProviderStatus?.configured ?? false;
  const answerCollection = taskProvider !== 'google';
  const monitorQuestionCount =
    task?.workflow?.questions.length ??
    (task?.monitor.queryIds.length || data?.questions.length || 0);
  const monitorRunCost =
    monitorQuestionCount * (answerCollection ? 0.1 : 0.005);
  const act = async (
    action: string,
    payload: Record<string, unknown> = {},
    message = '已保存',
  ) => {
    const actionProject = projectRef.current;
    actionError.current = '';
    setBusy(action);
    if (action === 'generate_questions') setQuestionGenerationProgress({ stage: 'preparing', message: '正在准备产品资料。' });
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
        ? await readQuestionGenerationStream(res, (progress) => {
            if (projectRef.current === actionProject) setQuestionGenerationProgress(progress);
          })
        : await res.json();
      if (!res.ok) throw new Error(result.error ?? '操作未完成，请重试。');
      if (projectRef.current !== actionProject) return null;
      setData(result);
      setToast(message);
      return result as GeoState;
    } catch (e) {
      actionError.current = e instanceof Error ? e.message : '操作失败';
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
  const openImplementation = (kind: 'rehearsal' | 'user_confirmed') => {
    setImplementationKind(kind);
    setNote(
      task?.implementation?.kind === 'user_confirmed'
        ? task.implementation.note
        : '',
    );
    setImplementationUrl(
      task?.implementation?.url || task?.proposal?.targetUrl || '',
    );
    setImplementationOccurredAt('');
    setImplementationRevision(task?.workflow?.proposalRevision);
    setDialog('implementation');
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
    setEvidence({ path, content: '正在读取依据…', format: 'text' });
    try {
      const res = await fetch(
        `/api/geo/evidence?project=${encodeURIComponent(evidenceProject)}&path=${encodeURIComponent(path)}`,
      );
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? '无法读取这份材料');
      if (projectRef.current === evidenceProject) setEvidence(result);
    } catch (e) {
      if (projectRef.current !== evidenceProject) return;
      setEvidence({
        path,
        format: 'text',
        content: e instanceof Error ? e.message : '读取失败',
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
  const openMonitor = () => {
    if (!task) return;
    setMonitorMode(answerCollection ? 'live' : task.monitor.mode);
    setMonitorTime(task.monitor.timeOfDay);
    setMonitorDays(task.monitor.days);
    setMonitorBudget(task.monitor.budgetLimit);
    setMonitorEnabled(task.monitor.enabled);
    setCostConsent(false);
    setDialog('monitor');
  };
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
  const confirmImplementation = async () => {
    const actualDate =
      implementationKind === 'user_confirmed'
        ? new Date(implementationOccurredAt)
        : null;
    if (actualDate && !Number.isFinite(actualDate.getTime())) {
      setToast('请填写真实实施时间。');
      return;
    }
    const result = await act(
      'confirm_implementation',
      {
        kind: implementationKind,
        note,
        url: implementationUrl,
        ...(actualDate ? { occurredAt: actualDate.toISOString() } : {}),
        ...(implementationRevision !== undefined
          ? { proposalRevision: implementationRevision }
          : {}),
      },
      implementationKind === 'rehearsal'
        ? '已进入演练观察，不会修改线上内容'
        : '已记录你的实施确认',
    );
    if (result) setDialog(null);
  };
  const saveMonitor = async () => {
    if (monitorMode === 'live' && !costConsent) return;
    const result = await act(
      'update_monitor',
      {
        monitor: {
          mode: monitorMode,
          timeOfDay: monitorTime,
          days: monitorDays,
          budgetLimit: monitorBudget,
          enabled: monitorEnabled,
        },
      },
      '跟踪设置已保存',
    );
    if (result) setDialog(null);
  };
  const loadingButton = (
    name: string,
    label: string,
    icon: ReactNode = <ArrowRight size={16} />,
  ) => (
    <>
      {busy === name ? <Loader2 size={16} className="spin" /> : icon}
      {label}
    </>
  );

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
      items: [
        { id: 'overview' as Page, label: t('nav.overview'), icon: LayoutDashboard },
        { id: 'tasks' as Page, label: t('nav.tasks'), icon: ListChecks },
      ],
    },
    {
      id: 'details',
      label: t('nav.details'),
      items: [
        { id: 'question-plan' as Page, label: t('nav.questions'), icon: Search },
        { id: 'competitor' as Page, label: t('nav.competitor'), icon: GitCompareArrows },
        { id: 'traffic' as Page, label: t('nav.traffic'), icon: MousePointer2 },
        { id: 'assets' as Page, label: t('nav.assets'), icon: BookOpen },
      ],
    },
  ];
  const nav = navGroups.flatMap((group) => group.items);
  const sidebarPage =
    page === 'monitor' ? 'tasks' : page;
  const improvementWorkspace = page === 'tasks' || page === 'monitor';
  const customCanvasPage = page === 'overview' || improvementWorkspace;
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
      <aside className="og-sidebar">
        <a
          className="og-logo"
          href={`/?view=overview&project=${encodeURIComponent(projectId)}`}
          aria-label="OpenGEO 首页"
        >
          <OpenGeoBrandMark size={22} />OpenGEO
        </a>
        <div className="og-project-picker">
          <button
            ref={projectButton}
            className="og-project-trigger"
            aria-expanded={projectMenuOpen}
            aria-haspopup="menu"
            aria-controls="og-project-menu"
            disabled={!data || !!busy}
            onClick={() => setProjectMenuOpen(!projectMenuOpen)}
          >
            <span className="og-project-avatar">
              {data?.project.name.slice(0, 1).toUpperCase() || '·'}
            </span>
            <span className="og-project-label">
              <small>{t('nav.currentProject')}</small>
              <strong>{data?.project.name ?? '正在读取…'}</strong>
            </span>
            <ChevronDown size={15} />
          </button>
          {projectMenuOpen && data && (
            <div
              id="og-project-menu"
              className="og-project-menu"
              role="menu"
              aria-label="切换项目"
              onKeyDown={(event) => {
                if (
                  !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
                )
                  return;
                event.preventDefault();
                const choices = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>(
                    '[role="menuitemradio"], [role="menuitem"]',
                  ),
                );
                const index = choices.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? choices.length - 1
                      : (index +
                          (event.key === 'ArrowDown' ? 1 : -1) +
                          choices.length) %
                        choices.length;
                choices[next]?.focus();
              }}
            >
              {(data.projects ?? [data.project]).map((project) => (
                <button
                  key={project.id}
                  role="menuitemradio"
                  aria-checked={project.id === projectId}
                  onClick={() => switchProject(project.id)}
                >
                  <span className="og-project-avatar">
                    {project.name.slice(0, 1).toUpperCase()}
                  </span>
                  <strong>{project.name}</strong>
                  {project.id === projectId && <Check size={16} />}
                </button>
              ))}
              <a href="/new" role="menuitem" className="og-project-create-link"><Plus size={17} /><strong>{t('nav.newProject')}</strong></a>
            </div>
          )}
        </div>
        <nav aria-label="主导航">
          {navGroups.map((group) => {
            const isDetails = group.id === 'details';
            const isDetailActive = group.items.some(
              (item) => sidebarPage === item.id,
            );
            const showItems = !isDetails || detailsNavOpen || isDetailActive;
            return (
              <div
                key={group.id}
                className={`og-nav-group og-nav-${group.id}`}
                role={group.label ? 'group' : undefined}
                aria-labelledby={
                  group.label && !isDetails ? `og-nav-${group.id}-label` : undefined
                }
              >
                {group.label &&
                  (isDetails ? (
                    <button
                      type="button"
                      className="og-nav-toggle"
                      aria-expanded={showItems}
                      onClick={() => setDetailsNavOpen((v) => !v)}
                    >
                      <span>{group.label}</span>
                      <ChevronDown
                        size={13}
                        className={showItems ? 'is-open' : ''}
                      />
                    </button>
                  ) : (
                    <h2
                      className="og-nav-label"
                      id={`og-nav-${group.id}-label`}
                    >
                      {group.label}
                    </h2>
                  ))}
                {showItems &&
                  group.items.map((item) => (
                    <button
                      key={item.id}
                      className={sidebarPage === item.id ? 'active' : ''}
                      aria-current={sidebarPage === item.id ? 'page' : undefined}
                      onClick={() => navigate(item.id)}
                    >
                      <item.icon size={17} />
                      <span>{item.label}</span>
                      {item.id === 'tasks' && optNavBadge && (
                        <small className={`og-nav-pill is-${optNavBadge.tone}`}>
                          {optNavBadge.label}
                        </small>
                      )}
                    </button>
                  ))}
              </div>
            );
          })}
        </nav>
        <div className="og-sidebar-bottom">
          <a
            href={data?.project.siteUrl || data?.project.repositoryUrl || undefined}
            aria-disabled={!data}
            target="_blank"
            rel="noreferrer"
          >
            {t('nav.visitProject')} <ArrowUpRight size={14} />
          </a>
          <button
            type="button"
            className="og-settings-link"
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => navigate('settings')}
          >
            {t('nav.settings')} <Settings2 size={14} />
          </button>
        </div>
      </aside>
      <main className="og-main">
        {error && (
          <div className="og-error-banner" role="alert">
            {error}
            <button
              onClick={() => {
                void refresh();
              }}
            >
              重新加载
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
              <header className="rw-page-heading">
                <div className="rw-heading-title">
                  <a
                    className="rw-brand"
                    href={`/?view=overview&project=${projectId}`}
                  >
                    <OpenGeoBrandMark size={25} /> OpenGEO
                  </a>
                  <h1>
                    {page === 'settings'
                      ? (uiLanguage === 'en' ? 'Settings' : '设置')
                      : nav.find((item) => item.id === sidebarPage)?.label}
                  </h1>
                </div>
                {page !== 'settings' && (
                  <form
                    className="rw-global-search"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const search = new FormData(event.currentTarget).get(
                        'search',
                      );
                      const current = new URLSearchParams(
                        window.location.search,
                      );
                      const target = new URL('/', window.location.origin);
                      target.searchParams.set('view', 'question-plan');
                      target.searchParams.set('project', projectId);
                      target.searchParams.set('search', String(search || ''));
                      target.searchParams.set('questionSearch', String(search || ''));
                      for (const key of ['language', 'engine', 'ui'])
                        if (current.has(key))
                          target.searchParams.set(key, current.get(key)!);
                      window.location.assign(target);
                    }}
                  >
                    <Search size={15} />
                    <input
                      name="search"
                      aria-label={uiLanguage === 'en' ? 'Search prompts' : '搜索项目内问题'}
                      placeholder={uiLanguage === 'en' ? 'Search prompts…' : '搜索项目内问题…'}
                    />
                  </form>
                )}
                {page !== 'settings' && data.latestResearch && (
                  <button
                    className="rw-button"
                    onClick={() =>
                      openEvidence(data.latestResearch!.reportPath)
                    }
                  >
                    <FileText size={15} />
                    {uiLanguage === 'en' ? 'Research report' : '研究报告'}
                  </button>
                )}
              </header>
            )}
            <div
              className={
                !customCanvasPage
                  ? 'og-workspace-body'
                  : undefined
              }
            >
              {data.latestResearch &&
                (page === 'overview' || page === 'question-plan') && (
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
                    detailsOnly={page === 'question-plan'}
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
                    onAssets={() => navigate('assets')}
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
                        '已保存人工核查与依据',
                      );
                      if (!result)
                        throw new Error('核查未保存，请查看提示后重试。');
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
                  <div className="pov-shell">
                    <div className="pov-empty-card">
                      <div className="pov-empty-head">
                        <div>
                          <h1>{t('overview.firstSetupTitle')}</h1>
                          <p>
                            {readyCandidates.length > 0
                              ? t('overview.firstSetupDesc', { langLabel })
                              : t('overview.firstSetupNoQuestions')}
                          </p>
                        </div>
                        {readyCandidates.length > 0 && (
                          <button
                            type="button"
                            className="pov-inline-link"
                            onClick={() => navigate('question-plan')}
                          >
                            {t('overview.reviewQuestionsBtn')} <ArrowRight size={14} />
                          </button>
                        )}
                      </div>
                      {readyCandidates.length > 0 ? (
                        <>
                          <ol className="pov-empty-questions">
                            {readyCandidates.slice(0, 8).map((c) => (
                              <li key={c.id}>
                                <span className="pov-q-cat">
                                  {c.category === 'brand'
                                    ? t('overview.catBrand')
                                    : t('overview.catProblem')}
                                </span>
                                <span>
                                  {targetLang === 'en' ? c.queryEn || c.query : c.query || c.queryEn}
                                </span>
                              </li>
                            ))}
                          </ol>
                          <div className="pov-empty-actions">
                            <button
                              type="button"
                              className="pov-primary-btn"
                              disabled={!!busy || genActive}
                              onClick={() =>
                                void act(
                                  'confirm_questions',
                                  {
                                    planId: data.questionPlan.id,
                                    revision: data.questionPlan.revision,
                                  },
                                  '已确认本批核心问题，可直接开始采集',
                                )
                              }
                            >
                              {busy === 'confirm_questions' ? (
                                <>
                                  <Loader2 size={15} className="spin" />
                                  {t('overview.confirmingQuestionsBtn')}
                                </>
                              ) : (
                                <>
                                  <Check size={15} />
                                  {t('overview.confirmQuestionsBtn', {
                                    count: readyCandidates.length,
                                  })}
                                </>
                              )}
                            </button>
                          </div>
                        </>
                      ) : (
                        <div className="pov-empty-actions">
                          <button
                            type="button"
                            className="pov-primary-btn"
                            disabled={!!busy || genActive}
                            onClick={() =>
                              void act(
                                'generate_questions',
                                {
                                  planId: data.questionPlan.id,
                                  revision: data.questionPlan.revision,
                                  positioning:
                                    data.questionPlan.positioning ||
                                    data.project.description,
                                },
                                '已生成并审核推荐问题',
                              )
                            }
                          >
                            {busy === 'generate_questions' || genActive ? (
                              <>
                                <Loader2 size={15} className="spin" />
                                {t('overview.generatingQuestionsBtn')}
                              </>
                            ) : (
                              <>
                                <Search size={15} />
                                {t('overview.generateQuestionsBtn')}
                              </>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
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
                <CompetitorPanel key={data.project.id} project={data.project} />
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
                        ? '已保存，等待人工审阅'
                        : action === 'review_question'
                          ? '人工审阅已保存'
                          : action === 'audit_question'
                            ? 'AI 复评已保存，请查看需求价值与承接情况'
                          : action === 'confirm_questions'
                            ? '题单已确认，尚未开始搜索'
                            : '题单选择已保存',
                    );
                    if (!result) {
                      const message =
                        actionError.current || '操作未保存，请重试。';
                      await refresh();
                      throw new Error(message);
                    }
                    return true;
                  }}
                  onResult={(question, language, engine = 'all', record) => {
                    // The collection response may be newer than the overview refresh.
                    // Open the precise record with the same server-returned batch.
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
                    url.searchParams.set('view', 'question-plan');
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
                  }}
                />
              )}
              {page === 'assets' && (
                <ContentPanel
                  data={data}
                  onAsset={setAsset}
                  onTask={() => openTask()}
                  onImprove={routeLegacyImprovementToActionPlan}
                  onGovernance={async (governance) => {
                    const result = await act(
                      'save_asset_governance',
                      { governance },
                      '材料核查记录已保存',
                    );
                    if (!result)
                      throw new Error('核查未保存，请查看提示后重试。');
                  }}
                  onOpenTask={openTask}
                />
              )}
              {page === 'question-plan' && dialog === 'questions' && (
                <Modal title="用户会怎么问" onClose={() => setDialog(null)}>
                  <div className="og-question-editor">
                    <QuestionPlanPanel
                      plan={data.questionPlan}
                      assets={data.assets}
                      modelConfigured={data.settings.questionModelConfigured ?? data.settings.modelConfigured}
                      busy={!!busy}
                      generationProgress={questionGenerationProgress}
                      generationJob={data.questionGeneration}
                      onAsset={setAsset}
                      onConfigureModel={() => navigate('settings')}
                      onAuditCandidate={async (candidateId) => {
                        const result = await act('audit_question', {
                          candidateId, planId: data.questionPlan.id,
                          revision: data.questionPlan.revision,
                        }, '已重新评估这个问题');
                        if (!result) throw new Error(actionError.current || '评估未完成，请重试。');
                      }}
                      onGenerate={async (positioning) => {
                        const key = `${projectId}:${data.questionPlan.id}:${data.questionPlan.revision}:${positioning}`;
                        if (questionRequest.current?.key !== key) {
                          questionRequest.current = { key, id: crypto.randomUUID() };
                        }
                        const result = await act(
                          'start_question_generation',
                          {
                            positioning,
                            planId: data.questionPlan.id,
                            revision: data.questionPlan.revision,
                            requestId: questionRequest.current.id,
                          },
                          '正在后台准备问题',
                        );
                        if (!result) throw new Error(actionError.current || '生成未完成，请重试。');
                        questionRequest.current = null;
                      }}
                      onToggle={async (candidateId, selected) => {
                        await act(
                          'select_question',
                          {
                            candidateId,
                            selected,
                            planId: data.questionPlan.id,
                            revision: data.questionPlan.revision,
                          },
                          '已保存所选问题',
                        );
                      }}
                      onConfirm={async () => {
                        await act(
                          'confirm_questions',
                          {
                            planId: data.questionPlan.id,
                            revision: data.questionPlan.revision,
                          },
                          '已确认要监测的问题',
                        );
                      }}
                      onContinue={() => navigate('tasks')}
                    />
                  </div>
                </Modal>
              )}
              {(page === 'tasks' || page === 'monitor') && (
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
          {toast}
          <button onClick={() => setToast('')} aria-label="关闭提示">
            <X size={14} />
          </button>
        </div>
      )}
      {dialog === 'implementation' && (
        <Modal title="登记实施情况" onClose={() => setDialog(null)}>
          <ImplementationRecordForm
            task={task}
            assets={data?.assets ?? []}
            kind={implementationKind}
            revision={implementationRevision}
            url={implementationUrl}
            note={note}
            occurredAt={implementationOccurredAt}
            onKind={setImplementationKind}
            onUrl={setImplementationUrl}
            onNote={setNote}
            onOccurredAt={setImplementationOccurredAt}
          />
          <div className="og-modal-actions">
            <button
              className="og-button secondary"
              onClick={() => setDialog(null)}
            >
              再看看
            </button>
            <button
              className="og-button primary"
              disabled={
                !!busy ||
                (implementationKind === 'user_confirmed' &&
                  (!note.trim() || !implementationOccurredAt))
              }
              onClick={confirmImplementation}
            >
              {loadingButton(
                'confirm_implementation',
                implementationKind === 'rehearsal'
                  ? '保存演练记录'
                  : '保存实施记录',
                <CheckCheck size={16} />,
              )}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'monitor' && (
        <Modal title="设置效果跟踪" onClose={() => setDialog(null)}>
          <div className="og-modal-body">
            <label className="og-field-label">跟踪方式</label>
            <div className="og-radio-cards">
              <button
                className={monitorMode === 'replay' ? 'selected' : ''}
                disabled={answerCollection}
                onClick={() => setMonitorMode('replay')}
              >
                <span className="og-radio-dot" />
                <div>
                  <strong>
                    历史回放 <Badge>免费</Badge>
                  </strong>
                  <p>
                    {answerCollection
                      ? '该入口尚不支持历史回放。'
                      : '用已有真实记录演示，不产生新测量。'}
                  </p>
                </div>
              </button>
              <button
                className={monitorMode === 'live' ? 'selected' : ''}
                disabled={
                  !taskProviderConfigured ||
                  task?.implementation?.kind !== 'user_confirmed'
                }
                onClick={() => setMonitorMode('live')}
              >
                <span className="og-radio-dot" />
                <div>
                  <strong>{taskProviderLabel} · 真实采集</strong>
                  <p>
                    {task?.implementation?.kind !== 'user_confirmed'
                      ? '记录实际实施后，才可采集实施后的真实结果。'
                      : taskProviderConfigured
                        ? '每天使用同一入口重新检查，保留回答与来源。'
                        : `需要配置：${taskProviderStatus?.missing.join('、') || '采集服务'}。`}
                  </p>
                </div>
              </button>
            </div>
            <div className="og-form-row">
              <div>
                <label className="og-field-label" htmlFor="monitor-time">
                  检查时间 <span>UTC</span>
                </label>
                <input
                  id="monitor-time"
                  className="og-input"
                  type="time"
                  value={monitorTime}
                  onChange={(e) => setMonitorTime(e.target.value)}
                />
              </div>
              <div>
                <label className="og-field-label" htmlFor="monitor-days">
                  跟踪时长
                </label>
                <GeoSelect
                  id="monitor-days"
                  label="跟踪时长"
                  value={String(monitorDays)}
                  onChange={(value) => setMonitorDays(Number(value))}
                  options={[3, 7, 14, 30].map((n) => ({
                    value: String(n),
                    label: `${n} 天`,
                  }))}
                />
              </div>
            </div>
            {monitorMode === 'live' && (
              <>
                <label className="og-field-label" htmlFor="monitor-budget">
                  {answerCollection
                    ? '累计预算预留（USD）'
                    : '搜索费用上限（USD）'}
                </label>
                <input
                  id="monitor-budget"
                  className="og-input"
                  type="number"
                  min={monitorRunCost}
                  step={answerCollection ? '0.1' : '0.005'}
                  value={monitorBudget}
                  onChange={(e) => setMonitorBudget(Number(e.target.value))}
                />
                <div className="og-cost-note">
                  固定 {monitorQuestionCount} 题，每次完整检查预留{' '}
                  {monitorRunCost.toFixed(3)}，{monitorDays} 天预留{' '}
                  {(monitorDays * monitorRunCost).toFixed(3)}。
                  {answerCollection
                    ? '按预算系数控制调用次数；搜索与模型费用以服务商账单为准，这不是实际花费或硬性费用上限。'
                    : '预算用尽后停止。'}
                </div>
                <label className="og-checkbox">
                  <input
                    type="checkbox"
                    checked={costConsent}
                    onChange={(e) => setCostConsent(e.target.checked)}
                  />
                  <span>
                    {answerCollection
                      ? '我同意按这个计划采集联网回答，并了解实际费用以服务商账单为准。'
                      : '我同意按这个计划调用付费搜索，费用不超过设置的上限。'}
                  </span>
                </label>
              </>
            )}
            <label className="og-checkbox">
              <input
                type="checkbox"
                checked={monitorEnabled}
                onChange={(e) => setMonitorEnabled(e.target.checked)}
              />
              <span>开启每天自动观察（本地服务需保持运行）</span>
            </label>
          </div>
          <div className="og-modal-actions">
            <button
              className="og-button secondary"
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button
              className="og-button primary"
              disabled={
                !!busy ||
                (monitorMode === 'live' &&
                  (!costConsent ||
                    !taskProviderConfigured ||
                    !Number.isFinite(monitorBudget) ||
                    monitorBudget < monitorRunCost ||
                    task?.implementation?.kind !== 'user_confirmed'))
              }
              onClick={saveMonitor}
            >
              {loadingButton(
                'update_monitor',
                '保存跟踪设置',
                <Check size={16} />,
              )}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'live' && (
        <Modal
          title="复测一次"
          description={`这会通过${taskProviderLabel}采集新的真实结果。`}
          onClose={() => setDialog(null)}
        >
          <div className="og-modal-body">
            <div className="og-cost-summary">
              <Search size={25} />
              <div>
                <strong>{monitorQuestionCount} 个固定问题</strong>
                <p>
                  预留额度 {monitorRunCost.toFixed(3)} ·{' '}
                  {answerCollection
                    ? '实际费用以服务商账单为准'
                    : '按服务商实际请求计费'}
                </p>
              </div>
            </div>
            <label className="og-checkbox">
              <input
                type="checkbox"
                checked={costConsent}
                onChange={(e) => setCostConsent(e.target.checked)}
              />
              <span>我确认运行这次付费采集，并记录新的测量结果。</span>
            </label>
          </div>
          <div className="og-modal-actions">
            <button
              className="og-button secondary"
              onClick={() => setDialog(null)}
            >
              取消
            </button>
            <button
              className="og-button primary"
              disabled={!!busy || !costConsent || !taskProviderConfigured}
              onClick={async () => {
                const r = await act(
                  'run_monitor',
                  { mode: 'live' },
                  '实时检查已开始，结果会自动更新',
                );
                if (r) setDialog(null);
              }}
            >
              {loadingButton('run_monitor', '确认并开始', <Play size={15} />)}
            </button>
          </div>
        </Modal>
      )}
      {asset && (
        <Modal
          title={asset.title}
          description={`${assetTypeLabel(asset.type)} · ${asset.language === 'zh-CN' ? '中文' : asset.language === 'en' ? '英文' : asset.language} · ${assetStatusLabel(asset.status)}`}
          onClose={() => setAsset(null)}
          wide
        >
          <div className="og-document-toolbar">
            <span>
              <FileText size={14} />{' '}
              {asset.markdownIsExcerpt ? '已保存摘录' : '已保存正文'}
            </span>
            {asset.publicUrl && (
              <a
                className="og-button secondary"
                href={asset.publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看线上页面 <ArrowUpRight size={14} />
              </a>
            )}
          </div>
          <div className="og-document-body">
            <MarkdownBody content={asset.markdown} />
            <div className="og-document-source">
              <strong>来源与依据</strong>
              {evidenceLinks([asset.sourcePath, ...asset.evidencePaths])}
            </div>
          </div>
        </Modal>
      )}
      {evidence && (
        <Modal
          title="查看依据"
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
              本地审计材料 · 原始搜索中的第三方文字仅供核对
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
    </UiLanguageProvider>
  );
}

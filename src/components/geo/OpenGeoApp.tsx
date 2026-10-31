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
  Search,
  Settings2,
  ShieldCheck,
  GitCompareArrows,
  MousePointer2,
  X,
} from 'lucide-react';
import type { GeoAsset, GeoState, ResearchTaskContext } from '@/lib/geo/types';
import type { CompetitorCandidates } from '@/lib/geo/competitor-types';
import {
  getBatchResearchEngines,
  isResearchEngine,
  RESEARCH_ENGINE_NAMES,
} from '@/lib/geo/research-engines';
import type { CollectionProvider } from '@/lib/geo/providers/types';
import type {
  ResearchBatch,
  ResearchQuestion,
  ResearchEngine,
} from '@/lib/geo/research-types';
import VisibilityPanel from './VisibilityPanel';
import ContentPanel from './ContentPanel';
import TaskWorkspace, {
  getTaskWorkspaceGroups,
  isHistoricalTask,
} from './TaskWorkspace';
import ImplementationRecordForm from './ImplementationRecordForm';
import QuestionPlanPanel from './QuestionPlanPanel';
import QuestionManagementPanel from './QuestionManagementPanel';
import ResearchPanel, { clearResearchDetailParams } from './ResearchPanel';
import CompetitorPanel from './CompetitorPanel';
import TrafficPanel from './TrafficPanel';
import ConnectionSettingsPanel from './ConnectionSettingsPanel';
import GeoSelect from './GeoSelect';
import './opengeo.css';
import './app-shell.css';

type Page =
  | 'overview'
  | 'questions'
  | 'question-plan'
  | 'competitor'
  | 'traffic'
  | 'assets'
  | 'tasks'
  | 'monitor'
  | 'settings';
const pages: Page[] = [
  'overview',
  'questions',
  'question-plan',
  'competitor',
  'traffic',
  'assets',
  'tasks',
  'monitor',
  'settings',
];
type Dialog =
  | 'create'
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

export default function OpenGeoApp() {
  const [researchContext, setResearchContext] =
    useState<ResearchTaskContext | null>(null);
  const [competitorReferenceName, setCompetitorReferenceName] = useState('');
  const [legacyQuestionPlan, setLegacyQuestionPlan] = useState(false);
  const [projectId, setProjectId] = useState('');
  const projectRef = useRef(projectId);
  const refreshVersion = useRef(0);
  const refreshRequest = useRef<AbortController | null>(null);
  const actionError = useRef('');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectButton = useRef<HTMLButtonElement>(null);
  const [storedData, setData] = useState<GeoState | null>(null),
    [page, setPage] = useState<Page>('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [toast, setToast] = useState('');
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
  const [goal, setGoal] = useState(
    '让 项目 在相关问题的搜索结果中被找到，给我一个有依据的改进方案，并持续观察它是否有效。',
  );
  const [collectionProvider, setCollectionProvider] =
    useState<CollectionProvider>('deepseek');
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
      if (!requestedProject || options?.signal?.aborted) return;
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
          'example-project') === requestedProject;
      try {
        const res = await fetch(
          `/api/geo?project=${encodeURIComponent(requestedProject)}`,
          { cache: 'no-store', signal: controller.signal },
        );
        if (!res.ok) throw new Error('暂时无法读取项目，请重试。');
        const next: GeoState = await res.json();
        if (!isCurrent()) return;
        if (next.project.id !== requestedProject)
          throw new Error('项目内容与当前地址不一致，请重新加载。');
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
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'history') {
        params.set('view', 'tasks');
        params.delete('task');
        const url = new URL(window.location.href);
        url.search = params.toString();
        window.history.replaceState(null, '', url);
      }
      const requestedPage = params.get('view') as Page;
      const requestedProject = params.get('project') || 'example-project';
      const projectChanged = projectRef.current !== requestedProject;
      if (projectChanged) {
        refreshVersion.current += 1;
        projectRef.current = requestedProject;
        setData(null);
        setProjectId(requestedProject);
        setError('');
        setToast('');
      }
      setPage(pages.includes(requestedPage) ? requestedPage : 'overview');
      setSelectedTask(params.get('task') ?? '');
      setDialog(null);
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
    if (data)
      setGoal(
        `让 ${data.project.name} 在相关问题的搜索结果中被找到，给我一个有依据的改进方案，并持续观察它是否有效。`,
      );
  }, [data?.project.id]);
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
  const task = data?.tasks.find((t) => t.id === selectedTask);
  const groups = getTaskWorkspaceGroups(data?.tasks ?? []);
  const navigate = (nextPage: Page, taskId = '', batchId?: string) => {
    const url = new URL(window.location.href);
    clearResearchDetailParams(url);
    if (
      (url.searchParams.get('project') || 'example-project') !== projectRef.current
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
    'deepseek';
  const providerOptions = data?.settings.collectionProviders ?? [];
  const taskProviderStatus = providerOptions.find((p) => p.id === taskProvider);
  const newProviderStatus = providerOptions.find(
    (p) => p.id === collectionProvider,
  );
  const taskProviderLabel = taskProviderStatus?.label ?? 'DeepSeek 搜索';
  const taskProviderConfigured =
    taskProviderStatus?.configured ??
    (taskProvider === 'deepseek' && !!data?.settings.liveSearchConfigured);
  const answerCollection = taskProvider !== 'deepseek';
  const monitorQuestionCount =
    task?.workflow?.questions.length ??
    (task?.monitor.queryIds.length || data?.questions.length || 0);
  const monitorRunCost =
    monitorQuestionCount * (answerCollection ? 0.1 : 0.005);
  const selectedQuestionCount =
    data?.questionPlan.candidates.filter(
      (candidate) =>
        candidate.selected && candidate.review.decision !== 'exclude',
    ).length ?? 0;
  const act = async (
    action: string,
    payload: Record<string, unknown> = {},
    message = '已保存',
  ) => {
    const actionProject = projectRef.current;
    actionError.current = '';
    setBusy(action);
    try {
      const res = await fetch('/api/geo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          projectId: actionProject,
          ...(task ? { taskId: task.id } : {}),
          ...payload,
        }),
      });
      const result = await res.json();
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
  const createTask = async () => {
    if (!goal.trim()) return;
    if (data?.latestResearch && !researchContext && !legacyQuestionPlan) {
      setToast('请选择本轮要解决的问题。');
      return;
    }
    const result = await act(
      'create_task',
      {
        goal,
        collectionProvider,
        ...(researchContext ? { researchContext } : {}),
        legacyQuestionPlan,
      },
      '任务已创建，原问题和依据已保存',
    );
    if (result) {
      const added = result.tasks.find(
        (t) => !data?.tasks.some((old) => old.id === t.id),
      );
      navigate('tasks', added?.id ?? task?.id ?? selectedTask);
      setDialog(null);
      setResearchContext(null);
      setLegacyQuestionPlan(false);
    }
  };
  const startSavedResearchPlan = async (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine: ResearchEngine,
  ) => {
    if (!data?.latestResearch || busy) return;
    const context = { batchId: data.latestResearch.id, questionId: question.id, language, engine };
    const existing = data.tasks.find(item =>
      item.researchContext?.batchId === context.batchId &&
      item.researchContext?.questionId === question.id &&
      item.researchContext?.language === language &&
      item.researchContext?.engine === engine &&
      item.researchContext?.purpose !== 'investigate_gap' &&
      !item.implementation,
    );
    if (existing && (existing.proposal || existing.status === 'investigating')) {
      navigate('tasks', existing.id);
      return;
    }
    let taskId = existing?.id;
    if (!taskId) {
      const result = await act('create_task', {
        goal: `${question[language]}\n\n对照已有回答与自有内容，提出有依据、可实施并能复测的改进方案。`,
        collectionProvider,
        researchContext: context,
      });
      if (!result) return;
      taskId = result.tasks.find(item => !data.tasks.some(old => old.id === item.id))?.id;
    }
    if (!taskId) return;
    navigate('tasks', taskId);
    await act('plan_from_saved', { taskId, maxQualityRounds: 2 }, '已开始比较已有回答、生成方案并独立审核');
  };
  const openResearchTask = (
    question: ResearchQuestion,
    language: 'zh' | 'en',
    engine: ResearchEngine,
  ) => {
    if (!data?.latestResearch) return;
    setLegacyQuestionPlan(false);
    setResearchContext({
      batchId: data.latestResearch.id,
      questionId: question.id,
      language,
      engine,
    });
    setGoal(
      [
        language === 'zh' ? question.zh : question.en,
        '已观察：' + question.diagnosis.observed,
        '待验证：' + question.diagnosis.hypothesis,
        '下一步：' + question.diagnosis.nextStep,
      ].join('\n\n'),
    );
    setDialog('create');
  };
  const openAssetImprovement = (context: ResearchTaskContext) => {
    const batch = data?.latestResearch;
    const question = [
      ...(batch?.questions || []),
      ...(batch?.deferredQuestions || []),
    ].find((item) => item.id === context.questionId);
    if (!batch || !question) return;
    setResearchContext(context);
    setLegacyQuestionPlan(false);
    setGoal(
      [
        question[context.language],
        context.gap
          ? `核查并补齐：${context.gap}`
          : question.diagnosis.nextStep,
      ].join('\n\n'),
    );
    setDialog('create');
  };
  useEffect(() => {
    let active = true;
    let request: AbortController | undefined;
    const openCompetitorImprovement = async (event: Event) => {
      const detail = (event as CustomEvent<Partial<ResearchTaskContext>>)
        .detail;
      if (!detail || !data || detail.projectId !== data.project.id) return;
      if (
        typeof detail.batchId !== 'string' ||
        !detail.batchId ||
        typeof detail.questionId !== 'string' ||
        typeof detail.candidateId !== 'string' ||
        !isResearchEngine(detail.engine) ||
        (detail.language !== 'zh' && detail.language !== 'en')
      ) {
        setToast('改进依据不完整，请重新选择改进方向。');
        return;
      }
      request?.abort();
      const controller = new AbortController();
      request = controller;
      const isCurrent = () =>
        active &&
        !controller.signal.aborted &&
        projectRef.current === detail.projectId;
      try {
        const params = new URLSearchParams({
          project: data.project.id,
          batch: detail.batchId,
        });
        let requestedBatch = data.latestResearch;
        if (requestedBatch?.id !== detail.batchId) {
          const response = await fetch(`/api/geo/research?${params}`, {
            cache: 'no-store',
            signal: controller.signal,
          });
          const result: { batch?: ResearchBatch | null; error?: string } =
            await response.json();
          if (!isCurrent()) return;
          if (!response.ok)
            throw new Error(result.error || '历史批次无法读取。');
          requestedBatch = result.batch;
        }
        const batch = requestedBatch;
        if (
          !batch ||
          batch.id !== detail.batchId ||
          batch.projectId !== detail.projectId
        )
          throw new Error('返回的项目或研究批次不匹配，请重新选择改进方向。');
        const question = batch.questions.find(
          (item) => item.id === detail.questionId,
        );
        if (!question) throw new Error('这份研究批次中没有找到所选问题。');
        const response = await fetch(
          `/api/geo/competitor-candidates?${params}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const result: CompetitorCandidates & { error?: string } =
          await response.json();
        if (!response.ok) throw new Error(result.error || '暂时无法读取参照。');
        if (!isCurrent()) return;
        if (
          result.projectId !== detail.projectId ||
          result.batch?.id !== batch.id
        )
          throw new Error('返回的参照项目或批次不匹配，请重新选择改进方向。');
        const reference = result.selectedCandidate;
        if (
          result.selection?.candidateId !== detail.candidateId ||
          reference?.id !== detail.candidateId
        )
          throw new Error('参照已变化，请重新选择改进方向。');
        const scopedEvidenceIds = new Set(
          reference.questions
            .filter(
              (item) =>
                item.batchId === batch.id &&
                item.questionId === question.id &&
                item.language === detail.language &&
                item.engine === detail.engine,
            )
            .map((item) => item.evidenceId)
            .filter(Boolean),
        );
        const opportunities =
          reference.analysis?.opportunities.filter(
            (item) =>
              item.questionId === question.id &&
              item.evidenceIds.length > 0 &&
              item.evidenceIds.every((id) => scopedEvidenceIds.has(id)),
          ) ?? [];
        if (!opportunities.length)
          throw new Error('这道问题暂无参照改进依据。');
        setResearchContext({
          projectId: detail.projectId,
          batchId: batch.id,
          questionId: question.id,
          language: detail.language,
          engine: detail.engine,
          candidateId: reference.id,
        });
        setCompetitorReferenceName(reference.name);
        setLegacyQuestionPlan(false);
        const brief = [
          question[detail.language],
          `参照：${reference.name}`,
          ...opportunities.map(
            (item) =>
              `已观察：${item.observed}\n待验证：${item.hypothesis}\n改进方向：${item.action}`,
          ),
        ].join('\n\n');
        setGoal(
          `${brief.length > 1800 ? `${brief.slice(0, 1799)}…` : brief}\n\n目标：自身比之前好，并缩小与参照的差距；同条件复测后分别判断。`,
        );
        if (['deepseek', 'qwen', 'doubao'].includes(detail.engine))
          setCollectionProvider(detail.engine as CollectionProvider);
        setDialog('create');
      } catch (error) {
        if (isCurrent())
          setToast(
            error instanceof Error ? error.message : '暂时无法读取参照。',
          );
      }
    };
    window.addEventListener(
      'geo-competitor-improve',
      openCompetitorImprovement,
    );
    return () => {
      active = false;
      request?.abort();
      window.removeEventListener(
        'geo-competitor-improve',
        openCompetitorImprovement,
      );
    };
  }, [data]);
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

  const navGroups = [
    {
      id: 'overview',
      label: null,
      items: [{ id: 'overview' as Page, label: '概览', icon: LayoutDashboard }],
    },
    {
      id: 'monitoring',
      label: '监测',
      items: [
        { id: 'question-plan' as Page, label: '问题监测', icon: Search },
        { id: 'competitor' as Page, label: '竞品对照', icon: GitCompareArrows },
        { id: 'traffic' as Page, label: '流量数据', icon: MousePointer2 },
      ],
    },
    {
      id: 'optimization',
      label: '优化',
      items: [
        { id: 'assets' as Page, label: '内容资产', icon: BookOpen },
        { id: 'tasks' as Page, label: '改进与追踪', icon: ListChecks },
      ],
    },
  ];
  const nav = navGroups.flatMap((group) => group.items);
  const sidebarPage =
    page === 'questions'
      ? 'question-plan'
      : page === 'monitor'
        ? 'tasks'
        : page;
  const improvementWorkspace = page === 'tasks' || page === 'monitor';
  const workspaceViews = improvementWorkspace
    ? [
        { id: 'tasks' as Page, label: '任务进展' },
        { id: 'monitor' as Page, label: '效果追踪' },
      ]
    : [];
  return (
    <div
      className={`og-app og-redesigned og-research-workspace ${page !== 'overview' ? 'og-b-workspace' : ''}`}
    >
      <aside className="og-sidebar">
        <a
          className="og-logo"
          href={`/?view=overview&project=${encodeURIComponent(projectId)}`}
          aria-label="OpenGEO 首页"
        >
          <span>O</span>OpenGEO
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
              <small>当前项目</small>
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
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitemradio"]',
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
            </div>
          )}
        </div>
        <nav aria-label="主导航">
          {navGroups.map((group) => (
            <div
              key={group.id}
              className={`og-nav-group og-nav-${group.id}`}
              role={group.label ? 'group' : undefined}
              aria-labelledby={
                group.label ? `og-nav-${group.id}-label` : undefined
              }
            >
              {group.label && (
                <h2 className="og-nav-label" id={`og-nav-${group.id}-label`}>
                  {group.label}
                </h2>
              )}
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={sidebarPage === item.id ? 'active' : ''}
                  aria-current={sidebarPage === item.id ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon size={18} />
                  <span>{item.label}</span>
                  {item.id === 'tasks' && groups.tasks.length > 0 && (
                    <small>{groups.tasks.length}</small>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="og-sidebar-bottom">
          <a
            href={
              data?.project.siteUrl ??
              'https://example.com/example-project'
            }
            target="_blank"
            rel="noreferrer"
          >
            访问项目 <ArrowUpRight size={14} />
          </a>
          <button
            type="button"
            className="og-settings-link"
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => navigate('settings')}
          >
            设置 <Settings2 size={14} />
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
        {!data ? (
          <div className="og-loading">
            <Loader2 className="spin" size={24} />
            <p>正在读取项目…</p>
          </div>
        ) : (
          <>
            {page !== 'overview' && (
              <header className="rw-page-heading">
                <div className="rw-heading-title">
                  <a
                    className="rw-brand"
                    href={`/?view=overview&project=${projectId}`}
                  >
                    <span>O</span> OpenGEO
                  </a>
                  <h1>
                    {page === 'settings'
                      ? '设置'
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
                      target.searchParams.set('view', 'questions');
                      target.searchParams.set('project', projectId);
                      target.searchParams.set('search', String(search || ''));
                      for (const key of ['language', 'engine'])
                        if (current.has(key))
                          target.searchParams.set(key, current.get(key)!);
                      window.location.assign(target);
                    }}
                  >
                    <Search size={15} />
                    <input
                      name="search"
                      aria-label="搜索项目内问题"
                      placeholder="搜索项目内问题…"
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
                    研究报告
                  </button>
                )}
              </header>
            )}
            {workspaceViews.length > 0 && (
              <nav className="og-workspace-views" aria-label="改进与追踪视图">
                {workspaceViews.map((view) => (
                  <button
                    key={view.id}
                    aria-current={page === view.id ? 'page' : undefined}
                    onClick={() =>
                      navigate(
                        view.id,
                        improvementWorkspace ? selectedTask : '',
                      )
                    }
                  >
                    {view.label}
                  </button>
                ))}
              </nav>
            )}
            <div
              className={
                page !== 'overview' && page !== 'questions'
                  ? 'og-workspace-body'
                  : undefined
              }
            >
              {data.latestResearch &&
                (page === 'overview' ||
                  page === 'questions' ||
                  page === 'question-plan') && (
                  <ResearchPanel
                    key={`research-${data.project.id}`}
                    batch={data.latestResearch}
                    project={data.project}
                    view={page === 'overview' ? 'overview' : 'questions'}
                    detailsOnly={page === 'question-plan'}
                    hideHeader={page === 'questions'}
                    tasks={groups.tasks}
                    onTask={openTask}
                    onCompetitor={() =>
                      navigate('competitor', '', data.latestResearch?.id)
                    }
                    onEvidence={openEvidence}
                    onQuestions={() => navigate('questions')}
                    onOverview={() => navigate('overview')}
                    onReview={() => navigate('question-plan')}
                    onImprove={openResearchTask}
                    onPlan={startSavedResearchPlan}
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
              {page === 'overview' && !data.latestResearch && (
                <VisibilityPanel
                  data={data}
                  onQuestions={() => navigate('questions')}
                  onTask={() =>
                    groups.tasks.length ? openTask() : setDialog('create')
                  }
                  onAsset={setAsset}
                  onEvidence={openEvidence}
                />
              )}
              {page === 'settings' && (
                <ConnectionSettingsPanel
                  research={data.latestResearch}
                  onSaved={() => {
                    void refresh();
                  }}
                  onRecords={(engine) => {
                    const url = new URL(window.location.href);
                    clearResearchDetailParams(url);
                    ['search', 'group', 'kind', 'result', 'collection'].forEach(
                      (key) => url.searchParams.delete(key),
                    );
                    url.searchParams.set('view', 'questions');
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
                    setPage('questions');
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
                  onImprove={openAssetImprovement}
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
                <Modal title="审阅下一批题单" onClose={() => setDialog(null)}>
                  <div className="og-question-editor">
                    <p className="og-editor-note">
                      这是下一批的候选草稿；已搜索题单和历史记录保持只读。
                    </p>
                    <QuestionPlanPanel
                      plan={data.questionPlan}
                      assets={data.assets}
                      modelConfigured={data.settings.modelConfigured}
                      busy={!!busy}
                      onAsset={setAsset}
                      onAuditCandidate={async (candidateId) => {
                        await act('audit_question', {
                          candidateId, planId: data.questionPlan.id,
                          revision: data.questionPlan.revision,
                        }, 'AI 复评已保存，请查看需求价值与承接情况');
                      }}
                      onGenerate={async (positioning) => {
                        await act(
                          'generate_questions',
                          {
                            positioning,
                            planId: data.questionPlan.id,
                            revision: data.questionPlan.revision,
                          },
                          '拟题和审核完成，请审阅候选问题',
                        );
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
                          '题单选择已保存',
                        );
                      }}
                      onConfirm={async () => {
                        await act(
                          'confirm_questions',
                          {
                            planId: data.questionPlan.id,
                            revision: data.questionPlan.revision,
                          },
                          '题单已确认，尚未发起搜索',
                        );
                      }}
                      onContinue={() => {
                        if (groups.tasks.length) navigate('tasks');
                        else {
                          setResearchContext(null);
                          setDialog('create');
                        }
                      }}
                    />
                  </div>
                </Modal>
              )}
              {(page === 'tasks' || page === 'monitor') && (
                <TaskWorkspace
                  data={data}
                  view={page}
                  selectedTaskId={selectedTask}
                  busy={busy}
                  onSelect={(id) => navigate(page, id)}
                  onBack={() => navigate(page)}
                  onCreate={() => {
                    setResearchContext(null);
                    setLegacyQuestionPlan(false);
                    setDialog('create');
                  }}
                  onQuestions={() => navigate('questions')}
                  onAct={act}
                  onImplementation={openImplementation}
                  onMonitor={openMonitor}
                  onLive={() => {
                    setCostConsent(false);
                    setDialog('live');
                  }}
                  onEvidence={openEvidence}
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
      {dialog === 'create' && (
        <Modal
          title="新建改进任务"
          onClose={() => {
            setDialog(null);
            setResearchContext(null);
          }}
        >
          <div className="og-modal-body">
            {data?.latestResearch && !legacyQuestionPlan && (
              <>
                <label
                  className="og-field-label"
                  htmlFor="research-task-question"
                >
                  这次解决哪个问题？
                </label>
                <GeoSelect
                  id="research-task-question"
                  label="这次解决哪个问题？"
                  value={researchContext?.questionId || ''}
                  onChange={(value) => {
                    const question = data.latestResearch!.questions.find(
                      (item) => item.id === value,
                    );
                    if (question)
                      openResearchTask(
                        question,
                        researchContext?.language || 'zh',
                        researchContext?.engine || 'chatgpt',
                      );
                  }}
                  disabled={
                    researchContext?.purpose === 'investigate_gap' ||
                    Boolean(researchContext?.candidateId)
                  }
                  options={[
                    { value: '', label: '选择本轮问题' },
                    ...[
                      ...data.latestResearch.questions,
                      ...data.latestResearch.deferredQuestions.filter(
                        (item) => item.id === researchContext?.questionId,
                      ),
                    ].map((question) => ({
                      value: question.id,
                      label: question[researchContext?.language || 'zh'],
                    })),
                  ]}
                />
                {researchContext && (
                  <div className="og-form-grid">
                    <label className="og-field-label">
                      问题语言
                      <GeoSelect<'zh' | 'en'>
                        label="任务问题语言"
                        value={researchContext.language}
                        disabled={Boolean(researchContext.candidateId)}
                        onChange={(language) =>
                          setResearchContext({
                            ...researchContext,
                            language,
                          })
                        }
                        options={[
                          { value: 'zh', label: '中文' },
                          { value: 'en', label: '英文' },
                        ]}
                      />
                    </label>
                    <label className="og-field-label">
                      原始观测
                      <GeoSelect<ResearchEngine>
                        label="任务原始观测"
                        value={researchContext.engine}
                        disabled={Boolean(researchContext.candidateId)}
                        onChange={(engine) =>
                          setResearchContext({
                            ...researchContext,
                            engine,
                          })
                        }
                        options={getBatchResearchEngines(
                          data.latestResearch,
                        ).map((engine) => ({
                          value: engine,
                          label: RESEARCH_ENGINE_NAMES[engine],
                        }))}
                      />
                    </label>
                  </div>
                )}
                {researchContext && (
                  <label className="og-field-label">
                    目标材料
                    <GeoSelect
                      label="任务目标材料"
                      value={researchContext.targetAssetId || ''}
                      onChange={(value) =>
                        setResearchContext({
                          ...researchContext,
                          targetAssetId: value || undefined,
                        })
                      }
                      options={[
                        { value: '', label: '由诊断匹配已有材料' },
                        ...data.assets
                          .filter((item) => item.publicUrl && item.markdown)
                          .map((item) => ({
                            value: item.id,
                            label: item.title,
                          })),
                      ]}
                    />
                  </label>
                )}
              </>
            )}
            <label className="og-field-label">希望解决什么问题？</label>
            <textarea
              className="og-goal-input"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={`例如：让有相关需求的人找到 ${data?.project.name ?? '项目'} 的内容。`}
              autoFocus
            />
            <label className="og-field-label" htmlFor="collection-provider">
              本次观察哪个入口？
            </label>
            <GeoSelect<CollectionProvider>
              id="collection-provider"
              label="本次观察哪个入口？"
              value={collectionProvider}
              onChange={setCollectionProvider}
              options={
                providerOptions.length
                  ? providerOptions.map((provider) => ({
                      value: provider.id,
                      label: `${provider.label}${provider.configured ? '' : ' · 待配置'}`,
                    }))
                  : [{ value: 'deepseek', label: 'DeepSeek 搜索' }]
              }
            />
            <p className="og-muted">
              {collectionProvider === 'deepseek'
                ? '观察网页搜索结果是否包含目标内容。'
                : '观察联网回答是否引用目标内容。API 回答与各家 App 中的回答分别记录。'}
              {newProviderStatus &&
                !newProviderStatus.configured &&
                ` 可先创建任务；真实采集还需要：${newProviderStatus.missing.join('、')}。`}
            </p>
            <div className="og-task-scope">
              <span className="og-project-avatar small">
                {data?.project.name.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{data?.project.name}</strong>
                <p>
                  {researchContext
                    ? '选定问题' +
                      ' · ' +
                      (researchContext.language === 'zh' ? '中文' : '英文') +
                      ' · 1 道研究题及其原始观测'
                    : '使用历史题单：已有 ' +
                      (data?.assets.length ?? 0) +
                      ' 份内容和 ' +
                      selectedQuestionCount +
                      ' 道草稿题调查'}
                </p>
              </div>
              <Check size={17} />
            </div>
            <div className="og-inline-note">
              <ShieldCheck size={16} /> 创建任务不会开始付费搜索。
            </div>
            {researchContext?.candidateId && (
              <div className="og-task-scope">
                <div>
                  <strong>参照：{competitorReferenceName}</strong>
                  <p>自身比之前好 · 与参照差距缩小</p>
                  <p className="og-muted">
                    创建时保存参照与基线，结果待同条件复测。
                  </p>
                </div>
              </div>
            )}
            {researchContext && (
              <p className="og-muted">
                原始观测随任务保留。后续采集会建立自己的基线；不同入口或条件不直接比较。
              </p>
            )}
            {data?.latestResearch && !researchContext && (
              <details>
                <summary>历史题单入口</summary>
                <label>
                  <input
                    type="checkbox"
                    checked={legacyQuestionPlan}
                    onChange={(event) =>
                      setLegacyQuestionPlan(event.target.checked)
                    }
                  />{' '}
                  使用旧题单创建兼容任务（{selectedQuestionCount}题）
                </label>
              </details>
            )}
          </div>
          <div className="og-modal-actions">
            <button
              className="og-button secondary"
              onClick={() => {
                setDialog(null);
                setResearchContext(null);
              }}
            >
              取消
            </button>
            <button
              className="og-button primary"
              disabled={
                !!busy ||
                !goal.trim() ||
                (!!data?.latestResearch &&
                  !researchContext &&
                  !legacyQuestionPlan)
              }
              onClick={createTask}
            >
              {loadingButton(
                'create_task',
                '创建任务',
                <ArrowRight size={16} />,
              )}
            </button>
          </div>
        </Modal>
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
                  检查时间 <span>北京时间</span>
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
                    ? '累计预算预留（元）'
                    : '搜索费用上限（元）'}
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
                  固定 {monitorQuestionCount} 题，每次完整检查预留 ¥
                  {monitorRunCost.toFixed(3)}，{monitorDays} 天预留 ¥
                  {(monitorDays * monitorRunCost).toFixed(3)}。
                  {answerCollection
                    ? '按每题 ¥0.10 预留以控制调用次数；搜索与模型费用以服务商账单为准，这不是实际花费或硬性费用上限。'
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
                  预留 ¥{monitorRunCost.toFixed(3)} ·{' '}
                  {answerCollection
                    ? '每题按 ¥0.10 预留，实际费用以服务商账单为准'
                    : '每题成功请求 ¥0.005'}
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

'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  FileText,
  ListChecks,
  Loader2,
  Play,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { GeoAsset, GeoState } from '@/lib/geo/types';
import VisibilityPanel from './VisibilityPanel';
import ContentPanel from './ContentPanel';
import TaskPanel from './TaskPanel';
import QuestionPlanPanel from './QuestionPlanPanel';
import './opengeo.css';

type Page = 'overview' | 'assets' | 'tasks';
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
function MarkdownBody({ content }: { content: string }) {
  return (
    <div className="og-markdown">
      <Markdown
        options={{
          disableParsingRawHTML: true,
          overrides: { a: { props: { target: '_blank', rel: 'noreferrer' } } },
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

export default function OpenGeoApp() {
  const [data, setData] = useState<GeoState | null>(null),
    [page, setPage] = useState<Page>('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [toast, setToast] = useState('');
  const [selectedTask, setSelectedTask] = useState(''),
    [dialog, setDialog] = useState<Dialog>(null),
    [asset, setAsset] = useState<GeoAsset | null>(null),
    [evidence, setEvidence] = useState<{
      path: string;
      content: string;
      format: string;
    } | null>(null);
  const [goal, setGoal] = useState(
    '让 ContextAdapt 在相关问题的搜索结果中被找到，给我一个有依据的改进方案，并持续观察它是否有效。',
  );
  const [implementationKind, setImplementationKind] = useState<
      'rehearsal' | 'user_confirmed'
    >('rehearsal'),
    [note, setNote] = useState(''),
    [implementationUrl, setImplementationUrl] = useState(''),
    [implementationRevision, setImplementationRevision] = useState<
      number | undefined
    >();
  const [monitorMode, setMonitorMode] = useState<'replay' | 'live'>('replay'),
    [monitorTime, setMonitorTime] = useState('09:00'),
    [monitorDays, setMonitorDays] = useState(7),
    [monitorBudget, setMonitorBudget] = useState(1),
    [monitorEnabled, setMonitorEnabled] = useState(true),
    [costConsent, setCostConsent] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/geo', { cache: 'no-store' });
      if (!res.ok) throw new Error('暂时无法读取项目，请重试。');
      const next: GeoState = await res.json();
      setData(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (
      !data?.tasks.some((t) =>
        ['investigating', 'monitoring'].includes(t.status),
      )
    )
      return;
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [data?.tasks, refresh]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(''), 4500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  const task = data?.tasks.find((t) => t.id === selectedTask) ?? data?.tasks[0];
  const monitorQuestionCount =
    task?.workflow?.questions.length ??
    (task?.monitor.queryIds.length || data?.questions.length || 0);
  const monitorRunCost = monitorQuestionCount * 0.005;
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
    setBusy(action);
    try {
      const res = await fetch('/api/geo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(task ? { taskId: task.id } : {}),
          ...payload,
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? '操作未完成，请重试。');
      setData(result);
      setToast(message);
      return result as GeoState;
    } catch (e) {
      setToast(e instanceof Error ? e.message : '操作失败');
      return null;
    } finally {
      setBusy('');
    }
  };
  const openTask = (id?: string) => {
    if (id) setSelectedTask(id);
    setPage('tasks');
  };
  const openImplementation = (kind: 'rehearsal' | 'user_confirmed') => {
    setImplementationKind(kind);
    setNote('');
    setImplementationUrl(task?.proposal?.targetUrl ?? '');
    setImplementationRevision(task?.workflow?.proposalRevision);
    setDialog('implementation');
  };
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [page]);
  const openEvidence = async (path: string) => {
    setEvidence({ path, content: '正在读取依据…', format: 'text' });
    try {
      const res = await fetch(
        `/api/geo/evidence?path=${encodeURIComponent(path)}`,
      );
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? '无法读取这份材料');
      setEvidence(result);
    } catch (e) {
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
    setMonitorMode(task.monitor.mode);
    setMonitorTime(task.monitor.timeOfDay);
    setMonitorDays(task.monitor.days);
    setMonitorBudget(task.monitor.budgetLimit);
    setMonitorEnabled(task.monitor.enabled);
    setCostConsent(false);
    setDialog('monitor');
  };
  const createTask = async () => {
    if (!goal.trim()) return;
    const result = await act(
      'create_task',
      { goal },
      '任务已创建，请选择搜索方式',
    );
    if (result) {
      const added = result.tasks.find(
        (t) => !data?.tasks.some((old) => old.id === t.id),
      );
      if (added) setSelectedTask(added.id);
      setPage('tasks');
      setDialog(null);
    }
  };
  const confirmImplementation = async () => {
    const result = await act(
      'confirm_implementation',
      {
        kind: implementationKind,
        note,
        url: implementationUrl,
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
      '每日观察计划已保存',
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

  const nav = [
    { id: 'overview' as Page, label: '当前可见性', icon: Search },
    { id: 'assets' as Page, label: '已有内容', icon: BookOpen },
    { id: 'tasks' as Page, label: '改进任务', icon: ListChecks },
  ];
  return (
    <div className="og-app">
      <aside className="og-sidebar">
        <a className="og-logo" href="/" aria-label="OpenGEO 首页">
          <span>O</span>OpenGEO
        </a>
        <div className="og-workspace">
          <span>C</span>
          <div>
            <strong>ContextAdapt</strong>
            <small>项目工作空间</small>
          </div>
        </div>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? 'active' : ''}
              aria-current={page === item.id ? 'page' : undefined}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === 'tasks' && !!data?.tasks.length && (
                <small>{data.tasks.length}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="og-sidebar-bottom">
          <a
            href={
              data?.project.siteUrl ??
              'https://cooleryu.github.io/ContextAdapt/'
            }
            target="_blank"
            rel="noreferrer"
          >
            访问项目 <ArrowUpRight size={14} />
          </a>
          <a href="/research">
            模型与搜索设置 <Settings2 size={14} />
          </a>
          <span>本地 Demo · 基于 Vane</span>
        </div>
      </aside>
      <main className="og-main">
        {error && (
          <div className="og-error-banner" role="alert">
            {error}
            <button onClick={refresh}>重新加载</button>
          </div>
        )}
        {!data ? (
          <div className="og-loading">
            <Loader2 className="spin" size={24} />
            <p>正在读取项目…</p>
          </div>
        ) : (
          <>
            {page === 'overview' && (
              <VisibilityPanel
                data={data}
                onQuestions={() => setDialog('questions')}
                onTask={() =>
                  data.tasks.length ? openTask() : setDialog('create')
                }
                onAsset={setAsset}
                onEvidence={openEvidence}
              />
            )}
            {page === 'assets' && (
              <ContentPanel
                data={data}
                onAsset={setAsset}
                onTask={() =>
                  data.tasks.length ? openTask() : setDialog('create')
                }
              />
            )}
            {page === 'tasks' && (
              <TaskPanel
                data={data}
                task={task}
                busy={busy}
                onSelect={setSelectedTask}
                onCreate={() => setDialog('create')}
                onAct={act}
                onImplementation={openImplementation}
                onMonitor={openMonitor}
                onLive={() => {
                  setCostConsent(false);
                  setDialog('live');
                }}
                onEvidence={openEvidence}
                onQuestions={() => setDialog('questions')}
              />
            )}
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
      {dialog === 'questions' && data && (
        <Modal
          title="先确定搜什么"
          description="先核对问题是否值得搜，再用搜索结果判断哪里需要改进。"
          wide
          onClose={() => setDialog(null)}
        >
          <QuestionPlanPanel
            plan={data.questionPlan}
            assets={data.assets}
            modelConfigured={data.settings.modelConfigured}
            busy={Boolean(busy)}
            onAsset={setAsset}
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
              setDialog(
                task &&
                  !task.implementation &&
                  ['queued', 'failed', 'proposal_ready'].includes(
                    task.status,
                  ) &&
                  !(
                    task.workflow?.baseline?.mode === 'live' &&
                    task.workflow.baseline.status === 'completed'
                  )
                  ? null
                  : 'create',
              );
              setPage('tasks');
            }}
          />
        </Modal>
      )}
      {dialog === 'create' && (
        <Modal
          title="派一条改进任务"
          description="说清楚想达成什么，调查与下一步交给 OpenGEO。"
          onClose={() => setDialog(null)}
        >
          <div className="og-modal-body">
            <label className="og-field-label">你想让什么变得更好？</label>
            <textarea
              className="og-goal-input"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如：让更多遇到上下文问题的人，找到 ContextAdapt 的研究文章。"
              autoFocus
            />
            <div className="og-task-scope">
              <span className="og-project-avatar small">C</span>
              <div>
                <strong>ContextAdapt</strong>
                <p>
                  将结合已有 {data?.assets.length ?? 0} 份内容和{' '}
                  {selectedQuestionCount} 道已选问题调查
                </p>
              </div>
              <Check size={17} />
            </div>
            <div className="og-inline-note">
              <ShieldCheck size={16} />{' '}
              创建后选择免费历史预览或付费真实搜索，不会自动发起搜索。通过审核后再确认实施。
            </div>
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
              disabled={!!busy || !goal.trim()}
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
        <Modal
          title="记录实施情况"
          description="让后续观察有一个明确的开始时间。"
          onClose={() => setDialog(null)}
        >
          <div className="og-modal-body">
            <div className="og-radio-cards">
              <button
                className={implementationKind === 'rehearsal' ? 'selected' : ''}
                onClick={() => setImplementationKind('rehearsal')}
              >
                <span className="og-radio-dot" />
                <div>
                  <strong>
                    先演练一次完整流程 <Badge>推荐</Badge>
                  </strong>
                  <p>仅在本地记录演练，线上内容不会被修改。</p>
                </div>
              </button>
              <button
                className={
                  implementationKind === 'user_confirmed' ? 'selected' : ''
                }
                onClick={() => setImplementationKind('user_confirmed')}
              >
                <span className="og-radio-dot" />
                <div>
                  <strong>我已完成实际修改</strong>
                  <p>记录你确认的修改时间，系统不会代你发布。</p>
                </div>
              </button>
            </div>
            <label className="og-field-label" htmlFor="implementation-url">
              实施页面
            </label>
            <input
              id="implementation-url"
              className="og-input"
              value={implementationUrl}
              onChange={(e) => setImplementationUrl(e.target.value)}
              placeholder="https://…"
            />
            <label className="og-field-label" htmlFor="implementation-note">
              补充说明{' '}
              <span>
                {implementationKind === 'rehearsal'
                  ? '选填'
                  : '必填：具体改了什么'}
              </span>
            </label>
            <textarea
              id="implementation-note"
              className="og-input og-note-input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                implementationKind === 'rehearsal'
                  ? '本次先体验方案到监控的流程'
                  : '例如：已更新首页介绍和证据链接'
              }
            />
            <div className="og-inline-note">
              <ShieldCheck size={16} />{' '}
              {implementationKind === 'rehearsal'
                ? '演练结果不会被当成真实改进效果。'
                : '这是一条用户确认记录，不代表系统已经验证线上改动。'}
            </div>
          </div>
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
                (implementationKind === 'user_confirmed' && !note.trim())
              }
              onClick={confirmImplementation}
            >
              {loadingButton(
                'confirm_implementation',
                implementationKind === 'rehearsal'
                  ? '确认演练，进入观察'
                  : '确认已实施',
                <CheckCheck size={16} />,
              )}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'monitor' && (
        <Modal
          title="每日观察计划"
          description="固定问题和搜索入口，让每次记录可以比较。"
          onClose={() => setDialog(null)}
        >
          <div className="og-modal-body">
            <label className="og-field-label">观察方式</label>
            <div className="og-radio-cards">
              <button
                className={monitorMode === 'replay' ? 'selected' : ''}
                onClick={() => setMonitorMode('replay')}
              >
                <span className="og-radio-dot" />
                <div>
                  <strong>
                    历史回放 <Badge>免费</Badge>
                  </strong>
                  <p>用已有真实记录演示，不产生新测量。</p>
                </div>
              </button>
              <button
                className={monitorMode === 'live' ? 'selected' : ''}
                disabled={
                  !data?.settings.liveSearchConfigured ||
                  task?.implementation?.kind !== 'user_confirmed'
                }
                onClick={() => setMonitorMode('live')}
              >
                <span className="og-radio-dot" />
                <div>
                  <strong>实时搜索</strong>
                  <p>
                    {task?.implementation?.kind !== 'user_confirmed'
                      ? '记录实际实施后，才可采集实施后的真实结果。'
                      : data?.settings.liveSearchConfigured
                        ? '每天重新检查，按成功请求计费。'
                        : '尚未配置搜索服务，暂不可用。'}
                  </p>
                </div>
              </button>
            </div>
            <div className="og-form-row">
              <div>
                <label className="og-field-label" htmlFor="monitor-time">
                  每天几点 <span>北京时间</span>
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
                  连续观察
                </label>
                <select
                  id="monitor-days"
                  className="og-input"
                  value={monitorDays}
                  onChange={(e) => setMonitorDays(Number(e.target.value))}
                >
                  {[3, 7, 14, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} 天
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {monitorMode === 'live' && (
              <>
                <label className="og-field-label" htmlFor="monitor-budget">
                  费用上限（元）
                </label>
                <input
                  id="monitor-budget"
                  className="og-input"
                  type="number"
                  min={monitorRunCost}
                  step="0.005"
                  value={monitorBudget}
                  onChange={(e) => setMonitorBudget(Number(e.target.value))}
                />
                <div className="og-cost-note">
                  固定 {monitorQuestionCount} 题，每次完整检查预留 ¥
                  {monitorRunCost.toFixed(3)}，{monitorDays} 天预留 ¥
                  {(monitorDays * monitorRunCost).toFixed(3)}。预算用尽后停止。
                </div>
                <label className="og-checkbox">
                  <input
                    type="checkbox"
                    checked={costConsent}
                    onChange={(e) => setCostConsent(e.target.checked)}
                  />
                  <span>
                    我同意按这个计划调用付费搜索，费用不超过设置的上限。
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
                    !Number.isFinite(monitorBudget) ||
                    monitorBudget < monitorRunCost ||
                    task?.implementation?.kind !== 'user_confirmed'))
              }
              onClick={saveMonitor}
            >
              {loadingButton(
                'update_monitor',
                '保存观察计划',
                <Check size={16} />,
              )}
            </button>
          </div>
        </Modal>
      )}
      {dialog === 'live' && (
        <Modal
          title="运行一次实时检查"
          description="这会向 DeepSeek 发出新的搜索请求。"
          onClose={() => setDialog(null)}
        >
          <div className="og-modal-body">
            <div className="og-cost-summary">
              <Search size={25} />
              <div>
                <strong>{monitorQuestionCount} 个固定问题</strong>
                <p>预留 ¥{monitorRunCost.toFixed(3)} · 每题成功请求 ¥0.005</p>
              </div>
            </div>
            <label className="og-checkbox">
              <input
                type="checkbox"
                checked={costConsent}
                onChange={(e) => setCostConsent(e.target.checked)}
              />
              <span>我确认运行这次付费搜索，并记录新的测量结果。</span>
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
              disabled={!!busy || !costConsent}
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
              <FileText size={14} /> 完整内容
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
              <MarkdownBody content={evidence.content} />
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

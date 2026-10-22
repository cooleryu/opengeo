'use client';

import { useEffect, useState } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import type { GeoState, GeoStatus, GeoTask } from '@/lib/geo/types';
import WorkflowPanel from './WorkflowPanel';

type Props = {
  data: GeoState;
  task: GeoTask | undefined;
  busy: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onAct: (
    action: string,
    payload?: Record<string, unknown>,
    message?: string,
  ) => Promise<GeoState | null>;
  onImplementation: (kind: 'rehearsal' | 'user_confirmed') => void;
  onMonitor: () => void;
  onLive: () => void;
  onEvidence: (path: string) => void;
  onQuestions: () => void;
};

const statusNames: Record<GeoStatus, string> = {
  queued: '等待调查',
  investigating: '正在调查',
  proposal_ready: '等你确认方案',
  awaiting_implementation: '等待实施',
  monitoring: '每日观察中',
  paused: '观察已暂停',
  completed: '本轮观察结束',
  failed: '需要处理',
};
const stages = ['调查', '方案', '实施', '观察'];
const widgetKinds = [
  'evidence_summary',
  'proposal',
  'implementation',
  'monitor',
];
const formatDate = (value: string | null, withTime = true) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
      })
    : '尚未安排';
const taskStage = (task?: GeoTask) => {
  if (!task) return 0;
  if (
    task.implementation ||
    ['monitoring', 'paused', 'completed'].includes(task.status)
  )
    return 3;
  if (task.status === 'awaiting_implementation') return 2;
  return task.proposal ? 1 : 0;
};
const shortTitle = (task: GeoTask) =>
  task.proposal?.title ||
  (task.title.length > 34 ? `${task.title.slice(0, 34)}…` : task.title);

export default function TaskPanel({
  data,
  task,
  busy,
  onSelect,
  onCreate,
  onAct,
  onImplementation,
  onMonitor,
  onLive,
  onEvidence,
  onQuestions,
}: Props) {
  const current = taskStage(task);
  const [stage, setStage] = useState(current);
  const [after, setAfter] = useState(task?.proposal?.after ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setStage(current);
  }, [task?.id, current]);
  useEffect(() => {
    setAfter(task?.proposal?.after ?? '');
    setEditing(false);
  }, [task?.id, task?.proposal?.after]);
  const proposal = task?.proposal;
  const latestLive = task?.runs
    .slice()
    .reverse()
    .find((run) => run.mode === 'live' && run.status === 'completed');
  const replayCount =
    task?.runs.filter((run) => run.mode === 'replay').length ?? 0;
  const liveCount = task?.runs.filter((run) => run.mode === 'live').length ?? 0;
  const evidence = (paths: string[]) => (
    <div className="og-evidence-links">
      {Array.from(new Set(paths)).map((path) => (
        <button key={path} onClick={() => onEvidence(path)}>
          <FileText size={14} />
          {path.split('/').slice(-2).join('/')}
        </button>
      ))}
    </div>
  );
  return (
    <>
      <div className="og-page-heading">
        <div>
          <span className="og-eyebrow">任务</span>
          <h1>改进任务</h1>
        </div>
        <button className="og-button secondary" onClick={onCreate}>
          <Plus size={16} />
          新建任务
        </button>
      </div>
      {data.tasks.length > 1 && (
        <label className="og-task-picker">
          切换任务
          <select
            aria-label="切换任务"
            value={task?.id ?? ''}
            onChange={(event) => onSelect(event.target.value)}
          >
            {data.tasks.map((item) => (
              <option key={item.id} value={item.id}>
                {shortTitle(item)} · {statusNames[item.status]}
              </option>
            ))}
          </select>
        </label>
      )}
      {!task ? (
        <section className="og-surface og-task-empty">
          <h2>把一个目标交给 OpenGEO</h2>
          <p className="og-muted">得到有依据的方案，实施后每天观察变化。</p>
          <button className="og-button primary" onClick={onCreate}>
            创建第一条任务
            <ArrowRight size={16} />
          </button>
        </section>
      ) : task.workflow || (!task.implementation && ['queued', 'proposal_ready', 'failed'].includes(task.status)) ? (
        <WorkflowPanel
          data={data}
          task={task}
          busy={busy}
          onAct={onAct}
          onQuestions={onQuestions}
          onImplementation={onImplementation}
          onMonitor={onMonitor}
          onLive={onLive}
          onEvidence={onEvidence}
        />
      ) : (
        <>
          <section className="og-current-task">
            <div className="og-task-title-row">
              <h2>{shortTitle(task)}</h2>
              <span
                className={`og-tag ${task.status === 'proposal_ready' ? 'amber' : task.status === 'monitoring' ? 'blue' : 'neutral'}`}
              >
                {statusNames[task.status]}
              </span>
            </div>
            <nav className="og-stage-tabs" aria-label="任务阶段">
              {stages.map((label, index) => (
                <button
                  key={label}
                  disabled={index > current}
                  className={stage === index ? 'active' : ''}
                  aria-current={stage === index ? 'step' : undefined}
                  onClick={() => setStage(index)}
                >
                  <span>
                    {index < current ? <Check size={14} /> : index + 1}
                  </span>
                  {label}
                  {index === current && <small>当前</small>}
                </button>
              ))}
            </nav>
          </section>
          {task.error && (
            <div className="og-task-error" role="alert">
              <span>{task.error}</span>
              {task.status === 'failed' && !task.implementation && (
                <button
                  className="og-button secondary"
                  disabled={!!busy}
                  onClick={() => onAct('investigate', {}, '重新开始调查')}
                >
                  重新调查
                </button>
              )}
            </div>
          )}
          <section
            className="og-surface og-task-stage"
            data-widget-type={widgetKinds[stage]}
            data-widget-id={
              task.blocks.find(
                (block) => block.data.widgetType === widgetKinds[stage],
              )?.id
            }
          >
            {stage === 0 && (
              <>
                <div className="og-eyebrow">调查</div>
                <h2>
                  {task.status === 'investigating'
                    ? '正在核对材料，整理下一步'
                    : data.questions.some((question) => question.projectHit)
                      ? '已经找到项目，继续核对内容与问题'
                      : '已有内容，还没有在这次搜索中出现'}
                </h2>
                <p className="og-task-lead">
                  {
                    data.questions.filter((question) => question.projectHit)
                      .length
                  }{' '}
                  / {data.questions.length} 个问题找到项目，已有{' '}
                  {data.assets.length} 份内容可供核对。
                </p>
                <p className="og-muted">
                  依据：{data.observations[0]?.provider ?? '现有搜索记录'} ·{' '}
                  {formatDate(
                    data.observations[0]?.measurementAt ?? null,
                    false,
                  )}
                  。搜索记录与 AI 回答中的引用分开判断。
                </p>
                {task.status === 'investigating' && (
                  <div className="og-task-working">
                    <Loader2 size={18} className="spin" />
                    完成后会自动显示方案。
                  </div>
                )}
                {current > 0 && (
                  <button
                    className="og-button primary"
                    onClick={() => setStage(1)}
                  >
                    查看改进方案
                    <ArrowRight size={16} />
                  </button>
                )}
                <details className="og-task-details">
                  <summary>
                    查看调查依据
                    <ChevronDown size={15} />
                  </summary>
                  <div className="og-task-findings">
                    {data.findings.map((finding) => (
                      <article key={finding.id}>
                        <h3>{finding.title}</h3>
                        <p>{finding.detail}</p>
                        {evidence(finding.evidencePaths)}
                      </article>
                    ))}
                  </div>
                </details>
              </>
            )}
            {stage === 1 && proposal && (
              <>
                <div className="og-eyebrow">建议的下一步</div>
                <p className="og-inline-note">
                  历史方案 · 尚未经过新一轮方案审核，以下保留原有记录。
                </p>
                <h2>先做这几处改动</h2>
                <p className="og-task-lead">{proposal.rationale}</p>
                <ol className="og-proposal-points">
                  {proposal.changes.slice(0, 3).map((change, index) => (
                    <li key={index}>
                      <span>{index + 1}</span>
                      <p>{change}</p>
                    </li>
                  ))}
                </ol>
                <details className="og-task-details">
                  <summary>
                    查看具体改稿
                    <ChevronDown size={15} />
                  </summary>
                  <div className="og-proposal-draft">
                    <div className="og-proposal-label">
                      <h3>建议内容</h3>
                      {task.status === 'proposal_ready' && (
                        <button onClick={() => setEditing(!editing)}>
                          {editing ? '预览内容' : '编辑改稿'}
                        </button>
                      )}
                    </div>
                    {editing ? (
                      <textarea
                        aria-label="编辑建议内容"
                        value={after}
                        onChange={(event) => setAfter(event.target.value)}
                      />
                    ) : (
                      <div className="og-markdown">
                        <Markdown options={{ disableParsingRawHTML: true }}>
                          {after || proposal.after}
                        </Markdown>
                      </div>
                    )}
                  </div>
                  <details className="og-task-details og-task-details-nested">
                    <summary>
                      对照原有内容
                      <ChevronDown size={14} />
                    </summary>
                    <div className="og-markdown">
                      <Markdown options={{ disableParsingRawHTML: true }}>
                        {proposal.before}
                      </Markdown>
                    </div>
                  </details>
                </details>
                <details className="og-task-details">
                  <summary>
                    依据与效果判断标准
                    <ChevronDown size={15} />
                  </summary>
                  <ul>
                    {proposal.successCriteria.map((criterion, index) => (
                      <li key={index}>{criterion}</li>
                    ))}
                  </ul>
                  <p className="og-muted">{proposal.limitations.join(' ')}</p>
                  {evidence(proposal.evidencePaths)}
                </details>
                {task.status === 'proposal_ready' ? (
                  <div className="og-task-primary-action">
                    <button
                      className="og-button primary"
                      disabled={!!busy}
                      onClick={onCreate}
                    >
                      新建任务，完成方案审核
                      <ArrowRight size={16} />
                    </button>
                    <span className="og-muted">
                      历史方案保留；新任务经过搜索、诊断与审核后再实施。
                    </span>
                  </div>
                ) : (
                  <p className="og-muted og-task-confirmed">
                    <Check size={15} />
                    这版方案已确认。
                  </p>
                )}
              </>
            )}
            {stage === 2 && (
              <>
                <div className="og-eyebrow">实施</div>
                <h2>
                  {task.implementation
                    ? task.implementation.kind === 'rehearsal'
                      ? '目前完成了流程演练'
                      : '已记录你的实施确认'
                    : '完成修改后，记录实施情况'}
                </h2>
                {task.implementation ? (
                  <>
                    <p className="og-task-lead">
                      {task.implementation.note || '已记录本次实施。'}
                    </p>
                    <p className="og-muted">
                      {formatDate(task.implementation.at)}
                      {task.implementation.kind === 'rehearsal'
                        ? ' · 线上内容未修改'
                        : ' · 用户确认记录'}
                    </p>
                    {task.implementation.url && (
                      <a
                        className="og-text-link"
                        href={task.implementation.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看实施页面
                        <ArrowRight size={14} />
                      </a>
                    )}
                    {task.implementation.kind === 'rehearsal' && (
                      <div className="og-task-primary-action">
                        <button
                          className="og-button primary"
                          disabled={!!busy}
                          onClick={() => onImplementation('user_confirmed')}
                        >
                          记录实际实施
                          <ArrowRight size={16} />
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p className="og-task-lead">
                      把方案应用到页面，再告诉我们改了什么。后续观察会以这次记录为起点。
                    </p>
                    <div className="og-task-primary-action">
                      <button
                        className="og-button primary"
                        disabled={!!busy}
                        onClick={() => onImplementation('user_confirmed')}
                      >
                        我已完成修改
                        <ArrowRight size={16} />
                      </button>
                      <button
                        className="og-text-button"
                        disabled={!!busy}
                        onClick={() => onImplementation('rehearsal')}
                      >
                        先演练一次流程
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {stage === 3 && (
              <>
                <div className="og-task-status">
                  <span
                    className={`og-tag ${task.monitor.mode === 'live' ? 'blue' : 'neutral'}`}
                  >
                    {task.monitor.mode === 'replay' ? '历史回放' : '实时观察'}
                  </span>
                  <span className="og-muted">
                    {task.status === 'paused'
                      ? '已暂停'
                      : task.monitor.enabled
                        ? '按计划执行'
                        : '自动观察未开启'}
                  </span>
                </div>
                <h2>
                  {latestLive
                    ? `${latestLive.hitCount ?? '—'} / ${latestLive.queryCount} 个问题找到项目`
                    : '尚无新的效果数据'}
                </h2>
                <p className="og-task-lead">
                  {latestLive
                    ? `最近一次新测量：${formatDate(latestLive.measurementAt)}。${latestLive.summary}`
                    : task.monitor.mode === 'replay'
                      ? '当前正在演练观察流程。历史回放不会产生新的搜索结果。'
                      : '等待第一次实时检查，结果会出现在这里。'}
                </p>
                <div className="og-monitor-summary">
                  <div>
                    <span>下一次观察</span>
                    <strong>
                      {task.status === 'paused'
                        ? '已暂停'
                        : task.monitor.enabled
                          ? formatDate(task.monitor.nextRunAt)
                          : '未开启'}
                    </strong>
                    <small>每天 {task.monitor.timeOfDay} · 北京时间</small>
                  </div>
                  <div>
                    <span>已执行</span>
                    <strong>{task.runs.length} 次</strong>
                    <small>
                      {liveCount} 次新测量 · {replayCount} 次回放
                    </small>
                  </div>
                  <div>
                    <span>剩余计划</span>
                    <strong>{task.monitor.remaining} 次</strong>
                    <small>
                      {task.monitor.queryIds.length || data.questions.length}{' '}
                      个固定问题
                    </small>
                  </div>
                </div>
                <div className="og-task-primary-action">
                  <button className="og-button primary" onClick={onMonitor}>
                    <Settings2 size={16} />
                    调整观察计划
                  </button>
                  {['monitoring', 'paused'].includes(task.status) && (
                    <button
                      className="og-text-button"
                      disabled={!!busy}
                      onClick={() =>
                        onAct(
                          task.status === 'paused' ? 'resume' : 'pause',
                          {},
                          task.status === 'paused'
                            ? '观察已恢复'
                            : '观察已暂停',
                        )
                      }
                    >
                      {task.status === 'paused' ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                      {task.status === 'paused' ? '恢复观察' : '暂停观察'}
                    </button>
                  )}
                </div>
                <details className="og-task-details">
                  <summary>
                    观察记录<span>{task.runs.length} 次</span>
                    <ChevronDown size={15} />
                  </summary>
                  {task.runs.length ? (
                    <div className="og-run-list">
                      {task.runs
                        .slice()
                        .reverse()
                        .map((run) => (
                          <details key={run.id} className="og-run-row">
                            <summary>
                              <time>{formatDate(run.at)}</time>
                              <span>
                                {run.mode === 'replay' ? '历史回放' : '新测量'}{' '}
                                ·{' '}
                                {run.status === 'failed'
                                  ? '失败'
                                  : run.status === 'partial'
                                    ? '部分完成'
                                    : '已完成'}
                              </span>
                              <strong>
                                {run.mode === 'live'
                                  ? `${run.hitCount ?? '—'} / ${run.queryCount} 命中`
                                  : '未新增测量'}
                              </strong>
                              <ChevronDown size={14} />
                            </summary>
                            <div className="og-run-detail">
                              <p>{run.summary}</p>
                              <p className="og-muted">
                                原始测量：{formatDate(run.measurementAt)} · 完成{' '}
                                {run.completedCount}/{run.queryCount} 题 · ¥
                                {run.cost.toFixed(3)}
                              </p>
                              {run.error && (
                                <p className="og-task-error">{run.error}</p>
                              )}
                              {evidence(
                                run.questions.map(
                                  (question) => question.evidencePath,
                                ),
                              )}
                            </div>
                          </details>
                        ))}
                    </div>
                  ) : (
                    <p className="og-muted">还没有执行记录。</p>
                  )}
                </details>
                <div className="og-task-secondary-actions">
                  <button
                    className="og-text-button"
                    disabled={!!busy}
                    onClick={() =>
                      onAct(
                        'run_monitor',
                        { mode: 'replay' },
                        '已安排回放，记录会自动更新',
                      )
                    }
                  >
                    <RefreshCw size={14} />
                    回放一次
                  </button>
                  {data.settings.liveSearchConfigured &&
                    task.implementation?.kind === 'user_confirmed' && (
                      <button
                        className="og-text-button"
                        disabled={!!busy}
                        onClick={onLive}
                      >
                        运行实时检查
                        <ArrowRight size={14} />
                      </button>
                    )}
                  {task.implementation?.kind === 'rehearsal' && (
                    <button
                      className="og-text-button"
                      disabled={!!busy}
                      onClick={() => onImplementation('user_confirmed')}
                    >
                      记录实际实施
                      <ArrowRight size={14} />
                    </button>
                  )}
                </div>
                <p className="og-task-footnote">
                  {data.settings.schedulerRunning
                    ? '自动观察需要本地服务保持运行。'
                    : '调度器尚未运行。'}
                  {task.monitor.mode === 'live'
                    ? `预算 ¥${task.monitor.budgetLimit.toFixed(2)}，已用 ¥${task.monitor.spent.toFixed(3)}。`
                    : '历史回放免费。'}
                </p>
              </>
            )}
          </section>
          <details className="og-task-activity">
            <summary>
              <Clock3 size={15} />
              任务动态<span>{task.events.length} 条</span>
              <ChevronDown size={15} />
            </summary>
            <div>
              {task.events
                .slice()
                .reverse()
                .map((event) => (
                  <article key={event.id}>
                    <time>{formatDate(event.at)}</time>
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.detail}</p>
                    </div>
                  </article>
                ))}
            </div>
          </details>
        </>
      )}
    </>
  );
}

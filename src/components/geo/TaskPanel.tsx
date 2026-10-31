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
} from 'lucide-react';
import type { GeoState, GeoStatus, GeoTask } from '@/lib/geo/types';
import WorkflowPanel from './WorkflowPanel';
import { taskPresentation } from './task-presentation';
import TaskTrackingPanel from './TaskTrackingPanel';
import { displayTaskTitle } from './question-labels';

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
  detailView?: 'task' | 'monitor';
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
const statusLabel = (task: GeoTask) => {
  if (task.implementation?.kind === 'rehearsal') return '历史回放演练';
  if (task.status !== 'proposal_ready' || !task.workflow)
    return statusNames[task.status];
  const quality = task.workflow.quality;
  const reviewed =
    quality?.rounds.find((round) => round.round === quality.bestRound) ??
    quality?.rounds[quality.rounds.length - 1];
  const passed =
    reviewed?.review.passed &&
    reviewed.candidate.after === task.proposal?.after &&
    task.workflow.baseline?.mode === 'live';
  return passed ? statusNames.proposal_ready : '方案待修改';
};
const stages = ['搜索结果', '改稿审核', '实施登记', '效果跟踪'];
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
export default function TaskPanel({
  data,
  task,
  busy,
  onCreate,
  onAct,
  onImplementation,
  onMonitor,
  onLive,
  onEvidence,
  onQuestions,
  detailView = 'task',
}: Props) {
  const presentation = task
    ? taskPresentation(task, data.assets, data.project)
    : null;
  const current = taskStage(task);
  const [stage, setStage] = useState(
    detailView === 'monitor' ? 3 : current,
  );
  const [after, setAfter] = useState(task?.proposal?.after ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setStage(detailView === 'monitor' ? 3 : current);
  }, [task?.id, current, detailView]);
  useEffect(() => {
    setAfter(task?.proposal?.after ?? '');
    setEditing(false);
  }, [task?.id, task?.proposal?.after]);
  const proposal = task?.proposal;
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
      {!task ? (
        <section className="og-surface og-task-empty">
          <h2>暂无改进任务</h2>
          <button className="og-button primary" onClick={onCreate}>
            创建第一条任务
            <ArrowRight size={16} />
          </button>
        </section>
      ) : task.workflow ||
        (!task.implementation &&
          ['queued', 'proposal_ready', 'failed'].includes(task.status)) ? (
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
          detailView={detailView}
        />
      ) : (
        <>
          <section className="og-current-task">
            <div className="og-task-title-row">
              <h2>{displayTaskTitle(task, data, presentation?.title)}</h2>
              <span
                className={`og-tag ${task.status === 'proposal_ready' ? 'amber' : task.status === 'monitoring' ? 'blue' : 'neutral'}`}
              >
                {statusLabel(task)}
              </span>
            </div>
            <details className="og-workflow-details">
              <summary>查看原始任务要求</summary>
              <p>{task.goal || task.title}</p>
            </details>
            <nav className="og-stage-tabs" aria-label="任务阶段">
              {stages.map((label, index) => (
                <button
                  key={label}
                  disabled={index > current && index !== 3}
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
                        {task.implementation.kind === 'rehearsal'
                          ? '查看目标页面'
                          : '查看实施页面'}
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
              <TaskTrackingPanel
                data={data}
                task={task}
                busy={busy}
                onAct={onAct}
                onMonitor={onMonitor}
                onLive={onLive}
                onEvidence={onEvidence}
                onImplementation={onImplementation}
              />
            )}
          </section>
          {stage !== 3 && (
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
          )}
        </>
      )}
    </>
  );
}

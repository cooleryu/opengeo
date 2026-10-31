'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Archive,
  ChevronRight,
  Plus,
  TrendingUp,
} from 'lucide-react';
import type { GeoState, GeoTask } from '@/lib/geo/types';
import type {
  CompetitorCandidates,
  CompetitorComparison,
} from '@/lib/geo/competitor-types';
import { getCompetitorProgress } from '@/lib/geo/competitor-progress';
import TaskPanel from './TaskPanel';
import TaskOutcomeHistory, {
  comparableChartRuns,
  realFollowupRuns,
  trackingDate,
} from './TaskOutcomeHistory';
import { taskPresentation, taskProviderLabel } from './task-presentation';
import { buildQualityEvolution } from './quality-evolution-data';
import { displayTaskTitle } from './question-labels';
import './task-workspace.css';

const historicalRecords: Record<string, { title: string; origin: string; summary: string }> = {};

export const isHistoricalTask = (task: GeoTask) =>
  Boolean(historicalRecords[task.id]);
export const getTaskWorkspaceGroups = (tasks: GeoTask[]) => ({
  tasks: tasks.filter(
    (task) =>
      !isHistoricalTask(task) || task.implementation?.kind === 'user_confirmed',
  ),
  history: tasks.filter(isHistoricalTask),
  monitor: tasks.filter(
    (task) => task.implementation?.kind === 'user_confirmed',
  ),
});

export type TaskWorkspaceProps = {
  data: GeoState;
  view: 'tasks' | 'history' | 'monitor';
  selectedTaskId: string;
  busy: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  onCreate: () => void;
  onQuestions: () => void;
  onAct: (
    action: string,
    payload?: Record<string, unknown>,
    message?: string,
  ) => Promise<GeoState | null>;
  onImplementation: (kind: 'rehearsal' | 'user_confirmed') => void;
  onMonitor: () => void;
  onLive: () => void;
  onEvidence: (path: string) => void;
};

const date = (value: string) =>
  new Date(value).toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  });
function taskState(task: GeoTask) {
  if (
    task.researchContext?.purpose === 'investigate_gap' &&
    !task.workflow &&
    !task.implementation
  )
    return '待核查';
  if (task.status === 'failed') return '需要处理';
  if (task.status === 'investigating') return '正在调查';
  if (task.implementation?.kind === 'rehearsal') return '仅演练';
  if (task.implementation?.kind === 'user_confirmed') return '已登记实施';
  if (task.status === 'awaiting_implementation') return '待实施';
  const evolution = buildQualityEvolution(task);
  const retained = evolution.frames.find(
    (frame) => frame.id === evolution.retainedFrameId,
  );
  if (
    task.proposal &&
    retained?.review.passed &&
    task.workflow?.baseline?.mode === 'live' &&
    (!task.reviewContextUpdatedAt ||
      Date.parse(retained.review.reviewedAt) >=
        Date.parse(task.reviewContextUpdatedAt))
  )
    return '待确认方案';
  return task.proposal ? '候选待完善' : '待调查';
}
function nextAction(task: GeoTask) {
  if (
    task.researchContext?.purpose === 'investigate_gap' &&
    !task.workflow &&
    !task.implementation
  )
    return '核查已有材料，补充依据';
  if (task.status === 'failed') return '查看失败原因，决定是否重试';
  if (task.status === 'investigating') return '等待调查与审核结果';
  if (task.implementation?.kind === 'rehearsal')
    return '实际实施后登记，再安排跟测';
  if (task.implementation && !task.implementation.occurredAt)
    return '补充实际实施时间';
  if (task.implementation)
    return realFollowupRuns(task).length
      ? '查看真实结果与复盘'
      : '安排实施后的第一次跟测';
  if (task.status === 'awaiting_implementation')
    return '按确认方案实施，登记结果';
  return task.proposal ? '核对正文改动和审核意见' : '确认题单，开始调查';
}

function trackingSummary(task: GeoTask) {
  const implementation = task.implementation;
  if (!implementation)
    return {
      implementation: '未登记实施',
      schedule: '实施后安排观察',
      outcome: '尚无实施后效果',
    };

  const schedule =
    task.status === 'paused'
      ? '观察已暂停'
      : task.status === 'completed' ||
          (task.monitor.enabled && task.monitor.remaining <= 0)
        ? '本轮观察结束'
        : !task.monitor.enabled
          ? '自动观察未开启'
          : `下次${task.monitor.mode === 'live' ? '实测' : '回放'} ${task.monitor.nextRunAt ? trackingDate(task.monitor.nextRunAt) : '待安排'}`;
  if (implementation.kind === 'rehearsal')
    return {
      implementation: '仅流程演练',
      schedule,
      outcome: '演练不计入真实效果',
    };
  if (!implementation.occurredAt)
    return {
      implementation: '实际实施时间待补',
      schedule,
      outcome: '尚不能比较效果',
    };

  const runs = realFollowupRuns(task);
  const latest = runs.at(-1);
  const outcome = task.workflow?.outcome;
  const comparable = comparableChartRuns(task);
  const result =
    comparable.length && outcome
      ? {
          improved: '观察到提升',
          unchanged: '未观察到变化',
          worse: '观察到下降',
          inconclusive: '尚不能判断效果',
        }[outcome.classification]
      : latest?.status === 'failed' || latest?.error
        ? '最近实测失败，尚不能判断效果'
        : latest?.status === 'partial'
          ? '最近实测部分完成，尚不能判断效果'
          : runs.length
            ? '尚未形成可比效果结论'
            : '尚无实施后实测';
  return {
    implementation: `${trackingDate(implementation.occurredAt)} 实施`,
    schedule,
    outcome: `${result}${runs.length ? ` · ${runs.length} 条实测记录` : ''}`,
  };
}

function TaskCompetitorProgress({
  task,
  projectId,
}: {
  task: GeoTask;
  projectId: string;
}) {
  const research = task.researchContext!;
  const reference = research.snapshot!.competitorReference!;
  const [comparison, setComparison] = useState<CompetitorComparison | null>(
    null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setComparison(null);
    setError('');
    const read = async () => {
      try {
        const params = new URLSearchParams({
          project: projectId,
          batch: research.batchId,
          candidate: reference.candidateId,
        });
        const response = await fetch(
          `/api/geo/competitor-candidates?${params}`,
          { cache: 'no-store', signal: controller.signal },
        );
        const result: CompetitorCandidates & { error?: string } =
          await response.json();
        if (!response.ok)
          throw new Error(result.error || '暂时无法读取参照复测结果。');
        const next = result.comparison;
        // A later selection may be different. Preview the saved candidate and
        // refuse to compare if its matching identity has since been edited.
        const sameList = (left: string[], right: string[]) =>
          JSON.stringify([...left].sort()) ===
          JSON.stringify([...right].sort());
        if (
          !next?.target ||
          next.projectId !== projectId ||
          next.batch?.id !== research.batchId ||
          next.target.name !== reference.name ||
          !sameList(next.target.aliases, reference.aliases) ||
          !sameList(next.target.officialUrls, reference.officialUrls)
        )
          throw new Error('参照身份与任务快照不一致，需核实后再比较。');
        if (!controller.signal.aborted) setComparison(next);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : '暂时无法读取参照复测结果。',
          );
      }
    };
    void read();
    return () => controller.abort();
  }, [projectId, reference, research.batchId, task.updatedAt]);
  const progress = comparison
    ? getCompetitorProgress(
        comparison,
        {
          id: reference.selectionId,
          projectId,
          batchId: reference.baseline.batch?.id ?? null,
          candidateId: reference.candidateId,
          selectedAt: reference.selectedAt,
          target: {
            name: reference.name,
            aliases: reference.aliases,
            officialUrls: reference.officialUrls,
            updatedAt: reference.selectedAt,
          },
          baseline: reference.baseline,
        },
        {
          questionId: research.questionId,
          engine: research.engine,
          language: research.language,
        },
      )
    : null;
  const change = (value: number | null | undefined, gap = false) =>
    value == null
      ? '待复测或核实'
      : value === 0
        ? '未变'
        : gap
          ? `${value > 0 ? '缩小' : '扩大'} ${Math.abs(Number(value.toFixed(1)))} 个百分点`
          : `${value > 0 ? '提升' : '下降'} ${Math.abs(Number(value.toFixed(1)))} 个百分点`;
  return (
    <div className="og-task-scope">
      <div>
        <strong>参照：{reference.name}</strong>
        <p>自身比之前好 · 与参照差距缩小</p>
        <p>
          自身提及率：{change(progress?.ownChange)} · 参照差距：
          {change(progress?.gapChange, true)}
        </p>
        <p className="og-muted">
          {error || progress?.reason || '正在读取复测结果…'}
        </p>
      </div>
    </div>
  );
}

export default function TaskWorkspace(props: TaskWorkspaceProps) {
  const {
    data,
    view,
    selectedTaskId,
    onSelect,
    onBack,
    onCreate,
    onQuestions,
    onEvidence,
  } = props;
  const groups = getTaskWorkspaceGroups(data.tasks);
  const task = data.tasks.find((item) => item.id === selectedTaskId);
  const title = { tasks: '改进任务', history: '历史记录', monitor: '效果跟踪' }[
    view
  ];
  if (task)
    return (
      <div className="og-task-workspace og-task-detail">
        <button className="og-workspace-back" onClick={onBack}>
          <ArrowLeft size={16} />
          {title}
        </button>
        {isHistoricalTask(task) && (
          <div className="og-history-context">
            <Archive size={16} />
            <span>
              {historicalRecords[task.id].origin} ·{' '}
              {historicalRecords[task.id].summary}
            </span>
          </div>
        )}
        {task.researchContext?.snapshot?.competitorReference && (
          <TaskCompetitorProgress
            key={task.id}
            task={task}
            projectId={data.project.id}
          />
        )}
        <TaskPanel
          {...props}
          task={task}
          detailView={view === 'monitor' ? 'monitor' : 'task'}
        />
      </div>
    );

  return (
    <div className="og-task-workspace">
      <header className="og-page-heading">
        <div>
          <h1>{title}</h1>
        </div>
        {view === 'tasks' && (
          <button className="og-button secondary" onClick={onCreate}>
            <Plus size={16} />
            新建任务
          </button>
        )}
      </header>
      {view === 'tasks' &&
        (groups.tasks.length ? (
          <div className="og-workspace-task-list og-task-register">
            <div className="og-task-register-head" aria-hidden="true">
              <span>改进任务</span>
              <span>发现的问题</span>
              <span>修改位置</span>
              <span>实施与观察</span>
              <span>下一步</span>
            </div>
            {groups.tasks.map((item) => {
              const presentation = taskPresentation(
                item,
                data.assets,
                data.project,
              );
              const tracking = trackingSummary(item);
              return (
                <article className="og-task-register-row" key={item.id}>
                  <div className="og-task-register-name">
                    <small>{taskProviderLabel(item)}</small>
                    <h2>
                      <button onClick={() => onSelect(item.id)}>
                        {displayTaskTitle(item, data, presentation.title)}
                      </button>
                    </h2>
                    <span className="og-tag neutral">{taskState(item)}</span>
                    {item.researchContext?.snapshot?.competitorReference && (
                      <small>
                        参照：
                        {item.researchContext.snapshot.competitorReference.name}
                      </small>
                    )}
                  </div>
                  <div className="og-task-register-problem">
                    <p>
                      {presentation.observation ||
                        item.workflow?.diagnosis?.findings[0]?.observation ||
                        item.researchContext?.gap ||
                        item.researchContext?.snapshot?.question.diagnosis
                          .observed ||
                        '尚未完成调查'}
                    </p>
                    <details>
                      <summary>任务依据</summary>
                      <dl>
                        <dt>要解决什么</dt>
                        <dd>
                          {item.researchContext?.snapshot?.question[
                            item.researchContext.language
                          ] ||
                            item.workflow?.questions[0]?.query ||
                            item.goal ||
                            item.title}
                        </dd>
                        <dt>为什么改</dt>
                        <dd>
                          {item.proposal?.rationale ||
                            item.workflow?.diagnosis?.recommendedAction ||
                            item.researchContext?.snapshot?.question.diagnosis
                              .nextStep ||
                            '尚未形成有依据的改进建议'}
                        </dd>
                        {item.researchContext?.snapshot
                          ?.competitorReference && (
                          <>
                            <dt>改进目标</dt>
                            <dd>
                              自身比之前好，并缩小与参照的差距；待同条件复测。
                            </dd>
                          </>
                        )}
                      </dl>
                    </details>
                  </div>
                  <p className="og-task-register-target">
                    {item.proposal
                      ? presentation.targetTitle
                      : item.researchContext?.snapshot?.targetAsset?.title ||
                        '调查后确定'}
                  </p>
                  <div className="og-task-register-tracking">
                    <strong>{tracking.implementation}</strong>
                    <span>{tracking.schedule}</span>
                    <p>{tracking.outcome}</p>
                  </div>
                  <button
                    className="og-task-register-next"
                    onClick={() => onSelect(item.id)}
                  >
                    {nextAction(item)} <ArrowRight size={16} />
                  </button>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="og-workspace-empty">
            <div className="og-workspace-empty-mark">
              <Plus size={24} />
            </div>
            <div>
              <h2>暂无改进任务</h2>
            </div>
            <button className="og-button primary" onClick={onQuestions}>
              {data.latestResearch ? '查看问题与回答' : '审阅问题'}
              <ArrowRight size={16} />
            </button>
          </section>
        ))}
      {view === 'history' && (
        <div className="og-history-list">
          {groups.history.length ? (
            groups.history.map((item) => {
              const record = historicalRecords[item.id];
              const realRuns = realFollowupRuns(item);
              const replays = item.runs.filter(
                (run) => run.mode === 'replay',
              ).length;
              return (
                <button
                  className="og-history-row"
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                >
                  <span className="og-history-icon">
                    <Archive size={19} />
                  </span>
                  <span className="og-history-copy">
                    <strong>{record.title}</strong>
                    <span>
                      {record.origin} ·{' '}
                      {item.implementation?.kind === 'user_confirmed'
                        ? '已登记真实实施'
                        : item.implementation?.kind === 'rehearsal'
                          ? `${replays} 次回放 · 未真实实施`
                          : item.status === 'failed' ||
                              (record.origin === '失败记录' &&
                                !(
                                  item.workflow?.baseline?.mode === 'live' &&
                                  item.workflow.baseline.status === 'completed'
                                ))
                            ? '采集未完成 · 没有新改稿'
                            : '正文候选 · 未实施'}
                      {realRuns.length > 0 &&
                        ` · ${realRuns.length} 次真实跟测`}
                    </span>
                  </span>
                  <time>{date(item.updatedAt)}</time>
                  <ChevronRight size={18} />
                </button>
              );
            })
          ) : (
            <section className="og-workspace-empty">
              <Archive size={24} />
              <div>
                <h2>暂无历史记录</h2>
              </div>
            </section>
          )}
        </div>
      )}
      {view === 'monitor' &&
        (groups.monitor.length ? (
          <div className="og-monitor-task-list">
            {groups.monitor.map((item) => {
              const presentation = taskPresentation(
                item,
                data.assets,
                data.project,
              );
              return (
                <article className="og-monitor-task-card" key={item.id}>
                  <header>
                    <div>
                      <span>
                        {taskProviderLabel(item)} ·{' '}
                        {item.implementation!.occurredAt
                          ? `${date(item.implementation!.occurredAt)} 实施`
                          : '实施时间待补'}
                      </span>
                      <h2>
                        {displayTaskTitle(item, data, presentation.title)}
                      </h2>
                    </div>
                    <button
                      className="og-button secondary"
                      onClick={() => onSelect(item.id)}
                    >
                      查看跟踪
                      <ArrowRight size={15} />
                    </button>
                  </header>
                  <TaskOutcomeHistory
                    task={item}
                    onEvidence={onEvidence}
                    compact
                  />
                  <footer>
                    <span>
                      {item.status === 'paused'
                        ? '观察已暂停'
                        : item.monitor.enabled
                          ? `下一次 ${item.monitor.nextRunAt ? date(item.monitor.nextRunAt) + ' ' + item.monitor.timeOfDay : '待安排'}`
                          : '自动观察未开启'}
                    </span>
                    <span>
                      {item.workflow?.outcome?.summary ||
                        '尚未形成可比效果结论'}
                    </span>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <section className="og-workspace-empty">
            <div className="og-workspace-empty-mark">
              <TrendingUp size={25} />
            </div>
            <div>
              <h2>暂无实施后的观测</h2>
              <p>登记实际改动后，在这里比较复测结果。</p>
            </div>
          </section>
        ))}
    </div>
  );
}

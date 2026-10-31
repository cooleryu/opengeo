'use client';

import { useState } from 'react';
import {
  ArrowUpRight,
  ChevronDown,
  FileText,
  Pause,
  Play,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import type { GeoRun, GeoState, GeoTask } from '@/lib/geo/types';
import TaskOutcomeHistory, {
  comparableChartRuns,
  observationLabel,
  realFollowupRuns,
  trackingDate,
  trackingLanguage,
} from './TaskOutcomeHistory';
import { taskPresentation } from './task-presentation';
import './tracking.css';

export type TaskTrackingPanelProps = {
  data: GeoState;
  task: GeoTask;
  busy: string;
  onAct: (
    action: string,
    payload?: Record<string, unknown>,
    message?: string,
  ) => Promise<GeoState | null>;
  onMonitor: () => void;
  onLive: () => void;
  onEvidence: (path: string) => void;
  onImplementation: (kind: 'rehearsal' | 'user_confirmed') => void;
};

const outcomeLabels = {
  improved: '观察到提升',
  unchanged: '未观察到变化',
  worse: '观察到下降',
  inconclusive: '尚不能判断效果',
};
const strategyLabels = {
  candidate: '待验证',
  validated: '已验证',
  active: '已启用',
  reverted: '已回退',
};
const strategyActionLabels = {
  created: '形成候选',
  validated: '验证通过',
  validation_failed: '验证未通过',
  activated: '启用',
  reverted: '回退',
};

export default function TaskTrackingPanel({
  data,
  task,
  busy,
  onAct,
  onMonitor,
  onLive,
  onEvidence,
  onImplementation,
}: TaskTrackingPanelProps) {
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const [revertReason, setRevertReason] = useState('');
  const presentation = taskPresentation(task, data.assets, data.project);
  const workflow = task.workflow;
  const implementation = task.implementation;
  const actual = implementation?.kind === 'user_confirmed';
  const needsActualDate = actual && !implementation.occurredAt;
  const comparable = comparableChartRuns(task);
  const outcome = workflow?.outcome;
  const realRuns = realFollowupRuns(task);
  const baseline = workflow?.baseline;
  const allRuns = [
    ...new Map(
      [...(baseline ? [baseline] : []), ...task.runs].map((run) => [
        run.id,
        run,
      ]),
    ).values(),
  ];
  const replays = allRuns.filter((run) => run.mode === 'replay');
  const failed = allRuns.filter(
    (run) => run.mode === 'live' && (run.status !== 'completed' || !!run.error),
  );
  const observations = allRuns.filter(
    (run) => run.mode === 'live' && run.status === 'completed' && !run.error,
  );
  const selectedIds = new Set(comparable.map((run) => run.id));
  const answerCollection =
    workflow?.collection?.metric === 'answer_target_citation';
  const provider =
    workflow?.collection?.provider ?? task.collectionProvider ?? 'deepseek';
  const configured =
    data.settings.collectionProviders?.find((item) => item.id === provider)
      ?.configured ??
    (provider === 'deepseek' && data.settings.liveSearchConfigured);
  const working = !!busy || task.status === 'investigating';
  const canRecord =
    (!actual || needsActualDate) &&
    task.proposal?.status === 'accepted' &&
    (needsActualDate ||
      ['awaiting_implementation', 'monitoring', 'paused'].includes(
        task.status,
      ));
  const strategies = (data.strategies ?? []).filter(
    (strategy) =>
      strategy.taskId === task.id &&
      strategy.projectId === data.project.id &&
      strategy.implementationRevision === implementation?.proposalRevision &&
      strategy.protocolKey === workflow?.protocolKey,
  );
  const title =
    implementation?.kind === 'rehearsal'
      ? '只有演练记录，尚无真实效果'
      : !actual
        ? '尚未登记实际实施'
        : needsActualDate
          ? '待补充实际实施时间'
          : comparable.length && outcome
            ? outcomeLabels[outcome.classification]
            : '尚不能判断效果';
  const next = !actual
    ? canRecord
      ? '完成修改后登记实施，再进行同题复查。'
      : '先完成方案审核与确认，再登记实际实施。'
    : needsActualDate
      ? '补充真实发生时间后，再比较实施前后的观测。'
      : !realRuns.length
        ? '下一步：按已冻结的问题和条件完成首次复测。'
        : !comparable.length
          ? '下一步：核对基线、实施版本和复测条件。'
          : outcome?.classification === 'improved'
            ? '结果仅支持当前条件下的观察，后续同条件验证后再复用。'
            : '下一步：复查实施内容、观察时长与同期变化。';

  function runRow(run: GeoRun) {
    const isBaseline = run.id === baseline?.id;
    const complete =
      run.status === 'completed' &&
      !run.error &&
      run.completedCount === run.queryCount &&
      run.queryCount > 0 &&
      run.questions.length === run.queryCount;
    const confirmed =
      !answerCollection ||
      run.questions.every((question) => typeof question.aiCited === 'boolean');
    const hits = run.questions.filter((question) =>
      answerCollection ? question.aiCited === true : question.projectHit,
    ).length;
    return (
      <details className="og-tracking-run" key={run.id}>
        <summary>
          <time>{trackingDate(run.at)}</time>
          <span>
            {run.mode === 'replay'
              ? '历史回放'
              : isBaseline
                ? '实施前记录'
                : '真实采集'}
          </span>
          <span>
            {run.status === 'failed' || run.error
              ? '失败'
              : run.status === 'partial'
                ? '部分完成'
                : '已完成'}
          </span>
          <strong>
            {run.mode === 'replay'
              ? '未新增测量'
              : !complete || !confirmed
                ? `${run.completedCount}/${run.queryCount} 题完成`
                : `${hits}/${run.queryCount} ${answerCollection ? '引用' : '找到'}`}
          </strong>
          <ChevronDown size={14} />
        </summary>
        <div className="og-tracking-run-body">
          <p>{run.summary}</p>
          <div className="og-tracking-run-meta">
            <span>原始测量 {trackingDate(run.measurementAt)}</span>
            <span>
              {selectedIds.has(run.id) ? '已纳入当前比较' : '未纳入当前比较'}
            </span>
            <span>
              实施版本{' '}
              {run.implementationRevision
                ? `v${run.implementationRevision}`
                : isBaseline
                  ? '实施前'
                  : '未关联'}
            </span>
            <span>
              {run.costEstimated ? '费用预留' : '记录费用'} ¥
              {run.cost.toFixed(3)}
            </span>
          </div>
          {run.error && <p className="og-tracking-error">{run.error}</p>}
          <div className="og-tracking-observations">
            {run.questions.map((question) => (
              <div key={question.id}>
                <div>
                  <span>{question.query}</span>
                  <small>
                    {question.provider} · {trackingLanguage(question.language)}{' '}
                    · {trackingDate(question.measurementAt)}
                  </small>
                </div>
                <span
                  className={
                    run.mode === 'live' &&
                    (answerCollection
                      ? question.aiCited === true
                      : question.projectHit)
                      ? 'observed'
                      : ''
                  }
                >
                  {observationLabel(question, answerCollection)}
                </span>
                {question.evidencePath && (
                  <button
                    type="button"
                    className="og-tracking-link"
                    onClick={() => onEvidence(question.evidencePath)}
                  >
                    <FileText size={13} />
                    原记录
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </details>
    );
  }

  return (
    <div className={`og-tracking-panel${actual ? ' has-actual' : ''}`}>
      <section className="og-tracking-result">
        <div>
          <h2>{title}</h2>
          <p>{next}</p>
        </div>
        <div className="og-tracking-actions">
          {actual && !needsActualDate && (
            <button
              type="button"
              className="og-tracking-button primary"
              disabled={working || !configured}
              onClick={onLive}
            >
              <RefreshCw size={14} />
              {realRuns.length ? '再次实测' : '开始实测'}
            </button>
          )}
          {canRecord && (
            <button
              type="button"
              className="og-tracking-button primary"
              disabled={working}
              onClick={() => onImplementation('user_confirmed')}
            >
              {needsActualDate ? '补充实际时间' : '登记实际实施'}
            </button>
          )}
          {implementation && (
            <button
              type="button"
              className="og-tracking-button"
              disabled={working}
              onClick={onMonitor}
            >
              <Settings2 size={14} />
              跟测设置
            </button>
          )}
        </div>
      </section>

      <section className="og-tracking-card og-tracking-implementation">
        {implementation && (
          <>
            <header className="og-tracking-section-heading">
              <h3>实施</h3>
              <span>
                {actual
                  ? '用户确认，未独立核验'
                  : implementation
                    ? '流程演练'
                    : '未实施'}
              </span>
            </header>
            <dl className="og-tracking-facts">
              <div>
                <dt>方案版本</dt>
                <dd>
                  {implementation?.proposalRevision
                    ? `v${implementation.proposalRevision}`
                    : '未关联'}
                </dd>
              </div>
              <div>
                <dt>实际实施</dt>
                <dd>
                  {actual
                    ? implementation.occurredAt
                      ? trackingDate(implementation.occurredAt)
                      : '未知'
                    : '未实施'}
                </dd>
              </div>
              <div>
                <dt>登记时间</dt>
                <dd>{trackingDate(implementation?.at)}</dd>
              </div>
              <div>
                <dt>修改页面</dt>
                <dd>
                  {implementation?.url ? (
                    <a
                      href={implementation.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {presentation.targetTitle}
                      <ArrowUpRight size={13} />
                    </a>
                  ) : (
                    '未登记'
                  )}
                </dd>
              </div>
            </dl>
          </>
        )}
        {implementation?.note && (
          <details className="og-tracking-disclosure">
            <summary>
              实施说明
              <ChevronDown size={14} />
            </summary>
            <div>
              <p>{implementation.note}</p>
            </div>
          </details>
        )}
        <details
          className={`og-tracking-disclosure${implementation ? '' : ' standalone'}`}
        >
          <summary>
            方案与要求
            <ChevronDown size={14} />
          </summary>
          <div>
            <p>{task.goal || task.title}</p>
            {task.proposal ? (
              <>
                <h4>{task.proposal.title}</h4>
                <p>{task.proposal.rationale}</p>
                <ul>
                  {task.proposal.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                <div className="og-tracking-draft">
                  <section>
                    <h4>修改前</h4>
                    <pre>{task.proposal.before || '未记录原文'}</pre>
                  </section>
                  <section>
                    <h4>确认稿</h4>
                    <pre>{task.proposal.after || '未记录改稿'}</pre>
                  </section>
                </div>
                {!!task.proposal.successCriteria.length && (
                  <>
                    <h4>原定验证要求</h4>
                    <ul>
                      {task.proposal.successCriteria.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p>尚无方案记录。</p>
            )}
          </div>
        </details>
      </section>

      {actual && (
        <section className="og-tracking-card og-tracking-outcome-card">
          <TaskOutcomeHistory
            key={task.id}
            task={task}
            onEvidence={onEvidence}
          />
        </section>
      )}

      {implementation && (
        <div className={`og-tracking-lower-grid${actual ? '' : ' single'}`}>
          <section className="og-tracking-card">
            <header className="og-tracking-section-heading">
              <h3>跟测安排</h3>
              <button
                type="button"
                className="og-tracking-link"
                disabled={working || !implementation}
                onClick={onMonitor}
              >
                调整
              </button>
            </header>
            <dl className="og-tracking-plan">
              <div>
                <dt>下一次</dt>
                <dd>
                  {task.status === 'paused'
                    ? '已暂停'
                    : task.monitor.enabled
                      ? trackingDate(task.monitor.nextRunAt)
                      : '未开启'}
                </dd>
              </div>
              <div>
                <dt>方式</dt>
                <dd>
                  {task.monitor.mode === 'live' ? '真实采集' : '历史回放'} ·
                  每天 {task.monitor.timeOfDay}
                </dd>
              </div>
              <div>
                <dt>剩余</dt>
                <dd>
                  {task.monitor.remaining} 次 ·{' '}
                  {workflow?.questions.length ||
                    task.monitor.queryIds.length ||
                    0}{' '}
                  个问题
                </dd>
              </div>
              <div>
                <dt>{answerCollection ? '费用预留' : '已用预算'}</dt>
                <dd>
                  ¥{task.monitor.spent.toFixed(3)} / ¥
                  {task.monitor.budgetLimit.toFixed(2)}
                </dd>
              </div>
            </dl>
            <div className="og-tracking-inline-actions">
              {['monitoring', 'paused'].includes(task.status) && (
                <button
                  type="button"
                  className="og-tracking-link"
                  disabled={working}
                  onClick={() =>
                    onAct(
                      task.status === 'paused' ? 'resume' : 'pause',
                      {},
                      task.status === 'paused' ? '观察已恢复' : '观察已暂停',
                    )
                  }
                >
                  {task.status === 'paused' ? (
                    <Play size={13} />
                  ) : (
                    <Pause size={13} />
                  )}
                  {task.status === 'paused' ? '恢复观察' : '暂停观察'}
                </button>
              )}
              <span>
                {data.settings.schedulerRunning
                  ? '本地服务运行中'
                  : '调度器未运行'}{' '}
                · 北京时间
              </span>
            </div>
            {actual && !configured && (
              <p className="og-tracking-note">当前采集入口尚未配置。</p>
            )}
          </section>

          {actual && (
            <section className="og-tracking-card">
              <header className="og-tracking-section-heading">
                <h3>策略经验</h3>
                <span>
                  {strategies.length
                    ? `${strategies.length} 条 · ${strategies.filter((strategy) => strategy.status === 'active').length} 已启用`
                    : '尚未形成'}
                </span>
              </header>
              {!strategies.length && (
                <p className="og-tracking-note">
                  {comparable.length
                    ? '可复盘现有记录，形成待验证候选。'
                    : '等待完整、可比的真实复测。'}
                </p>
              )}
              {strategies.map((strategy) => (
                <article key={strategy.id} className="og-tracking-strategy">
                  <header>
                    <strong>
                      {strategyLabels[strategy.status || 'candidate']} · v
                      {strategy.version || 1}
                      {strategy.history?.at(-1)?.action ===
                        'validation_failed' && ' · 验证未通过'}
                    </strong>
                    <time>{trackingDate(strategy.createdAt)}</time>
                  </header>
                  <div className="og-tracking-strategy-actions">
                    {(!strategy.status ||
                      strategy.status === 'candidate' ||
                      strategy.status === 'reverted') && (
                      <button
                        type="button"
                        className="og-tracking-button"
                        disabled={working || needsActualDate}
                        onClick={() =>
                          onAct(
                            'validate_strategy',
                            {
                              strategyId: strategy.id,
                              version: strategy.version || 1,
                            },
                            '已检查策略的新增观测',
                          )
                        }
                      >
                        验证现有观测
                      </button>
                    )}
                    {strategy.status === 'validated' && (
                      <button
                        type="button"
                        className="og-tracking-button primary"
                        disabled={working}
                        onClick={() =>
                          onAct(
                            'activate_strategy',
                            {
                              strategyId: strategy.id,
                              version: strategy.version,
                            },
                            '策略已启用',
                          )
                        }
                      >
                        启用策略
                      </button>
                    )}
                    {strategy.status === 'active' && (
                      <button
                        type="button"
                        className="og-tracking-button"
                        disabled={working}
                        onClick={() => {
                          setRevertingId(strategy.id);
                          setRevertReason('');
                        }}
                      >
                        回退
                      </button>
                    )}
                  </div>
                  {revertingId === strategy.id &&
                    strategy.status === 'active' && (
                      <div className="og-tracking-revert">
                        <label htmlFor={`strategy-revert-${strategy.id}`}>
                          回退依据
                        </label>
                        <textarea
                          id={`strategy-revert-${strategy.id}`}
                          rows={2}
                          value={revertReason}
                          maxLength={3000}
                          onChange={(event) =>
                            setRevertReason(event.target.value)
                          }
                          placeholder="记录发现的问题或新观察。"
                        />
                        <div className="og-tracking-strategy-actions">
                          <button
                            type="button"
                            className="og-tracking-button"
                            disabled={working || !revertReason.trim()}
                            onClick={async () => {
                              const result = await onAct(
                                'revert_strategy',
                                {
                                  strategyId: strategy.id,
                                  version: strategy.version,
                                  reason: revertReason,
                                },
                                '策略已回退',
                              );
                              if (result) {
                                setRevertingId(null);
                                setRevertReason('');
                              }
                            }}
                          >
                            确认回退
                          </button>
                          <button
                            type="button"
                            className="og-tracking-link"
                            disabled={working}
                            onClick={() => setRevertingId(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  <details className="og-tracking-disclosure">
                    <summary>
                      依据与版本记录
                      <ChevronDown size={14} />
                    </summary>
                    <div>
                      <p>
                        {strategy.status === 'active'
                          ? '已验证并人工启用，适用于当前项目、内容、类别和协议。'
                          : strategy.status === 'reverted'
                            ? `已停止用于后续方案：${strategy.history?.at(-1)?.reason || '用户已回退。'}`
                            : strategy.validation?.summary ||
                              `初始观测：${outcomeLabels[strategy.outcome]}。等待候选生成后的新增同协议实测验证。`}
                      </p>
                      <p>{strategy.recommendation}</p>
                      <p>{strategy.action}</p>
                      <div className="og-tracking-strategy-history">
                        {(strategy.history || []).map((entry) => (
                          <div key={entry.version}>
                            <strong>
                              v{entry.version} ·{' '}
                              {strategyActionLabels[entry.action]}
                            </strong>
                            <time>{trackingDate(entry.at)}</time>
                            <p>{entry.reason}</p>
                          </div>
                        ))}
                      </div>
                      <div className="og-tracking-evidence">
                        {[
                          ...new Set([
                            ...strategy.evidencePaths,
                            ...(strategy.validation?.evidencePaths || []),
                            ...(strategy.history || []).flatMap(
                              (entry) => entry.evidencePaths,
                            ),
                          ]),
                        ].map((path) => (
                          <button
                            key={path}
                            type="button"
                            className="og-tracking-link"
                            onClick={() => onEvidence(path)}
                          >
                            <FileText size={13} />
                            {path.split('/').slice(-2).join('/')}
                          </button>
                        ))}
                      </div>
                    </div>
                  </details>
                </article>
              ))}
              {workflow && (
                <button
                  type="button"
                  className="og-tracking-link"
                  disabled={
                    working || !actual || needsActualDate || !realRuns.length
                  }
                  onClick={() => onAct('reflect', {}, '已完成本次效果复盘')}
                >
                  复盘现有记录
                </button>
              )}
              <div className="og-tracking-unmeasured">
                <span>
                  网站访问 <strong>未测</strong>
                </span>
                <span>
                  转化 <strong>未测</strong>
                </span>
              </div>
            </section>
          )}
        </div>
      )}

      <section className="og-tracking-card og-tracking-history">
        <header className="og-tracking-section-heading">
          <h3>执行历史</h3>
          <span>{allRuns.length} 次记录</span>
        </header>
        {(
          [
            ['真实观测', observations],
            ['失败与未完成', failed],
            ['历史回放', replays],
          ] as [string, GeoRun[]][]
        ).map(
          ([label, runs]) =>
            runs.length > 0 && (
              <details key={label} className="og-tracking-history-group">
                <summary>
                  {label}
                  <span>{runs.length} 次</span>
                  <ChevronDown size={14} />
                </summary>
                <div>
                  {runs
                    .slice()
                    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
                    .map(runRow)}
                </div>
              </details>
            ),
        )}
        {!allRuns.length && <p className="og-tracking-note">尚无执行记录。</p>}
        {!answerCollection && implementation && (
          <button
            type="button"
            className="og-tracking-link og-tracking-replay"
            disabled={working}
            onClick={() =>
              onAct('run_monitor', { mode: 'replay' }, '已安排历史回放')
            }
          >
            回放一次历史记录
          </button>
        )}
        {!!task.events.length && (
          <details className="og-tracking-disclosure">
            <summary>
              任务动态<span>{task.events.length} 条</span>
              <ChevronDown size={14} />
            </summary>
            <div className="og-tracking-events">
              {task.events
                .slice()
                .reverse()
                .map((event) => (
                  <article key={event.id}>
                    <time>{trackingDate(event.at)}</time>
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.detail}</p>
                    </div>
                  </article>
                ))}
            </div>
          </details>
        )}
      </section>
    </div>
  );
}

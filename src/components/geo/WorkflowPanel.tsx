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
  RefreshCw,
  Settings2,
} from 'lucide-react';
import type { GeoRun, GeoState, GeoTask } from '@/lib/geo/types';
import type { QualityLoop } from '@/lib/geo/workflow-types';

type Props = {
  data: GeoState;
  task: GeoTask;
  busy: string;
  onAct: (
    action: string,
    payload?: Record<string, unknown>,
    message?: string,
  ) => Promise<GeoState | null>;
  onQuestions: () => void;
  onImplementation: (kind: 'rehearsal' | 'user_confirmed') => void;
  onMonitor: () => void;
  onLive: () => void;
  onEvidence: (path: string) => void;
};

const stages = ['搜索基线', '诊断', '方案审核', '实施', '观察与复盘'];
const stopLabels: Record<QualityLoop['stopReason'], string> = {
  target_reached: '达到审核目标',
  no_progress: '继续修改没有进步，已停止',
  round_limit: '已达到本轮修改次数上限',
  needs_configuration: '需要配置模型后重新审核',
  needs_evidence: '证据不足，暂不通过',
};
const outcomeLabels = {
  improved: '观察到改善',
  unchanged: '未观察到变化',
  worse: '观察到下降',
  inconclusive: '暂时无法判断',
};
const scoreLabels: Record<string, string> = {
  evidence: '证据',
  relevance: '相关性',
  actionability: '可执行性',
  verifiability: '可验证性',
};
const date = (value?: string | null) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '尚未安排';
const percent = (value: number | null) =>
  value === null ? '—' : `${(value * 100).toFixed(1)}%`;
const money = (value: number) => value.toFixed(3).replace(/0$/, '');

export default function WorkflowPanel({
  data,
  task,
  busy,
  onAct,
  onQuestions,
  onImplementation,
  onMonitor,
  onLive,
  onEvidence,
}: Props) {
  const workflow = task.workflow;
  const current = workflow
    ? {
        search: 0,
        diagnosis: 1,
        quality: 2,
        implementation: 3,
        monitoring: 4,
        reflection: 4,
      }[workflow.stage]
    : 0;
  const [stage, setStage] = useState(current);
  const [mode, setMode] = useState<'live' | 'replay'>('replay');
  const [budget, setBudget] = useState(1);
  const [consent, setConsent] = useState(false);
  const [after, setAfter] = useState(task.proposal?.after ?? '');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setStage(current);
  }, [task.id, current]);
  useEffect(() => {
    setAfter(task.proposal?.after ?? '');
    setEditing(false);
  }, [task.id, task.proposal?.after]);
  useEffect(() => {
    setMode('replay');
    setConsent(false);
  }, [task.id]);
  const selectedQuestions = data.questionPlan.candidates.filter(
    (q) => q.selected && q.review.decision !== 'exclude',
  );
  const questions = workflow?.questions ?? selectedQuestions;
  const queryCost = questions.length * 0.005;
  const ready =
    data.questionPlan.status === 'ready' && selectedQuestions.length > 0;
  const configured =
    data.settings.liveSearchConfigured && data.settings.modelConfigured;
  const working = !!busy || task.status === 'investigating';
  const baseline = workflow?.baseline;
  const hasCompleteLiveBaseline =
    baseline?.mode === 'live' && baseline.status === 'completed';
  const canStartSearch =
    !task.implementation &&
    ['queued', 'failed', 'proposal_ready'].includes(task.status) &&
    !hasCompleteLiveBaseline;
  const startQueryCost = selectedQuestions.length * 0.005;
  const requiredSearchBudget = task.monitor.spent + startQueryCost;
  const diagnosis = workflow?.diagnosis;
  const quality = workflow?.quality;
  const reviewed =
    quality?.rounds.find((round) => round.round === quality.bestRound) ??
    quality?.rounds[quality.rounds.length - 1];
  const proposal = task.proposal;
  const dirty = !!proposal && after !== proposal.after;
  const passed =
    !!reviewed?.review.passed &&
    reviewed.candidate.after === proposal?.after &&
    baseline?.mode === 'live';
  const followups = task.runs.filter(
    (run) => run.phase !== 'baseline' && run.id !== baseline?.id,
  );
  const outcome = workflow?.outcome;
  const usedStrategies = (data.strategies ?? []).filter((strategy) =>
    workflow?.appliedStrategyIds.includes(strategy.id),
  );
  const learnedStrategies = (data.strategies ?? []).filter(
    (strategy) => strategy.taskId === task.id,
  );
  const evidence = (paths: string[]) => (
    <div className="og-evidence-links">
      {Array.from(new Set(paths.filter(Boolean))).map((path) => (
        <button key={path} onClick={() => onEvidence(path)}>
          <FileText size={14} />
          {path.split('/').slice(-2).join('/')}
        </button>
      ))}
    </div>
  );
  const spinner = (action: string) =>
    busy === action || task.status === 'investigating' ? (
      <Loader2 size={16} className="spin" />
    ) : (
      <ArrowRight size={16} />
    );
  const runDetails = (run: GeoRun) => (
    <details key={run.id} className="og-run-row">
      <summary>
        <time>{date(run.at)}</time>
        <span>
          {run.mode === 'live' ? '真实搜索' : '历史预览'} ·{' '}
          {run.status === 'completed'
            ? '完成'
            : run.status === 'partial'
              ? '部分完成'
              : '失败'}
        </span>
        <strong>
          {run.completedCount}/{run.queryCount} 题
        </strong>
        <ChevronDown size={14} />
      </summary>
      <div className="og-run-detail">
        <p>{run.summary}</p>
        <p className="og-muted">
          原始测量：{date(run.measurementAt)} · 费用 ¥{money(run.cost)}
        </p>
        {run.error && <p className="og-task-error">{run.error}</p>}
        {evidence(run.questions.map((q) => q.evidencePath))}
      </div>
    </details>
  );

  return (
    <>
      <section className="og-current-task">
        <div className="og-task-title-row">
          <h2>{task.title}</h2>
          <span className={`og-tag ${working ? 'blue' : 'neutral'}`}>
            {working
              ? '正在处理'
              : workflow
                ? stages[current]
                : '等待选择搜索方式'}
          </span>
        </div>
        <nav className="og-stage-tabs og-workflow-tabs" aria-label="任务阶段">
          {stages.map((label, index) => (
            <button
              key={label}
              disabled={index > current}
              className={stage === index ? 'active' : ''}
              aria-current={stage === index ? 'step' : undefined}
              onClick={() => setStage(index)}
            >
              <span>{index < current ? <Check size={14} /> : index + 1}</span>
              {label}
              {index === current && <small>当前</small>}
            </button>
          ))}
        </nav>
      </section>
      {task.error && (
        <div className="og-task-error" role="alert">
          <span>{task.error}</span>
          {!task.implementation &&
            (canStartSearch || hasCompleteLiveBaseline) && (
              <button
                className="og-button secondary"
                disabled={working}
                onClick={() => {
                  if (canStartSearch) {
                    setStage(0);
                    setMode('live');
                    setConsent(false);
                  } else
                    void onAct('investigate', {}, '已重新开始诊断与方案审核');
                }}
              >
                {canStartSearch ? '重新选择搜索方式' : '重试诊断与审核'}
              </button>
            )}
        </div>
      )}
      {working && (
        <div className="og-task-working" role="status">
          <Loader2 size={18} className="spin" />
          正在{stages[current]}
          ，完成后会自动更新。搜索结果、审核记录会保留在这条任务中。
        </div>
      )}
      <section className="og-surface og-task-stage og-workflow-stage">
        {stage === 0 && (
          <>
            <div className="og-eyebrow">先知道现在的情况</div>
            <h2>
              {baseline ? '本次改进的搜索基线' : '选择本次任务的搜索方式'}
            </h2>
            <p className="og-task-lead">
              {workflow
                ? `已固定 ${questions.length} 道问题，后续观察沿用这份题单。`
                : `当前题单已选 ${questions.length} 道问题。开始后会固定题单，再根据搜索结果诊断并审核方案。`}
            </p>
            {canStartSearch && !ready && (
              <div className="og-workflow-notice">
                <p>先确认要测的问题，再开始这条任务。</p>
                <button
                  className="og-button primary"
                  disabled={working}
                  onClick={onQuestions}
                >
                  审阅并确认题单
                  <ArrowRight size={16} />
                </button>
              </div>
            )}
            {canStartSearch && ready && (
              <>
                {workflow && (
                  <p className="og-workflow-notice">
                    当前基线是历史预览或尚未完整采集。可以重新发起搜索，使用当前已确认的{' '}
                    {selectedQuestions.length} 道问题；之前的任务记录会保留。
                  </p>
                )}
                <button
                  className="og-text-button"
                  disabled={working}
                  onClick={onQuestions}
                >
                  查看已确认题单 · 版本 {data.questionPlan.revision}
                </button>
                <div className="og-radio-cards og-workflow-modes">
                  <button
                    disabled={working}
                    className={mode === 'replay' ? 'selected' : ''}
                    onClick={() => {
                      setMode('replay');
                      setConsent(false);
                    }}
                  >
                    <span className="og-radio-dot" />
                    <div>
                      <strong>
                        先用历史记录预览{' '}
                        <span className="og-tag neutral">免费</span>
                      </strong>
                      <p>
                        只匹配已有记录，可能覆盖部分题目。用于预览诊断与审核流程，不能作为通过审核的实施方案。
                      </p>
                    </div>
                  </button>
                  <button
                    disabled={working || !configured}
                    className={mode === 'live' ? 'selected' : ''}
                    onClick={() => {
                      setMode('live');
                      setConsent(false);
                    }}
                  >
                    <span className="og-radio-dot" />
                    <div>
                      <strong>真实搜索，再诊断与审核</strong>
                      <p>
                        {configured
                          ? `向 DeepSeek 搜索 ${selectedQuestions.length} 题，搜索费用最多预留 ¥${money(startQueryCost)}；随后调用模型诊断、修改和复检。`
                          : `需要${!data.settings.liveSearchConfigured ? '配置 DeepSeek 搜索' : ''}${!data.settings.liveSearchConfigured && !data.settings.modelConfigured ? '和' : ''}${!data.settings.modelConfigured ? '配置诊断模型' : ''}后启用。`}
                      </p>
                    </div>
                  </button>
                </div>
                {!configured && (
                  <p className="og-muted">
                    可先免费预览。真实任务需要可用的搜索密钥和模型配置。
                    <a className="og-text-link" href="/research">
                      查看模型设置
                    </a>
                  </p>
                )}
                {mode === 'live' && (
                  <div className="og-workflow-consent">
                    <label className="og-field-label" htmlFor="baseline-budget">
                      任务搜索累计预算上限（元）
                    </label>
                    <input
                      id="baseline-budget"
                      className="og-input"
                      type="number"
                      min={requiredSearchBudget}
                      step="0.005"
                      value={budget}
                      onChange={(event) =>
                        setBudget(Number(event.target.value))
                      }
                    />
                    <p className="og-muted">
                      每题成功请求 ¥0.005；模型诊断与最多 3
                      轮方案修改、审核另按已配置模型计费，不计入搜索预算。
                    </p>
                    {task.monitor.spent > 0 && (
                      <p className="og-muted">
                        之前已使用或预留 ¥{money(task.monitor.spent)}
                        ，本轮搜索后累计至少预留 ¥{money(requiredSearchBudget)}
                        。
                      </p>
                    )}
                    <label className="og-checkbox">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(event) => setConsent(event.target.checked)}
                      />
                      <span>我确认本次付费搜索及后续模型诊断、方案审核。</span>
                    </label>
                  </div>
                )}
                <div className="og-task-primary-action">
                  <button
                    className="og-button primary"
                    disabled={
                      working ||
                      (mode === 'live' &&
                        (!configured ||
                          !consent ||
                          !Number.isFinite(budget) ||
                          budget < requiredSearchBudget))
                    }
                    onClick={() =>
                      onAct(
                        'start_workflow',
                        { mode, budgetLimit: mode === 'live' ? budget : 0 },
                        mode === 'live'
                          ? '任务已开始，将搜索、诊断并审核方案'
                          : '已开始历史预览，不会产生新测量',
                      )
                    }
                  >
                    {mode === 'live' ? '确认并开始真实任务' : '预览这条任务'}
                    {spinner('start_workflow')}
                  </button>
                </div>
              </>
            )}
            {workflow && (
              <>
                <div className="og-workflow-meta">
                  <span
                    className={`og-tag ${baseline?.mode === 'live' ? 'blue' : 'neutral'}`}
                  >
                    {baseline?.mode === 'live'
                      ? '真实搜索基线'
                      : baseline
                        ? '历史记录预览'
                        : '等待搜索结果'}
                  </span>
                  <span>
                    题单版本 {workflow.questionPlanRevision} ·{' '}
                    {date(workflow.frozenAt)}
                  </span>
                </div>
                {baseline && (
                  <>
                    <p className="og-task-lead">{baseline.summary}</p>
                    {baseline.mode === 'replay' && (
                      <p className="og-workflow-notice">
                        匹配到 {baseline.completedCount}/{baseline.queryCount}{' '}
                        题的历史记录，其余题尚未测量。原始测量时间保留，历史预览不会通过实施审核。
                      </p>
                    )}
                    {runDetails(baseline)}
                  </>
                )}
                <details className="og-task-details">
                  <summary>
                    本任务固定的 {questions.length} 道问题
                    <ChevronDown size={15} />
                  </summary>
                  <ol className="og-workflow-questions">
                    {questions.map((q) => (
                      <li key={q.id}>{q.query}</li>
                    ))}
                  </ol>
                </details>
                {diagnosis && (
                  <button
                    className="og-button primary"
                    onClick={() => setStage(1)}
                  >
                    查看诊断
                    <ArrowRight size={16} />
                  </button>
                )}
              </>
            )}
          </>
        )}
        {stage === 1 && (
          <>
            <div className="og-eyebrow">搜索结果与已有内容一起看</div>
            <h2>为什么还没有被找到</h2>
            {diagnosis ? (
              <>
                <p className="og-task-lead">{diagnosis.summary}</p>
                <p className="og-muted">
                  {diagnosis.source === 'model'
                    ? '基于本次证据的模型诊断'
                    : '本地材料预览'}{' '}
                  · {date(diagnosis.createdAt)}
                </p>
                <div className="og-task-findings">
                  {diagnosis.findings.map((finding) => (
                    <article key={finding.id}>
                      <h3>{finding.observation}</h3>
                      <p>
                        <strong>可能原因：</strong>
                        {finding.hypothesis}
                      </p>
                      <p className="og-muted">{finding.uncertainty}</p>
                      {evidence(finding.evidencePaths)}
                    </article>
                  ))}
                </div>
                {diagnosis.comparisons.length > 0 && (
                  <details className="og-task-details">
                    <summary>
                      与本次出现的来源对照
                      <ChevronDown size={15} />
                    </summary>
                    {diagnosis.comparisons.map((comparison, index) => (
                      <article className="og-workflow-comparison" key={index}>
                        <a
                          href={comparison.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          查看实际来源
                        </a>
                        <p>{comparison.observedDifference}</p>
                        {evidence([comparison.evidencePath])}
                      </article>
                    ))}
                  </details>
                )}
                <p className="og-workflow-notice">
                  <strong>建议尝试：</strong>
                  {diagnosis.recommendedAction}
                </p>
                <p className="og-muted">{diagnosis.limitations.join(' ')}</p>
                {usedStrategies.length > 0 && (
                  <details className="og-task-details">
                    <summary>
                      这次参考了 {usedStrategies.length} 条既有策略经验
                      <ChevronDown size={15} />
                    </summary>
                    {usedStrategies.map((strategy) => (
                      <article
                        key={strategy.id}
                        className="og-workflow-comparison"
                      >
                        <h3>
                          {outcomeLabels[strategy.outcome]} · {strategy.action}
                        </h3>
                        <p>{strategy.recommendation}</p>
                        <p className="og-muted">
                          来自真实实施后的观察，仍需在本次任务中验证。
                        </p>
                        {evidence(strategy.evidencePaths)}
                      </article>
                    ))}
                  </details>
                )}
                {quality && (
                  <button
                    className="og-button primary"
                    onClick={() => setStage(2)}
                  >
                    查看方案与审核
                    <ArrowRight size={16} />
                  </button>
                )}
              </>
            ) : (
              <p className="og-muted">
                搜索结束后，诊断会显示观察、假设和证据。
              </p>
            )}
          </>
        )}
        {stage === 2 && (
          <>
            <div className="og-eyebrow">改稿 → 审核 → 必要时再改</div>
            <h2>
              {passed ? '方案通过审核，可以确认实施' : '先把方案改到值得实施'}
            </h2>
            {quality && (
              <div className={`og-workflow-notice ${passed ? 'passed' : ''}`}>
                <strong>{stopLabels[quality.stopReason]}</strong>
                <p>
                  已审核 {quality.rounds.length} 轮 · 目标 {quality.targetScore}{' '}
                  分 · 每项至少 {quality.minimumDimensionScore} 分。
                  {baseline?.mode === 'replay'
                    ? '历史预览不提供通过结论。'
                    : '通过审核表示值得尝试，实施效果仍需后续观察。'}
                </p>
              </div>
            )}
            {reviewed && (
              <>
                <div className="og-quality-scores">
                  {Object.entries(reviewed.review.scores).map(
                    ([key, score]) => (
                      <div key={key}>
                        <span>{scoreLabels[key] ?? key}</span>
                        <strong>{score}</strong>
                      </div>
                    ),
                  )}
                </div>
                <details className="og-task-details">
                  <summary>
                    审核依据与改进意见（{reviewed.review.issues.length} 项）
                  </summary>
                  <p className="og-task-lead">{reviewed.review.summary}</p>
                  {reviewed.review.issues.length > 0 && (
                    <ul className="og-quality-issues">
                      {reviewed.review.issues.map((issue, index) => (
                        <li key={index}>
                          <span
                            className={`og-tag ${issue.severity === 'blocking' ? 'amber' : 'neutral'}`}
                          >
                            {issue.severity === 'blocking'
                              ? '待解决'
                              : '可改进'}
                          </span>
                          <div>
                            <strong>{issue.detail}</strong>
                            <p>{issue.suggestion}</p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </details>
              </>
            )}
            {proposal && (
              <>
                <h3>{proposal.title}</h3>
                <p>{proposal.rationale}</p>
                <ol className="og-proposal-points">
                  {proposal.changes.map((change, index) => (
                    <li key={index}>
                      <span>{index + 1}</span>
                      <p>{change}</p>
                    </li>
                  ))}
                </ol>
                <details className="og-task-details" open>
                  <summary>
                    候选改稿
                    <ChevronDown size={15} />
                  </summary>
                  <div className="og-proposal-draft">
                    <div className="og-proposal-label">
                      <h3>建议内容</h3>
                      {!task.implementation &&
                        task.status !== 'awaiting_implementation' && (
                          <button
                            disabled={working}
                            onClick={() => setEditing(!editing)}
                          >
                            {editing ? '预览改稿' : '编辑改稿'}
                          </button>
                        )}
                    </div>
                    {editing ? (
                      <textarea
                        aria-label="编辑建议内容"
                        value={after}
                        disabled={working}
                        onChange={(event) => setAfter(event.target.value)}
                      />
                    ) : (
                      <div className="og-markdown">
                        <Markdown options={{ disableParsingRawHTML: true }}>
                          {after}
                        </Markdown>
                      </div>
                    )}
                  </div>
                  <details className="og-task-details">
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
              </>
            )}
            {quality && quality.rounds.length > 0 && (
              <details className="og-task-details">
                <summary>
                  查看 {quality.rounds.length} 轮修改与复检记录
                  <ChevronDown size={15} />
                </summary>
                {quality.rounds.map((round) => (
                  <article key={round.round} className="og-workflow-comparison">
                    <h3>
                      第 {round.round} 轮 · {round.review.total} 分 ·{' '}
                      {round.review.passed ? '该轮审核通过' : '未通过'}
                      {round.round === quality.bestRound ? ' · 当前候选' : ''}
                    </h3>
                    <p>{round.review.summary}</p>
                    {round.review.issues.map((issue, index) => (
                      <p className="og-muted" key={index}>
                        {issue.detail} {issue.suggestion}
                      </p>
                    ))}
                  </article>
                ))}
              </details>
            )}
            {!!workflow?.qualityHistory?.length && (
              <details className="og-task-details">
                <summary>
                  查看以前版本的审核记录
                  <ChevronDown size={15} />
                </summary>
                {workflow.qualityHistory.map((history, index) => (
                  <article
                    key={`${history.proposalRevision}-${index}`}
                    className="og-workflow-comparison"
                  >
                    <h3>
                      方案版本 {history.proposalRevision} ·{' '}
                      {history.quality.rounds.length} 轮审核
                    </h3>
                    <p>{stopLabels[history.quality.stopReason]}</p>
                    <p className="og-muted">
                      旧版本的审核记录保留供回看，不作为当前方案的通过依据。
                    </p>
                  </article>
                ))}
              </details>
            )}
            {!task.implementation &&
              task.status !== 'awaiting_implementation' &&
              proposal && (
                <div className="og-task-primary-action">
                  {dirty ? (
                    <>
                      <button
                        className="og-button primary"
                        disabled={working || !after.trim()}
                        onClick={() =>
                          onAct(
                            'review_plan',
                            {
                              after,
                              proposalRevision: workflow?.proposalRevision,
                            },
                            '改稿已提交，将重新审核',
                          )
                        }
                      >
                        保存修改并重新审核{spinner('review_plan')}
                      </button>
                      <span className="og-muted">
                        改稿已变化，旧审核结论不再适用。
                      </span>
                    </>
                  ) : passed ? (
                    <>
                      <button
                        className="og-button primary"
                        disabled={working}
                        onClick={() =>
                          onAct(
                            'accept_plan',
                            { proposalRevision: workflow?.proposalRevision },
                            '已确认通过审核的方案，下一步记录实施',
                          )
                        }
                      >
                        采用已通过审核的方案{spinner('accept_plan')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="og-button secondary"
                        disabled={
                          working ||
                          (!canStartSearch && !hasCompleteLiveBaseline)
                        }
                        onClick={() => {
                          if (canStartSearch) {
                            setStage(0);
                            setMode('live');
                            setConsent(false);
                          } else
                            void onAct(
                              'investigate',
                              {},
                              '重新诊断与审核已开始',
                            );
                        }}
                      >
                        {canStartSearch
                          ? '补充真实搜索，再审核'
                          : '重新诊断与审核'}
                        {spinner('investigate')}
                      </button>
                      <span className="og-muted">
                        {canStartSearch
                          ? '先取得完整的真实基线，再判断方案是否值得实施。'
                          : '通过审核后才能进入实施，已有真实基线会继续用于诊断。'}
                      </span>
                    </>
                  )}
                </div>
              )}
            {(task.implementation ||
              task.status === 'awaiting_implementation') && (
              <button className="og-button primary" onClick={() => setStage(3)}>
                查看实施步骤
                <ArrowRight size={16} />
              </button>
            )}
          </>
        )}
        {stage === 3 && (
          <>
            <div className="og-eyebrow">实施</div>
            <h2>
              {task.implementation
                ? '已记录实施情况'
                : '完成修改后，记录实施情况'}
            </h2>
            <p className="og-task-lead">
              {task.implementation?.note ||
                '将通过审核的方案应用到页面，再记录改动内容。后续观察沿用这次任务的固定题单。'}
            </p>
            {task.implementation ? (
              <>
                <p className="og-muted">
                  {date(task.implementation.at)} ·{' '}
                  {task.implementation.kind === 'rehearsal'
                    ? '流程演练，不能证明真实效果'
                    : '用户确认记录'}
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
                <div className="og-task-primary-action">
                  <button
                    className="og-button primary"
                    onClick={() => setStage(4)}
                  >
                    查看观察与复盘
                    <ArrowRight size={16} />
                  </button>
                  {task.implementation.kind === 'rehearsal' && (
                    <button
                      className="og-text-button"
                      disabled={working}
                      onClick={() => onImplementation('user_confirmed')}
                    >
                      记录实际实施
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="og-task-primary-action">
                <button
                  className="og-button primary"
                  disabled={working || !passed}
                  onClick={() => onImplementation('user_confirmed')}
                >
                  我已完成修改
                  <ArrowRight size={16} />
                </button>
                <button
                  className="og-text-button"
                  disabled={working || !passed}
                  onClick={() => onImplementation('rehearsal')}
                >
                  先演练实施记录
                </button>
              </div>
            )}
          </>
        )}
        {stage === 4 && (
          <>
            <div className="og-eyebrow">真实结果 → 策略经验 → 下次建议</div>
            <h2>
              {outcome
                ? outcomeLabels[outcome.classification]
                : '持续观察这次改动，再做判断'}
            </h2>
            <p className="og-task-lead">
              {outcome?.summary ||
                '先积累实施后的同题、同入口测量，再复盘是否改善。未满足比较条件时保留“无法判断”。'}
            </p>
            {outcome && (
              <>
                <div className="og-quality-scores og-outcome-scores">
                  <div>
                    <span>实施前</span>
                    <strong>{percent(outcome.beforeRate)}</strong>
                  </div>
                  <div>
                    <span>实施后</span>
                    <strong>{percent(outcome.afterRate)}</strong>
                  </div>
                </div>
                <p className="og-muted">
                  {date(outcome.evaluatedAt)} · {outcome.limitations.join(' ')}
                </p>
                {evidence(outcome.evidencePaths)}
              </>
            )}
            <div className="og-monitor-summary">
              <div>
                <span>下一次观察</span>
                <strong>
                  {task.status === 'paused'
                    ? '已暂停'
                    : task.monitor.enabled
                      ? date(task.monitor.nextRunAt)
                      : '尚未开启'}
                </strong>
                <small>每天 {task.monitor.timeOfDay} · 北京时间</small>
              </div>
              <div>
                <span>实施后记录</span>
                <strong>{followups.length} 次</strong>
                <small>
                  {followups.filter((run) => run.mode === 'live').length}{' '}
                  次真实搜索 ·{' '}
                  {followups.filter((run) => run.mode === 'replay').length}{' '}
                  次回放
                </small>
              </div>
              <div>
                <span>固定题单</span>
                <strong>{questions.length} 题</strong>
                <small>单次搜索预留 ¥{money(queryCost)}</small>
              </div>
            </div>
            <div className="og-task-primary-action">
              <button
                className="og-button primary"
                disabled={working}
                onClick={onMonitor}
              >
                <Settings2 size={16} />
                设置观察计划
              </button>
              <button
                className="og-button secondary"
                disabled={working || !followups.length}
                onClick={() => onAct('reflect', {}, '已完成本次效果复盘')}
              >
                {spinner('reflect')}复盘结果并更新策略
              </button>
              {['monitoring', 'paused'].includes(task.status) && (
                <button
                  className="og-text-button"
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
                    <Play size={14} />
                  ) : (
                    <Pause size={14} />
                  )}
                  {task.status === 'paused' ? '恢复观察' : '暂停观察'}
                </button>
              )}
            </div>
            <div className="og-task-secondary-actions">
              <button
                className="og-text-button"
                disabled={working}
                onClick={() =>
                  onAct('run_monitor', { mode: 'replay' }, '已安排历史回放')
                }
              >
                <RefreshCw size={14} />
                回放一次
              </button>
              {data.settings.liveSearchConfigured &&
                task.implementation?.kind === 'user_confirmed' && (
                  <button
                    className="og-text-button"
                    disabled={working}
                    onClick={onLive}
                  >
                    运行一次真实搜索
                    <ArrowRight size={14} />
                  </button>
                )}
              {task.implementation?.kind === 'rehearsal' && (
                <button
                  className="og-text-button"
                  disabled={working}
                  onClick={() => onImplementation('user_confirmed')}
                >
                  记录实际实施
                </button>
              )}
            </div>
            {learnedStrategies.length > 0 && (
              <div className="og-workflow-notice passed">
                <strong>已形成 {learnedStrategies.length} 条策略经验</strong>
                {learnedStrategies.map((strategy) => (
                  <p key={strategy.id}>{strategy.recommendation}</p>
                ))}
                <p>
                  后续条件匹配的任务会参考这些经验，并再次通过实际结果验证。
                </p>
              </div>
            )}
            <details className="og-task-details">
              <summary>
                实施后观察记录 · {followups.length} 次<ChevronDown size={15} />
              </summary>
              {followups.length ? (
                <div className="og-run-list">
                  {followups.slice().reverse().map(runDetails)}
                </div>
              ) : (
                <p className="og-muted">尚无实施后的观测记录。</p>
              )}
            </details>
            <p className="og-task-footnote">
              {data.settings.schedulerRunning
                ? '自动观察需要本地服务保持运行。'
                : '调度器尚未运行。'}
              {task.monitor.mode === 'live'
                ? `搜索预算 ¥${money(task.monitor.budgetLimit)}，已用 ¥${money(task.monitor.spent)}。`
                : '历史回放免费，不纳入真实效果判断。'}
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
                <time>{date(event.at)}</time>
                <div>
                  <strong>{event.title}</strong>
                  <p>{event.detail}</p>
                </div>
              </article>
            ))}
        </div>
      </details>
    </>
  );
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import Markdown from 'markdown-to-jsx';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  FileText,
  Loader2,
} from 'lucide-react';
import type { GeoRun, GeoState, GeoTask } from '@/lib/geo/types';
import type { ResearchObservation } from '@/lib/geo/research-types';
import type { QualityLoop } from '@/lib/geo/workflow-types';
import GeoSelect from './GeoSelect';
import QualityEvolution from './QualityEvolution';
import { buildQualityEvolution } from './quality-evolution-data';
import { taskPresentation } from './task-presentation';
import TaskTrackingPanel from './TaskTrackingPanel';
import { CurrentWorkflowReview, WorkflowReviewHistory } from './WorkflowReview';
import { displayTaskTitle } from './question-labels';
import './workflow-review.css';

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
  detailView?: 'task' | 'monitor';
};

const stages = ['搜索结果', '发现的问题', '方案审核', '实施登记', '效果跟踪'];
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
const money = (value: number) => value.toFixed(3).replace(/0$/, '');
const researchEntryLabel = (observation: ResearchObservation) => {
  const engine = {
    chatgpt: 'ChatGPT',
    google: 'Google',
    deepseek: 'DeepSeek',
    qwen: '通义千问',
    doubao: '豆包',
  }[observation.engine];
  const entry = observation.entryType
    ? {
        web_answer: '网页回答',
        web_search: '网页搜索',
        api_answer: 'API 联网回答',
        api_search: 'API 搜索',
      }[observation.entryType]
    : observation.engine === 'chatgpt'
      ? '网页回答'
      : observation.engine === 'google'
        ? '网页搜索'
        : '';
  return `${engine}${entry ? ` ${entry}` : ''}`;
};

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
  detailView = 'task',
}: Props) {
  const workflow = task.workflow;
  const savedResearch = workflow?.savedResearch;
  const presentation = taskPresentation(task, data.assets, data.project);
  const evolution = useMemo(() => buildQualityEvolution(task), [task]);
  const retained = evolution.frames.find(
    (frame) => frame.id === evolution.retainedFrameId,
  );
  const firstScore = evolution.frames.find(
    (frame) => frame.score !== null,
  )?.score;
  const provider =
    workflow?.collection?.provider ?? task.collectionProvider ?? 'deepseek';
  const providerStatus = data.settings.collectionProviders?.find(
    (item) => item.id === provider,
  );
  const providerLabel =
    workflow?.collection?.label ?? providerStatus?.label ?? 'DeepSeek 搜索';
  const answerCollection = provider !== 'deepseek';
  const providerConfigured =
    providerStatus?.configured ??
    (provider === 'deepseek' && data.settings.liveSearchConfigured);
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
  const [stage, setStage] = useState(detailView === 'monitor' ? 4 : current);
  const [mode, setMode] = useState<'live' | 'replay'>(
    answerCollection ? 'live' : 'replay',
  );
  const [budget, setBudget] = useState(1);
  const [selectedMaxQualityRounds, setSelectedMaxQualityRounds] = useState(3);
  const maxQualityRounds = workflow
    ? (workflow.maxQualityRounds ?? 3)
    : selectedMaxQualityRounds;
  const [consent, setConsent] = useState(false);
  const [after, setAfter] = useState(task.proposal?.after ?? '');
  const [editing, setEditing] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [copyState, setCopyState] = useState('');
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(after);
      setCopyState('已复制改稿');
    } catch {
      setCopyState('复制未成功，请选中文字复制');
    }
  };
  useEffect(() => {
    setStage(detailView === 'monitor' ? 4 : current);
  }, [task.id, current, detailView]);
  useEffect(() => {
    setAfter(task.proposal?.after ?? '');
    setEditing(false);
    setCopyState('');
  }, [task.id, task.proposal?.after]);
  useEffect(() => {
    setProcessOpen(false);
  }, [task.id]);
  useEffect(() => {
    setMode(answerCollection ? 'live' : 'replay');
    setConsent(false);
    setSelectedMaxQualityRounds(3);
  }, [task.id, answerCollection]);
  const researchContext = task.researchContext;
  const researchBatch = data.latestResearch;
  const researchQuestion =
    researchContext?.snapshot?.question ??
    (researchContext &&
    researchBatch?.id === researchContext.batchId &&
    researchBatch.projectId === data.project.id
      ? [...researchBatch.questions, ...researchBatch.deferredQuestions].find(
          (question) => question.id === researchContext.questionId,
        )
      : undefined);
  const researchSnapshot = researchContext?.snapshot;
  const headerResearch =
    savedResearch ??
    (busy === 'plan_from_saved' && researchContext && researchSnapshot
      ? researchSnapshot.observations
          .filter(
            (observation) =>
              observation.engine === researchContext.engine &&
              observation.language === researchContext.language &&
              observation.query ===
                researchSnapshot.question[researchContext.language] &&
              (!researchContext.sourceUrl ||
                observation.sources.some(
                  (source) => source.url === researchContext.sourceUrl,
                )),
          )
          .at(-1)
      : undefined);
  const gapInvestigation = researchContext?.purpose === 'investigate_gap';
  const taskStages = savedResearch
    ? ['历史回答', ...stages.slice(1)]
    : gapInvestigation && !workflow
      ? ['材料核查', ...stages.slice(1)]
      : stages;
  const researchSearchEligible = researchQuestion?.decision === 'search_now';
  const selectedQuestions = researchContext
    ? researchQuestion
      ? [
          {
            id: `research-${researchContext.batchId}-${researchContext.questionId}-${researchContext.language}`,
            query: researchQuestion[researchContext.language],
          },
        ]
      : []
    : data.questionPlan.candidates.filter(
        (q) => q.selected && q.review.decision !== 'exclude',
      );
  const questions = workflow?.questions ?? selectedQuestions;
  const queryCost = questions.length * (answerCollection ? 0.1 : 0.005);
  const ready = researchContext
    ? selectedQuestions.length === 1 && researchSearchEligible
    : data.questionPlan.status === 'ready' && selectedQuestions.length > 0;
  const researchQuestionLabel = researchContext
    ? `${researchQuestion?.[researchContext.language] || '原研究问题'} · ${researchContext.language === 'zh' ? '中文' : '英文'}`
    : '';
  const configured = providerConfigured && data.settings.modelConfigured;
  const working = !!busy || task.status === 'investigating';
  const workingStageLabel =
    busy === 'plan_from_saved' ? '分析历史回答并生成方案' : taskStages[current];
  const baseline = workflow?.baseline;
  const hasCompleteLiveBaseline =
    baseline?.mode === 'live' && baseline.status === 'completed';
  const canPlanFromSaved =
    !task.implementation &&
    !!researchSnapshot &&
    (researchContext?.purpose ?? 'improve_answer') === 'improve_answer' &&
    researchSearchEligible &&
    ['queued', 'failed', 'proposal_ready'].includes(task.status);
  const canRestartSavedPlan = !!savedResearch && canPlanFromSaved;
  const planFromSaved = () =>
    onAct(
      'plan_from_saved',
      { maxQualityRounds: 2 },
      '已开始使用保存的回答诊断并审核方案',
    );
  const canStartSearch =
    !task.implementation &&
    ['queued', 'failed', 'proposal_ready'].includes(task.status) &&
    !hasCompleteLiveBaseline &&
    (!researchContext || researchSearchEligible);
  const startQueryCost =
    selectedQuestions.length * (answerCollection ? 0.1 : 0.005);
  const requiredSearchBudget = task.monitor.spent + startQueryCost;
  const diagnosis = workflow?.diagnosis;
  const quality = workflow?.quality;
  const proposal = task.proposal;
  const dirty = !!proposal && after !== proposal.after;
  const reviewContextChanged = Boolean(
    task.reviewContextUpdatedAt &&
    (!retained?.review.reviewedAt ||
      !(
        Date.parse(retained.review.reviewedAt) >=
        Date.parse(task.reviewContextUpdatedAt)
      )),
  );
  const reviewNeedsGeoAcceptance =
    !!savedResearch &&
    (retained?.review.geoAcceptanceRequired !== true ||
      !retained.review.geoAcceptance);
  const requiresReview = reviewContextChanged || reviewNeedsGeoAcceptance;
  const passed =
    !!retained?.review.passed &&
    retained.review.source === 'model' &&
    retained.score !== null &&
    (baseline?.mode === 'live' || !!savedResearch) &&
    !requiresReview;
  const usedStrategies = (data.strategies ?? []).filter((strategy) =>
    workflow?.appliedStrategyIds.includes(strategy.id),
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
          {run.mode === 'live'
            ? answerCollection
              ? '联网回答'
              : '真实搜索'
            : '历史预览'}{' '}
          ·{' '}
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
          原始测量：{date(run.measurementAt)} ·{' '}
          {run.costEstimated ? '预算预留' : '搜索费用'} ¥{money(run.cost)}
          {run.costEstimated && '（实际费用以服务商账单为准）'}
        </p>
        {run.error && <p className="og-task-error">{run.error}</p>}
        {run.questions
          .filter((question) => question.answer)
          .map((question) => {
            const answer = question.answer!;
            return (
              <details key={question.id} className="og-task-details">
                <summary>
                  {question.query}
                  <ChevronDown size={14} />
                </summary>
                <p className="og-muted">
                  {answer.searchPerformed
                    ? '已执行联网搜索'
                    : '未确认执行联网搜索'}{' '}
                  ·{' '}
                  {question.aiCited === true
                    ? '回答引用了目标内容'
                    : question.aiCited === false
                      ? '回答未引用目标内容'
                      : '引用情况未确认'}
                </p>
                <div className="og-markdown" style={{ whiteSpace: 'pre-wrap' }}>
                  {answer.text}
                </div>
                <h4>回答中的引用 · {answer.citations.length}</h4>
                {answer.citations.length ? (
                  <ul>
                    {answer.citations.map((citation, index) => (
                      <li key={`${citation.url}-${index}`}>
                        {/^https?:\/\//i.test(citation.url) ? (
                          <a
                            href={citation.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {citation.title || citation.url}
                          </a>
                        ) : (
                          citation.title || citation.url
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="og-muted">本次未返回回答引用。</p>
                )}
                <h4>搜索参考来源 · {answer.sources.length}</h4>
                <p className="og-muted">
                  搜索参考来源不等于回答引用，列表顺序也不是搜索排名。
                </p>
                {answer.sources.length ? (
                  <ul>
                    {answer.sources.map((source, index) => (
                      <li key={`${source.url}-${index}`}>
                        {/^https?:\/\//i.test(source.url) ? (
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title || source.url}
                          </a>
                        ) : (
                          source.title || source.url
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="og-muted">本次未单独返回搜索参考来源。</p>
                )}
              </details>
            );
          })}
        {evidence(run.questions.map((q) => q.evidencePath))}
      </div>
    </details>
  );

  return (
    <div className="og-workflow-workspace">
      <section className="og-current-task">
        <div className="og-task-title-row">
          <div>
            <h2>{displayTaskTitle(task, data, presentation.title)}</h2>
            <p className="og-task-object">
              {data.project.name} ·{' '}
              {headerResearch
                ? researchEntryLabel(headerResearch)
                : providerLabel}
            </p>
          </div>
          <span className={`og-tag ${working ? 'blue' : 'neutral'}`}>
            {working
              ? '正在处理'
              : workflow
                ? taskStages[current]
                : gapInvestigation
                  ? '待核查材料'
                  : canPlanFromSaved
                    ? '等待生成方案'
                    : '等待选择搜索方式'}
          </span>
        </div>
        <dl className="og-task-summary-table">
          <div>
            <dt>问题</dt>
            <dd>
              {researchQuestion && researchContext
                ? researchQuestion[researchContext.language]
                : questions[0]?.query || task.goal || task.title}
            </dd>
          </div>
          <div>
            <dt>目标材料</dt>
            <dd>
              {/^https?:\/\//i.test(presentation.targetUrl) ? (
                <a
                  href={presentation.targetUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {researchSnapshot?.targetAsset?.title ||
                    presentation.targetTitle}
                  <ArrowRight size={12} />
                </a>
              ) : (
                researchSnapshot?.targetAsset?.title || presentation.targetTitle
              )}
            </dd>
          </div>
          <div>
            <dt>当前动作</dt>
            <dd>
              {working
                ? `正在${workingStageLabel}`
                : task.implementation
                  ? '查看实施登记与效果跟踪'
                  : task.status === 'awaiting_implementation'
                    ? '完成修改后登记实施'
                    : dirty || requiresReview
                      ? '保存改稿并重新审核'
                      : passed
                        ? '确认改稿，进入实施'
                        : quality
                          ? '处理审核意见'
                          : gapInvestigation
                            ? task.researchGapReview
                              ? '查看核查结果，选择采集方式'
                              : '核对已有材料'
                            : savedResearch
                              ? '查看历史回答与诊断'
                              : baseline
                                ? '查看搜索结果与诊断'
                                : canPlanFromSaved
                                  ? '使用保存的回答生成方案，或重新采集'
                                  : '选择采集方式'}
            </dd>
          </div>
        </dl>
        <nav className="og-stage-tabs og-workflow-tabs" aria-label="任务阶段">
          {taskStages.map((label, index) => (
            <button
              key={label}
              disabled={index > current && index !== 4}
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
            (canRestartSavedPlan ||
              canStartSearch ||
              hasCompleteLiveBaseline) && (
              <button
                className="og-button secondary"
                disabled={working}
                onClick={() => {
                  if (canRestartSavedPlan) void planFromSaved();
                  else if (canStartSearch) {
                    setStage(0);
                    setMode('live');
                    setConsent(false);
                  } else
                    void onAct('investigate', {}, '已重新开始诊断与方案审核');
                }}
              >
                {canRestartSavedPlan
                  ? '用保存的回答重试诊断与审核'
                  : canStartSearch
                    ? '重新选择搜索方式'
                    : '重试诊断与审核'}
              </button>
            )}
        </div>
      )}
      {requiresReview && task.proposal && !task.implementation && (
        <p className="og-workflow-notice">
          {reviewNeedsGeoAcceptance
            ? '当前稿尚未核对实施与效果验收要求，需完整复检。'
            : '依据已更新，需重新复检。'}
        </p>
      )}
      {working && (
        <div className="og-task-working" role="status">
          <Loader2 size={18} className="spin" />
          正在{workingStageLabel}，完成后自动更新。
        </div>
      )}
      <section
        className={`og-surface og-task-stage og-workflow-stage og-workflow-step-${stage}`}
      >
        {stage === 0 && (
          <>
            <details className="og-task-details og-task-context-note">
              <summary>
                任务范围 · {questions.length} 题<ChevronDown size={14} />
              </summary>
              <p className="og-muted">
                {gapInvestigation && !researchSearchEligible
                  ? '原题保留为先补依据。本任务记录核查材料与待验证项；通过后续审题后，再建立搜索与改稿任务。'
                  : savedResearch
                    ? '本方案使用已保存的原题、历史回答及材料。原始观测时间和条件保留。'
                    : workflow
                      ? `已固定 ${questions.length} 道问题，后续观察沿用这份题单。`
                      : researchContext && ready
                        ? `本次使用已审研究题 ${researchQuestionLabel}，共 1 题。开始后固定原题，再根据搜索结果诊断并审核方案。`
                        : `当前题单已选 ${questions.length} 道问题。开始后会固定题单，再根据搜索结果诊断并审核方案。`}
              </p>
            </details>
            {researchContext && researchSnapshot && (
              <details className="og-task-details og-task-source-details">
                <summary>
                  价值、能力与来源依据
                  <ChevronDown size={15} />
                </summary>
                <dl className="og-task-summary-table og-task-context-table">
                  <div>
                    <dt>值得争取</dt>
                    <dd>{researchSnapshot.question.valueReason}</dd>
                  </div>
                  <div>
                    <dt>目前能回答</dt>
                    <dd>{researchSnapshot.question.answerability}</dd>
                  </div>
                  {researchContext.gap && (
                    <div>
                      <dt>本次缺口</dt>
                      <dd>{researchContext.gap}</dd>
                    </div>
                  )}
                </dl>
                {researchContext.sourceUrl && (
                  <p>
                    <strong>对照来源：</strong>
                    <a
                      href={researchContext.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {researchSnapshot.observations
                        .flatMap((item) => item.sources)
                        .find((item) => item.url === researchContext.sourceUrl)
                        ?.title || researchContext.sourceUrl}
                    </a>
                  </p>
                )}
                <p className="og-muted">
                  保存于 {date(researchSnapshot.capturedAt)}
                  。原研究观测供核查参考，不是本任务的新基线。
                </p>
                {researchSnapshot.observations.map((observation, index) => (
                  <div key={`${observation.evidencePath}:${index}`}>
                    <p>{observation.summary}</p>
                    <p className="og-muted">
                      {researchEntryLabel(observation)} ·{' '}
                      {observation.recordedAt}
                    </p>
                    <details>
                      <summary>原始条件</summary>
                      <p>{observation.conditions}</p>
                    </details>
                    {evidence([
                      observation.evidencePath,
                      observation.answerPath ?? '',
                    ])}
                  </div>
                ))}
                {!researchSnapshot.observations.length && (
                  <p className="og-muted">
                    这道原题尚未搜索，未测不能当作没有结果。
                  </p>
                )}
                {evidence([
                  researchSnapshot.reviewPath,
                  researchSnapshot.sourceAuditPath,
                  researchSnapshot.reportPath,
                ])}
              </details>
            )}
            {gapInvestigation && (
              <div className="og-gap-check">
                <div className="og-gap-check-row">
                  {task.researchGapReview && (
                    <p>
                      <strong>材料检查已保存</strong>
                      <time>{date(task.researchGapReview.createdAt)}</time>
                    </p>
                  )}
                  <button
                    className="og-button secondary"
                    disabled={working}
                    onClick={() =>
                      void onAct(
                        'review_research_gap',
                        {},
                        '已有材料核对结果已保存',
                      )
                    }
                  >
                    {task.researchGapReview ? '重新核查材料' : '核对已有材料'} ·
                    免费
                    <ArrowRight size={16} />
                  </button>
                </div>
                {task.researchGapReview && (
                  <details className="og-gap-check-results">
                    <summary>
                      查看核查结果
                      <ChevronDown size={14} />
                    </summary>
                    <p>{task.researchGapReview.summary}</p>
                    <p>{task.researchGapReview.recommendedAction}</p>
                    {task.researchGapReview.findings.map((finding) => (
                      <div key={finding.id}>
                        <p style={{ whiteSpace: 'pre-wrap' }}>
                          {finding.observation}
                        </p>
                        <p className="og-muted">{finding.uncertainty}</p>
                      </div>
                    ))}
                    {task.researchGapReview.limitations.length > 0 && (
                      <ul>
                        {task.researchGapReview.limitations.map(
                          (limitation, index) => (
                            <li key={index}>{limitation}</li>
                          ),
                        )}
                      </ul>
                    )}
                    <p className="og-muted">
                      本地材料检查不代表缺口已补齐，也不批准改稿或实施。
                    </p>
                    {evidence(
                      task.researchGapReview.findings.flatMap(
                        (item) => item.evidencePaths,
                      ),
                    )}
                  </details>
                )}
              </div>
            )}
            {canPlanFromSaved && ['queued', 'failed'].includes(task.status) && (
              <div className="og-task-primary-action">
                <button
                  className="og-button primary"
                  disabled={working || !data.settings.modelConfigured}
                  onClick={() => void planFromSaved()}
                >
                  用已保存回答生成方案
                  {spinner('plan_from_saved')}
                </button>
                <p className="og-muted">
                  使用保存的原题、回答和材料，不重新搜索。最多审核 2
                  轮，按已配置模型计费。
                  {!data.settings.modelConfigured && (
                    <>
                      请先配置分析模型。
                      <a className="og-text-link" href="/research">
                        查看模型设置
                      </a>
                    </>
                  )}
                </p>
              </div>
            )}
            {(!gapInvestigation || researchSearchEligible) && (
              <p className="og-muted">
                {savedResearch ? '重新采集入口' : '采集入口'}：{providerLabel}。
                {answerCollection
                  ? '观察 API 联网回答中的目标引用，不代表对应 App 的回答。'
                  : '观察网页搜索结果中的目标内容。'}
              </p>
            )}
            {canStartSearch && !ready && (
              <div className="og-workflow-notice">
                <p>
                  {researchContext
                    ? '关联研究题已更新或不可用，请返回关键问题重新选择。'
                    : '先确认要测的问题，再开始这条任务。'}
                </p>
                <button
                  className="og-button primary"
                  disabled={working}
                  onClick={onQuestions}
                >
                  {researchContext ? '查看关键问题' : '审阅并确认题单'}
                  <ArrowRight size={16} />
                </button>
              </div>
            )}
            {canStartSearch && ready && (
              <>
                {workflow && !savedResearch && (
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
                  {researchContext
                    ? `查看已审研究题 · ${researchQuestionLabel}`
                    : `查看已确认题单 · 版本 ${data.questionPlan.revision}`}
                </button>
                <div className="og-radio-cards og-workflow-modes">
                  <button
                    disabled={working || answerCollection}
                    className={mode === 'replay' ? 'selected' : ''}
                    onClick={() => {
                      setMode('replay');
                      setConsent(false);
                    }}
                  >
                    <span className="og-radio-dot" />
                    <div>
                      <strong>
                        历史预览 <span className="og-tag neutral">免费</span>
                      </strong>
                      <p>
                        {answerCollection
                          ? '该入口暂不支持历史预览'
                          : '已有记录 · 不作为实施依据'}
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
                      <strong>
                        {answerCollection ? '采集联网回答' : '真实搜索'}
                      </strong>
                      <p>
                        {configured
                          ? `${selectedQuestions.length} 题 · ${answerCollection ? '预算' : '搜索费'} ¥${money(startQueryCost)} · 模型费用另计`
                          : `需要${[!providerConfigured && (providerStatus?.missing.join('、') || `${providerLabel}配置`), !data.settings.modelConfigured && '诊断模型配置'].filter(Boolean).join('、')}后启用。`}
                      </p>
                    </div>
                  </button>
                </div>
                <details className="og-workflow-mode-notes">
                  <summary>采集说明</summary>
                  <p>
                    历史预览只匹配已有记录，可能覆盖部分题目。用于预览诊断与审核流程，不能作为通过审核的实施方案。
                  </p>
                  <p>
                    真实采集通过 {providerLabel}{' '}
                    搜索，随后调用模型诊断、修改和复检。该入口不支持历史预览时，需配置后采集真实回答。
                  </p>
                </details>
                {!configured && (
                  <p className="og-muted">
                    {answerCollection
                      ? '可先准备任务和题单。'
                      : '可先免费预览。'}
                    真实任务需要该入口的密钥和诊断模型配置。
                    <a className="og-text-link" href="/research">
                      查看模型设置
                    </a>
                  </p>
                )}
                {!workflow && (
                  <div className="og-round-setting">
                    <span className="og-field-label">最多审核</span>
                    <GeoSelect
                      label="最多审核"
                      value={String(selectedMaxQualityRounds)}
                      disabled={working}
                      onChange={(value) =>
                        setSelectedMaxQualityRounds(Number(value))
                      }
                      options={[1, 2, 3].map((rounds) => ({
                        value: String(rounds),
                        label: `${rounds} 轮`,
                      }))}
                    />
                    <p className="og-muted">达标或无进步时停止</p>
                  </div>
                )}
                {mode === 'live' && (
                  <div className="og-workflow-consent">
                    <label className="og-field-label" htmlFor="baseline-budget">
                      {answerCollection
                        ? '任务累计预算预留（元）'
                        : '任务搜索累计预算上限（元）'}
                    </label>
                    <input
                      id="baseline-budget"
                      className="og-input"
                      type="number"
                      min={requiredSearchBudget}
                      step={answerCollection ? '0.1' : '0.005'}
                      value={budget}
                      onChange={(event) =>
                        setBudget(Number(event.target.value))
                      }
                    />
                    <p className="og-muted">
                      {answerCollection
                        ? '每题暂按 ¥0.10 预留以控制调用次数；搜索和回答模型的实际费用以服务商账单为准，不是硬性费用上限。'
                        : '每题成功请求 ¥0.005。'}
                      模型诊断与最多 {maxQualityRounds}
                      轮方案修改、审核另按已配置模型计费，不计入本项预留。
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
                      <span>我确认本次付费采集及后续模型诊断、方案审核。</span>
                    </label>
                  </div>
                )}
                <div className="og-task-primary-action">
                  <button
                    className="og-button primary"
                    disabled={
                      working ||
                      (answerCollection && mode === 'replay') ||
                      (mode === 'live' &&
                        (!configured ||
                          !consent ||
                          !Number.isFinite(budget) ||
                          budget < requiredSearchBudget))
                    }
                    onClick={() =>
                      onAct(
                        'start_workflow',
                        {
                          mode,
                          budgetLimit: mode === 'live' ? budget : 0,
                          maxQualityRounds,
                        },
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
                    {savedResearch
                      ? '已保存的历史回答'
                      : baseline?.mode === 'live'
                        ? '真实观测基线'
                        : baseline
                          ? '历史记录预览'
                          : '等待采集结果'}
                  </span>
                  <span>
                    {researchContext
                      ? `研究题 ${researchQuestionLabel}`
                      : `题单版本 ${workflow.questionPlanRevision}`}{' '}
                    · {date(workflow.frozenAt)} · 最多审核 {maxQualityRounds} 轮
                  </span>
                </div>
                {savedResearch && (
                  <div className="og-run-detail">
                    <p>{savedResearch.query}</p>
                    <p className="og-muted">
                      {researchEntryLabel(savedResearch)} ·{' '}
                      {savedResearch.language === 'zh' ? '中文' : '英文'} ·
                      原始观测：
                      {savedResearch.recordedAt}
                    </p>
                    <p className="og-muted">
                      原始条件：{savedResearch.conditions}
                    </p>
                    {evidence([
                      savedResearch.evidencePath,
                      savedResearch.answerPath ?? '',
                    ])}
                  </div>
                )}
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
            <h2>诊断结果</h2>
            {diagnosis ? (
              <>
                <p className="og-task-lead">{diagnosis.summary}</p>
                <p className="og-muted">
                  {diagnosis.source === 'model'
                    ? savedResearch
                      ? '基于保存的历史回答的模型诊断'
                      : '基于本次证据的模型诊断'
                    : '本地材料预览'}{' '}
                  · {date(diagnosis.createdAt)}
                </p>
                <div className="og-task-findings">
                  {diagnosis.findings.map((finding) => (
                    <article key={finding.id}>
                      <h3>{finding.observation}</h3>
                      <details className="og-task-finding-detail">
                        <summary>原因、边界与证据</summary>
                        <p>{finding.hypothesis}</p>
                        <p className="og-muted">{finding.uncertainty}</p>
                        {evidence(finding.evidencePaths)}
                      </details>
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
          <div className="og-review-workspace">
            <div className="og-review-heading">
              <h2>方案与审核</h2>
              <span
                className={`og-review-status ${passed && !dirty ? 'is-passed' : ''}`}
              >
                {dirty
                  ? '修改后待复检'
                  : task.implementation?.kind === 'user_confirmed'
                    ? '已登记实施'
                    : task.implementation?.kind === 'rehearsal'
                      ? '实施演练'
                      : passed
                        ? '审核通过 · 未实施'
                        : working
                          ? '正在审核'
                          : '尚未通过'}
              </span>
            </div>
            {savedResearch && (
              <p className="og-muted">
                方案依据：已保存的历史回答 · {researchEntryLabel(savedResearch)}{' '}
                · {savedResearch.recordedAt}
              </p>
            )}
            <details className="og-review-disclosure og-review-context-disclosure">
              <summary>
                任务来由与本次改动
                <ChevronDown size={14} />
              </summary>
              <dl className="og-review-origin">
                <div>
                  <dt>任务来由</dt>
                  <dd>
                    {presentation.observation ||
                      diagnosis?.summary ||
                      '尚无完整的真实观测。'}
                  </dd>
                </div>
                <div>
                  <dt>本次改动</dt>
                  <dd>{presentation.changeSummary}</dd>
                </div>
              </dl>
            </details>
            <div className="og-review-next">
              <p>
                {task.implementation
                  ? task.implementation.kind === 'rehearsal'
                    ? '已完成演练；实际实施后登记页面链接。'
                    : '已登记实施，可查看后续观测。'
                  : dirty
                    ? '当前改稿有未保存修改，需要重新审核。'
                    : requiresReview
                      ? '当前稿需重新审核后再确认。'
                      : passed
                        ? '确认当前稿后进入实施登记。'
                        : quality
                          ? stopLabels[quality.stopReason] +
                            '。请先处理审核意见。'
                          : savedResearch
                            ? '先完成历史回答分析和改稿检查。'
                            : '先完成搜索、分析和改稿检查。'}
              </p>
              {task.canContinueRevision && (
                <div className="og-workflow-notice">
                  <button
                    className="og-button primary"
                    disabled={working || dirty}
                    onClick={() =>
                      onAct(
                        'continue_revision',
                        {
                          maxAdditionalRounds: 2,
                          proposalRevision: workflow?.proposalRevision,
                        },
                        '已从当前稿和审核意见继续修改，将复用现有搜索与诊断',
                      )
                    }
                  >
                    继续完善这份改稿{spinner('continue_revision')}
                  </button>
                  <p>
                    最多续改 2
                    轮，每轮完整复检；达标、无进步或轮次用完即停止。按已配置模型计费。
                  </p>
                  {dirty && (
                    <p className="og-muted">
                      有未保存的手动修改，请先保存并复检，或
                      <button
                        className="og-text-button"
                        disabled={working}
                        onClick={() => {
                          setAfter(proposal?.after ?? '');
                          setEditing(false);
                        }}
                      >
                        取消未保存修改
                      </button>
                      后再继续自动改。
                    </p>
                  )}
                </div>
              )}
              {!task.implementation &&
                task.status !== 'awaiting_implementation' &&
                proposal && (
                  <div className="og-task-primary-action">
                    {dirty || requiresReview ? (
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
                              requiresReview
                                ? '已提交当前稿完整复检'
                                : '改稿已提交，将重新审核',
                            )
                          }
                        >
                          {reviewNeedsGeoAcceptance
                            ? '补充完整审核'
                            : reviewContextChanged
                              ? '按新依据完整复检'
                              : '保存并重新审核'}
                          {spinner('review_plan')}
                        </button>
                        <span className="og-muted">
                          保存后会重新检查，按已配置模型计费。
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
                              '已确认改稿，请按下一步提示更新原页面',
                            )
                          }
                        >
                          确认改稿，进入实施{spinner('accept_plan')}
                        </button>
                        <span className="og-muted">
                          只确认这份改稿，不会自动发布，也不会调用模型。
                        </span>
                      </>
                    ) : !task.canContinueRevision ? (
                      <>
                        <button
                          className="og-button secondary"
                          disabled={
                            working ||
                            (!canRestartSavedPlan &&
                              !canStartSearch &&
                              !hasCompleteLiveBaseline)
                          }
                          onClick={() => {
                            if (canRestartSavedPlan) void planFromSaved();
                            else if (canStartSearch) {
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
                          {canRestartSavedPlan
                            ? '用保存的回答重新诊断与审核'
                            : canStartSearch
                              ? '补充真实搜索，再审核'
                              : '重新诊断与审核'}
                          {spinner(
                            canRestartSavedPlan
                              ? 'plan_from_saved'
                              : 'investigate',
                          )}
                        </button>
                        <span className="og-muted">
                          {canRestartSavedPlan
                            ? '复用保存的回答和材料，重新生成方案并审核，最多 2 轮。'
                            : canStartSearch
                              ? '先取得完整的真实基线，再判断方案是否值得实施。'
                              : '通过审核后才能进入实施，已有真实基线会继续用于诊断。'}
                        </span>
                      </>
                    ) : null}
                  </div>
                )}
              {(task.implementation ||
                task.status === 'awaiting_implementation') && (
                <button
                  className="og-button primary"
                  onClick={() => setStage(3)}
                >
                  查看实施登记
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
            <div className="og-review-working-grid">
              <div>
                {proposal ? (
                  <section
                    id={`proposal-draft-${task.id}`}
                    className="og-review-draft"
                    aria-label="正文修改对照"
                  >
                    <header>
                      <h3>
                        当前稿 <span>v{workflow?.proposalRevision ?? 1}</span>
                      </h3>
                      <div>
                        <button
                          type="button"
                          className="og-text-button"
                          onClick={copyDraft}
                        >
                          复制改稿
                        </button>
                        {!task.implementation &&
                          task.status !== 'awaiting_implementation' && (
                            <button
                              type="button"
                              className="og-text-button"
                              disabled={working}
                              onClick={() => setEditing(!editing)}
                            >
                              {editing ? '预览改稿' : '自己调整'}
                            </button>
                          )}
                      </div>
                    </header>
                    <div className="og-body-comparison">
                      <section>
                        <h4>原文</h4>
                        <div className="og-markdown">
                          <Markdown options={{ disableParsingRawHTML: true }}>
                            {proposal.before}
                          </Markdown>
                        </div>
                      </section>
                      <section>
                        <h4>
                          {task.implementation?.kind === 'user_confirmed'
                            ? '登记实施的改稿'
                            : '当前改稿'}
                        </h4>
                        {editing ? (
                          <textarea
                            aria-label="编辑建议内容"
                            value={after}
                            disabled={working}
                            onChange={(event) => {
                              setAfter(event.target.value);
                              setCopyState('');
                            }}
                          />
                        ) : (
                          <div className="og-markdown">
                            <Markdown options={{ disableParsingRawHTML: true }}>
                              {after}
                            </Markdown>
                          </div>
                        )}
                      </section>
                    </div>
                    <details className="og-review-disclosure og-review-draft-changes">
                      <summary>
                        具体改动 · {proposal.changes.length} 项
                        <ChevronDown size={14} />
                      </summary>
                      <ol>
                        {proposal.changes.map((change, index) => (
                          <li key={index}>{change}</li>
                        ))}
                      </ol>
                    </details>
                    {copyState && (
                      <p className="og-muted" role="status">
                        {copyState}
                      </p>
                    )}
                  </section>
                ) : (
                  <p className="og-task-lead">
                    {savedResearch
                      ? '完成历史回答分析后，这里会出现可供你确认的改稿。'
                      : '完成搜索和分析后，这里会出现可供你确认的改稿。'}
                  </p>
                )}
              </div>
              <CurrentWorkflowReview
                frame={retained}
                quality={quality}
                dirty={dirty}
                passed={passed}
              />
            </div>
            <details className="og-review-disclosure og-review-rationale">
              <summary>
                原始需求、方案依据与验证方法
                <ChevronDown size={15} />
              </summary>
              <h4>原始任务要求</h4>
              <p>
                {researchQuestion && researchContext
                  ? researchQuestion[researchContext.language]
                  : task.goal || task.title}
              </p>
              {researchContext?.gap && <p>本次缺口：{researchContext.gap}</p>}
              {proposal && (
                <>
                  <h4>为什么这样改</h4>
                  <p>{proposal.rationale}</p>
                  <h4>实施后如何验证</h4>
                  <ul>
                    {proposal.successCriteria.map((criterion, index) => (
                      <li key={index}>{criterion}</li>
                    ))}
                  </ul>
                  {!!proposal.limitations.length && (
                    <>
                      <h4>适用边界</h4>
                      <ul>
                        {proposal.limitations.map((limitation, index) => (
                          <li key={index}>{limitation}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  {evidence(proposal.evidencePaths)}
                </>
              )}
              {task.canContinueRevision && (
                <button
                  className="og-text-button"
                  disabled={working || dirty}
                  onClick={() =>
                    savedResearch
                      ? void planFromSaved()
                      : void onAct('investigate', {}, '重新分析与检查已开始')
                  }
                >
                  重新分析这条任务
                </button>
              )}
            </details>
            <WorkflowReviewHistory
              task={task}
              evolution={evolution}
              onEvidence={onEvidence}
            />
            <details
              className="og-review-process"
              open={processOpen}
              onToggle={(event) => setProcessOpen(event.currentTarget.open)}
            >
              <summary>
                <div>
                  <strong>回看改稿过程</strong>
                  <span>
                    {evolution.frames.length
                      ? `${evolution.frames.length} 次检查`
                      : '等待检查记录'}
                    {!evolution.hasMixedCriteria &&
                    firstScore != null &&
                    retained?.score != null
                      ? ` · ${firstScore} → ${retained.score} 分`
                      : ''}
                  </span>
                </div>
                <ChevronDown size={16} />
              </summary>
              {processOpen && (
                <QualityEvolution
                  key={task.id}
                  task={task}
                  approved={passed}
                  dirty={dirty}
                />
              )}
            </details>
          </div>
        )}
        {stage === 3 && (
          <>
            <h2>
              {task.implementation?.kind === 'rehearsal'
                ? '已记录流程演练'
                : task.implementation
                  ? '已登记实际实施'
                  : '实施后登记页面链接'}
            </h2>
            <p className="og-task-lead">
              {task.implementation?.note ||
                '将已确认改稿更新到原页面，实施后登记链接并安排复查。'}
            </p>
            {!task.implementation && proposal && (
              <ol className="og-publish-steps">
                <li>
                  <strong>打开要修改的页面</strong>
                  <a href={proposal.targetUrl} target="_blank" rel="noreferrer">
                    {presentation.targetTitle}
                    <ArrowRight size={13} />
                  </a>
                </li>
                <li>
                  <strong>替换原文并发布</strong>
                  <span>在你管理内容的编辑器里完成修改。</span>
                  <button className="og-text-button" onClick={copyDraft}>
                    复制已确认的改稿
                  </button>
                  {copyState && <small role="status">{copyState}</small>}
                </li>
                <li>
                  <strong>回来记录发布结果</strong>
                  <span>填写改了什么和页面链接，然后设置后续检查。</span>
                </li>
              </ol>
            )}
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
                    {task.implementation.kind === 'rehearsal'
                      ? '查看目标页面'
                      : '查看实施页面'}
                    <ArrowRight size={14} />
                  </a>
                )}
                <div className="og-task-primary-action">
                  <button
                    className="og-button primary"
                    onClick={() => setStage(4)}
                  >
                    查看跟踪结果
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
                  我已发布，记录页面链接
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
      {stage !== 4 && (
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
      )}
    </div>
  );
}

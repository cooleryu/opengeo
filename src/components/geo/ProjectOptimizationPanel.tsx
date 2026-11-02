'use client';

import {
  Check,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import type { GeoState, GeoTask } from '@/lib/geo/types';
import { getProjectOptimizationProgress } from './project-optimization-progress';
import './project-optimization.css';

type Optimization = NonNullable<GeoTask['projectOptimization']>;
type Action = Optimization['actions'][number];
type Props = {
  task: GeoTask;
  busy: string;
  onAct: (
    action: string,
    payload?: Record<string, unknown>,
    message?: string,
  ) => Promise<GeoState | null>;
  onEvidence: (path: string) => void;
};

export const projectOptimizationTitle = (task: GeoTask) =>
  `项目优化 · ${task.projectOptimization?.mode === 'deep' ? '深度优化' : '重点优化'}`;

export function projectOptimizationStatus(optimization: Optimization) {
  return getProjectOptimizationProgress(optimization).label;
}

const recordedAt = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const engineName = (engine: string) =>
  ({
    chatgpt: 'ChatGPT',
    google: 'Google',
    deepseek: 'DeepSeek',
    qwen: '千问',
    doubao: '豆包',
  })[engine] || engine;

function QuestionLinks({
  optimization,
  questionIds,
}: {
  optimization: Optimization;
  questionIds: string[];
}) {
  return (
    <ul className="og-project-question-links">
      {questionIds.map((id) => {
        const question = optimization.snapshot.questions.find(
          (item) => item.id === id,
        );
        if (!question) return <li key={id}>问题记录待核实</li>;
        const params = new URLSearchParams({
          view: 'question-plan',
          project: optimization.snapshot.project.id,
          batch: optimization.batchId,
          question: id,
          language: 'zh',
          engine: 'all',
        });
        return (
          <li key={id}>
            <a href={`?${params}`} target="_blank" rel="noreferrer">
              {question.zh || question.en}
              <ChevronRight size={13} aria-hidden="true" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function ActionCard({
  action,
  optimization,
  onEvidence,
}: {
  action: Action;
  optimization: Optimization;
  onEvidence: Props['onEvidence'];
}) {
  const review = optimization.review?.actions.find(
    (item) => item.actionId === action.id,
  );
  const assets = optimization.snapshot.assets.filter((item) =>
    action.assetIds.includes(item.id),
  );
  const reviewLabel =
    action.status === 'blocked'
      ? '待完善'
      : review
        ? review.passed
          ? '审核通过'
          : '待完善'
        : optimization.phase === 'reviewing'
          ? '审核中'
          : '待审核';
  return (
    <article className="og-project-action">
      <header>
        <h3>{action.title}</h3>
        <span
          className={`og-tag ${review?.passed && action.status === 'ready' ? 'blue' : 'neutral'}`}
        >
          {reviewLabel}
        </span>
      </header>
      <QuestionLinks
        optimization={optimization}
        questionIds={action.questionIds}
      />
      <p className="og-project-action-target">
        {assets.length
          ? assets.map((asset) => asset.title).join(' · ')
          : '修改位置待明确'}
      </p>
      <div className="og-project-action-change">{action.change}</div>
      <details className="og-project-details">
        <summary>
          依据与验证 <span>{action.evidence.length} 条引用</span>
        </summary>
        <dl className="og-project-reasoning">
          <div>
            <dt>已有观测</dt>
            <dd>{action.observed}</dd>
          </div>
          {action.hypothesis && (
            <div>
              <dt>待验证的解释</dt>
              <dd>{action.hypothesis}</dd>
            </div>
          )}
          <div>
            <dt>改进依据</dt>
            <dd>{action.rationale}</dd>
          </div>
          <div>
            <dt>如何验证</dt>
            <dd>{action.verification}</dd>
          </div>
        </dl>
        {action.evidence.map((citation, index) => {
          const evidence = optimization.snapshot.evidence.find(
            (item) => item.id === citation.evidenceId,
          );
          return (
            <figure
              className="og-project-citation"
              key={`${citation.evidenceId}-${index}`}
            >
              <blockquote>{citation.quote}</blockquote>
              {evidence ? (
                <figcaption>
                  <span>
                    {engineName(evidence.engine)} ·{' '}
                    {evidence.language === 'zh' ? '中文' : '英文'} ·{' '}
                    {recordedAt(evidence.recordedAt)}
                  </span>
                  <span>{evidence.conditions}</span>
                  {evidence.boundary && <span>{evidence.boundary}</span>}
                  {evidence.evidencePath && (
                    <button onClick={() => onEvidence(evidence.evidencePath)}>
                      <FileText size={13} />
                      查看保存的回答
                    </button>
                  )}
                </figcaption>
              ) : (
                <figcaption>引用记录待核实</figcaption>
              )}
            </figure>
          );
        })}
        {action.limitations.length > 0 && (
          <ul className="og-project-notes">
            {action.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
        )}
      </details>
      {review && (
        <details
          className="og-project-details"
          open={optimization.phase === 'blocked' && !review.passed}
        >
          <summary>
            独立审核 <span>{reviewLabel}</span>
          </summary>
          <div className="og-project-review-scores">
            {(
              [
                ['证据', review.scores.evidence],
                ['需求相关', review.scores.relevance],
                ['可实施', review.scores.actionability],
                ['可验证', review.scores.verifiability],
              ] as const
            ).map(([label, score]) => (
              <span key={label}>
                {label}
                <strong>{score}/100</strong>
              </span>
            ))}
          </div>
          <p className="og-project-review-gates">
            原始目标：
            {review.preservesGoal === 'pass'
              ? '保留'
              : review.preservesGoal === 'fail'
                ? '未通过'
                : '待核实'}
            <span>
              证据支撑：
              {review.evidenceGrounded === 'pass'
                ? '通过'
                : review.evidenceGrounded === 'fail'
                  ? '未通过'
                  : '待核实'}
            </span>
          </p>
          {review.issues.length > 0 && (
            <ul className="og-project-notes">
              {review.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
        </details>
      )}
    </article>
  );
}

export default function ProjectOptimizationPanel({
  task,
  busy,
  onAct,
  onEvidence,
}: Props) {
  const optimization = task.projectOptimization;
  if (!optimization) return null;
  const phase = optimization.phase;
  const progress = getProjectOptimizationProgress(optimization);
  const canRetry = phase === 'failed' || phase === 'blocked';
  const canClose = canRetry || phase === 'awaiting_review';
  const limitations = Array.from(
    new Set([
      ...optimization.snapshot.limitations,
      ...optimization.limitations,
    ]),
  );
  const sortedActions = [...optimization.actions].sort(
    (left, right) => left.priority - right.priority,
  );
  const needsWork = (action: Action) =>
    action.status === 'blocked' ||
    optimization.review?.actions.find((review) => review.actionId === action.id)
      ?.passed === false;
  const actionGroups = [
    {
      title: '建议行动',
      actions: sortedActions.filter((action) => !needsWork(action)),
    },
    {
      title: '待补齐的行动',
      actions: sortedActions.filter(needsWork),
    },
  ].filter((group) => group.actions.length > 0);
  return (
    <div className="og-project-optimization">
      <header className="og-project-plan-heading">
        <div>
          <h1>{projectOptimizationTitle(task)}</h1>
          <p>基于已保存的回答与内容 · {optimization.questionCount} 个问题</p>
        </div>
        <span
          className={`og-tag ${progress.ready ? 'blue' : 'neutral'}`}
          role="status"
        >
          {progress.running && <Loader2 size={13} className="animate-spin" />}
          {progress.label}
          {progress.roundLabel && ` · ${progress.roundLabel}`}
        </span>
      </header>
      {phase !== 'closed' && (
        <ol className="og-project-plan-stages" aria-label="项目优化阶段">
          {[progress.firstStageLabel, '独立审核', '人工审阅'].map(
            (label, index) => (
              <li
                key={label}
                className={
                  progress.stage === index
                    ? 'current'
                    : index < progress.stage
                      ? 'done'
                      : ''
                }
                aria-current={progress.stage === index ? 'step' : undefined}
              >
                <span>
                  {index < progress.stage ? <Check size={13} /> : index + 1}
                </span>
                {label}
              </li>
            ),
          )}
        </ol>
      )}
      <section
        className="og-project-plan-summary"
        aria-labelledby="project-plan-summary"
      >
        <h2 id="project-plan-summary">项目优化方案</h2>
        <p className="og-project-plan-state" role="status">
          {progress.message}
        </p>
        {optimization.summary && <p>{optimization.summary}</p>}
        <p className="og-project-plan-boundary">
          方案尚未实施或验证效果。本次不发起新搜索；缺失或未完成的采集不计为零值，方案仅覆盖已保存的依据。
        </p>
        <details
          className="og-project-details"
          open={phase === 'blocked' && !optimization.review}
        >
          <summary>
            本次范围与限制 <span>{recordedAt(optimization.frozenAt)} 保存</span>
          </summary>
          <QuestionLinks
            optimization={optimization}
            questionIds={optimization.questionIds}
          />
          {limitations.length > 0 && (
            <ul className="og-project-notes">
              {limitations.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          )}
        </details>
        {!!optimization.review?.issues.length && (
          <details className="og-project-details" open={phase === 'blocked'}>
            <summary>方案审核意见</summary>
            <ul className="og-project-notes">
              {optimization.review.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
      {phase === 'failed' && (
        <div className="og-project-plan-error" role="alert">
          <div>
            <strong>本次任务未完成</strong>
            <p>
              {task.error ||
                '生成或审核过程未能完成，可使用本次保存的范围重试。'}
            </p>
          </div>
        </div>
      )}
      {actionGroups.map((group) => (
        <section className="og-project-action-group" key={group.title}>
          <h2>
            {group.title}
            <span>{group.actions.length}</span>
          </h2>
          <div className="og-project-action-list">
            {group.actions.map((action) => (
              <ActionCard
                key={action.id}
                action={action}
                optimization={optimization}
                onEvidence={onEvidence}
              />
            ))}
          </div>
        </section>
      ))}
      {!!optimization.history?.length && (
        <details className="og-project-plan-history">
          <summary>
            方案与审核记录 <span>{optimization.history.length} 轮</span>
          </summary>
          {optimization.history.map((round) => (
            <details
              className="og-project-details"
              key={`${round.attempt}:${round.round}:${round.candidateSavedAt}`}
            >
              <summary>
                第 {round.attempt} 次尝试 · 第 {round.round} 轮 ·{' '}
                {round.review
                  ? round.review.passed
                    ? '审核通过'
                    : '审核未通过'
                  : '审核未完成'}
                <span>{recordedAt(round.candidateSavedAt)}</span>
              </summary>
              <p className="og-project-history-summary">{round.summary}</p>
              {!!round.review?.issues.length && (
                <ul className="og-project-notes">
                  {round.review.issues.map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
              {!!round.limitations.length && (
                <ul className="og-project-notes">
                  {round.limitations.map((limitation, index) => (
                    <li key={index}>{limitation}</li>
                  ))}
                </ul>
              )}
              <div className="og-project-action-list">
                {round.actions.map((action) => (
                  <ActionCard
                    key={action.id}
                    action={action}
                    optimization={{
                      ...optimization,
                      phase: round.review
                        ? round.review.passed
                          ? 'awaiting_review'
                          : 'blocked'
                        : 'planning',
                      actions: round.actions,
                      review: round.review,
                    }}
                    onEvidence={onEvidence}
                  />
                ))}
              </div>
            </details>
          ))}
        </details>
      )}
      {canClose && (
        <footer className="og-project-plan-controls">
          <p>
            {canRetry && '重新分析会沿用本轮保存的材料。'}
            结束本轮会保留记录，不会实施方案。
          </p>
          <div>
            {canRetry && (
              <button
                className="og-button secondary"
                disabled={!!busy}
                onClick={() =>
                  onAct(
                    'retry_project_optimization',
                    { taskId: task.id },
                    '已使用本轮保存的材料重新分析',
                  )
                }
              >
                <RotateCcw size={14} />
                重新分析
              </button>
            )}
            <button
              className="og-button secondary"
              disabled={!!busy}
              onClick={() =>
                onAct(
                  'close_project_optimization',
                  { taskId: task.id },
                  '已结束本轮，记录已保留；未实施方案',
                )
              }
            >
              结束本轮
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

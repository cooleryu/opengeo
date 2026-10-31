'use client';

import Markdown from 'markdown-to-jsx';
import { ChevronDown, FileText } from 'lucide-react';
import type { GeoTask } from '@/lib/geo/types';
import type { QualityLoop } from '@/lib/geo/workflow-types';
import type {
  QualityEvolutionData,
  QualityEvolutionFrame,
} from './quality-evolution-data';

const dimensions = [
  ['evidence', '证据支撑'],
  ['relevance', '需求匹配'],
  ['actionability', '可以实施'],
  ['verifiability', '可以验证'],
] as const;
const dimensionNames: Record<string, string> = Object.fromEntries(dimensions);
const stopLabels: Record<QualityLoop['stopReason'], string> = {
  target_reached: '达到审核目标',
  no_progress: '没有进一步改善，停止续改',
  round_limit: '本轮次数已用完',
  needs_configuration: '等待模型配置',
  needs_evidence: '证据不足',
};
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function ReviewDimensions({ frame }: { frame: QualityEvolutionFrame }) {
  return (
    <table className="og-review-dimensions">
      <thead>
        <tr>
          <th>审核项</th>
          <th>得分</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        {dimensions.map(([key, name]) => {
          const blocked = frame.review.issues.some(
            (issue) => issue.dimension === key && issue.severity === 'blocking',
          );
          const score = frame.score === null ? null : frame.review.scores[key];
          const shortfall =
            score !== null && score < frame.minimumDimensionScore;
          return (
            <tr
              key={key}
              className={blocked || shortfall ? 'needs-attention' : ''}
            >
              <th scope="row">{name}</th>
              <td>{score ?? '—'}</td>
              <td>
                {blocked
                  ? '有阻塞项'
                  : score === null
                    ? '未评分'
                    : shortfall
                      ? '未达门槛'
                      : '分数达标'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ReviewIssues({
  frame,
  severity,
}: {
  frame: QualityEvolutionFrame;
  severity?: 'blocking' | 'improvement';
}) {
  const issues = frame.review.issues
    .filter((issue) => !severity || issue.severity === severity)
    .sort(
      (a, b) =>
        Number(b.severity === 'blocking') - Number(a.severity === 'blocking'),
    );
  if (!issues.length)
    return (
      <p className="og-review-small">
        {frame.score === null
          ? '尚无模型审核意见。'
          : '本次审核未记录阻塞或改进意见。'}
      </p>
    );
  return (
    <ol className="og-review-issues">
      {issues.map((issue, index) => (
        <li
          key={`${issue.dimension}-${index}`}
          className={issue.severity === 'blocking' ? 'blocking' : ''}
        >
          <div>
            <strong>
              {issue.severity === 'blocking' ? '阻塞' : '改进建议'}
            </strong>
            <span>{dimensionNames[issue.dimension] || issue.dimension}</span>
          </div>
          <p>{issue.detail}</p>
          {issue.suggestion && (
            <details className="og-review-issue-suggestion">
              <summary>修改建议</summary>
              <p className="og-review-suggestion">{issue.suggestion}</p>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

export function CurrentWorkflowReview({
  frame,
  quality,
  dirty,
  passed,
}: {
  frame?: QualityEvolutionFrame;
  quality?: QualityLoop;
  dirty: boolean;
  passed: boolean;
}) {
  return (
    <aside className="og-independent-review" aria-label="当前方案的独立审核">
      <header>
        <h3>独立审核</h3>
        <span className={passed && !dirty ? 'is-passed' : ''}>
          {dirty
            ? '待复检'
            : passed
              ? '已通过'
              : frame?.review.passed
                ? '历史审核达标'
                : frame?.score !== null && frame
                  ? '未通过'
                  : '未完成'}
        </span>
      </header>
      {frame ? (
        <>
          <div className="og-review-score-line">
            <span>综合分</span>
            <strong>
              {frame.score ?? '—'}
              <small> / 100</small>
            </strong>
            <span>目标 {frame.targetScore}</span>
          </div>
          <ReviewDimensions frame={frame} />
          {dirty && (
            <p className="og-review-stale">
              以下记录对应保存前的稿件，修改后需重新审核。
            </p>
          )}
          {frame.review.issues.some(
            (issue) => issue.severity === 'blocking',
          ) && <ReviewIssues frame={frame} severity="blocking" />}
          {frame.review.issues.some(
            (issue) => issue.severity === 'improvement',
          ) && (
            <details className="og-review-disclosure">
              <summary>
                改进建议 ·{' '}
                {
                  frame.review.issues.filter(
                    (issue) => issue.severity === 'improvement',
                  ).length
                }
                <ChevronDown size={14} />
              </summary>
              <ReviewIssues frame={frame} severity="improvement" />
            </details>
          )}
          <details className="og-review-disclosure">
            <summary>
              完整审核结论
              <ChevronDown size={14} />
            </summary>
            <p>{frame.review.summary}</p>
            <p className="og-review-small">
              各项至少 {frame.minimumDimensionScore}{' '}
              分，且无阻塞项。综合分不能抵消关键项失败。
              审核通过仅代表方案达标；实施效果见跟踪记录。
            </p>
            <p className="og-review-small">
              {frame.review.source === 'model' ? '模型审核' : '本地结构核对'} ·{' '}
              {date(frame.review.reviewedAt)}
            </p>
            <p className="og-review-small">
              审核规则：{frame.review.criteriaVersion}
            </p>
          </details>
        </>
      ) : (
        <p className="og-review-empty">当前稿尚无匹配的审核记录。</p>
      )}
      {quality && (
        <div className="og-review-stop">
          <strong>{stopLabels[quality.stopReason]}</strong>
          <span>
            {quality.rounds.length} / {quality.maxRounds} 轮 · 保留第{' '}
            {quality.bestRound || '—'} 轮
          </span>
        </div>
      )}
    </aside>
  );
}

export function WorkflowReviewHistory({
  task,
  evolution,
  onEvidence,
}: {
  task: GeoTask;
  evolution: QualityEvolutionData;
  onEvidence: (path: string) => void;
}) {
  const workflow = task.workflow;
  const loops = [
    ...(workflow?.qualityHistory ?? []),
    ...(workflow?.quality
      ? [
          {
            proposalRevision: workflow.proposalRevision,
            quality: workflow.quality,
          },
        ]
      : []),
  ];
  return (
    <section className="og-review-history" aria-label="逐轮审核记录">
      <header>
        <h3>审核记录</h3>
        <span>{evolution.frames.length} 次独立记录</span>
      </header>
      {!evolution.frames.length && (
        <p className="og-review-empty">尚无审核记录。</p>
      )}
      {evolution.frames
        .slice()
        .reverse()
        .map((frame) => (
          <details key={frame.id} className="og-review-record">
            <summary>
              <span>
                v{frame.proposalRevision} · 第 {frame.round} 轮
                {frame.isRetained && <small>当前稿</small>}
              </span>
              <time>{date(frame.review.reviewedAt)}</time>
              <strong>
                {frame.score === null ? '未评分' : `${frame.score} 分`}
              </strong>
              <span
                className={
                  frame.review.passed && frame.score !== null ? 'is-passed' : ''
                }
              >
                {frame.score === null
                  ? '结构核对'
                  : frame.review.passed
                    ? '该轮通过'
                    : '未通过'}
              </span>
              <ChevronDown size={15} />
            </summary>
            <div className="og-review-record-body">
              <details className="og-review-disclosure">
                <summary>
                  完整审核结论
                  <ChevronDown size={14} />
                </summary>
                <p>{frame.review.summary}</p>
              </details>
              {frame.proposalRevisions.length > 1 && (
                <p className="og-review-small">
                  这次审核也被 v{frame.proposalRevisions.slice(1).join('、v')}{' '}
                  用作续改起点。
                </p>
              )}
              <div className="og-review-record-columns">
                <ReviewDimensions frame={frame} />
                <ReviewIssues frame={frame} />
              </div>
              <details className="og-review-disclosure">
                <summary>
                  查看该轮完整方案
                  <ChevronDown size={14} />
                </summary>
                <h4>{frame.candidate.title}</h4>
                <p>{frame.candidate.rationale}</p>
                <div className="og-review-historic-draft og-markdown">
                  <Markdown options={{ disableParsingRawHTML: true }}>
                    {frame.candidate.after}
                  </Markdown>
                </div>
                <h4>具体改动</h4>
                <ol>
                  {frame.candidate.changes.map((change, index) => (
                    <li key={index}>{change}</li>
                  ))}
                </ol>
                <h4>验证方法</h4>
                <ul>
                  {frame.candidate.successCriteria.map((criterion, index) => (
                    <li key={index}>{criterion}</li>
                  ))}
                </ul>
                {!!frame.candidate.limitations.length && (
                  <>
                    <h4>适用边界</h4>
                    <ul>
                      {frame.candidate.limitations.map((limitation, index) => (
                        <li key={index}>{limitation}</li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="og-evidence-links">
                  {[
                    ...new Set(frame.candidate.evidencePaths.filter(Boolean)),
                  ].map((path) => (
                    <button key={path} onClick={() => onEvidence(path)}>
                      <FileText size={13} />
                      {path.split('/').slice(-2).join('/')}
                    </button>
                  ))}
                </div>
                <p className="og-review-small">
                  审核规则：{frame.review.criteriaVersion} · 单项门槛{' '}
                  {frame.minimumDimensionScore} · 综合目标 {frame.targetScore}
                </p>
              </details>
            </div>
          </details>
        ))}
      {!!loops.length && (
        <details className="og-review-disclosure og-review-loop-history">
          <summary>
            版本与停止记录
            <ChevronDown size={14} />
          </summary>
          {loops
            .slice()
            .reverse()
            .map(({ proposalRevision, quality }, index) => (
              <div key={`${proposalRevision}-${index}`}>
                <strong>v{proposalRevision}</strong>
                <span>
                  {quality.rounds.length} / {quality.maxRounds} 轮
                </span>
                <span>{stopLabels[quality.stopReason]}</span>
              </div>
            ))}
        </details>
      )}
    </section>
  );
}

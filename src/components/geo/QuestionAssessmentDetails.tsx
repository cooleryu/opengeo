import type { QuestionCandidate } from '@/lib/geo/question-types';
import type { GeoAsset } from '@/lib/geo/types';
import './question-assessment.css';

export function hasQuestionAssessment(candidate: QuestionCandidate) {
  return (
    candidate.review.source === 'model' &&
    candidate.review.status === 'reviewed' &&
    !!candidate.review.assessment
  );
}

const worthLabels = {
  yes: '值得争取',
  uncertain: '尚不确定',
  no: '不值得争取',
};
const supportLabels = {
  supported: '现有内容或能力可以满足',
  partial: '可以部分满足',
  unverified: '尚未核实',
  missing: '已确认缺失',
};
const demandLabels = {
  'user-provided': '用户给定',
  'public-observation': '公开观测',
  inferred: '推导',
  unknown: '尚未核实',
};
const gapLabels = {
  content: '内容',
  evidence: '证据',
  capability: '能力',
  investigation: '调查',
};

export default function QuestionAssessmentDetails({
  candidate,
  assets,
}: {
  candidate: QuestionCandidate;
  assets: GeoAsset[];
}) {
  const assessment = hasQuestionAssessment(candidate)
    ? candidate.review.assessment
    : undefined;

  if (!assessment) {
    return (
      <p className="qa-assessment-note">
        尚未进行 AI 双判断；现有记录不代表已分别核查争取价值与当前承接情况。
      </p>
    );
  }

  return (
    <section className="qa-assessment" aria-label="AI 双判断结果">
      <h4>AI 双判断</h4>
      <dl>
        <div>
          <dt>是否值得争取</dt>
          <dd>
            <strong>{worthLabels[assessment.worthPursuing.verdict]}</strong>
            <p>{assessment.worthPursuing.reason}</p>
          </dd>
        </div>
        <div>
          <dt>目前能回答到哪里</dt>
          <dd>
            <strong>{supportLabels[assessment.currentSupport.level]}</strong>
            <p>{assessment.currentSupport.reason}</p>
          </dd>
        </div>
        <div>
          <dt>
            需求依据 · {demandLabels[assessment.worthPursuing.demandBasis]}
          </dt>
          <dd>{assessment.worthPursuing.basis}</dd>
        </div>
      </dl>
      {assessment.evidence.length > 0 && (
        <div className="qa-assessment-evidence">
          <h4>判断引用的原文</h4>
          {assessment.evidence.map((evidence, index) => (
            <figure key={`${evidence.assetId}-${index}`}>
              <blockquote>{evidence.quote}</blockquote>
              <figcaption>
                {assets.find((asset) => asset.id === evidence.assetId)?.title ??
                  evidence.assetId}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {assessment.gaps.length > 0 && (
        <div className="qa-assessment-gaps">
          <h4>当前缺口</h4>
          <ul>
            {assessment.gaps.map((gap, index) => (
              <li key={index}>
                {gapLabels[gap.kind]}：{gap.description}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

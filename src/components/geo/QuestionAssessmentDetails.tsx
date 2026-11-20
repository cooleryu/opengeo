'use client';

import type { QuestionCandidate } from '@/lib/geo/question-types';
import type { GeoAsset } from '@/lib/geo/types';
import { inferContentLang } from '@/lib/geo/i18n';
import { useUiLanguage } from './UiLanguageContext';
import './question-assessment.css';

export function hasQuestionAssessment(candidate: QuestionCandidate) {
  return (
    candidate.review.source === 'model' &&
    candidate.review.status === 'reviewed' &&
    !!candidate.review.assessment
  );
}

const worthLabels = {
  yes: { en: 'Worth pursuing', zh: '值得争取' },
  uncertain: { en: 'Uncertain', zh: '尚不确定' },
  no: { en: 'Not worth pursuing', zh: '不值得争取' },
};
const supportLabels = {
  supported: { en: 'Supported by current docs/features', zh: '现有内容或能力可以满足' },
  partial: { en: 'Partially supported', zh: '可以部分满足' },
  unverified: { en: 'Not verified yet', zh: '尚未核实' },
  missing: { en: 'Confirmed missing', zh: '已确认缺失' },
};
const demandLabels = {
  'user-provided': { en: 'User-provided', zh: '用户给定' },
  'public-observation': { en: 'Public observation', zh: '公开观测' },
  inferred: { en: 'Inferred', zh: '推导' },
  unknown: { en: 'Not verified', zh: '尚未核实' },
};
const gapLabels = {
  content: { en: 'Content', zh: '内容' },
  evidence: { en: 'Evidence', zh: '证据' },
  capability: { en: 'Capability', zh: '能力' },
  investigation: { en: 'Investigation', zh: '调查' },
};

export default function QuestionAssessmentDetails({
  candidate,
  assets,
}: {
  candidate: QuestionCandidate;
  assets: GeoAsset[];
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const langKey = isEn ? 'en' : 'zh';
  const assessment = hasQuestionAssessment(candidate)
    ? candidate.review.assessment
    : undefined;

  if (!assessment) {
    return (
      <p className="qa-assessment-note">
        {isEn
          ? 'No AI dual-assessment yet; existing records do not confirm separate value and coverage checks.'
          : '尚未进行 AI 双判断；现有记录不代表已分别核查争取价值与当前承接情况。'}
      </p>
    );
  }

  return (
    <section
      className="qa-assessment"
      aria-label={isEn ? 'AI dual assessment' : 'AI 双判断结果'}
    >
      <h4>{isEn ? 'AI dual assessment' : 'AI 双判断'}</h4>
      <dl>
        <div>
          <dt>{isEn ? 'Worth pursuing' : '是否值得争取'}</dt>
          <dd>
            <strong>{worthLabels[assessment.worthPursuing.verdict][langKey]}</strong>
            <p lang={inferContentLang(assessment.worthPursuing.reason)}>
              {assessment.worthPursuing.reason}
            </p>
          </dd>
        </div>
        <div>
          <dt>{isEn ? 'Current coverage' : '目前能回答到哪里'}</dt>
          <dd>
            <strong>{supportLabels[assessment.currentSupport.level][langKey]}</strong>
            <p lang={inferContentLang(assessment.currentSupport.reason)}>
              {assessment.currentSupport.reason}
            </p>
          </dd>
        </div>
        <div>
          <dt>
            {isEn ? 'Demand basis · ' : '需求依据 · '}
            {demandLabels[assessment.worthPursuing.demandBasis][langKey]}
          </dt>
          <dd lang={inferContentLang(assessment.worthPursuing.basis)}>
            {assessment.worthPursuing.basis}
          </dd>
        </div>
      </dl>
      {assessment.evidence.length > 0 && (
        <div className="qa-assessment-evidence">
          <h4>{isEn ? 'Cited excerpts' : '判断引用的原文'}</h4>
          {assessment.evidence.map((evidence, index) => (
            <figure key={`${evidence.assetId}-${index}`}>
              <blockquote lang={inferContentLang(evidence.quote)}>
                {evidence.quote}
              </blockquote>
              <figcaption data-i18n-skip="">
                {assets.find((asset) => asset.id === evidence.assetId)?.title ??
                  evidence.assetId}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {assessment.gaps.length > 0 && (
        <div className="qa-assessment-gaps">
          <h4>{isEn ? 'Open gaps' : '当前缺口'}</h4>
          <ul>
            {assessment.gaps.map((gap, index) => (
              <li key={index}>
                {gapLabels[gap.kind][langKey]}
                {isEn ? ': ' : '：'}
                <span lang={inferContentLang(gap.description)}>
                  {gap.description}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

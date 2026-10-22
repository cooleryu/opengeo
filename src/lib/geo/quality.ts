import { createHash } from 'node:crypto';
import type { GeoProposal } from './types';
import type { QualityLoop, QualityReview } from './workflow-types';

export const QUALITY_CRITERIA_VERSION = 'opengeo-evidence-review-v1';
export const QUALITY_TARGET = 80;
export const QUALITY_MINIMUM = 70;
export type QualityIssue = QualityReview['issues'][number];
export type ReviewAssessment = Pick<QualityReview, 'scores' | 'issues' | 'summary'>;

/** Approval binds the exact editable proposal, including its evidence and measurement plan. */
export function proposalDigest(proposal: GeoProposal): string {
  return createHash('sha256').update(JSON.stringify({
    id: proposal.id, title: proposal.title, rationale: proposal.rationale,
    targetAssetId: proposal.targetAssetId, targetUrl: proposal.targetUrl,
    before: proposal.before, after: proposal.after, changes: proposal.changes,
    evidencePaths: [...new Set(proposal.evidencePaths)].sort(),
    successCriteria: proposal.successCriteria, limitations: proposal.limitations,
  })).digest('hex');
}

export function buildQualityReview(
  proposal: GeoProposal,
  assessment: ReviewAssessment | null,
  structuralIssues: QualityIssue[] = [],
): QualityReview {
  const scores = assessment ? { evidence: assessment.scores.evidence, relevance: assessment.scores.relevance,
    actionability: assessment.scores.actionability, verifiability: assessment.scores.verifiability }
    : { evidence: 0, relevance: 0, actionability: 0, verifiability: 0 };
  const values = Object.values(scores);
  const validScores = values.length === 4 && values.every(value => Number.isFinite(value) && value >= 0 && value <= 100);
  const issues = [...(assessment?.issues ?? []), ...structuralIssues];
  if (!validScores) issues.push({ dimension: 'evidence', severity: 'blocking', detail: '审核分数格式无效。', suggestion: '重新完成四个维度的审核。' });
  const total = validScores ? Math.round(values.reduce((sum, value) => sum + value, 0) / 4 * 10) / 10 : 0;
  return {
    criteriaVersion: QUALITY_CRITERIA_VERSION, proposalDigest: proposalDigest(proposal),
    reviewedAt: new Date().toISOString(), source: assessment ? 'model' : 'local', scores,
    total, passed: Boolean(assessment && validScores && values.every(value => value >= QUALITY_MINIMUM)
      && total >= QUALITY_TARGET && !issues.some(issue => issue.severity === 'blocking')),
    issues, summary: assessment?.summary ?? '仅完成本地结构核对，尚未进行模型质量审核；零分表示未评分。',
  };
}

/** Independent reviews receive the whole candidate. Only the revision callback sees prior criticisms. */
export async function runQualityLoop(
  initial: GeoProposal,
  reviewCandidate: (candidate: GeoProposal) => Promise<QualityReview>,
  reviseCandidate: (candidate: GeoProposal, review: QualityReview) => Promise<GeoProposal>,
): Promise<QualityLoop> {
  const loop: QualityLoop = { maxRounds: 3, targetScore: QUALITY_TARGET, minimumDimensionScore: QUALITY_MINIMUM,
    stopReason: 'round_limit', rounds: [], bestRound: 0 };
  let candidate = structuredClone(initial);
  for (let round = 1; round <= loop.maxRounds; round++) {
    const returned = await reviewCandidate(candidate);
    // Never accept an upstream/self-reported passed flag or total.
    const review = buildQualityReview(candidate, returned.source === 'model' ? returned : null,
      returned.source === 'local' ? returned.issues : []);
    const previous = loop.rounds.at(-1)?.review;
    loop.rounds.push({ round, candidate: structuredClone(candidate), review });
    const best = loop.rounds.find(item => item.round === loop.bestRound);
    if (!best || (review.passed && !best.review.passed)
      || (review.passed === best.review.passed && review.total > best.review.total)) loop.bestRound = round;
    if (review.passed) { loop.stopReason = 'target_reached'; break; }
    if (previous) {
      const blockers = (value: QualityReview) => value.issues.filter(issue => issue.severity === 'blocking').length;
      if (!(review.total > previous.total || (blockers(review) < blockers(previous) && review.total >= previous.total))) {
        loop.stopReason = 'no_progress'; break;
      }
    }
    if (round < loop.maxRounds) {
      const revised = await reviseCandidate(candidate, review);
      if (proposalDigest(revised) === proposalDigest(candidate)) { loop.stopReason = 'no_progress'; break; }
      candidate = revised;
    }
  }
  return loop;
}

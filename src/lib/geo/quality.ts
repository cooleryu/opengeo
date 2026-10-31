import { createHash } from 'node:crypto';
import type { GeoProposal } from './types';
import type { QualityLoop, QualityReview } from './workflow-types';

export const QUALITY_CRITERIA_VERSION = 'opengeo-evidence-review-v1';
export const GEO_ACCEPTANCE_CRITERIA_VERSION = 'opengeo-evidence-review-v2-geo-goals';
export const QUALITY_TARGET = 80;
export const QUALITY_MINIMUM = 70;
export type QualityIssue = QualityReview['issues'][number];
export type ReviewAssessment = Pick<QualityReview, 'scores' | 'issues' | 'summary' | 'geoAcceptanceRequired' | 'geoAcceptance'>;

const geoAcceptanceLabels = {
  implementation: '内容实施验收与 GEO 效果分开',
  ownBrandMention: '自身品牌被正确提及',
  ownTargetCitation: '自有目标页面被实际引用',
  comparableConditions: '同题、同语言、同入口与可比采集条件',
  unknownBaseline: '缺少可比观测时待跟测，不承诺改善',
} as const;

/** The reviewer judges meaning; the program requires every judgment and its verbatim criterion. */
function geoAcceptanceIssues(proposal: GeoProposal, assessment: ReviewAssessment): QualityIssue[] {
  if (!assessment.geoAcceptanceRequired) return [];
  return Object.entries(geoAcceptanceLabels).flatMap(([key, label]) => {
    const check = assessment.geoAcceptance?.[key as keyof typeof geoAcceptanceLabels];
    if (check?.met === true && typeof check.criterionQuote === 'string' && check.criterionQuote.trim()
      && typeof check.reason === 'string' && check.reason.trim()
      && proposal.successCriteria.some(criterion => criterion.includes(check.criterionQuote))) return [];
    return [{ dimension: 'verifiability', severity: 'blocking' as const,
      detail: `GEO 验收未通过：${label}。${check?.reason || '独立审核未提供该项判断或方案原句。'}`,
      suggestion: `在 successCriteria 中明确“${label}”，再独立复审；方法覆盖率、答案完整度或改稿完成不能代替自身提及与自有引用。` }];
  });
}

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
  const combinedIssues = [...(assessment?.issues ?? []), ...structuralIssues, ...(assessment ? geoAcceptanceIssues(proposal, assessment) : [])];
  const issues = [...new Map(combinedIssues.map(issue => [JSON.stringify(issue), issue])).values()];
  if (!validScores) issues.push({ dimension: 'evidence', severity: 'blocking', detail: '审核分数格式无效。', suggestion: '重新完成四个维度的审核。' });
  const total = validScores ? Math.round(values.reduce((sum, value) => sum + value, 0) / 4 * 10) / 10 : 0;
  return {
    criteriaVersion: assessment?.geoAcceptanceRequired ? GEO_ACCEPTANCE_CRITERIA_VERSION : QUALITY_CRITERIA_VERSION, proposalDigest: proposalDigest(proposal),
    reviewedAt: new Date().toISOString(), source: assessment ? 'model' : 'local', scores,
    total, passed: Boolean(assessment && validScores && values.every(value => value >= QUALITY_MINIMUM)
      && total >= QUALITY_TARGET && !issues.some(issue => issue.severity === 'blocking')),
    issues, summary: assessment?.summary ?? '仅完成本地结构核对，尚未进行模型质量审核；零分表示未评分。',
    ...(assessment?.geoAcceptanceRequired ? { geoAcceptanceRequired: true,
      ...(assessment.geoAcceptance ? { geoAcceptance: structuredClone(assessment.geoAcceptance) } : {}) } : {}),
  };
}

/** Store every candidate, select the best, and apply the same stop rules to new and resumed work. */
function recordQualityRound(loop: QualityLoop, candidate: GeoProposal, review: QualityReview): boolean {
  const previous = loop.rounds.at(-1)?.review;
  const round = loop.rounds.length + 1;
  loop.rounds.push({ round, candidate: structuredClone(candidate), review: structuredClone(review) });
  const best = loop.rounds.find(item => item.round === loop.bestRound);
  if (!best || (review.passed && !best.review.passed)
    || (review.passed === best.review.passed && review.total > best.review.total)) loop.bestRound = round;
  if (review.passed) { loop.stopReason = 'target_reached'; return true; }
  if (previous) {
    const blockers = (value: QualityReview) => value.issues.filter(issue => issue.severity === 'blocking').length;
    if (!(review.total > previous.total || (blockers(review) < blockers(previous) && review.total >= previous.total))) {
      loop.stopReason = 'no_progress'; return true;
    }
  }
  return false;
}

/** Independent reviews receive the whole candidate. Only the revision callback sees prior criticisms. */
export async function runQualityLoop(
  initial: GeoProposal,
  reviewCandidate: (candidate: GeoProposal) => Promise<QualityReview>,
  reviseCandidate: (candidate: GeoProposal, review: QualityReview) => Promise<GeoProposal>,
  maxRounds = 3,
): Promise<QualityLoop> {
  const loop: QualityLoop = { maxRounds: Math.min(3, Math.max(1, Math.floor(maxRounds))), targetScore: QUALITY_TARGET, minimumDimensionScore: QUALITY_MINIMUM,
    stopReason: 'round_limit', rounds: [], bestRound: 0 };
  let candidate = structuredClone(initial);
  for (let round = 1; round <= loop.maxRounds; round++) {
    const returned = await reviewCandidate(candidate);
    // Never accept an upstream/self-reported passed flag or total.
    const review = buildQualityReview(candidate, returned.source === 'model' ? returned : null,
      returned.source === 'local' ? returned.issues : []);
    if (recordQualityRound(loop, candidate, review)) break;
    if (round < loop.maxRounds) {
      const revised = await reviseCandidate(candidate, review);
      if (proposalDigest(revised) === proposalDigest(candidate)) { loop.stopReason = 'no_progress'; break; }
      candidate = revised;
    }
  }
  return loop;
}

/** Continue from a matching model review: revise first, then independently review the whole new candidate. */
export async function continueQualityLoop(
  initial: GeoProposal,
  initialReview: QualityReview,
  reviewCandidate: (candidate: GeoProposal) => Promise<QualityReview>,
  reviseCandidate: (candidate: GeoProposal, review: QualityReview) => Promise<GeoProposal>,
  maxAdditionalRounds = 2,
): Promise<QualityLoop> {
  const criteriaVersion = initialReview.geoAcceptanceRequired ? GEO_ACCEPTANCE_CRITERIA_VERSION : QUALITY_CRITERIA_VERSION;
  if (initialReview.source !== 'model' || initialReview.criteriaVersion !== criteriaVersion
    || initialReview.proposalDigest !== proposalDigest(initial)) {
    throw new Error('当前稿没有匹配的有效模型审核，请先重新审核。');
  }
  const verified = buildQualityReview(initial, initialReview);
  if (initialReview.passed || verified.passed) throw new Error('当前稿已经通过审核，无需继续自动改稿。');
  if (initialReview.total !== verified.total) throw new Error('审核分数与记录不一致，请先重新审核。');
  const additionalRounds = Number.isFinite(maxAdditionalRounds) ? Math.min(2, Math.max(1, Math.floor(maxAdditionalRounds))) : 2;
  const loop: QualityLoop = { maxRounds: 1 + additionalRounds, targetScore: QUALITY_TARGET,
    minimumDimensionScore: QUALITY_MINIMUM, stopReason: 'round_limit', rounds: [], bestRound: 0 };
  let candidate = structuredClone(initial);
  let review = structuredClone(initialReview);
  recordQualityRound(loop, candidate, review);
  for (let round = 2; round <= loop.maxRounds; round++) {
    const revised = await reviseCandidate(candidate, review);
    if (proposalDigest(revised) === proposalDigest(candidate)) { loop.stopReason = 'no_progress'; break; }
    candidate = revised;
    const returned = await reviewCandidate(candidate);
    review = buildQualityReview(candidate, returned.source === 'model' ? returned : null,
      returned.source === 'local' ? returned.issues : []);
    if (recordQualityRound(loop, candidate, review)) break;
  }
  return loop;
}

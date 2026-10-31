import type { GeoProposal, GeoTask } from '../../lib/geo/types';
import type { QualityReview } from '../../lib/geo/workflow-types';

export type EvolutionField =
  | 'after'
  | 'title'
  | 'rationale'
  | 'changes'
  | 'evidencePaths'
  | 'successCriteria'
  | 'limitations';
export type EvolutionValue = string | string[];
export type EvolutionDimension = keyof QualityReview['scores'];

export interface EvolutionChange {
  field: EvolutionField;
  label: string;
  /** null means that no earlier plan was recorded; it does not mean an empty plan. */
  before: EvolutionValue | null;
  after: EvolutionValue;
  changed: boolean;
}

export interface EvolutionComparison {
  kind: 'original' | 'revision';
  bodyChanged: boolean;
  changes: EvolutionChange[];
}

export interface QualityEvolutionFrame {
  id: string;
  sequence: number;
  proposalRevision: number;
  proposalRevisions: number[];
  round: number;
  candidate: GeoProposal;
  review: QualityReview;
  targetScore: number;
  minimumDimensionScore: number;
  /** Local structure checks are unscored, never zero-point model assessments. */
  score: number | null;
  scoreDelta: number | null;
  dimensionDeltas: Record<EvolutionDimension, number> | null;
  criteriaChanged: boolean;
  isRetained: boolean;
  /** The actual revision source, which can be older than the latest discarded attempt. */
  previousFrameId: string | null;
  previousSequence: number | null;
  comparison: EvolutionComparison;
}

export interface QualityEvolutionData {
  frames: QualityEvolutionFrame[];
  retainedFrameId: string | null;
  latestFrameId: string | null;
  hasMixedCriteria: boolean;
}

const fields: { field: EvolutionField; label: string }[] = [
  { field: 'after', label: '正文' },
  { field: 'title', label: '方案标题' },
  { field: 'rationale', label: '改进依据' },
  { field: 'changes', label: '实施步骤' },
  { field: 'evidencePaths', label: '依据来源' },
  { field: 'successCriteria', label: '验收标准' },
  { field: 'limitations', label: '适用边界' },
];

/** Keep the same content boundaries as the server's approval digest, without importing crypto into the UI. */
function approvalContent(proposal: GeoProposal): string {
  return JSON.stringify({
    id: proposal.id,
    title: proposal.title,
    rationale: proposal.rationale,
    targetAssetId: proposal.targetAssetId,
    targetUrl: proposal.targetUrl,
    before: proposal.before,
    after: proposal.after,
    changes: proposal.changes,
    evidencePaths: [...new Set(proposal.evidencePaths)].sort(),
    successCriteria: proposal.successCriteria,
    limitations: proposal.limitations,
  });
}

function reviewIdentity(review: QualityReview): string {
  return JSON.stringify([
    review.criteriaVersion,
    review.proposalDigest,
    review.reviewedAt,
    review.source,
    review.passed,
  ]);
}

function scoredReview(review: QualityReview): boolean {
  return (
    review.source === 'model' &&
    [review.total, ...Object.values(review.scores)].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 100,
    )
  );
}

function delta(current: number, previous: number): number {
  return Math.round((current - previous) * 10) / 10;
}

export function compareQualityCandidates(
  previous: GeoProposal | null,
  candidate: GeoProposal,
): EvolutionComparison {
  // A changed target begins a new before/after comparison instead of comparing unrelated articles.
  const prior =
    previous?.targetAssetId === candidate.targetAssetId &&
    previous.targetUrl === candidate.targetUrl
      ? previous
      : null;
  const changes = fields.map(({ field, label }): EvolutionChange => {
    const before = prior
      ? prior[field]
      : field === 'after'
        ? candidate.before
        : null;
    const after = candidate[field];
    return {
      field,
      label,
      before,
      after,
      changed:
        before !== null && JSON.stringify(before) !== JSON.stringify(after),
    };
  });
  return {
    kind: prior ? 'revision' : 'original',
    bodyChanged: changes[0].changed,
    changes,
  };
}

/** The current workflow is one measurement protocol; older workflowHistory runs must not be mixed into it. */
export function buildQualityEvolution(task: GeoTask): QualityEvolutionData {
  const workflow = task.workflow;
  if (!workflow)
    return {
      frames: [],
      retainedFrameId: null,
      latestFrameId: null,
      hasMixedCriteria: false,
    };

  const loops = [
    ...(workflow.qualityHistory ?? []),
    ...(workflow.quality
      ? [
          {
            proposalRevision: workflow.proposalRevision,
            quality: workflow.quality,
          },
        ]
      : []),
  ];
  type RecordEntry = {
    id: string;
    order: number;
    proposalRevision: number;
    proposalRevisions: number[];
    round: number;
    candidate: GeoProposal;
    review: QualityReview;
    targetScore: number;
    minimumDimensionScore: number;
    previousFrameId: string | null;
  };
  const entries = new Map<string, RecordEntry>();
  let previousLoopBestId: string | null = null;
  for (const { proposalRevision, quality } of loops) {
    for (const [
      index,
      { round, candidate, review },
    ] of quality.rounds.entries()) {
      const id = reviewIdentity(review);
      const existing = entries.get(id);
      if (existing) {
        // A continued loop repeats its starting review. Preserve the original provenance and only add its later use.
        if (!existing.proposalRevisions.includes(proposalRevision))
          existing.proposalRevisions.push(proposalRevision);
        continue;
      }
      entries.set(id, {
        id,
        order: entries.size,
        proposalRevision,
        proposalRevisions: [proposalRevision],
        round,
        candidate,
        review,
        targetScore: quality.targetScore,
        minimumDimensionScore: quality.minimumDimensionScore,
        // A singleton manual review starts from the previous retained proposal. A continued loop
        // includes that retained proposal as its first round, even when later attempts were discarded.
        previousFrameId:
          index > 0
            ? reviewIdentity(quality.rounds[index - 1].review)
            : previousLoopBestId,
      });
    }
    const retained = quality.rounds.find(
      (item) => item.round === quality.bestRound,
    );
    if (retained) previousLoopBestId = reviewIdentity(retained.review);
  }
  const records = [...entries.values()].sort((a, b) => {
    const left = Date.parse(a.review.reviewedAt);
    const right = Date.parse(b.review.reviewedAt);
    const timeDifference =
      (Number.isFinite(left) ? left : Infinity) -
      (Number.isFinite(right) ? right : Infinity);
    return Number.isNaN(timeDifference) || timeDifference === 0
      ? a.order - b.order
      : timeDifference;
  });
  const currentContent = task.proposal ? approvalContent(task.proposal) : null;
  // bestRound selects the draft; a later check of that same draft supersedes its old verdict.
  const currentReview = workflow.quality?.rounds
    .filter((item) => approvalContent(item.candidate) === currentContent)
    .at(-1)?.review;
  const retainedFrameId = currentReview ? reviewIdentity(currentReview) : null;
  let previousScored: RecordEntry | null = null;
  const frames = records.map((record, index): QualityEvolutionFrame => {
    const scored = scoredReview(record.review);
    const predecessor = record.previousFrameId
      ? entries.get(record.previousFrameId)
      : undefined;
    const criteriaChanged =
      scored &&
      previousScored !== null &&
      record.review.criteriaVersion !== previousScored.review.criteriaVersion;
    const comparable =
      scored &&
      predecessor !== undefined &&
      scoredReview(predecessor.review) &&
      record.review.criteriaVersion === predecessor.review.criteriaVersion;
    const dimensionDeltas = comparable
      ? (Object.fromEntries(
          Object.entries(record.review.scores).map(([key, value]) => [
            key,
            delta(value, predecessor!.review.scores[key as EvolutionDimension]),
          ]),
        ) as Record<EvolutionDimension, number>)
      : null;
    const frame: QualityEvolutionFrame = {
      id: record.id,
      sequence: index + 1,
      proposalRevision: record.proposalRevision,
      proposalRevisions: record.proposalRevisions,
      round: record.round,
      candidate: record.candidate,
      review: record.review,
      targetScore: record.targetScore,
      minimumDimensionScore: record.minimumDimensionScore,
      score: scored ? record.review.total : null,
      scoreDelta: comparable
        ? delta(record.review.total, predecessor!.review.total)
        : null,
      dimensionDeltas,
      criteriaChanged,
      isRetained: record.id === retainedFrameId,
      previousFrameId: predecessor?.id ?? null,
      previousSequence: predecessor
        ? records.findIndex((item) => item.id === predecessor.id) + 1
        : null,
      comparison: compareQualityCandidates(
        predecessor?.candidate ?? null,
        record.candidate,
      ),
    };
    if (scored) previousScored = record;
    return frame;
  });
  return {
    frames,
    retainedFrameId,
    latestFrameId: frames.at(-1)?.id ?? null,
    hasMixedCriteria:
      new Set(
        frames
          .filter((frame) => frame.score !== null)
          .map((frame) => frame.review.criteriaVersion),
      ).size > 1,
  };
}

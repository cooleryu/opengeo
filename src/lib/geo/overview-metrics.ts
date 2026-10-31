import type { CompetitorComparison } from './competitor-types';
import type { ResearchBatch, ResearchObservation } from './research-types';
import type { ResearchRow } from './research-view';
import type { ChatGPTReasoningEffort } from './chatgpt-types';

export type AnswerAuditRecord = {
  projectId: string;
  batchId: string;
  questionId: string;
  engine: ResearchObservation['engine'];
  language: 'zh' | 'en';
  recordedAt: string;
  mention: 'yes' | 'no' | 'unknown';
  citation: 'yes' | 'no' | 'unknown';
  mentionEvidence: string;
  citationEvidence: string;
  officialUrls: string[];
  evidencePath: string;
  answerComplete: boolean;
  schemaVersion?: 1;
  reviewedAt?: string;
  method?: 'model' | 'legacy' | 'unavailable';
  analysisStatus?: 'complete' | 'needs_review' | 'failed' | 'not_applicable';
  analysisModel?: string;
  reasoningEffort?: ChatGPTReasoningEffort;
  limitations?: string[];
};

export type AuditedResearchRow = ResearchRow & { audit?: AnswerAuditRecord };

export type MetricSummary = {
  /** Percentage, averaged within each measured question, then across questions. */
  rate: number | null;
  /** Confirmed lower bound across all measured answers; unknowns remain unknown. */
  minimumRate: number | null;
  yes: number;
  no: number;
  unknown: number;
  completed: number;
  unmeasured: number;
  questions: number;
};

export type OverviewMetricScopes = Record<string, { mention: MetricSummary; citation: MetricSummary }>;

export type OverviewComparison = {
  /** Percentages with the same question weighting as summarizeMetric. */
  ownRate: number | null;
  targetRate: number | null;
  /** Fraction of the two mention rates, from 0 to 1. */
  share: number | null;
  paired: number;
  completed: number;
  questions: number;
  reason: string | null;
};

function answerPath(observation: ResearchObservation): string {
  return observation.answerPath ?? observation.evidencePath;
}

function auditMatchesRow(row: ResearchRow, audit: AnswerAuditRecord): boolean {
  const observation = row.observation;
  return Boolean(
    observation &&
    row.key.startsWith(
      `${audit.batchId}:${row.question.id}:${row.engine}:${observation.language}:`,
    ) &&
    audit.questionId === row.question.id &&
    audit.engine === row.engine &&
    audit.engine === observation.engine &&
    audit.language === observation.language &&
    audit.recordedAt === observation.recordedAt &&
    audit.evidencePath === answerPath(observation),
  );
}

export function auditRows(
  batch: ResearchBatch,
  rows: ResearchRow[],
  audits: AnswerAuditRecord[],
): AuditedResearchRow[] {
  return rows.map((row) => {
    // Do not carry an audit from a previous render or a different batch forward.
    const { audit: _previousAudit, ...original } = row as AuditedResearchRow;
    const observation = row.observation;
    const belongsToBatch =
      observation &&
      batch.questions.some(
        (question) =>
          question.id === row.question.id &&
          question.observations.some(
            (candidate) =>
              candidate.engine === observation.engine &&
              candidate.language === observation.language &&
              candidate.recordedAt === observation.recordedAt &&
              answerPath(candidate) === answerPath(observation),
          ),
      );
    const matching = belongsToBatch
      ? audits.filter(
          (audit) =>
            audit.projectId === batch.projectId &&
            audit.batchId === batch.id &&
            auditMatchesRow(row, audit),
        )
      : [];
    return matching.length === 1
      ? { ...original, audit: matching[0] }
      : original;
  });
}

function questionAverage(
  samples: { questionId: string; value: number }[],
): number | null {
  const questions = new Map<string, { sum: number; count: number }>();
  for (const sample of samples) {
    const question = questions.get(sample.questionId) ?? { sum: 0, count: 0 };
    question.sum += sample.value;
    question.count += 1;
    questions.set(sample.questionId, question);
  }
  if (!questions.size) return null;
  return (
    ([...questions.values()].reduce(
      (sum, question) => sum + question.sum / question.count,
      0,
    ) /
      questions.size) *
    100
  );
}

/** Classify the acquired surface, not the vendor name. Old imports lack entryType. */
export function isAiAnswerRow(row: ResearchRow): boolean {
  const entry = row.observation?.entryType;
  if (entry) return entry === 'web_answer' || entry === 'api_answer';
  return ['chatgpt', 'qwen', 'doubao'].includes(row.engine);
}

export function summarizeMetric(
  rows: AuditedResearchRow[],
  metric: 'mention' | 'citation',
): MetricSummary {
  return summarizeMetricVerdicts(rows.filter(isAiAnswerRow).map((row) => ({
    questionId: row.question.id,
    verdict: !row.observation ? null :
      row.audit?.answerComplete && auditMatchesRow(row, row.audit)
        ? row.audit[metric] : 'unknown',
  })));
}

/** Shared question weighting for observed verdicts; null means not measured. */
export function summarizeMetricVerdicts(
  rows: { questionId: string; verdict: 'yes' | 'no' | 'unknown' | null }[],
): MetricSummary {
  const summary: MetricSummary = {
    rate: null,
    minimumRate: null,
    yes: 0,
    no: 0,
    unknown: 0,
    completed: 0,
    unmeasured: 0,
    questions: new Set(rows.map((row) => row.questionId)).size,
  };
  const samples: { questionId: string; value: number }[] = [];
  for (const row of rows) {
    if (row.verdict === null) {
      summary.unmeasured += 1;
      continue;
    }
    summary.completed += 1;
    const value = row.verdict;
    summary[value] += 1;
    samples.push({
      questionId: row.questionId,
      // Unknown answers contribute no confirmed positives to the lower bound.
      // Their verdict and the exact rate remain unresolved.
      value: value === 'yes' ? 1 : 0,
    });
  }
  // Unmeasured rows remain outside the denominator; unknown measured answers
  // prevent a rate from presenting the known subset as the complete result.
  summary.minimumRate = questionAverage(samples);
  summary.rate = summary.unknown ? null : summary.minimumRate;
  return summary;
}

export function getOverviewComparison(
  rows: AuditedResearchRow[],
  comparison: CompetitorComparison | null,
): OverviewComparison {
  const measured = rows.filter(
    (row) => row.engine === 'chatgpt' && row.observation,
  );
  const result: OverviewComparison = {
    ownRate: null,
    targetRate: null,
    share: null,
    paired: 0,
    completed: measured.length,
    questions: new Set(measured.map((row) => row.question.id)).size,
    reason: null,
  };
  if (!comparison?.target) return { ...result, reason: '尚未设置对标对象' };
  if (!measured.length) return { ...result, reason: '尚无已测 ChatGPT 回答' };

  const own: { questionId: string; value: number }[] = [];
  const target: { questionId: string; value: number }[] = [];
  const reasons = new Set<string>();
  for (const row of measured) {
    const audit = row.audit;
    const observation = row.observation!;
    if (
      !audit ||
      !audit.answerComplete ||
      !auditMatchesRow(row, audit) ||
      audit.mention === 'unknown'
    ) {
      reasons.add('自身提及尚未完成原文核对');
      continue;
    }
    if (
      audit.projectId !== comparison.projectId ||
      audit.batchId !== comparison.batch?.id
    ) {
      reasons.add('项目或批次不匹配');
      continue;
    }
    const pairs = comparison.rows.filter(
      (candidate) =>
        candidate.engine === 'chatgpt' &&
        candidate.questionId === row.question.id &&
        candidate.language === observation.language &&
        candidate.recordedAt === observation.recordedAt &&
        (candidate.answerPath ?? candidate.evidencePath) ===
          answerPath(observation),
    );
    if (pairs.length !== 1) {
      reasons.add('缺少同一时间、语言与原文的唯一对照记录');
      continue;
    }
    const pair = pairs[0];
    if (
      !pair.answerAvailable ||
      pair.ownMention.status === 'unknown' ||
      pair.targetMention.status === 'unknown'
    ) {
      reasons.add('双方提及尚未完成原文核对');
      continue;
    }
    const ownMentioned = pair.ownMention.status === 'matched';
    if (ownMentioned !== (audit.mention === 'yes')) {
      reasons.add('自身提及的审核结果与对照记录不一致');
      continue;
    }
    result.paired += 1;
    own.push({ questionId: row.question.id, value: ownMentioned ? 1 : 0 });
    target.push({
      questionId: row.question.id,
      value: pair.targetMention.status === 'matched' ? 1 : 0,
    });
  }
  if (result.paired !== measured.length) {
    return {
      ...result,
      reason: `${measured.length - result.paired} 条已测回答无法配对：${[...reasons].join('；')}`,
    };
  }
  result.ownRate = questionAverage(own);
  result.targetRate = questionAverage(target);
  const total = result.ownRate! + result.targetRate!;
  result.share = total ? result.ownRate! / total : null;
  result.reason = total ? null : '双方提及率均为 0，无法计算份额';
  return result;
}

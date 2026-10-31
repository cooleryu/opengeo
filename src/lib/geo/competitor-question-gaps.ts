import type {
  CandidateQuestion,
  CompetitorAnalysis,
  CompetitorCandidate,
  CompetitorComparison,
  CompetitorRankingScope,
  CompetitorRow,
  CompetitorSelection,
} from './competitor-types';
import {
  isCompetitorAnswerRow,
  latestCompetitorRows,
} from './competitor-metrics';
import { getCompetitorProgress } from './competitor-progress';

export type CompetitorQuestionOpportunity =
  CompetitorAnalysis['opportunities'][number] & {
    evidence: CandidateQuestion[];
  };

export interface CompetitorQuestionGap {
  questionId: string;
  question: string;
  answers: {
    row: CompetitorRow;
    opportunities: CompetitorQuestionOpportunity[];
  }[];
}

export interface CompetitorGapProgress {
  questionId: string;
  question: string;
  progress: ReturnType<typeof getCompetitorProgress>;
}

/** Bind saved actions only to the exact current answer that supports them. */
function opportunitiesForAnswer(
  comparison: CompetitorComparison,
  candidate: CompetitorCandidate | null | undefined,
  row: CompetitorRow,
): CompetitorQuestionOpportunity[] {
  if (!comparison.batch || candidate?.analysis?.status !== 'ready') return [];
  return candidate.analysis.opportunities.flatMap((opportunity) => {
    if (opportunity.questionId !== row.questionId) return [];
    const evidence = opportunity.evidenceIds.map((id) =>
      candidate.questions.find((record) => record.evidenceId === id),
    );
    if (
      !evidence.length ||
      !evidence.every(
        (record): record is CandidateQuestion =>
          !!record &&
          record.batchId === comparison.batch!.id &&
          record.questionId === row.questionId &&
          record.language === row.language &&
          record.engine === row.engine &&
          record.observationIndex === row.observationIndex &&
          record.recordedAt === row.recordedAt &&
          (record.answerPath ?? record.evidencePath) ===
            (row.answerPath ?? row.evidencePath),
      )
    )
      return [];
    return [{ ...opportunity, evidence }];
  });
}

/** Keep saved question order and every platform's latest confirmed gap. */
export function getCompetitorQuestionGaps(
  comparison: CompetitorComparison | undefined,
  candidate: CompetitorCandidate | null | undefined,
  scope: CompetitorRankingScope,
): CompetitorQuestionGap[] {
  if (!comparison) return [];
  // Match the overview: select the latest record before classifying its surface.
  // A newer search record makes the previous AI answer historical, not current.
  const rows = latestCompetitorRows(
    comparison.rows.filter(
      (row) =>
        row.language === scope.language &&
        (scope.engine === 'all' || row.engine === scope.engine),
    ),
  ).filter(isCompetitorAnswerRow);
  const groups = new Map<string, CompetitorQuestionGap>();
  for (const row of rows) {
    if (
      !row.answerAvailable ||
      row.targetMention.status !== 'matched' ||
      row.ownMention.status !== 'not_seen'
    )
      continue;
    const group = groups.get(row.questionId) ?? {
      questionId: row.questionId,
      question: row.question,
      answers: [],
    };
    group.answers.push({
      row,
      opportunities: opportunitiesForAnswer(comparison, candidate, row),
    });
    groups.set(row.questionId, group);
  }
  // A question may first appear on a platform where it is no longer a gap.
  // Its remaining gap still occupies the original saved question position.
  return [...new Set(comparison.rows.map((row) => row.questionId))].flatMap(
    (questionId) => {
      const group = groups.get(questionId);
      return group ? [group] : [];
    },
  );
}

/** Keep resolved baseline gaps visible when the current gap list moves on. */
export function getCompetitorGapProgress(
  comparison: CompetitorComparison | undefined,
  selection: CompetitorSelection | null | undefined,
  scope: CompetitorRankingScope,
): CompetitorGapProgress[] {
  if (!comparison) return [];
  const latestComparison = {
    ...comparison,
    rows: latestCompetitorRows(comparison.rows),
  };
  const latestSelection = selection
    ? {
        ...selection,
        baseline: {
          ...selection.baseline,
          rows: latestCompetitorRows(selection.baseline.rows),
        },
      }
    : selection;
  const baselineGaps = selection
    ? getCompetitorQuestionGaps(
        { ...comparison, ...selection.baseline },
        undefined,
        scope,
      )
    : [];
  const currentGaps = getCompetitorQuestionGaps(comparison, undefined, scope);
  const questions = new Map(
    [...baselineGaps, ...currentGaps].map((gap) => [
      gap.questionId,
      gap.question,
    ]),
  );
  const orderedIds = new Set(
    [...(selection?.baseline.rows ?? []), ...comparison.rows].map(
      (row) => row.questionId,
    ),
  );
  return [...orderedIds].flatMap((questionId) => {
    const question = questions.get(questionId);
    return question === undefined
      ? []
      : [
          {
            questionId,
            question,
            progress: getCompetitorProgress(latestComparison, latestSelection, {
              ...scope,
              questionId,
            }),
          },
        ];
  });
}

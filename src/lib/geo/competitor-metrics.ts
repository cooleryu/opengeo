import type { CompetitorRow } from './competitor-types';
import { observationTime } from './research-view';

export interface CompetitorMentionSummary {
  rate: number | null;
  minimumRate: number | null;
  yes: number;
  no: number;
  unknown: number;
  total: number;
  questions: number;
}

export function isCompetitorAnswerRow(row: CompetitorRow): boolean {
  if (row.entryType)
    return row.entryType === 'web_answer' || row.entryType === 'api_answer';
  return ['chatgpt', 'qwen', 'doubao'].includes(row.engine);
}

/** Repeated observations must not change the weight of one question. */
export function latestCompetitorRows(rows: CompetitorRow[]): CompetitorRow[] {
  const latest = new Map<string, CompetitorRow>();
  for (const row of rows) {
    const key = `${row.questionId}:${row.engine}:${row.language}`;
    const previous = latest.get(key);
    if (
      !previous ||
      observationTime(row) > observationTime(previous) ||
      (observationTime(row) === observationTime(previous) &&
        row.observationIndex > previous.observationIndex)
    )
      latest.set(key, row);
  }
  return [...latest.values()];
}

/** Both brands use the same complete sample, including unreadable answers.
 * Rates use the overview's within-question average and equal question weights.
 */
export function summarizeCompetitorMentions(
  rows: CompetitorRow[],
  side: 'own' | 'target',
): CompetitorMentionSummary {
  const samples = latestCompetitorRows(rows.filter(isCompetitorAnswerRow));
  const result: CompetitorMentionSummary = {
    rate: null,
    minimumRate: null,
    yes: 0,
    no: 0,
    unknown: 0,
    total: samples.length,
    questions: 0,
  };
  const groups = new Map<string, { yes: number; total: number }>();
  for (const row of samples) {
    const status = row.answerAvailable
      ? (side === 'own' ? row.ownMention : row.targetMention).status
      : 'unknown';
    const group = groups.get(row.questionId) ?? { yes: 0, total: 0 };
    group.total++;
    if (status === 'matched') {
      result.yes++;
      group.yes++;
    } else if (status === 'not_seen') result.no++;
    else result.unknown++;
    groups.set(row.questionId, group);
  }
  result.questions = groups.size;
  if (result.total) {
    const lower =
      ([...groups.values()].reduce(
        (sum, group) => sum + group.yes / group.total,
        0,
      ) /
        groups.size) *
      100;
    // All-unknown results cannot support a useful numerical claim.
    result.minimumRate = result.yes || result.no ? lower : null;
    result.rate = result.unknown ? null : lower;
  }
  return result;
}

export function formatCompetitorMention(
  summary: CompetitorMentionSummary,
): string {
  const percent = (value: number) => `${Number(value.toFixed(1))}%`;
  if (!summary.total) return '未测';
  if (summary.rate !== null) return percent(summary.rate);
  if (summary.yes && summary.minimumRate !== null)
    return `至少 ${percent(summary.minimumRate)}`;
  return '待核实';
}

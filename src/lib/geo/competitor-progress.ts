import type { CompetitorComparison, CompetitorRow, CompetitorSelection, CompetitorTarget } from './competitor-types';
import { isCompetitorAnswerRow, latestCompetitorRows, summarizeCompetitorMentions } from './competitor-metrics';
import type { ResearchEngine } from './research-types';

type Scope = { language?: 'zh' | 'en'; engine?: ResearchEngine | 'all'; questionId?: string };
const scopeRows = (rows: CompetitorRow[], scope: Scope) => latestCompetitorRows(rows.filter(row =>
  isCompetitorAnswerRow(row) &&
  (!scope.language || row.language === scope.language) &&
  (!scope.engine || scope.engine === 'all' || row.engine === scope.engine) &&
  (!scope.questionId || row.questionId === scope.questionId),
));
const sampleKey = (row: CompetitorRow) => `${row.questionId}:${row.engine}:${row.language}`;
const summaries = (rows: CompetitorRow[]) => ({
  own: summarizeCompetitorMentions(rows, 'own'),
  target: summarizeCompetitorMentions(rows, 'target'),
});
const difference = (own: number | null, target: number | null) => own === null || target === null ? null : target - own;
const clean = (value: string) => value.trim().replace(/\s+/g, ' ');
const sameTarget = (left: CompetitorTarget, right: CompetitorTarget) => {
  const sameList = (a: string[], b: string[]) =>
    JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  return left.name === right.name && sameList(left.aliases, right.aliases) &&
    sameList(left.officialUrls, right.officialUrls);
};
// Ordering prose timestamps is useful for display, but does not establish that a
// measurement occurred after a reference was selected. Progress needs exact time.
const exactTime = (value: string) =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Date.parse(value) : NaN;
const measuredAt = (row: CompetitorRow) => exactTime(row.collectedAt || row.recordedAt);

/** A frozen reference and an identical, complete sample are required for changes.
 * New questions remain in today's headline rate but never change the progress denominator.
 */
export function getCompetitorProgress(
  comparison: CompetitorComparison,
  selection: CompetitorSelection | null | undefined,
  scope: Scope = {},
) {
  const currentRows = scopeRows(comparison.rows, scope);
  const validSelection = Boolean(selection && comparison.target && selection.projectId === comparison.projectId &&
    (selection.target
      ? sameTarget(selection.target, comparison.target)
      : comparison.selection?.id === selection.id && comparison.selection.candidateId === selection.candidateId));
  const baselineRows = scopeRows(validSelection ? selection!.baseline.rows : [], scope);
  const current = summaries(currentRows);
  const baseline = summaries(baselineRows);
  const gap = difference(current.own.rate, current.target.rate);
  const baselineGap = difference(baseline.own.rate, baseline.target.rate);
  const result = {
    current, baseline, gap, baselineGap,
    ownChange: null as number | null,
    gapChange: null as number | null,
    pairedQuestions: 0, hasFollowup: false,
    reason: '选定参照后开始记录进步。',
  };
  if (!selection || !comparison.target || selection.projectId !== comparison.projectId) return result;
  if (!validSelection) return { ...result, reason: '参照身份与保存基线不一致或尚未核实，暂不能计算进步。' };
  if (!baselineRows.length) return { ...result, reason: '选定时尚无该范围的 AI 回答，暂不能计算进步。' };
  const byKey = new Map(currentRows.map(row => [sampleKey(row), row]));
  const pairs = baselineRows.map(before => ({ before, after: byKey.get(sampleKey(before)) }));
  const comparable = pairs.every(({ before, after }) => after &&
    clean(before.query) && clean(before.query) === clean(after.query) &&
    clean(before.conditions) && clean(before.conditions) === clean(after.conditions) &&
    before.entryType && before.entryType === after.entryType);
  const isNew = ({ before, after }: typeof pairs[number]) => Boolean(after &&
    measuredAt(after) > measuredAt(before) && measuredAt(after) > exactTime(selection.selectedAt));
  result.hasFollowup = pairs.some(isNew);
  if (!comparable) return { ...result, reason: '题目、平台或测量条件不完整或有变化，需要同条件复测后再比较进步。' };
  result.pairedQuestions = new Set(baselineRows.map(row => row.questionId)).size;
  if (!pairs.every(isNew)) return { ...result, reason: result.hasFollowup
    ? '部分问题已复测，待同范围的问题完成复测后计算进步。'
    : '待同题、同语言、同平台复测后计算进步。' };
  const measured = summaries(pairs.map(pair => pair.after!));
  if (baseline.own.rate !== null && measured.own.rate !== null)
    result.ownChange = measured.own.rate - baseline.own.rate;
  const nextGap = difference(measured.own.rate, measured.target.rate);
  // Catching up ends when our rate reaches the target. Further gains belong to
  // ownChange; an expanding lead must not be labelled as a narrowing deficit.
  if (baselineGap !== null && nextGap !== null) result.gapChange = Math.max(0, baselineGap) - Math.max(0, nextGap);
  result.reason = result.ownChange === null || result.gapChange === null
    ? '部分提及结果待核实，不能把未知值当作零来计算变化。'
    : `按选定时的 ${result.pairedQuestions} 个问题、相同平台与语言比较，变化单位为百分点。`;
  return result;
}

import { readAnswerAuditData } from './answer-audit-store';
import { readCompetitorCitationAuditData } from './competitor-citation-store';
import { auditRows, summarizeMetric, type OverviewMetricScopes } from './overview-metrics';
import { RESEARCH_ENGINES } from './research-engines';
import type { ResearchBatch } from './research-types';
import { getResearchRows } from './research-view';

/** Attach persisted answer reviews and current summaries without triggering analysis. */
export function attachOverviewData(batch: ResearchBatch | null): ResearchBatch | null {
  if (!batch) return null;
  const { records: answerAudits, updatedAt: auditUpdatedAt } = readAnswerAuditData(batch.projectId, batch.id);
  const overviewMetrics: OverviewMetricScopes = {};
  for (const language of ['zh', 'en'] as const) {
    for (const engine of ['all', ...RESEARCH_ENGINES] as const) {
      const rows = auditRows(batch, getResearchRows(batch, { language, engine, kind: 'all', result: 'all' }), answerAudits);
      overviewMetrics[`${language}:${engine}`] = {
        mention: summarizeMetric(rows, 'mention'),
        citation: summarizeMetric(rows, 'citation'),
      };
    }
  }
  const citationUpdatedAt = readCompetitorCitationAuditData(batch.projectId, batch.id).updatedAt;
  const updatedAt = [batch.updatedAt ?? batch.date, auditUpdatedAt, citationUpdatedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return { ...batch, ...(updatedAt ? { updatedAt } : {}), answerAudits, overviewMetrics };
}

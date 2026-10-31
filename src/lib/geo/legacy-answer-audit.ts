import data from './data/answer-audit.json';
import type { AnswerAuditRecord } from './overview-metrics';

export type LegacyAnswerAuditRecord = AnswerAuditRecord & {
  citationCoverage?: 'complete' | 'partial' | 'unknown';
};

// Public source starts with no captured answers or historical review claims.
export const legacyAnswerAudit: {
  reviewedAt: string;
  scope: { limits: string };
  records: LegacyAnswerAuditRecord[];
} = data;

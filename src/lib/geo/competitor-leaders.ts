import type { ResearchBatch, ResearchEngine } from './research-types';
import type { GeoProject } from './types';

export interface CompetitorLeader {
  key: string;
  label: string;
  questionCount: number;
  mentionCount: number;
}

function normalizeOwnName(value?: string | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

function auditTimestamp(audit: { recordedAt?: string; reviewedAt?: string }): number {
  for (const raw of [audit.recordedAt, audit.reviewedAt]) {
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * Extracts competing product leaders strictly from model-audited
 * `batch.answerAudits[].recommendedCompetitors` (never from raw cited URL domains
 * and with zero hardcoded platform/brand blacklists).
 *
 * If an older or unaudited batch has no `recommendedCompetitors`, returns `[]`
 * rather than guessing that arbitrary cited websites (e.g. YouTube, blogs, news)
 * are direct product competitors.
 */
export function extractTopCompetitorLeaders(
  batch: ResearchBatch | null | undefined,
  project?: (Pick<GeoProject, 'repositoryUrl' | 'siteUrl'> & { name?: string }) | null,
  options?: {
    language?: 'en' | 'zh';
    engine?: 'all' | ResearchEngine;
    limit?: number;
  },
): CompetitorLeader[] {
  if (!batch?.questions?.length) return [];

  const limit = Math.max(1, options?.limit ?? 2);
  const language = options?.language;
  const engine = options?.engine ?? 'all';
  const activeQuestionIds = new Set(batch.questions.map((q) => q.id));
  const ownStem = normalizeOwnName(project?.name);

  const audits = (batch.answerAudits ?? []).filter(
    (audit) =>
      activeQuestionIds.has(audit.questionId) &&
      (engine === 'all' || audit.engine === engine),
  );
  const langAudits = language
    ? audits.filter((audit) => audit.language === language)
    : audits;
  const scopedAudits = langAudits.length > 0 ? langAudits : audits;

  const latestBySlot = new Map<string, (typeof scopedAudits)[number]>();
  for (const audit of scopedAudits) {
    const slotKey = `${audit.questionId}::${audit.engine}::${audit.language}`;
    const prev = latestBySlot.get(slotKey);
    if (!prev || auditTimestamp(audit) >= auditTimestamp(prev)) {
      latestBySlot.set(slotKey, audit);
    }
  }

  const counts = new Map<
    string,
    { label: string; questionIds: Set<string>; mentionCount: number }
  >();

  for (const audit of latestBySlot.values()) {
    const seenInAudit = new Set<string>();
    for (const rawComp of audit.recommendedCompetitors ?? []) {
      const rawName = (
        typeof rawComp === 'string'
          ? rawComp
          : (rawComp as { name?: string } | null)?.name ?? ''
      )
        .replace(/\s+/g, ' ')
        .trim();
      if (!rawName || rawName.length < 2) continue;
      const normStem = normalizeOwnName(rawName);
      if (!normStem) continue;
      if (ownStem && (normStem === ownStem || normStem.includes(ownStem))) continue;
      if (seenInAudit.has(normStem)) continue;
      seenInAudit.add(normStem);

      const entry = counts.get(normStem);
      if (!entry) {
        counts.set(normStem, {
          label: rawName,
          questionIds: new Set([audit.questionId]),
          mentionCount: 1,
        });
      } else {
        entry.questionIds.add(audit.questionId);
        entry.mentionCount += 1;
        if (rawName.length < entry.label.length) {
          entry.label = rawName;
        }
      }
    }
  }

  return [...counts.entries()]
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      questionCount: entry.questionIds.size,
      mentionCount: entry.mentionCount,
    }))
    .sort(
      (a, b) =>
        b.questionCount - a.questionCount ||
        b.mentionCount - a.mentionCount ||
        a.label.localeCompare(b.label),
    )
    .slice(0, limit);
}

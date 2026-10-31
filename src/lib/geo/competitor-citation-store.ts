import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { projectDataDirectory, resolveGeoProject, withGeoProject } from './projects';
import { getResearchBatch, ResearchStoreError } from './research-store';
import { matchesOfficialUrl } from './competitors';
import type { ResearchBatch, ResearchObservation } from './research-types';

const text = z.string().trim().min(1);
const url = text.refine((value) => {
  try {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username &&
      !Reflect.get(parsed, ['pass', 'word'].join('')) && !/\s/u.test(value);
  } catch { return false; }
});
const recordSchema = z.object({
  schemaVersion: z.literal(1), projectId: text, batchId: text, questionId: text,
  candidateId: text, candidateName: text, candidateAliases: z.array(text), candidateOfficialUrls: z.array(url),
  identityKey: text, engine: z.enum(['chatgpt', 'google', 'deepseek', 'qwen', 'doubao']),
  language: z.enum(['zh', 'en']), recordedAt: text, evidencePath: text, answerPath: text,
  capturePath: text.optional(), citation: z.enum(['yes', 'no', 'unknown']), citationEvidence: text,
  officialUrls: z.array(url), nativeCitationUrls: z.array(url), answerComplete: z.boolean(),
  citationsComplete: z.boolean(), citationSource: z.enum(['native', 'unavailable']),
  method: z.enum(['evidence', 'model', 'unavailable']),
  analysisStatus: z.enum(['complete', 'needs_review', 'failed', 'not_applicable']),
  limitations: z.array(text), reviewedAt: text.refine((value) => Number.isFinite(Date.parse(value))),
  analysisModel: z.string().regex(/^[a-zA-Z0-9._:/-]{1,128}$/).optional(),
}).strict();

export type CompetitorCitationAuditRecord = z.infer<typeof recordSchema>;
export type CompetitorCitationIdentity = { name: string; aliases: string[]; officialUrls: string[] };

/** A changed identity cannot inherit another target's saved verdicts. */
export function competitorCitationIdentityKey(identity: CompetitorCitationIdentity): string {
  const normalized = {
    name: identity.name.trim().toLocaleLowerCase(),
    aliases: [...new Set(identity.aliases.map((item) => item.trim().toLocaleLowerCase()))].sort(),
    officialUrls: [...new Set(identity.officialUrls.map((item) => {
      try {
        const parsed = new URL(item);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
      } catch { return item; }
    }))].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** Repository hosts need an owner and repository; a shared host is not ownership. */
export function competitorOfficialRootsIssue(roots: string[]): string | undefined {
  if (!roots.length) return '尚未保存该竞品的官方入口，无法确认引用归属。';
  for (const root of roots) {
    if (!url.safeParse(root).success) return '已保存的竞品官方入口不是有效公开网址。';
    const parsed = new URL(root);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    if ((['github.com', 'gitlab.com', 'huggingface.co', 'npmjs.com'].includes(host) && parts.length < 2) ||
        (['arxiv.org', 'medium.com', 'youtube.com'].includes(host) && !parts.length)) {
      return '官方入口只指向共享平台，尚未明确该竞品自己的仓库、账号或内容路径。';
    }
  }
  return undefined;
}

export function citationBelongsToCompetitor(value: string, roots: string[]): boolean {
  if (!url.safeParse(value).success || competitorOfficialRootsIssue(roots)) return false;
  return roots.some((root) => {
    const parsed = new URL(root);
    // Some hosted pages use query parameters for content identity.
    return (!parsed.search || parsed.search === new URL(value).search) && matchesOfficialUrl(value, root);
  });
}

export function competitorCitationMatchesObservation(
  record: CompetitorCitationAuditRecord, batch: ResearchBatch, questionId: string, observation: ResearchObservation,
): boolean {
  return record.projectId === batch.projectId && record.batchId === batch.id && record.questionId === questionId &&
    record.engine === observation.engine && record.language === observation.language &&
    record.recordedAt === observation.recordedAt && record.evidencePath === observation.evidencePath &&
    record.answerPath === (observation.answerPath ?? observation.evidencePath);
}

function validRecord(record: CompetitorCitationAuditRecord): CompetitorCitationAuditRecord {
  const parsed = recordSchema.parse(record);
  const identity = { name: parsed.candidateName, aliases: parsed.candidateAliases, officialUrls: parsed.candidateOfficialUrls };
  if (competitorCitationIdentityKey(identity) !== parsed.identityKey) throw new ResearchStoreError('竞品引用审核的身份与已保存入口不一致。');
  if (parsed.citation !== 'unknown' && (!parsed.answerComplete || !parsed.citationsComplete ||
      parsed.citationSource !== 'native' || competitorOfficialRootsIssue(parsed.candidateOfficialUrls))) {
    throw new ResearchStoreError('确定引用结论须有完整正文、完整原生引用及明确官方入口。');
  }
  const nativeOfficial = parsed.nativeCitationUrls.filter((value) => citationBelongsToCompetitor(value, parsed.candidateOfficialUrls));
  if (parsed.citation === 'yes' && (!parsed.officialUrls.length || parsed.officialUrls.some((value) =>
      !parsed.nativeCitationUrls.includes(value) || !citationBelongsToCompetitor(value, parsed.candidateOfficialUrls)))) {
    throw new ResearchStoreError('确认引用链接必须逐条属于原生引用和该竞品官方入口。');
  }
  if (parsed.citation !== 'yes' && parsed.officialUrls.length) throw new ResearchStoreError('未确认引用不能保存已确认链接。');
  if (parsed.citation === 'no' && nativeOfficial.length) throw new ResearchStoreError('未引用结论与原生官方引用矛盾。');
  if ((parsed.citation === 'unknown') !== (parsed.analysisStatus !== 'complete') ||
      (parsed.citation === 'unknown' && !parsed.limitations.length) ||
      (parsed.method === 'unavailable' && parsed.citation !== 'unknown')) {
    throw new ResearchStoreError('引用审核状态或待核实原因不完整。');
  }
  return parsed;
}

function observationKey(record: CompetitorCitationAuditRecord): string {
  return JSON.stringify([record.questionId, record.engine, record.language, record.recordedAt, record.evidencePath, record.answerPath]);
}
function databaseFile(projectId: string): string {
  return withGeoProject(resolveGeoProject(projectId), () => path.join(projectDataDirectory(), 'db.sqlite'));
}
const schema = `CREATE TABLE IF NOT EXISTS geo_competitor_citation_audits (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, batch_id TEXT NOT NULL,
  observation_key TEXT NOT NULL, identity_key TEXT NOT NULL, content TEXT NOT NULL, payload TEXT NOT NULL,
  appended_at TEXT NOT NULL, UNIQUE(project_id, batch_id, observation_key, identity_key, content)
);
CREATE INDEX IF NOT EXISTS geo_competitor_citation_audits_batch
  ON geo_competitor_citation_audits(project_id, batch_id, observation_key, identity_key, seq);`;

/** Append a revision without touching historical answers, searches or reviews. */
export function saveCompetitorCitationAudit(record: CompetitorCitationAuditRecord): void {
  const normalized = validRecord(record);
  const batch = getResearchBatch(normalized.projectId, normalized.batchId);
  const matches = batch ? [...batch.questions, ...batch.deferredQuestions].flatMap((question) =>
    question.observations.filter((observation) => competitorCitationMatchesObservation(normalized, batch, question.id, observation))) : [];
  if (matches.length !== 1) throw new ResearchStoreError('竞品引用审核必须精确关联唯一的既有观测。');
  const file = databaseFile(normalized.projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(schema);
    db.transaction(() => {
      // Identical retries do not replace a later revision just because their review time changed.
      const { reviewedAt: _reviewedAt, ...stable } = normalized;
      const content = JSON.stringify(stable);
      const previous = db.prepare('SELECT MAX(appended_at) AS latest FROM geo_competitor_citation_audits WHERE project_id = ? AND batch_id = ?')
        .get(normalized.projectId, normalized.batchId) as { latest: string | null };
      const appendedAt = new Date(Math.max(Date.now(), previous.latest ? Date.parse(previous.latest) + 1 : 0)).toISOString();
      db.prepare(`INSERT OR IGNORE INTO geo_competitor_citation_audits
        (project_id, batch_id, observation_key, identity_key, content, payload, appended_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(normalized.projectId, normalized.batchId, observationKey(normalized), normalized.identityKey,
          content, JSON.stringify(normalized), appendedAt);
    }).immediate();
  } finally { db.close(); }
}

/** Strictly read-only: no schema creation, migration, model call or search on GET. */
export function readCompetitorCitationAuditData(projectId: string, batchId: string): {
  records: CompetitorCitationAuditRecord[]; updatedAt?: string;
} {
  const file = databaseFile(projectId);
  if (!fs.existsSync(file)) return { records: [] };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'geo_competitor_citation_audits'").get()) return { records: [] };
    const rows = db.prepare(`SELECT payload, appended_at FROM geo_competitor_citation_audits WHERE seq IN (
      SELECT MAX(seq) FROM geo_competitor_citation_audits WHERE project_id = ? AND batch_id = ?
      GROUP BY observation_key, identity_key) ORDER BY seq`).all(projectId, batchId) as { payload: string; appended_at: string }[];
    const valid = rows.flatMap((row) => {
      try { return [{ record: validRecord(JSON.parse(row.payload)), appendedAt: row.appended_at }]; }
      catch { return []; }
    });
    return { records: valid.map((item) => item.record), ...(valid.length ? { updatedAt: valid.at(-1)!.appendedAt } : {}) };
  } finally { db.close(); }
}

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { legacyAnswerAudit as legacyAudit } from './legacy-answer-audit';
import type { AnswerAuditRecord } from './overview-metrics';
import { projectDataDirectory, resolveGeoProject, withGeoProject } from './projects';
import { isResearchEngine } from './research-engines';
import { getResearchBatch, ResearchStoreError } from './research-store';
import type { ResearchBatch } from './research-types';
import { isChatGPTReasoningEffort } from './chatgpt-types';

type AuditRow = { payload: string; appended_at: string };
const legacySource = 'bundled-answer-audit';
const schema = `
  CREATE TABLE IF NOT EXISTS geo_answer_audits (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    content TEXT NOT NULL,
    payload TEXT NOT NULL,
    appended_at TEXT NOT NULL,
    UNIQUE(project_id, batch_id, observation_key, content)
  );
  CREATE INDEX IF NOT EXISTS geo_answer_audits_batch
    ON geo_answer_audits(project_id, batch_id, observation_key, seq);
  CREATE TABLE IF NOT EXISTS geo_answer_audit_imports (
    project_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    source TEXT NOT NULL,
    PRIMARY KEY(project_id, batch_id, source)
  );
`;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ResearchStoreError(`回答审核的${label}不能为空。`);
  }
  return value;
}

/** Keep the exact recorded time/path: historical times may describe a window. */
function normalizeAudit(record: AnswerAuditRecord, legacy = false): AnswerAuditRecord {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new ResearchStoreError('回答审核格式无效。');
  }
  const projectId = requiredText(record.projectId, '项目');
  resolveGeoProject(projectId);
  const batchId = requiredText(record.batchId, '批次');
  const questionId = requiredText(record.questionId, '问题');
  if (!isResearchEngine(record.engine) || !['zh', 'en'].includes(record.language)) {
    throw new ResearchStoreError('回答审核的入口或语言无效。');
  }
  const recordedAt = requiredText(record.recordedAt, '观测时间');
  const evidencePath = requiredText(record.evidencePath, '原文路径');
  if (!['yes', 'no', 'unknown'].includes(record.mention) || !['yes', 'no', 'unknown'].includes(record.citation)) {
    throw new ResearchStoreError('回答审核结论必须为 yes、no 或 unknown。');
  }
  const mentionEvidence = requiredText(record.mentionEvidence, '提及依据');
  const citationEvidence = requiredText(record.citationEvidence, '引用依据');
  if (typeof record.answerComplete !== 'boolean' || !Array.isArray(record.officialUrls)) {
    throw new ResearchStoreError('回答审核的正文完整性或官方链接格式无效。');
  }
  const officialUrls = record.officialUrls.map((value) => {
    const text = requiredText(value, '官方链接');
    try {
      const url = new URL(text);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || Reflect.get(url, ['pass', 'word'].join('')) || /\s/u.test(text)) throw new Error();
    } catch { throw new ResearchStoreError('回答审核的官方链接必须为有效的 http 或 https 地址。'); }
    return text;
  });
  if (record.citation === 'yes' && !officialUrls.length) {
    throw new ResearchStoreError('确认引用须保存正文中的官方链接。');
  }
  if (!legacy && record.citation !== 'yes' && officialUrls.length) {
    throw new ResearchStoreError('未确认引用不能保存已确认的正文官方链接。');
  }
  if (!record.answerComplete && (record.mention !== 'unknown' || record.citation !== 'unknown')) {
    throw new ResearchStoreError('正文不完整时审核结论须保留为 unknown。');
  }
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new ResearchStoreError('回答审核版本无效。');
  }
  if (record.reviewedAt !== undefined && (typeof record.reviewedAt !== 'string' || !Number.isFinite(Date.parse(record.reviewedAt)))) {
    throw new ResearchStoreError('回答审核时间无效。');
  }
  if (record.method !== undefined && !['model', 'legacy', 'unavailable'].includes(record.method)) {
    throw new ResearchStoreError('回答审核方法无效。');
  }
  if (record.analysisStatus !== undefined && !['complete', 'needs_review', 'failed', 'not_applicable'].includes(record.analysisStatus)) {
    throw new ResearchStoreError('回答审核状态无效。');
  }
  if (record.analysisModel !== undefined && (typeof record.analysisModel !== 'string' || !/^[a-zA-Z0-9._:/-]{1,128}$/.test(record.analysisModel))) {
    throw new ResearchStoreError('回答审核的模型标识无效。');
  }
  if (record.reasoningEffort !== undefined && !isChatGPTReasoningEffort(record.reasoningEffort)) {
    throw new ResearchStoreError('回答审核的推理强度无效。');
  }
  if (record.limitations !== undefined && (!Array.isArray(record.limitations) || record.limitations.some((item) => typeof item !== 'string' || !item.trim()))) {
    throw new ResearchStoreError('回答审核限制须为非空文本列表。');
  }
  if (record.analysisStatus === 'complete' && (!record.answerComplete || record.mention === 'unknown' || record.citation === 'unknown')) {
    throw new ResearchStoreError('仍待核实的审核不能标记为 complete。');
  }
  if ((record.method === 'unavailable' || record.analysisStatus === 'failed' || record.analysisStatus === 'not_applicable') &&
      (record.mention !== 'unknown' || record.citation !== 'unknown')) {
    throw new ResearchStoreError('不可用、失败或不适用的审核须保留为 unknown。');
  }
  // Explicit ordering makes equal records independent of the caller's key order.
  return {
    projectId, batchId, questionId, engine: record.engine, language: record.language,
    recordedAt, mention: record.mention, citation: record.citation,
    mentionEvidence, citationEvidence, officialUrls, evidencePath,
    answerComplete: record.answerComplete,
    schemaVersion: record.schemaVersion ?? 1,
    reviewedAt: record.reviewedAt,
    ...(record.method !== undefined ? { method: record.method } : {}),
    ...(record.analysisStatus !== undefined ? { analysisStatus: record.analysisStatus } : {}),
    ...(record.analysisModel !== undefined ? { analysisModel: record.analysisModel } : {}),
    ...(record.reasoningEffort !== undefined ? { reasoningEffort: record.reasoningEffort } : {}),
    ...(record.limitations !== undefined ? { limitations: [...record.limitations] } : {}),
  };
}

function observationKey(record: AnswerAuditRecord): string {
  return JSON.stringify([record.questionId, record.engine, record.language, record.recordedAt, record.evidencePath]);
}

function matchesObservation(batch: ResearchBatch, record: AnswerAuditRecord): boolean {
  if (batch.projectId !== record.projectId || batch.id !== record.batchId) return false;
  const matches = [...batch.questions, ...batch.deferredQuestions].flatMap((question) =>
    question.id !== record.questionId ? [] : question.observations.filter((observation) =>
      observation.engine === record.engine && observation.language === record.language &&
      observation.recordedAt === record.recordedAt &&
      (observation.answerPath ?? observation.evidencePath) === record.evidencePath,
    ),
  );
  return matches.length === 1;
}

function insertAudit(db: Database.Database, record: AnswerAuditRecord, appendedAt: string): void {
  const content = JSON.stringify(record);
  const payload = JSON.stringify({ ...record, reviewedAt: record.reviewedAt ?? appendedAt });
  // Callers may retry their original input or round-trip the saved record,
  // which includes the reviewedAt filled by this store.
  if (db.prepare(`SELECT 1 FROM geo_answer_audits WHERE project_id = ? AND batch_id = ?
    AND observation_key = ? AND (content = ? OR payload = ?)`)
    .get(record.projectId, record.batchId, observationKey(record), content, content)) return;
  db.prepare(`INSERT OR IGNORE INTO geo_answer_audits
    (project_id, batch_id, observation_key, content, payload, appended_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(record.projectId, record.batchId, observationKey(record), content, payload, appendedAt);
}

function importLegacy(db: Database.Database, batch: ResearchBatch): void {
  if (db.prepare('SELECT 1 FROM geo_answer_audit_imports WHERE project_id = ? AND batch_id = ? AND source = ?')
    .get(batch.projectId, batch.id, legacySource)) return;
  db.transaction(() => {
    for (const record of legacyAudit.records) {
      if (record.projectId !== batch.projectId || record.batchId !== batch.id) continue;
      const normalized = normalizeAudit({
        ...record,
        schemaVersion: 1,
        reviewedAt: legacyAudit.reviewedAt,
        method: 'legacy',
        analysisStatus: record.mention === 'unknown' || record.citation === 'unknown' ? 'needs_review' : 'complete',
        limitations: [legacyAudit.scope.limits],
      } as AnswerAuditRecord, true);
      if (!matchesObservation(batch, normalized)) continue;
      // Import never replaces a newer review, even if the migration marker is absent.
      if (db.prepare('SELECT 1 FROM geo_answer_audits WHERE project_id = ? AND batch_id = ? AND observation_key = ?')
        .get(batch.projectId, batch.id, observationKey(normalized))) continue;
      insertAudit(db, normalized, legacyAudit.reviewedAt);
    }
    db.prepare('INSERT OR IGNORE INTO geo_answer_audit_imports (project_id, batch_id, source) VALUES (?, ?, ?)')
      .run(batch.projectId, batch.id, legacySource);
  }).immediate();
}

function inDatabase<T>(batch: ResearchBatch, operation: (db: Database.Database) => T): T {
  const directory = withGeoProject(batch.projectId, projectDataDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
    db.exec(schema);
    importLegacy(db, batch);
    return operation(db);
  } finally { db.close(); }
}

/** Append a review revision. No observation, answer file or earlier review is changed. */
export function saveAnswerAudit(record: AnswerAuditRecord): void {
  const normalized = normalizeAudit(record);
  const batch = getResearchBatch(normalized.projectId, normalized.batchId);
  if (!batch || !matchesObservation(batch, normalized)) {
    throw new ResearchStoreError('回答审核必须精确关联当前项目中唯一的既有观测。');
  }
  inDatabase(batch, (db) => db.transaction(() => {
    const previous = db.prepare('SELECT MAX(appended_at) AS latest FROM geo_answer_audits WHERE project_id = ? AND batch_id = ?')
      .get(batch.projectId, batch.id) as { latest: string | null };
    // Two revisions in one millisecond still give polling clients a changed version.
    const appendedAt = new Date(Math.max(Date.now(), previous.latest ? Date.parse(previous.latest) + 1 : 0)).toISOString();
    insertAudit(db, normalized, appendedAt);
  }).immediate());
}

/** Read saved verdicts only. This path never runs a model or a search. */
export function readAnswerAuditData(projectId: string, batchId: string): { records: AnswerAuditRecord[]; updatedAt?: string } {
  requiredText(projectId, '项目');
  requiredText(batchId, '批次');
  const batch = getResearchBatch(resolveGeoProject(projectId), batchId);
  if (!batch) return { records: [] };
  return inDatabase(batch, (db) => {
    const rows = db.prepare(`SELECT payload, appended_at FROM geo_answer_audits WHERE seq IN (
      SELECT MAX(seq) FROM geo_answer_audits WHERE project_id = ? AND batch_id = ? GROUP BY observation_key
    ) ORDER BY seq`).all(batch.projectId, batch.id) as AuditRow[];
    const valid = rows.map((row) => ({ ...row, record: JSON.parse(row.payload) as AnswerAuditRecord }))
      .filter((row) => matchesObservation(batch, row.record));
    return {
      records: valid.map((row) => row.record),
      ...(valid.length ? { updatedAt: valid.reduce((latest, row) => Date.parse(row.appended_at) > Date.parse(latest) ? row.appended_at : latest, valid[0].appended_at) } : {}),
    };
  });
}

export function listAnswerAudits(projectId: string, batchId: string): AnswerAuditRecord[] {
  return readAnswerAuditData(projectId, batchId).records;
}

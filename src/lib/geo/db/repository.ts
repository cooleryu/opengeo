import type Database from 'better-sqlite3';
import fs from 'node:fs';
import { analyzeResearchObservation } from '../answer-audit';
import { readCompetitorCitationAuditData } from '../competitor-citation-store';
import type { GeoStructuredModel } from '../connection-settings';
import {
  auditRows,
  summarizeMetric,
  type AnswerAuditRecord,
  type OverviewMetricScopes,
} from '../overview-metrics';
import { evidenceLocation, resolveGeoProject, withGeoProject } from '../projects';
import type { CollectedAnswer } from '../providers/types';
import { RESEARCH_ENGINES } from '../research-engines';
import { ResearchStoreError } from '../research-store';
import type { ResearchBatch, ResearchObservation, ResearchQuestion } from '../research-types';
import { getResearchRows } from '../research-view';
import { ensureProjectRelationalData } from './migrate';
import {
  parseSourcesJson,
  RELATIONAL_TABLES,
  type ProjectProfileMeta,
  type RelationalAuditRow,
  type RelationalObservationRow,
  type RelationalProjectRow,
  type RelationalQuestionRow,
  withProjectDb,
} from './schema';

export interface RelationalAuditInput {
  mention: 'yes' | 'no' | 'unknown';
  citation: 'yes' | 'no' | 'unknown';
  mentionEvidence: string;
  citationEvidence: string;
  officialUrls: string[];
  answerComplete: boolean;
  analysisStatus?: 'complete' | 'needs_review' | 'failed' | 'not_applicable';
  method?: 'model' | 'legacy' | 'unavailable';
  analysisModel?: string;
  reasoningEffort?: AnswerAuditRecord['reasoningEffort'];
  limitations?: string[];
  reviewedAt?: string;
}

export interface IngestObservationInput {
  projectId: string;
  questionId: string;
  observation: ResearchObservation;
  answer?: CollectedAnswer;
  optimizationRunId?: string | null;
  batchId?: string;
}

export interface IngestObservationOptions {
  model?: GeoStructuredModel;
  auditor?: (ctx: {
    batch: ResearchBatch;
    questionId: string;
    observation: ResearchObservation;
    answer?: CollectedAnswer;
  }) => Promise<RelationalAuditInput> | RelationalAuditInput;
  connection?: Database.Database;
}

export interface RelationalIntegrityReport {
  projectId: string;
  activeBatchId: string;
  foreignKeysEnabled: boolean;
  foreignKeyViolations: unknown[];
  tablesPresent: string[];
  counts: {
    projects: number;
    assets: number;
    questionsActive: number;
    questionsCandidate: number;
    questionsArchived: number;
    optimizationRuns: number;
    observations: number;
    auditsCurrent: number;
    auditsHistory: number;
    deliverables: number;
  };
  orphans: {
    assets: number;
    questions: number;
    observationsMissingQuestion: number;
    observationsMissingRun: number;
    auditsMissingObservation: number;
    deliverablesMissingRun: number;
  };
  evidenceFiles: {
    totalChecked: number;
    readableCount: number;
    missingPaths: string[];
  };
}

function parseJsonArray<T>(raw: string): T[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function parseDiagnosisJson(raw: string): ResearchQuestion['diagnosis'] {
  const parsed = JSON.parse(raw) as Partial<ResearchQuestion['diagnosis']>;
  return {
    observed: typeof parsed?.observed === 'string' ? parsed.observed : '',
    hypothesis: typeof parsed?.hypothesis === 'string' ? parsed.hypothesis : '',
    nextStep: typeof parsed?.nextStep === 'string' ? parsed.nextStep : '',
  };
}

function rowToObservation(row: RelationalObservationRow): ResearchObservation {
  const embedded = row.id.startsWith('embedded:');
  return {
    ...(!embedded ? { id: row.id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.collected_at ? { collectedAt: row.collected_at } : {}),
    ...(row.entry_type ? { entryType: row.entry_type } : {}),
    engine: row.engine,
    language: row.language,
    query: row.query_text,
    recordedAt: row.recorded_at,
    status: row.status,
    summary: row.summary,
    conditions: row.conditions_text,
    sources: parseSourcesJson(row.sources_json),
    evidencePath: row.evidence_path,
    ...(row.answer_path ? { answerPath: row.answer_path } : {}),
    ...(row.overview_status ? { overviewStatus: row.overview_status } : {}),
  };
}

function rowToQuestion(
  row: RelationalQuestionRow,
  observations: ResearchObservation[],
): ResearchQuestion {
  return {
    id: row.id,
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    ...(row.plan_revision !== null ? { questionPlanRevision: row.plan_revision } : {}),
    ...(row.category ? { category: row.category } : {}),
    zh: row.query_zh,
    en: row.query_en,
    decision: row.decision,
    valueReason: row.intent_summary,
    evidenceBasis: row.evidence_basis,
    answerability: row.answerability,
    gaps: parseJsonArray<string>(row.gaps_json),
    decisionReason: row.decision_reason,
    reviewPath: row.review_path,
    observations,
    diagnosis: parseDiagnosisJson(row.diagnosis_json),
  };
}

type JoinedAuditRow = RelationalAuditRow & {
  batch_id: string;
  question_id: string;
  engine: ResearchObservation['engine'];
  language: 'zh' | 'en';
  recorded_at: string;
  resolved_evidence_path: string;
};

function joinedRowToAudit(row: JoinedAuditRow): AnswerAuditRecord {
  const limitations = parseJsonArray<string>(row.limitations_json);
  return {
    projectId: row.project_id,
    batchId: row.batch_id,
    questionId: row.question_id,
    engine: row.engine,
    language: row.language,
    recordedAt: row.recorded_at,
    mention: row.mention,
    citation: row.citation,
    mentionEvidence: row.mention_evidence,
    citationEvidence: row.citation_evidence,
    officialUrls: parseJsonArray<string>(row.official_urls_json),
    evidencePath: row.resolved_evidence_path,
    answerComplete: row.answer_complete === 1,
    schemaVersion: 1,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.method ? { method: row.method } : {}),
    ...(row.analysis_status ? { analysisStatus: row.analysis_status } : {}),
    ...(row.analysis_model ? { analysisModel: row.analysis_model } : {}),
    ...(row.reasoning_effort
      ? { reasoningEffort: row.reasoning_effort as AnswerAuditRecord['reasoningEffort'] }
      : {}),
    ...(limitations.length || row.method !== null || row.analysis_status !== null
      ? { limitations }
      : {}),
  };
}

function validateAuditInput(input: RelationalAuditInput): void {
  if (!['yes', 'no', 'unknown'].includes(input.mention)) {
    throw new ResearchStoreError('回答审核提及结论必须为 yes、no 或 unknown。');
  }
  if (!['yes', 'no', 'unknown'].includes(input.citation)) {
    throw new ResearchStoreError('回答审核引用结论必须为 yes、no 或 unknown。');
  }
  if (!input.mentionEvidence?.trim() || !input.citationEvidence?.trim()) {
    throw new ResearchStoreError('回答审核依据不能为空。');
  }
  if (input.citation === 'yes' && !input.officialUrls.length) {
    throw new ResearchStoreError('确认引用须保存正文中的官方链接。');
  }
  if (input.citation !== 'yes' && input.officialUrls.length) {
    throw new ResearchStoreError('未确认引用不能保存已确认的正文官方链接。');
  }
  if (!input.answerComplete && (input.mention !== 'unknown' || input.citation !== 'unknown')) {
    throw new ResearchStoreError('正文不完整时审核结论须保留为 unknown。');
  }
}

/**
 * Reconstructs the active `ResearchBatch` for `projectId` strictly from relational tables
 * (`opengeo_projects`, `opengeo_questions`, `opengeo_observations`).
 */
export function readRelationalResearchBatch(
  projectId: string,
  connection?: Database.Database,
): ResearchBatch | null {
  return withProjectDb(
    projectId,
    (db, id) => {
      ensureProjectRelationalData(id, db);
      const projectRow = db
        .prepare('SELECT * FROM opengeo_projects WHERE id = ?')
        .get(id) as RelationalProjectRow | undefined;
      if (!projectRow || !projectRow.active_batch_id) return null;

      const batchId = projectRow.active_batch_id;
      const profile = JSON.parse(projectRow.profile_json) as ProjectProfileMeta;

      const questionRows = db
        .prepare(
          `SELECT * FROM opengeo_questions
           WHERE project_id = ? AND batch_id = ?
           ORDER BY sort_order ASC`,
        )
        .all(id, batchId) as RelationalQuestionRow[];

      const obsRows = db
        .prepare(
          `SELECT * FROM opengeo_observations
           WHERE project_id = ? AND batch_id = ?
           ORDER BY seq ASC`,
        )
        .all(id, batchId) as RelationalObservationRow[];

      const obsByQuestion = new Map<string, ResearchObservation[]>();
      let latestAppendedAt: string | undefined;
      for (const row of obsRows) {
        const list = obsByQuestion.get(row.question_id) ?? [];
        list.push(rowToObservation(row));
        obsByQuestion.set(row.question_id, list);
        if (!row.id.startsWith('embedded:')) {
          latestAppendedAt = row.created_at;
        }
      }

      const questions: ResearchQuestion[] = [];
      const deferredQuestions: ResearchQuestion[] = [];
      for (const qRow of questionRows) {
        const question = rowToQuestion(qRow, obsByQuestion.get(qRow.id) ?? []);
        if (qRow.decision === 'search_now') {
          questions.push(question);
        } else {
          deferredQuestions.push(question);
        }
      }

      const updatedAt = latestAppendedAt ?? profile.initialUpdatedAt;

      return {
        id: batchId,
        date: projectRow.batch_date,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        projectId: id,
        ...(profile.questionPlan ? { questionPlan: profile.questionPlan } : {}),
        productSummary: profile.productSummary,
        contributionSummary: profile.contributionSummary,
        scopeNote: profile.scopeNote,
        reportPath: profile.reportPath ?? '',
        sourceAuditPath: profile.sourceAuditPath ?? '',
        reviewPath: profile.reviewPath ?? '',
        questions,
        deferredQuestions,
        nextStep: profile.nextStep,
      };
    },
    connection,
  );
}

/**
 * Reads current semantic audit verdicts (`WHERE is_current = 1`) via relational JOIN
 * against `opengeo_observations`.
 */
export function readRelationalCurrentAudits(
  projectId: string,
  batchId?: string,
  connection?: Database.Database,
): { records: AnswerAuditRecord[]; updatedAt?: string } {
  return withProjectDb(
    projectId,
    (db, id) => {
      ensureProjectRelationalData(id, db);
      const targetBatchId =
        batchId ??
        (
          db
            .prepare('SELECT active_batch_id FROM opengeo_projects WHERE id = ?')
            .get(id) as { active_batch_id: string } | undefined
        )?.active_batch_id ??
        '';
      if (!targetBatchId) return { records: [] };

      const joinedRows = db
        .prepare(
          `SELECT
            a.*,
            o.batch_id,
            o.question_id,
            o.engine,
            o.language,
            o.recorded_at,
            COALESCE(o.answer_path, o.evidence_path) AS resolved_evidence_path
          FROM opengeo_answer_audits a
          JOIN opengeo_observations o
            ON o.project_id = a.project_id AND o.id = a.observation_id
          WHERE a.project_id = ? AND o.batch_id = ? AND a.is_current = 1
          ORDER BY a.id ASC`,
        )
        .all(id, targetBatchId) as JoinedAuditRow[];

      const records = joinedRows.map(joinedRowToAudit);
      const updatedAt = joinedRows.length
        ? joinedRows.reduce(
            (latest, row) =>
              Date.parse(row.audited_at) > Date.parse(latest) ? row.audited_at : latest,
            joinedRows[0].audited_at,
          )
        : undefined;

      return {
        records,
        ...(updatedAt ? { updatedAt } : {}),
      };
    },
    connection,
  );
}

/**
 * Computes full Overview (`ResearchBatch` + `answerAudits` + `overviewMetrics`)
 * directly from relational SQLite tables.
 */
export function readRelationalOverview(
  projectId: string,
  connection?: Database.Database,
): ResearchBatch | null {
  return withProjectDb(
    projectId,
    (db, id) => {
      const batch = readRelationalResearchBatch(id, db);
      if (!batch) return null;

      const { records: answerAudits, updatedAt: auditUpdatedAt } = readRelationalCurrentAudits(
        id,
        batch.id,
        db,
      );

      const overviewMetrics: OverviewMetricScopes = {};
      for (const language of ['zh', 'en'] as const) {
        for (const engine of ['all', ...RESEARCH_ENGINES] as const) {
          const rows = auditRows(
            batch,
            getResearchRows(batch, { language, engine, kind: 'all', result: 'all' }),
            answerAudits,
          );
          overviewMetrics[`${language}:${engine}`] = {
            mention: summarizeMetric(rows, 'mention'),
            citation: summarizeMetric(rows, 'citation'),
          };
        }
      }

      const citationUpdatedAt = readCompetitorCitationAuditData(id, batch.id).updatedAt;
      const updatedAt = [batch.updatedAt ?? batch.date, auditUpdatedAt, citationUpdatedAt]
        .filter((value): value is string => Boolean(value))
        .sort((left, right) => Date.parse(right) - Date.parse(left))[0];

      return {
        ...batch,
        ...(updatedAt ? { updatedAt } : {}),
        answerAudits,
        overviewMetrics,
      };
    },
    connection,
  );
}

/**
 * Appends a new semantic audit revision for `observationId`, atomically marking any
 * previous `is_current = 1` row as `0` and enforcing FK + partial unique index invariants.
 */
export function saveRelationalAuditRevision(
  projectId: string,
  observationId: string,
  input: RelationalAuditInput,
  connection?: Database.Database,
): AnswerAuditRecord {
  validateAuditInput(input);
  return withProjectDb(
    projectId,
    (db, id) => {
      const tx = db.transaction(() => {
        const latestRow = db
          .prepare('SELECT MAX(audited_at) AS latest FROM opengeo_answer_audits WHERE project_id = ?')
          .get(id) as { latest: string | null };
        const auditedAt = new Date(
          Math.max(Date.now(), latestRow.latest ? Date.parse(latestRow.latest) + 1 : 0),
        ).toISOString();
        const reviewedAt = input.reviewedAt ?? auditedAt;

        db.prepare(
          `UPDATE opengeo_answer_audits
           SET is_current = 0
           WHERE project_id = ? AND observation_id = ? AND is_current = 1`,
        ).run(id, observationId);

        const info = db
          .prepare(
            `INSERT INTO opengeo_answer_audits (
              project_id, observation_id, is_current, mention, citation,
              mention_evidence, citation_evidence, official_urls_json, answer_complete,
              analysis_status, method, analysis_model, reasoning_effort,
              limitations_json, reviewed_at, audited_at
            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            observationId,
            input.mention,
            input.citation,
            input.mentionEvidence.trim(),
            input.citationEvidence.trim(),
            JSON.stringify(input.officialUrls),
            input.answerComplete ? 1 : 0,
            input.analysisStatus ?? null,
            input.method ?? null,
            input.analysisModel ?? null,
            input.reasoningEffort ?? null,
            JSON.stringify(input.limitations ?? []),
            reviewedAt,
            auditedAt,
          );

        const joined = db
          .prepare(
            `SELECT
              a.*,
              o.batch_id,
              o.question_id,
              o.engine,
              o.language,
              o.recorded_at,
              COALESCE(o.answer_path, o.evidence_path) AS resolved_evidence_path
            FROM opengeo_answer_audits a
            JOIN opengeo_observations o
              ON o.project_id = a.project_id AND o.id = a.observation_id
            WHERE a.id = ?`,
          )
          .get(info.lastInsertRowid) as JoinedAuditRow;

        return joinedRowToAudit(joined);
      });

      return db.inTransaction ? tx() : tx.immediate();
    },
    connection,
  );
}

/**
 * End-to-end ingestion pipeline:
 * 1) Validates & inserts new observation into `opengeo_observations` (strict FK to `opengeo_questions`)
 * 2) Runs automatic semantic audit (`options.auditor` or `analyzeResearchObservation`) -> `opengeo_answer_audits`
 * 3) Returns updated relational overview (`{ observationId, observation, audit, overview }`)
 */
export async function ingestRelationalObservation(
  input: IngestObservationInput,
  options: IngestObservationOptions = {},
): Promise<{
  observationId: string;
  observation: ResearchObservation;
  audit: AnswerAuditRecord;
  overview: ResearchBatch;
}> {
  const resolvedProjectId = resolveGeoProject(input.projectId);
  const { observationId, savedObservation, batchSnapshot } = withProjectDb(
    resolvedProjectId,
    (db, id) => {
      ensureProjectRelationalData(id, db);
      const projectRow = db
        .prepare('SELECT active_batch_id FROM opengeo_projects WHERE id = ?')
        .get(id) as { active_batch_id: string } | undefined;
      const batchId = input.batchId ?? projectRow?.active_batch_id ?? '';
      if (!batchId) {
        throw new ResearchStoreError('当前项目尚未初始化有效的问题批次。', 404);
      }

      const qRow = db
        .prepare('SELECT * FROM opengeo_questions WHERE project_id = ? AND id = ?')
        .get(id, input.questionId) as RelationalQuestionRow | undefined;
      if (qRow) {
        const expectedQuery = input.observation.language === 'zh' ? qRow.query_zh : qRow.query_en;
        if (expectedQuery && input.observation.query !== expectedQuery) {
          throw new ResearchStoreError('采集问法必须与研究题目的对应语言原文一致。');
        }
      }

      const obsId =
        input.observation.id ||
        `obs:${input.observation.runId ?? Date.now()}:${input.questionId}:${input.observation.engine}:${input.observation.language}`;
      const createdAt = new Date().toISOString();
      const saved: ResearchObservation = { ...input.observation, id: obsId };

      const tx = db.transaction(() => {
        // Note: if input.questionId or input.optimizationRunId does not exist,
        // SQLite `PRAGMA foreign_keys = ON` rejects this INSERT with SQLITE_CONSTRAINT_FOREIGNKEY.
        db.prepare(
          `INSERT INTO opengeo_observations (
            project_id, id, batch_id, question_id, optimization_run_id, run_id,
            engine, language, entry_type, overview_status, query_text, status,
            summary, answer_path, evidence_path, sources_json, conditions_text,
            recorded_at, collected_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          obsId,
          batchId,
          input.questionId,
          input.optimizationRunId ?? null,
          saved.runId ?? null,
          saved.engine,
          saved.language,
          saved.entryType ?? null,
          saved.overviewStatus ?? null,
          saved.query,
          saved.status,
          saved.summary ?? '',
          saved.answerPath ?? null,
          saved.evidencePath,
          JSON.stringify(saved.sources ?? []),
          saved.conditions ?? '',
          saved.recordedAt,
          saved.collectedAt ?? null,
          createdAt,
        );

        db.prepare('UPDATE opengeo_projects SET updated_at = ? WHERE id = ?').run(createdAt, id);
      });

      if (db.inTransaction) tx();
      else tx.immediate();

      const batch = readRelationalResearchBatch(id, db);
      if (!batch) {
        throw new ResearchStoreError('无法读取当前研究批次。', 500);
      }

      return { observationId: obsId, savedObservation: saved, batchSnapshot: batch };
    },
    options.connection,
  );

  let persistedAudit: AnswerAuditRecord | undefined;
  if (options.auditor) {
    const verdict = await options.auditor({
      batch: batchSnapshot,
      questionId: input.questionId,
      observation: savedObservation,
      answer: input.answer,
    });
    persistedAudit = saveRelationalAuditRevision(
      resolvedProjectId,
      observationId,
      verdict,
      options.connection,
    );
  } else {
    await analyzeResearchObservation(
      batchSnapshot,
      input.questionId,
      savedObservation,
      input.answer,
      {
        model: options.model,
        persist: (auditRecord) => {
          persistedAudit = saveRelationalAuditRevision(
            resolvedProjectId,
            observationId,
            {
              mention: auditRecord.mention,
              citation: auditRecord.citation,
              mentionEvidence: auditRecord.mentionEvidence,
              citationEvidence: auditRecord.citationEvidence,
              officialUrls: auditRecord.officialUrls,
              answerComplete: auditRecord.answerComplete,
              analysisStatus: auditRecord.analysisStatus,
              method: auditRecord.method,
              analysisModel: auditRecord.analysisModel,
              reasoningEffort: auditRecord.reasoningEffort,
              limitations: auditRecord.limitations,
              reviewedAt: auditRecord.reviewedAt,
            },
            options.connection,
          );
        },
      },
    );
  }

  const overview = readRelationalOverview(resolvedProjectId, options.connection);
  if (!persistedAudit || !overview) {
    throw new ResearchStoreError('观测审核入库或总览汇总未完成。', 500);
  }

  return {
    observationId,
    observation: savedObservation,
    audit: persistedAudit,
    overview,
  };
}

/**
 * Runs structural, foreign-key, orphan, and on-disk evidence file verification
 * across all 7 relational tables for `projectId`.
 */
export function getRelationalIntegrityReport(
  projectId: string,
  connection?: Database.Database,
): RelationalIntegrityReport {
  return withProjectDb(
    projectId,
    (db, id) => {
      ensureProjectRelationalData(id, db);

      const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) === 1;
      const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];

      const existingTables = new Set(
        (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as { name: string }[]
        ).map((row) => row.name),
      );
      const tablesPresent = RELATIONAL_TABLES.filter((table) => existingTables.has(table));

      const projectRow = db
        .prepare('SELECT active_batch_id FROM opengeo_projects WHERE id = ?')
        .get(id) as { active_batch_id: string } | undefined;

      const scalar = (sql: string, ...params: unknown[]): number =>
        Number((db.prepare(sql).get(...params) as { n: number }).n);

      const counts = {
        projects: scalar('SELECT COUNT(*) AS n FROM opengeo_projects WHERE id = ?', id),
        assets: scalar('SELECT COUNT(*) AS n FROM opengeo_assets WHERE project_id = ?', id),
        questionsActive: scalar(
          "SELECT COUNT(*) AS n FROM opengeo_questions WHERE project_id = ? AND status = 'active'",
          id,
        ),
        questionsCandidate: scalar(
          "SELECT COUNT(*) AS n FROM opengeo_questions WHERE project_id = ? AND status = 'candidate'",
          id,
        ),
        questionsArchived: scalar(
          "SELECT COUNT(*) AS n FROM opengeo_questions WHERE project_id = ? AND status = 'archived'",
          id,
        ),
        optimizationRuns: scalar(
          'SELECT COUNT(*) AS n FROM opengeo_optimization_runs WHERE project_id = ?',
          id,
        ),
        observations: scalar(
          'SELECT COUNT(*) AS n FROM opengeo_observations WHERE project_id = ?',
          id,
        ),
        auditsCurrent: scalar(
          'SELECT COUNT(*) AS n FROM opengeo_answer_audits WHERE project_id = ? AND is_current = 1',
          id,
        ),
        auditsHistory: scalar(
          'SELECT COUNT(*) AS n FROM opengeo_answer_audits WHERE project_id = ? AND is_current = 0',
          id,
        ),
        deliverables: scalar(
          'SELECT COUNT(*) AS n FROM opengeo_deliverables WHERE project_id = ?',
          id,
        ),
      };

      const orphans = {
        assets: scalar(
          `SELECT COUNT(*) AS n FROM opengeo_assets a
           LEFT JOIN opengeo_projects p ON p.id = a.project_id
           WHERE a.project_id = ? AND p.id IS NULL`,
          id,
        ),
        questions: scalar(
          `SELECT COUNT(*) AS n FROM opengeo_questions q
           LEFT JOIN opengeo_projects p ON p.id = q.project_id
           WHERE q.project_id = ? AND p.id IS NULL`,
          id,
        ),
        observationsMissingQuestion: scalar(
          `SELECT COUNT(*) AS n FROM opengeo_observations o
           LEFT JOIN opengeo_questions q ON q.project_id = o.project_id AND q.id = o.question_id
           WHERE o.project_id = ? AND q.id IS NULL`,
          id,
        ),
        observationsMissingRun: scalar(
          `SELECT COUNT(*) AS n FROM opengeo_observations o
           LEFT JOIN opengeo_optimization_runs r ON r.project_id = o.project_id AND r.id = o.optimization_run_id
           WHERE o.project_id = ? AND o.optimization_run_id IS NOT NULL AND r.id IS NULL`,
          id,
        ),
        auditsMissingObservation: scalar(
          `SELECT COUNT(*) AS n FROM opengeo_answer_audits a
           LEFT JOIN opengeo_observations o ON o.project_id = a.project_id AND o.id = a.observation_id
           WHERE a.project_id = ? AND o.id IS NULL`,
          id,
        ),
        deliverablesMissingRun: scalar(
          `SELECT COUNT(*) AS n FROM opengeo_deliverables d
           LEFT JOIN opengeo_optimization_runs r ON r.project_id = d.project_id AND r.id = d.run_id
           WHERE d.project_id = ? AND r.id IS NULL`,
          id,
        ),
      };

      const obsPaths = db
        .prepare(
          'SELECT evidence_path, answer_path FROM opengeo_observations WHERE project_id = ? ORDER BY seq ASC',
        )
        .all(id) as { evidence_path: string; answer_path: string | null }[];

      const uniquePaths = new Set<string>();
      for (const row of obsPaths) {
        if (row.evidence_path) uniquePaths.add(row.evidence_path);
        if (row.answer_path) uniquePaths.add(row.answer_path);
      }

      const missingPaths: string[] = [];
      let readableCount = 0;
      withGeoProject(id, () => {
        for (const relPath of uniquePaths) {
          const { target } = evidenceLocation(relPath);
          if (fs.existsSync(target)) {
            readableCount += 1;
          } else {
            missingPaths.push(relPath);
          }
        }
      });

      return {
        projectId: id,
        activeBatchId: projectRow?.active_batch_id ?? '',
        foreignKeysEnabled,
        foreignKeyViolations,
        tablesPresent: [...tablesPresent],
        counts,
        orphans,
        evidenceFiles: {
          totalChecked: uniquePaths.size,
          readableCount,
          missingPaths,
        },
      };
    },
    connection,
  );
}

import type Database from 'better-sqlite3';
import { resolveAssetOwnership } from '../asset-ownership';
import type { AnswerAuditRecord } from '../overview-metrics';
import { loadInitialResearch, loadLegacyAnswerAudit, loadProjectSeed } from '../project-data';
import type { ResearchBatch, ResearchObservation, ResearchQuestion } from '../research-types';
import {
  configureSqliteConnection,
  type ProjectProfileMeta,
  type QuestionStatus,
  type RelationalObservationRow,
  withProjectDb,
} from './schema';

export interface MigrationSummary {
  projectId: string;
  activeBatchId: string;
  assetsUpserted: number;
  questionsUpserted: number;
  observationsInserted: number;
  auditsInserted: number;
}

export function questionStatusFromDecision(decision: ResearchQuestion['decision']): QuestionStatus {
  if (decision === 'search_now') return 'active';
  if (decision === 'keep_and_fill') return 'candidate';
  return 'archived';
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  );
}

function runInTransaction<T>(db: Database.Database, fn: () => T): T {
  const tx = db.transaction(fn);
  return db.inTransaction ? tx() : tx.immediate();
}

function loadSourceBatches(db: Database.Database, projectId: string): ResearchBatch[] {
  if (tableExists(db, 'geo_research_batches')) {
    const rows = db
      .prepare('SELECT payload FROM geo_research_batches WHERE project_id = ? ORDER BY seq ASC')
      .all(projectId) as { payload: string }[];
    if (rows.length > 0) {
      return rows.map((row) => JSON.parse(row.payload) as ResearchBatch);
    }
  }
  return loadInitialResearch().filter((batch) => batch.projectId === projectId);
}

function insertObservationIfMissing(
  db: Database.Database,
  params: {
    projectId: string;
    id: string;
    batchId: string;
    questionId: string;
    optimizationRunId?: string | null;
    observation: ResearchObservation;
    createdAt: string;
  },
): boolean {
  const { projectId, id, batchId, questionId, optimizationRunId = null, observation, createdAt } = params;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO opengeo_observations (
        project_id, id, batch_id, question_id, optimization_run_id, run_id,
        engine, language, entry_type, overview_status, query_text, status,
        summary, answer_path, evidence_path, sources_json, conditions_text,
        recorded_at, collected_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      projectId,
      id,
      batchId,
      questionId,
      optimizationRunId,
      observation.runId ?? null,
      observation.engine,
      observation.language,
      observation.entryType ?? null,
      observation.overviewStatus ?? null,
      observation.query,
      observation.status,
      observation.summary ?? '',
      observation.answerPath ?? null,
      observation.evidencePath,
      JSON.stringify(observation.sources ?? []),
      observation.conditions ?? '',
      observation.recordedAt,
      observation.collectedAt ?? null,
      createdAt,
    );
  return result.changes > 0;
}

function findMatchingObservationId(
  db: Database.Database,
  record: AnswerAuditRecord,
): string | null {
  const matches = db
    .prepare(
      `SELECT id
       FROM opengeo_observations
       WHERE project_id = ?
         AND batch_id = ?
         AND question_id = ?
         AND engine = ?
         AND language = ?
         AND recorded_at = ?
         AND COALESCE(answer_path, evidence_path) = ?`,
    )
    .all(
      record.projectId,
      record.batchId,
      record.questionId,
      record.engine,
      record.language,
      record.recordedAt,
      record.evidencePath,
    ) as Pick<RelationalObservationRow, 'id'>[];
  return matches.length === 1 ? matches[0].id : null;
}

function appendAuditIfMissing(
  db: Database.Database,
  observationId: string,
  record: AnswerAuditRecord,
  auditedAt: string,
): boolean {
  const alreadyExists = db
    .prepare(
      `SELECT 1
       FROM opengeo_answer_audits
       WHERE project_id = ? AND observation_id = ? AND audited_at = ?`,
    )
    .get(record.projectId, observationId, auditedAt);
  if (alreadyExists) return false;

  db.prepare(
    `UPDATE opengeo_answer_audits
     SET is_current = 0
     WHERE project_id = ? AND observation_id = ? AND is_current = 1`,
  ).run(record.projectId, observationId);

  db.prepare(
    `INSERT INTO opengeo_answer_audits (
      project_id, observation_id, is_current, mention, citation,
      mention_evidence, citation_evidence, official_urls_json, answer_complete,
      analysis_status, method, analysis_model, reasoning_effort,
      limitations_json, reviewed_at, audited_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.projectId,
    observationId,
    record.mention,
    record.citation,
    record.mentionEvidence,
    record.citationEvidence,
    JSON.stringify(record.officialUrls ?? []),
    record.answerComplete ? 1 : 0,
    record.analysisStatus ?? null,
    record.method ?? null,
    record.analysisModel ?? null,
    record.reasoningEffort ?? null,
    JSON.stringify(record.limitations ?? []),
    record.reviewedAt ?? auditedAt,
    auditedAt,
  );
  return true;
}

/**
 * Idempotently ensures the 7-table relational schema is populated for `projectId`
 * from its project seed, active research batch, observations, and semantic audits.
 */
export function ensureProjectRelationalData(
  projectId: string,
  connection?: Database.Database,
): MigrationSummary {
  return withProjectDb(
    projectId,
    (db, id) => {
      const seed = loadProjectSeed(id);
      const batches = loadSourceBatches(db, id);
      const latestBatch = batches.at(-1) ?? null;

      return runInTransaction(db, () => {
        const now = new Date().toISOString();
        const createdAt =
          latestBatch?.questionPlan?.createdAt ??
          latestBatch?.date ??
          seed.project.asOf ??
          now;
        let updatedAt = latestBatch?.updatedAt ?? latestBatch?.date ?? seed.project.asOf ?? now;

        const profile: ProjectProfileMeta = {
          productSummary: latestBatch?.productSummary ?? '',
          contributionSummary: latestBatch?.contributionSummary ?? '',
          scopeNote: latestBatch?.scopeNote ?? '',
          nextStep: latestBatch?.nextStep ?? '',
          asOf: seed.project.asOf,
          ...(latestBatch?.updatedAt !== undefined
            ? { initialUpdatedAt: latestBatch.updatedAt }
            : {}),
          ...(latestBatch?.reportPath !== undefined ? { reportPath: latestBatch.reportPath } : {}),
          ...(latestBatch?.sourceAuditPath !== undefined
            ? { sourceAuditPath: latestBatch.sourceAuditPath }
            : {}),
          ...(latestBatch?.reviewPath !== undefined ? { reviewPath: latestBatch.reviewPath } : {}),
          ...(latestBatch?.questionPlan ? { questionPlan: latestBatch.questionPlan } : {}),
        };

        db.prepare(
          `INSERT INTO opengeo_projects (
            id, name, description, site_url, repo_url, owner,
            active_batch_id, batch_date, profile_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            site_url = excluded.site_url,
            repo_url = excluded.repo_url,
            owner = excluded.owner,
            active_batch_id = excluded.active_batch_id,
            batch_date = excluded.batch_date,
            profile_json = excluded.profile_json,
            updated_at = excluded.updated_at`,
        ).run(
          id,
          seed.project.name,
          seed.project.description ?? '',
          seed.project.siteUrl ?? '',
          seed.project.repositoryUrl ?? '',
          seed.project.owner ?? '',
          latestBatch?.id ?? '',
          latestBatch?.date ?? '',
          JSON.stringify(profile),
          createdAt,
          updatedAt,
        );

        const upsertAsset = db.prepare(
          `INSERT INTO opengeo_assets (
            project_id, id, ownership, type, language, status,
            title, summary, public_url, content_path, published_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, id) DO UPDATE SET
            ownership = excluded.ownership,
            type = excluded.type,
            language = excluded.language,
            status = excluded.status,
            title = excluded.title,
            summary = excluded.summary,
            public_url = excluded.public_url,
            content_path = excluded.content_path,
            published_at = excluded.published_at,
            updated_at = excluded.updated_at`,
        );

        for (const asset of seed.assets) {
          const { ownership } = resolveAssetOwnership(asset, seed);
          upsertAsset.run(
            id,
            asset.id,
            ownership,
            asset.type,
            asset.language || 'zh',
            asset.status || 'published',
            asset.title,
            asset.summary ?? '',
            asset.publicUrl ?? null,
            asset.sourcePath ?? '',
            asset.publishedAt ?? null,
            asset.publishedAt ?? createdAt,
            updatedAt,
          );
        }

        const insertHistoricalQuestion = db.prepare(
          `INSERT OR IGNORE INTO opengeo_questions (
            project_id, id, batch_id, status, decision, category, candidate_id, plan_revision,
            sort_order, query_zh, query_en, intent_summary, evidence_basis, answerability,
            decision_reason, review_path, gaps_json, diagnosis_json, created_at, updated_at
          ) VALUES (?, ?, ?, 'archived', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        for (const olderBatch of batches.slice(0, -1)) {
          const olderQuestions = [...olderBatch.questions, ...olderBatch.deferredQuestions];
          olderQuestions.forEach((question, idx) => {
            insertHistoricalQuestion.run(
              id,
              question.id,
              olderBatch.id,
              question.decision,
              question.category ?? null,
              question.candidateId ?? null,
              question.questionPlanRevision ?? null,
              idx,
              question.zh ?? '',
              question.en ?? '',
              question.valueReason ?? '',
              question.evidenceBasis ?? '',
              question.answerability ?? '',
              question.decisionReason ?? '',
              question.reviewPath ?? '',
              JSON.stringify(question.gaps ?? []),
              JSON.stringify(question.diagnosis ?? { observed: '', hypothesis: '', nextStep: '' }),
              olderBatch.date,
              olderBatch.updatedAt ?? olderBatch.date,
            );
          });
        }

        let questionsUpserted = 0;
        if (latestBatch) {
          const activeQuestions = [...latestBatch.questions, ...latestBatch.deferredQuestions];
          const activeIds = new Set(activeQuestions.map((q) => q.id));
          const existingIds = db
            .prepare('SELECT id FROM opengeo_questions WHERE project_id = ?')
            .all(id) as { id: string }[];
          const archiveQuestion = db.prepare(
            "UPDATE opengeo_questions SET status = 'archived' WHERE project_id = ? AND id = ?",
          );
          for (const row of existingIds) {
            if (!activeIds.has(row.id)) {
              archiveQuestion.run(id, row.id);
            }
          }

          const upsertQuestion = db.prepare(
            `INSERT INTO opengeo_questions (
              project_id, id, batch_id, status, decision, category, candidate_id, plan_revision,
              sort_order, query_zh, query_en, intent_summary, evidence_basis, answerability,
              decision_reason, review_path, gaps_json, diagnosis_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_id, id) DO UPDATE SET
              batch_id = excluded.batch_id,
              status = excluded.status,
              decision = excluded.decision,
              category = excluded.category,
              candidate_id = excluded.candidate_id,
              plan_revision = excluded.plan_revision,
              sort_order = excluded.sort_order,
              query_zh = excluded.query_zh,
              query_en = excluded.query_en,
              intent_summary = excluded.intent_summary,
              evidence_basis = excluded.evidence_basis,
              answerability = excluded.answerability,
              decision_reason = excluded.decision_reason,
              review_path = excluded.review_path,
              gaps_json = excluded.gaps_json,
              diagnosis_json = excluded.diagnosis_json,
              updated_at = excluded.updated_at`,
          );

          activeQuestions.forEach((question, idx) => {
            upsertQuestion.run(
              id,
              question.id,
              latestBatch.id,
              questionStatusFromDecision(question.decision),
              question.decision,
              question.category ?? null,
              question.candidateId ?? null,
              question.questionPlanRevision ?? null,
              idx,
              question.zh ?? '',
              question.en ?? '',
              question.valueReason ?? '',
              question.evidenceBasis ?? '',
              question.answerability ?? '',
              question.decisionReason ?? '',
              question.reviewPath ?? '',
              JSON.stringify(question.gaps ?? []),
              JSON.stringify(question.diagnosis ?? { observed: '', hypothesis: '', nextStep: '' }),
              createdAt,
              updatedAt,
            );
            questionsUpserted += 1;
          });
        }

        let observationsInserted = 0;
        for (const batch of batches) {
          for (const question of [...batch.questions, ...batch.deferredQuestions]) {
            question.observations.forEach((obs, obsIndex) => {
              const obsId = obs.id || `embedded:${batch.id}:${question.id}:${obsIndex}`;
              if (
                insertObservationIfMissing(db, {
                  projectId: id,
                  id: obsId,
                  batchId: batch.id,
                  questionId: question.id,
                  observation: obs,
                  createdAt: obs.collectedAt ?? obs.recordedAt,
                })
              ) {
                observationsInserted += 1;
              }
            });
          }
        }

        if (tableExists(db, 'geo_research_observations')) {
          const obsRows = db
            .prepare(
              `SELECT id, batch_id, question_id, run_id, payload, appended_at
               FROM geo_research_observations
               WHERE project_id = ?
               ORDER BY seq ASC`,
            )
            .all(id) as {
            id: string;
            batch_id: string;
            question_id: string;
            run_id: string;
            payload: string;
            appended_at: string;
          }[];

          for (const row of obsRows) {
            const obs = JSON.parse(row.payload) as ResearchObservation;
            const obsId = obs.id || row.id;
            if (
              insertObservationIfMissing(db, {
                projectId: id,
                id: obsId,
                batchId: row.batch_id,
                questionId: row.question_id,
                observation: { ...obs, runId: obs.runId ?? row.run_id },
                createdAt: row.appended_at,
              })
            ) {
              observationsInserted += 1;
            }
            if (row.batch_id === latestBatch?.id) {
              updatedAt = row.appended_at;
            }
          }

          if (latestBatch && updatedAt !== (latestBatch.updatedAt ?? latestBatch.date)) {
            db.prepare('UPDATE opengeo_projects SET updated_at = ? WHERE id = ?').run(
              updatedAt,
              id,
            );
          }
        }

        let auditsInserted = 0;
        const hasAuditTable = tableExists(db, 'geo_answer_audits');
        const auditRows = hasAuditTable
          ? (db
              .prepare(
                `SELECT payload, appended_at
                 FROM geo_answer_audits
                 WHERE project_id = ?
                 ORDER BY seq ASC`,
              )
              .all(id) as { payload: string; appended_at: string }[])
          : [];

        if (!auditRows.length && latestBatch) {
          const legacyAudit = loadLegacyAnswerAudit();
          for (const raw of legacyAudit.records) {
            if (raw.projectId !== id || raw.batchId !== latestBatch.id) continue;
            const normalized: AnswerAuditRecord = {
              ...raw,
              schemaVersion: 1,
              reviewedAt: legacyAudit.reviewedAt,
              method: 'legacy',
              analysisStatus:
                raw.mention === 'unknown' || raw.citation === 'unknown'
                  ? 'needs_review'
                  : 'complete',
              limitations: [legacyAudit.scope.limits],
            };
            const observationId = findMatchingObservationId(db, normalized);
            if (
              observationId &&
              appendAuditIfMissing(db, observationId, normalized, legacyAudit.reviewedAt)
            ) {
              auditsInserted += 1;
            }
          }
        }

        for (const row of auditRows) {
          const record = JSON.parse(row.payload) as AnswerAuditRecord;
          const observationId = findMatchingObservationId(db, record);
          if (observationId && appendAuditIfMissing(db, observationId, record, row.appended_at)) {
            auditsInserted += 1;
          }
        }

        return {
          projectId: id,
          activeBatchId: latestBatch?.id ?? '',
          assetsUpserted: seed.assets.length,
          questionsUpserted,
          observationsInserted,
          auditsInserted,
        };
      });
    },
    connection,
  );
}

/** Syncs a newly saved observation from `research-store.ts` into `opengeo_observations`. */
export function syncObservationToRelational(
  db: Database.Database,
  projectId: string,
  batchId: string,
  questionId: string,
  observation: ResearchObservation,
  appendedAt: string,
): void {
  configureSqliteConnection(db);
  const hasQuestion = db
    .prepare('SELECT 1 FROM opengeo_questions WHERE project_id = ? AND id = ?')
    .get(projectId, questionId);
  if (!hasQuestion) {
    ensureProjectRelationalData(projectId, db);
  }
  const obsId =
    observation.id ||
    `run:${observation.runId ?? 'manual'}:${questionId}:${observation.engine}:${observation.language}`;
  insertObservationIfMissing(db, {
    projectId,
    id: obsId,
    batchId,
    questionId,
    observation,
    createdAt: appendedAt,
  });
  db.prepare(
    'UPDATE opengeo_projects SET updated_at = ? WHERE id = ? AND active_batch_id = ?',
  ).run(appendedAt, projectId, batchId);
}

/** Syncs a newly saved semantic audit from `answer-audit-store.ts` into `opengeo_answer_audits`. */
export function syncAuditToRelational(
  db: Database.Database,
  record: AnswerAuditRecord,
  appendedAt: string,
): void {
  configureSqliteConnection(db);
  let observationId = findMatchingObservationId(db, record);
  if (!observationId) {
    ensureProjectRelationalData(record.projectId, db);
    observationId = findMatchingObservationId(db, record);
  }
  if (observationId) {
    appendAuditIfMissing(db, observationId, record, appendedAt);
  }
}

import { randomUUID } from 'node:crypto';
import type { HumanProgressStep } from '../../agent-hub';
import {
  ensureProjectRelationalData,
  withProjectDb,
  type DeliverableFormat,
  type DeliverableKind,
  type DeliverableStatus,
  type OptimizationRunMode,
  type OptimizationRunStatus,
  type RelationalDeliverableRow,
  type RelationalOptimizationRunRow,
} from '../db';
import type { ResearchEngine } from '../research-types';
import {
  RUN_STATUS_LABELS,
  type DeliverableAppliedRecord,
  type DeliverableCompanionFile,
  type DeliverableMediaItem,
  type DeliverableReviewResult,
  type OptimizationDeliverable,
  type OptimizationRun,
  type OptimizationRunViewModel,
  type ReferenceWinner,
  type RetestComparisonSummary,
  type RetestQuestionComparison,
} from './types';

export class OptimizationStateError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export const LEGAL_RUN_TRANSITIONS: Record<OptimizationRunStatus, OptimizationRunStatus[]> = {
  planning: ['drafting', 'failed'],
  drafting: ['reviewing', 'failed'],
  reviewing: ['drafting', 'awaiting_approval', 'failed'],
  awaiting_approval: ['implementing', 'remeasuring', 'failed'],
  implementing: ['awaiting_retest', 'awaiting_approval', 'failed'],
  awaiting_retest: ['remeasuring', 'implementing', 'failed'],
  remeasuring: ['completed', 'awaiting_retest', 'failed'],
  completed: ['remeasuring', 'implementing'],
  failed: ['planning', 'drafting'],
};

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToDeliverable(row: RelationalDeliverableRow): OptimizationDeliverable {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    priority: row.priority,
    kind: row.kind,
    format: row.format,
    status: row.status,
    title: row.title,
    targetAssetId: row.target_asset_id,
    destination: row.destination,
    audienceAndGoal: row.audience_and_goal,
    questionIds: parseJsonSafe<string[]>(row.question_ids_json, []),
    beforeContent: row.before_content,
    afterContent: row.after_content,
    mediaManifest: parseJsonSafe<DeliverableMediaItem[]>(row.media_manifest_json, []),
    companionFiles: parseJsonSafe<DeliverableCompanionFile[]>(row.companion_files_json ?? '[]', []),
    referenceWinners: parseJsonSafe<ReferenceWinner[]>(row.reference_winners_json ?? '[]', []),
    review: parseJsonSafe<DeliverableReviewResult | null>(row.review_json, null),
    appliedRecord: parseJsonSafe<DeliverableAppliedRecord | null>(row.applied_record_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRun(
  row: RelationalOptimizationRunRow,
  deliverables: OptimizationDeliverable[],
): OptimizationRun {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    status: row.status,
    statusMessage: row.status_message,
    summary: row.summary,
    progress: parseJsonSafe<HumanProgressStep[]>(row.progress_json, []),
    baselineObservationIds: parseJsonSafe<string[]>(row.baseline_obs_ids_json, []),
    followupObservationIds: parseJsonSafe<string[]>(row.followup_obs_ids_json, []),
    errorMessage: row.error_message,
    deliverables,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function captureBaselineObservationIds(projectId: string): string[] {
  return withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const rows = db
      .prepare(
        `SELECT o.id, o.question_id, o.engine, o.language
         FROM opengeo_observations o
         JOIN opengeo_questions q ON q.project_id = o.project_id AND q.id = o.question_id
         WHERE o.project_id = ? AND q.status = 'active'
         ORDER BY o.seq DESC`,
      )
      .all(id) as Array<{ id: string; question_id: string; engine: string; language: string }>;

    const seen = new Set<string>();
    const latestIds: string[] = [];
    for (const r of rows) {
      const slot = `${r.question_id}::${r.engine}::${r.language}`;
      if (!seen.has(slot)) {
        seen.add(slot);
        latestIds.push(r.id);
      }
    }
    return latestIds;
  });
}

export function createOptimizationRunRecord(
  projectId: string,
  mode: OptimizationRunMode,
  initialMessage: string,
): OptimizationRun {
  const baselineIds = captureBaselineObservationIds(projectId);
  return withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const now = new Date().toISOString();
    const runId = `opt-${randomUUID().slice(0, 12)}`;
    const initialProgress: HumanProgressStep[] = [
      { at: now, agentId: 'optimization-engine', kind: 'start', message: initialMessage },
    ];
    db.prepare(
      `INSERT INTO opengeo_optimization_runs (
        id, project_id, mode, status, status_message, summary, progress_json,
        baseline_obs_ids_json, followup_obs_ids_json, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, 'planning', ?, '', ?, ?, '[]', NULL, ?, ?)`,
    ).run(
      runId,
      id,
      mode,
      initialMessage,
      JSON.stringify(initialProgress),
      JSON.stringify(baselineIds),
      now,
      now,
    );
    return getOptimizationRun(id, runId, db)!;
  });
}

export function getOptimizationRun(
  projectId: string,
  runId: string,
  existingDb?: Parameters<Parameters<typeof withProjectDb>[1]>[0],
): OptimizationRun | null {
  return withProjectDb(
    projectId,
    (db, id) => {
      ensureProjectRelationalData(id, db);
      const row = db
        .prepare('SELECT * FROM opengeo_optimization_runs WHERE project_id = ? AND id = ?')
        .get(id, runId) as RelationalOptimizationRunRow | undefined;
      if (!row) return null;
      const delivRows = db
        .prepare(
          'SELECT * FROM opengeo_deliverables WHERE project_id = ? AND run_id = ? ORDER BY priority ASC, created_at ASC',
        )
        .all(id, runId) as RelationalDeliverableRow[];
      return rowToRun(row, delivRows.map(rowToDeliverable));
    },
    existingDb,
  );
}

export function getLatestOptimizationRun(projectId: string): OptimizationRun | null {
  return withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const row = db
      .prepare(
        'SELECT * FROM opengeo_optimization_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(id) as RelationalOptimizationRunRow | undefined;
    if (!row) return null;
    return getOptimizationRun(id, row.id, db);
  });
}

export function listOptimizationRuns(projectId: string): OptimizationRun[] {
  return withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const rows = db
      .prepare('SELECT id FROM opengeo_optimization_runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(id) as Array<{ id: string }>;
    return rows.map((r) => getOptimizationRun(id, r.id, db)!).filter(Boolean);
  });
}

export function appendRunProgress(
  projectId: string,
  runId: string,
  step: HumanProgressStep,
): void {
  withProjectDb(projectId, (db, id) => {
    const row = db
      .prepare('SELECT progress_json FROM opengeo_optimization_runs WHERE project_id = ? AND id = ?')
      .get(id, runId) as { progress_json: string } | undefined;
    if (!row) return;
    const progress = parseJsonSafe<HumanProgressStep[]>(row.progress_json, []);
    progress.push(step);
    db.prepare(
      `UPDATE opengeo_optimization_runs
       SET status_message = ?, progress_json = ?, updated_at = ?
       WHERE project_id = ? AND id = ?`,
    ).run(step.message, JSON.stringify(progress), new Date().toISOString(), id, runId);
  });
}

export function transitionOptimizationRun(
  projectId: string,
  runId: string,
  nextStatus: OptimizationRunStatus,
  patch: {
    statusMessage?: string;
    summary?: string;
    errorMessage?: string | null;
    followupObservationIds?: string[];
    recordStep?: boolean;
  } = {},
): OptimizationRun {
  return withProjectDb(projectId, (db, id) => {
    const current = getOptimizationRun(id, runId, db);
    if (!current) throw new OptimizationStateError('没有找到该优化任务。', 404);
    if (current.status !== nextStatus && !LEGAL_RUN_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new OptimizationStateError(
        `状态流转冲突：当前处于「${RUN_STATUS_LABELS[current.status]}」，不能直接跳到「${RUN_STATUS_LABELS[nextStatus]}」。`,
        409,
      );
    }
    const now = new Date().toISOString();
    const nextMessage = patch.statusMessage ?? current.statusMessage;
    const nextSummary = patch.summary ?? current.summary;
    const nextError =
      patch.errorMessage !== undefined ? patch.errorMessage : nextStatus === 'failed' ? current.errorMessage : null;
    const nextFollowup = patch.followupObservationIds ?? current.followupObservationIds;
    const nextProgress = [...current.progress];
    if (patch.recordStep && patch.statusMessage) {
      nextProgress.push({
        at: now,
        agentId: 'optimization-engine',
        kind: nextStatus === 'failed' ? 'error' : nextStatus === 'completed' ? 'done' : 'start',
        message: patch.statusMessage,
      });
    }

    db.prepare(
      `UPDATE opengeo_optimization_runs
       SET status = ?, status_message = ?, summary = ?, progress_json = ?,
           followup_obs_ids_json = ?, error_message = ?, updated_at = ?
       WHERE project_id = ? AND id = ?`,
    ).run(
      nextStatus,
      nextMessage,
      nextSummary,
      JSON.stringify(nextProgress),
      JSON.stringify(nextFollowup),
      nextError,
      now,
      id,
      runId,
    );
    return getOptimizationRun(id, runId, db)!;
  });
}

export function insertDeliverableSkeleton(
  projectId: string,
  runId: string,
  input: {
    priority: number;
    kind: DeliverableKind;
    format: DeliverableFormat;
    title: string;
    targetAssetId: string | null;
    destination: string;
    audienceAndGoal: string;
    questionIds: string[];
    beforeContent: string;
  },
): OptimizationDeliverable {
  return withProjectDb(projectId, (db, id) => {
    const now = new Date().toISOString();
    const delivId = `deliv-${randomUUID().slice(0, 12)}`;
    db.prepare(
      `INSERT INTO opengeo_deliverables (
        id, project_id, run_id, priority, kind, format, status, title,
        target_asset_id, destination, audience_and_goal, question_ids_json,
        before_content, after_content, media_manifest_json, review_json, applied_record_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'drafting', ?, ?, ?, ?, ?, ?, '', '[]', NULL, NULL, ?, ?)`,
    ).run(
      delivId,
      id,
      runId,
      input.priority,
      input.kind,
      input.format,
      input.title,
      input.targetAssetId,
      input.destination,
      input.audienceAndGoal,
      JSON.stringify(input.questionIds),
      input.beforeContent,
      now,
      now,
    );
    const row = db
      .prepare('SELECT * FROM opengeo_deliverables WHERE project_id = ? AND id = ?')
      .get(id, delivId) as RelationalDeliverableRow;
    return rowToDeliverable(row);
  });
}

export function updateDeliverableRecord(
  projectId: string,
  deliverableId: string,
  patch: {
    priority?: number;
    status?: DeliverableStatus;
    title?: string;
    destination?: string;
    audienceAndGoal?: string;
    afterContent?: string;
    mediaManifest?: DeliverableMediaItem[];
    companionFiles?: DeliverableCompanionFile[];
    referenceWinners?: ReferenceWinner[];
    review?: DeliverableReviewResult | null;
    appliedRecord?: DeliverableAppliedRecord | null;
  },
): OptimizationDeliverable {
  return withProjectDb(projectId, (db, id) => {
    const existing = db
      .prepare('SELECT * FROM opengeo_deliverables WHERE project_id = ? AND id = ?')
      .get(id, deliverableId) as RelationalDeliverableRow | undefined;
    if (!existing) throw new OptimizationStateError('没有找到对应的交付稿件。', 404);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE opengeo_deliverables
       SET priority = ?, status = ?, title = ?, destination = ?, audience_and_goal = ?,
           after_content = ?, media_manifest_json = ?, companion_files_json = ?, reference_winners_json = ?, review_json = ?, applied_record_json = ?, updated_at = ?
       WHERE project_id = ? AND id = ?`,
    ).run(
      patch.priority ?? existing.priority,
      patch.status ?? existing.status,
      patch.title ?? existing.title,
      patch.destination ?? existing.destination,
      patch.audienceAndGoal ?? existing.audience_and_goal,
      patch.afterContent ?? existing.after_content,
      patch.mediaManifest ? JSON.stringify(patch.mediaManifest) : existing.media_manifest_json,
      patch.companionFiles ? JSON.stringify(patch.companionFiles) : (existing.companion_files_json ?? '[]'),
      patch.referenceWinners ? JSON.stringify(patch.referenceWinners) : (existing.reference_winners_json ?? '[]'),
      patch.review !== undefined ? (patch.review ? JSON.stringify(patch.review) : null) : existing.review_json,
      patch.appliedRecord !== undefined
        ? patch.appliedRecord
          ? JSON.stringify(patch.appliedRecord)
          : null
        : existing.applied_record_json,
      now,
      id,
      deliverableId,
    );
    const updated = db
      .prepare('SELECT * FROM opengeo_deliverables WHERE project_id = ? AND id = ?')
      .get(id, deliverableId) as RelationalDeliverableRow;
    return rowToDeliverable(updated);
  });
}

export function computeRetestComparison(
  projectId: string,
  run: OptimizationRun,
): RetestComparisonSummary | null {
  if (!run.followupObservationIds.length) return null;
  return withProjectDb(projectId, (db, id) => {
    const fetchObsMap = (obsIds: string[]) => {
      const map = new Map<
        string,
        {
          questionId: string;
          query: string;
          engine: ResearchEngine;
          mention: 'yes' | 'no' | 'unknown';
          citation: 'yes' | 'no' | 'unknown';
          evidence: string;
        }
      >();
      const stmt = db.prepare(
        `SELECT o.id, o.question_id, o.query_text, o.engine, o.language,
                a.mention, a.citation, a.mention_evidence
         FROM opengeo_observations o
         LEFT JOIN opengeo_answer_audits a
           ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
         WHERE o.project_id = ? AND o.id = ?`,
      );
      for (const oid of obsIds) {
        const row = stmt.get(id, oid) as
          | {
              id: string;
              question_id: string;
              query_text: string;
              engine: ResearchEngine;
              language: string;
              mention: 'yes' | 'no' | 'unknown' | null;
              citation: 'yes' | 'no' | 'unknown' | null;
              mention_evidence: string | null;
            }
          | undefined;
        if (!row) continue;
        map.set(`${row.question_id}::${row.engine}::${row.language}`, {
          questionId: row.question_id,
          query: row.query_text,
          engine: row.engine,
          mention: row.mention ?? 'unknown',
          citation: row.citation ?? 'unknown',
          evidence: row.mention_evidence ?? '',
        });
      }
      return map;
    };

    const baselineMap = fetchObsMap(run.baselineObservationIds);
    const followupMap = fetchObsMap(run.followupObservationIds);
    const items: RetestQuestionComparison[] = [];

    for (const [slot, after] of followupMap.entries()) {
      const before = baselineMap.get(slot);
      items.push({
        questionId: after.questionId,
        query: after.query,
        engine: after.engine,
        beforeMention: before?.mention ?? 'unmeasured',
        afterMention: after.mention,
        beforeCitation: before?.citation ?? 'unmeasured',
        afterCitation: after.citation,
        afterEvidence: after.evidence,
      });
    }

    return {
      comparedCount: items.length,
      beforeMentionYes: items.filter((i) => i.beforeMention === 'yes').length,
      afterMentionYes: items.filter((i) => i.afterMention === 'yes').length,
      beforeCitationYes: items.filter((i) => i.beforeCitation === 'yes').length,
      afterCitationYes: items.filter((i) => i.afterCitation === 'yes').length,
      items,
    };
  });
}

export function buildOptimizationRunViewModel(
  projectId: string,
  runId?: string,
): OptimizationRunViewModel {
  const run = runId ? getOptimizationRun(projectId, runId) : getLatestOptimizationRun(projectId);
  if (!run) {
    return {
      run: null,
      stageLabel: '尚未发起重点优化',
      primaryAction: {
        kind: 'start_focus',
        label: '开始内容改进',
        description: '从真实搜索落败原因出发，为你准备配套图文改进方案，可逐篇审阅、按需采用。',
      },
      retestComparison: null,
    };
  }

  const stageLabel = RUN_STATUS_LABELS[run.status];
  const retestComparison = computeRetestComparison(projectId, run);

  switch (run.status) {
    case 'planning':
    case 'drafting':
    case 'reviewing':
    case 'implementing':
    case 'remeasuring':
      return {
        run,
        stageLabel,
        primaryAction: {
          kind: 'wait_working',
          label: stageLabel,
          description: run.statusMessage || '正在推进当前步骤，请稍候…',
        },
        retestComparison,
      };
    case 'awaiting_approval':
      return {
        run,
        stageLabel,
        primaryAction: {
          kind: 'review_and_confirm',
          label: '审阅成稿并确认落地',
          description: '成稿已通过真实性、合规与可读性三红线把关；在你点击确认前，不会修改任何真实文件。',
        },
        retestComparison,
      };
    case 'awaiting_retest':
      return {
        run,
        stageLabel,
        primaryAction: {
          kind: 'run_retest',
          label: '按原问题发起复测',
          description: '内容已落地登记，现在可用原问题同条件复测，对比优化前后的真实曝光与引用变化。',
        },
        retestComparison,
      };
    case 'completed':
      return {
        run,
        stageLabel,
        primaryAction: {
          kind: 'view_result',
          label: '查看复测前后对比',
          description: '已完成原题复测与语义判卷，可随时核查每道题的前后变化，或开启下一轮重点优化。',
        },
        retestComparison,
      };
    case 'failed':
      return {
        run,
        stageLabel,
        primaryAction: {
          kind: 'retry',
          label: '重新尝试优化',
          description: run.errorMessage || '执行过程中遇到异常，原资料完好未动，可点击重试。',
        },
        retestComparison,
      };
  }
}

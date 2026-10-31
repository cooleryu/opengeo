import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import initialResearch from './data/research.json';
import { projectDataDirectory, resolveGeoProject, withGeoProject } from './projects';
import type { ResearchBatch, ResearchObservation } from './research-types';
import type { GeoRun } from './types';
import type { NormalizedResearchBudget } from './research-budget';

export interface ResearchRunRecord {
  id: string;
  projectId: string;
  batchId: string;
  provider: ResearchObservation['engine'];
  language: ResearchObservation['language'];
  questions: { questionId: string; query: string }[];
  status: 'running' | 'completed' | 'partial' | 'failed' | 'interrupted';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  /** null is an explicitly disabled cap; absent budgetEnabled preserves legacy records. */
  budgetLimit: number | null;
  budgetEnabled?: boolean;
  budgetEnforcement?: 'strict' | 'legacy' | 'disabled';
  spent: number;
  completedCount?: number;
  error?: string;
  evidencePath?: string;
  taskId?: string;
  entryType?: ResearchObservation['entryType'];
  imported?: boolean;
  importedRun?: GeoRun;
  matchedQuestionIds?: string[];
  ownerPid?: number;
  costAllocation?: 'per_query';
  scheduleId?: string;
  budget?: NormalizedResearchBudget;
  confirmedSpentCny?: number;
  reservedCny?: number;
  currentQuestionId?: string;
  phase?: 'searching' | 'analyzing' | 'finalizing';
  stopRequestedAt?: string;
  analysisStatus?: 'pending_budget';
  analysisNote?: string;
}

export class ResearchStoreError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type PayloadRow = { payload: string };
const seedBatches = initialResearch as ResearchBatch[];
const schema = `
  CREATE TABLE IF NOT EXISTS geo_research_batches (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    date TEXT NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(project_id, id)
  );
  CREATE TABLE IF NOT EXISTS geo_research_observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    language TEXT NOT NULL,
    payload TEXT NOT NULL,
    appended_at TEXT NOT NULL,
    UNIQUE(project_id, id),
    UNIQUE(project_id, run_id, question_id, engine, language)
  );
  CREATE TABLE IF NOT EXISTS geo_research_runs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS geo_research_one_running
    ON geo_research_runs(project_id) WHERE status = 'running';
`;

function initializeResearch(db: Database.Database, projectId: string): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'geo_research_one_running'").get()) db.exec(schema);
  for (const batch of seedBatches.filter((item) => item.projectId === projectId)) {
    if (!db.prepare('SELECT 1 FROM geo_research_batches WHERE project_id = ? AND id = ?').get(projectId, batch.id)) {
      // A completed import is never refreshed from the fixture. Its original
      // observations stay in this immutable payload, preserving index-based links.
      db.prepare('INSERT OR IGNORE INTO geo_research_batches (id, project_id, date, payload) VALUES (?, ?, ?, ?)')
        .run(batch.id, projectId, batch.date, JSON.stringify(batch));
    }
  }
}

/** Use the existing project database without importing store.ts or its scheduler. */
function inDatabase<T>(projectId: string, operation: (db: Database.Database, projectId: string) => T): T {
  const id = resolveGeoProject(projectId);
  const directory = withGeoProject(id, projectDataDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
    initializeResearch(db, id);
    return operation(db, id);
  } finally { db.close(); }
}

function readBatch(db: Database.Database, projectId: string, batchId: string): ResearchBatch {
  const row = db.prepare('SELECT payload FROM geo_research_batches WHERE project_id = ? AND id = ?').get(projectId, batchId) as PayloadRow | undefined;
  if (!row) throw new ResearchStoreError('没有找到当前项目的研究批次。', 404);
  return JSON.parse(row.payload) as ResearchBatch;
}

function readRun(db: Database.Database, projectId: string, id: string): ResearchRunRecord | null {
  const row = db.prepare('SELECT payload FROM geo_research_runs WHERE project_id = ? AND id = ?').get(projectId, id) as PayloadRow | undefined;
  return row ? JSON.parse(row.payload) as ResearchRunRecord : null;
}

export function readLatestResearch(projectId: string): ResearchBatch | null {
  return inDatabase(projectId, (db, id) => {
    const row = db.prepare('SELECT payload FROM geo_research_batches WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(id) as PayloadRow | undefined;
    if (!row) return null;
    return withAppendedObservations(db, id, JSON.parse(row.payload) as ResearchBatch);
  });
}

function withAppendedObservations(db: Database.Database, projectId: string, batch: ResearchBatch): ResearchBatch {
  const questions = new Map([...batch.questions, ...batch.deferredQuestions].map((question) => [question.id, question]));
  const observations = db.prepare('SELECT question_id, payload, appended_at FROM geo_research_observations WHERE project_id = ? AND batch_id = ? ORDER BY seq')
    .all(projectId, batch.id) as (PayloadRow & { question_id: string; appended_at: string })[];
  for (const observation of observations) {
    questions.get(observation.question_id)!.observations.push(JSON.parse(observation.payload));
    batch.updatedAt = observation.appended_at;
  }
  return batch;
}

export function getResearchBatch(projectId: string, batchId: string): ResearchBatch | null {
  return inDatabase(projectId, (db, id) => {
    const row = db.prepare('SELECT payload FROM geo_research_batches WHERE project_id = ? AND id = ?').get(id, batchId) as PayloadRow | undefined;
    return row ? withAppendedObservations(db, id, JSON.parse(row.payload) as ResearchBatch) : null;
  });
}

export function listResearchBatches(projectId: string): ResearchBatch[] {
  return inDatabase(projectId, (db, id) => (
    db.prepare('SELECT payload FROM geo_research_batches WHERE project_id = ? ORDER BY seq DESC').all(id) as PayloadRow[]
  ).map(row => withAppendedObservations(db, id, JSON.parse(row.payload) as ResearchBatch)));
}

/** Only insert a new immutable batch. Optional connection joins question-plan confirmation atomically. */
export function saveResearchBatch(projectId: string, batch: ResearchBatch, connection?: Database.Database): void {
  const id = resolveGeoProject(projectId);
  const save = (db: Database.Database) => db.transaction(() => {
    initializeResearch(db, id);
    if (batch.projectId !== id) throw new ResearchStoreError('研究批次不属于当前项目。');
    if (!batch.id || !Number.isFinite(Date.parse(batch.date))) throw new ResearchStoreError('研究批次编号或日期无效。');
    const questions = [...batch.questions, ...batch.deferredQuestions];
    if (!batch.questions.length || batch.questions.length > 8 || batch.questions.some(question => question.decision !== 'search_now')) throw new ResearchStoreError('可搜索批次须包含 1—8 个已通过审核的问题。');
    if (new Set(questions.map(question => question.id)).size !== questions.length || questions.some(question => !question.id || (!question.zh.trim() && !question.en.trim()) || question.observations.length)) throw new ResearchStoreError('新批次须保留独立题目与原文，不能附带历史观测。');
    const existing = db.prepare('SELECT payload FROM geo_research_batches WHERE project_id = ? AND id = ?').get(id, batch.id) as PayloadRow | undefined;
    if (existing) {
      if (!isDeepStrictEqual(JSON.parse(existing.payload), batch)) throw new ResearchStoreError('已确认的研究批次不能覆盖。', 409);
      return;
    }
    db.prepare('INSERT INTO geo_research_batches (id, project_id, date, payload) VALUES (?, ?, ?, ?)').run(batch.id, id, batch.date, JSON.stringify(batch));
  }).immediate();
  if (connection) save(connection);
  else inDatabase(id, save);
}

export function getResearchRun(projectId: string, runId: string): ResearchRunRecord | null {
  return inDatabase(projectId, (db, id) => readRun(db, id, runId));
}

export function listResearchRuns(projectId: string): ResearchRunRecord[] {
  return inDatabase(projectId, (db, id) => (
    db.prepare('SELECT payload FROM geo_research_runs WHERE project_id = ? ORDER BY started_at DESC, seq DESC').all(id) as PayloadRow[]
  ).map((row) => JSON.parse(row.payload) as ResearchRunRecord));
}

function frozenInput(record: ResearchRunRecord) {
  return {
    id: record.id, projectId: record.projectId, batchId: record.batchId,
    provider: record.provider, language: record.language, questions: record.questions,
    startedAt: record.startedAt, budgetLimit: record.budgetLimit,
    budgetEnabled: record.budgetEnabled, budgetEnforcement: record.budgetEnforcement,
    taskId: record.taskId, entryType: record.entryType, imported: record.imported,
    importedRun: record.importedRun, matchedQuestionIds: record.matchedQuestionIds,
    ownerPid: record.ownerPid, costAllocation: record.costAllocation,
    scheduleId: record.scheduleId, budget: record.budget,
  };
}

/** A stop request is durable and idempotent, and never changes a finished run. */
export function requestResearchStop(projectId: string, runId: string): ResearchRunRecord {
  return inDatabase(projectId, (db, id) => db.transaction(() => {
    const record = readRun(db, id, runId);
    if (!record) throw new ResearchStoreError('没有找到当前项目的搜索运行。', 404);
    if (record.status !== 'running' || record.stopRequestedAt) return record;
    const now = new Date().toISOString();
    const stopped = { ...record, stopRequestedAt: now, updatedAt: now };
    db.prepare('UPDATE geo_research_runs SET payload = ?, updated_at = ? WHERE project_id = ? AND id = ?')
      .run(JSON.stringify(stopped), now, id, runId);
    return stopped;
  }).immediate());
}

export function saveResearchRun(projectId: string, record: ResearchRunRecord): ResearchRunRecord {
  return inDatabase(projectId, (db, id) => db.transaction(() => {
    if (record.projectId !== id) throw new ResearchStoreError('研究运行不属于当前项目。');
    if (!record.id || !['running', 'completed', 'partial', 'failed', 'interrupted'].includes(record.status)) throw new ResearchStoreError('研究运行编号或状态无效。');
    if (!['chatgpt', 'google', 'deepseek', 'qwen', 'doubao'].includes(record.provider) || !['zh', 'en'].includes(record.language)) throw new ResearchStoreError('研究运行入口或语言无效。');
    if (![record.startedAt, record.updatedAt, ...(record.completedAt ? [record.completedAt] : [])].every((at) => Number.isFinite(Date.parse(at)))) throw new ResearchStoreError('研究运行时间无效。');
    const unlimited = record.budgetEnabled === false;
    if ((record.budgetEnabled !== undefined && typeof record.budgetEnabled !== 'boolean')
      || (unlimited ? record.budgetLimit !== null || record.budget !== undefined
        : record.budgetLimit === null || !Number.isFinite(record.budgetLimit) || record.budgetLimit < 0)
      || !Number.isFinite(record.spent) || record.spent < 0
      || (record.budgetLimit !== null && record.spent > record.budgetLimit)) throw new ResearchStoreError('研究运行费用必须在本次预算范围内。');
    if (record.budgetEnforcement !== undefined && !(
      (record.budgetEnforcement === 'disabled' && unlimited)
      || (record.budgetEnforcement === 'legacy' && !unlimited)
      || (record.budgetEnforcement === 'strict' && record.budgetEnabled === true && record.provider === 'deepseek')
    )) throw new ResearchStoreError('研究运行费用上限模式无效。');
    if (!Array.isArray(record.questions) || (!record.imported && record.questions.length === 0) || record.questions.some((question) => !question.questionId || !question.query)) throw new ResearchStoreError('研究运行必须保存冻结的问题与问法。');
    if (record.completedCount !== undefined && (!Number.isInteger(record.completedCount) || record.completedCount < 0 || record.completedCount > record.questions.length)) throw new ResearchStoreError('研究运行完成题数无效。');
    if (record.imported && (!record.importedRun || record.status === 'running')) throw new ResearchStoreError('历史导入必须附带已经结束的原始运行。');
    const previous = readRun(db, id, record.id);
    // The collector may hold an older in-memory record while another request
    // persists a stop. Merge inside this write transaction so it cannot be lost.
    if (previous?.stopRequestedAt) record = { ...record, stopRequestedAt: previous.stopRequestedAt,
      ...(record.status !== 'running' ? { status: 'interrupted' as const } : {}) };
    if (previous) {
      if (!isDeepStrictEqual(frozenInput(previous), frozenInput(record))) throw new ResearchStoreError('研究运行的冻结输入不能修改。', 409);
      if (isDeepStrictEqual(previous, record)) return previous;
      if (previous.status !== 'running') throw new ResearchStoreError('已经结束的研究运行不能覆盖。', 409);
    }
    if (!record.imported) {
      const batch = readBatch(db, id, record.batchId);
      const questions = new Map([...batch.questions, ...batch.deferredQuestions].map((question) => [question.id, question]));
      if (new Set(record.questions.map((question) => question.questionId)).size !== record.questions.length) throw new ResearchStoreError('同一次运行不能重复收录同一问题。');
      for (const input of record.questions) {
        if (questions.get(input.questionId)?.[record.language] !== input.query) throw new ResearchStoreError('冻结问法必须与研究题目的对应语言原文一致。');
      }
    }
    if (record.status === 'running' && db.prepare("SELECT 1 FROM geo_research_runs WHERE project_id = ? AND status = 'running' AND id <> ?").get(id, record.id)) throw new ResearchStoreError('当前项目已有研究采集正在运行。', 409);
    db.prepare('INSERT INTO geo_research_runs (id, project_id, status, payload, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at')
      .run(record.id, id, record.status, JSON.stringify(record), record.startedAt, record.updatedAt);
    return record;
  }).immediate());
}

export function appendResearchObservation(projectId: string, batchId: string, questionId: string, observation: ResearchObservation): void {
  inDatabase(projectId, (db, id) => db.transaction(() => {
    const batch = readBatch(db, id, batchId);
    const question = [...batch.questions, ...batch.deferredQuestions].find((item) => item.id === questionId);
    if (!question) throw new ResearchStoreError('没有找到当前研究批次的问题。', 404);
    if (!['zh', 'en'].includes(observation.language) || observation.query !== question[observation.language]) throw new ResearchStoreError('采集问法必须与研究题目的对应语言原文一致。');
    if (!observation.runId) throw new ResearchStoreError('追加观测必须关联研究运行。');
    const run = readRun(db, id, observation.runId);
    if (!run || run.batchId !== batchId || run.provider !== observation.engine || run.language !== observation.language || !run.questions.some((item) => item.questionId === questionId && item.query === observation.query)) throw new ResearchStoreError('观测与研究运行的冻结输入不一致。');
    if (!['found', 'not_observed'].includes(observation.status) || !observation.recordedAt || !observation.evidencePath || !Array.isArray(observation.sources)) throw new ResearchStoreError('只有留有证据的已完成采集可以作为观测；执行失败应记录在运行中。');
    if (observation.collectedAt && !Number.isFinite(Date.parse(observation.collectedAt))) throw new ResearchStoreError('观测采集时间无效。');
    const saved = { ...observation, id: observation.id || `run:${observation.runId}:${questionId}:${observation.engine}:${observation.language}` };
    const previous = db.prepare('SELECT payload FROM geo_research_observations WHERE project_id = ? AND run_id = ? AND question_id = ? AND engine = ? AND language = ?')
      .get(id, observation.runId, questionId, observation.engine, observation.language) as PayloadRow | undefined;
    if (previous) {
      if (isDeepStrictEqual(JSON.parse(previous.payload), saved)) return;
      throw new ResearchStoreError('同一次采集的观测已经保存，不能覆盖原记录。', 409);
    }
    if (db.prepare('SELECT 1 FROM geo_research_observations WHERE project_id = ? AND id = ?').get(id, saved.id)) throw new ResearchStoreError('观测编号已存在，不能覆盖原记录。', 409);
    db.prepare('INSERT INTO geo_research_observations (id, project_id, batch_id, question_id, run_id, engine, language, payload, appended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(saved.id, id, batchId, questionId, observation.runId, observation.engine, observation.language, JSON.stringify(saved), new Date().toISOString());
  }).immediate());
}

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GEO_PROJECT_IDS, projectDataDirectory, resolveGeoProject, withGeoProject } from './projects';
import { normalizeResearchBudget } from './research-budget';
import { getLatestResearch, getResearchRun } from './research';
import type { ResearchRunRecord } from './research-store';
import type { ResearchSchedule } from './research-tracking-types';

export class ResearchTrackingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const QUERY_COST_CNY = 0.005;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const roundCny = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
type PayloadRow = { payload: string };
type CollectionResult = { run: ResearchRunRecord };
type Collector = (input: Record<string, unknown>, context: { scheduleId: string; shouldContinue: () => boolean }) => Promise<CollectionResult>;

const schema = `
  CREATE TABLE IF NOT EXISTS geo_research_schedules (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    status TEXT NOT NULL,
    next_run_at TEXT,
    active_run_id TEXT,
    payload TEXT NOT NULL,
    PRIMARY KEY (project_id, id),
    UNIQUE (project_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS geo_research_schedules_due
    ON geo_research_schedules(project_id, status, next_run_at);
`;

function inDatabase<T>(projectId: string, operation: (db: Database.Database, projectId: string) => T): T {
  const id = resolveGeoProject(projectId);
  const directory = withGeoProject(id, projectDataDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
    db.exec(schema);
    return operation(db, id);
  } finally { db.close(); }
}

function readSchedule(db: Database.Database, projectId: string, planId: string): ResearchSchedule {
  const row = db.prepare('SELECT payload FROM geo_research_schedules WHERE project_id = ? AND id = ?').get(projectId, planId) as PayloadRow | undefined;
  if (!row) throw new ResearchTrackingError('没有找到当前项目的跟踪计划。', 404);
  return JSON.parse(row.payload) as ResearchSchedule;
}

function writeSchedule(db: Database.Database, plan: ResearchSchedule): void {
  db.prepare(`INSERT INTO geo_research_schedules (id, project_id, request_id, status, next_run_at, active_run_id, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, id) DO UPDATE SET
    status = excluded.status, next_run_at = excluded.next_run_at, active_run_id = excluded.active_run_id, payload = excluded.payload`)
    .run(plan.id, plan.projectId, plan.requestId, plan.status, plan.nextRunAt, plan.activeRunId, JSON.stringify(plan));
}

function localDate(at: Date): string { return new Date(at.getTime() + SHANGHAI_OFFSET).toISOString().slice(0, 10); }

/** All new/resumed plans start tomorrow; missed calendar days are never replayed. */
function nextRunAt(timeOfDay: string, now: Date, tomorrow = true): string {
  const today = Date.parse(`${localDate(now)}T${timeOfDay}:00+08:00`);
  return new Date(today + (tomorrow || today <= now.getTime() ? DAY : 0)).toISOString();
}

function validTimeOfDay(value: unknown): string {
  if (value === undefined) return '09:00';
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ResearchTrackingError('每日跟踪时间须为 HH:mm（北京时间）。');
  return value;
}

function frozenInput(plan: ResearchSchedule) {
  return { projectId: plan.projectId, batchId: plan.batchId, questions: plan.questions, language: plan.language,
    provider: plan.provider, timeOfDay: plan.timeOfDay, budget: plan.budget, limitCny: plan.limitCny };
}

export function listResearchSchedules(projectId: string): ResearchSchedule[] {
  return inDatabase(projectId, (db, id) => (
    db.prepare('SELECT payload FROM geo_research_schedules WHERE project_id = ? ORDER BY rowid DESC').all(id) as PayloadRow[]
  ).map(row => JSON.parse(row.payload) as ResearchSchedule));
}

export function createResearchSchedule(input: Record<string, unknown>, now = new Date()): ResearchSchedule {
  const projectId = resolveGeoProject(input.projectId);
  if (input.provider !== 'deepseek') throw new ResearchTrackingError('每日跟踪目前只支持 DeepSeek 搜索 API。');
  const language = input.language;
  if (language !== 'zh' && language !== 'en') throw new ResearchTrackingError('请选择中文或英文。');
  const requestId = input.requestId;
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)) throw new ResearchTrackingError('缺少本次跟踪编号，请重新打开跟踪窗口。');
  const questionIds = input.questionIds;
  if (!Array.isArray(questionIds) || questionIds.length < 1 || questionIds.length > 8 || new Set(questionIds).size !== questionIds.length || questionIds.some(id => typeof id !== 'string')) throw new ResearchTrackingError('每个计划请选择 1—8 个不同的核心问题。');
  const timeOfDay = validTimeOfDay(input.timeOfDay);
  let normalized;
  try { normalized = normalizeResearchBudget(input.budget); }
  catch (error) { throw new ResearchTrackingError(error instanceof Error ? error.message : '请填写跟踪计划的累计预算。'); }
  const { limitCny, ...budget } = normalized;
  const batch = getLatestResearch(projectId);
  if (!batch) throw new ResearchTrackingError('当前项目没有已审阅的问题。');
  if (input.batchId !== undefined && input.batchId !== batch.id) throw new ResearchTrackingError('题单已更新，请重新确认后创建跟踪计划。', 409);
  const questions = questionIds.map(questionId => {
    const question = batch.questions.find(item => item.id === questionId && item.decision === 'search_now');
    if (!question?.[language]?.trim()) throw new ResearchTrackingError('所选问题尚未通过搜索审核或缺少对应语言的原文。');
    if ([...question[language]].length > 128) throw new ResearchTrackingError(`问题 ${questionId} 超过 DeepSeek 的 128 字符上限，原题未截断。`);
    return { questionId, query: question[language] };
  });
  if (limitCny + 1e-9 < questions.length * QUERY_COST_CNY) throw new ResearchTrackingError('累计预算不足以完成一轮跟踪，未启用计划。');
  const plan: ResearchSchedule = {
    id: `track_${randomUUID()}`, requestId, projectId, batchId: batch.id,
    questionIds: [...questionIds], questions, language, provider: 'deepseek', timeOfDay, timeZone: 'Asia/Shanghai',
    budget, limitCny, spentCny: 0, reservedCny: 0, status: 'active',
    nextRunAt: nextRunAt(timeOfDay, now), lastRunAt: null, lastRunId: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    activeRunId: null, activeRunReservationCny: 0, activeRunConfirmedCny: 0,
  };
  return inDatabase(projectId, (db, id) => db.transaction(() => {
    const previous = db.prepare('SELECT payload FROM geo_research_schedules WHERE project_id = ? AND request_id = ?').get(id, requestId) as PayloadRow | undefined;
    if (previous) {
      const existing = JSON.parse(previous.payload) as ResearchSchedule;
      if (!isDeepStrictEqual(frozenInput(existing), frozenInput(plan))) throw new ResearchTrackingError('该跟踪编号已用于其他条件，请重新打开跟踪窗口。', 409);
      return existing;
    }
    writeSchedule(db, plan);
    return plan;
  }).immediate());
}

export function updateResearchSchedule(projectId: string, planId: string, action: 'pause' | 'resume' | 'stop', now = new Date()): ResearchSchedule {
  if (!['pause', 'resume', 'stop'].includes(action)) throw new ResearchTrackingError('跟踪操作无效。');
  return inDatabase(projectId, (db, id) => db.transaction(() => {
    const plan = readSchedule(db, id, planId);
    if (action === 'resume') {
      if (plan.status === 'stopped') throw new ResearchTrackingError('已停止的计划不能恢复，请新建计划。', 409);
      if (plan.status === 'active') return plan;
      if (plan.activeRunId) throw new ResearchTrackingError('上一轮仍在执行或等待费用核对，请稍后恢复。', 409);
      if (plan.limitCny - plan.spentCny - plan.reservedCny + 1e-9 < plan.questions.length * QUERY_COST_CNY) throw new ResearchTrackingError('剩余累计预算不足以完成下一轮，未恢复计划。');
      plan.status = 'active';
      plan.nextRunAt = nextRunAt(plan.timeOfDay, now);
      delete plan.error;
    } else {
      if (plan.status === 'stopped' || plan.status === 'paused' && action === 'pause') return plan;
      plan.status = action === 'stop' ? 'stopped' : 'paused';
      plan.nextRunAt = null;
    }
    plan.updatedAt = now.toISOString();
    writeSchedule(db, plan);
    return plan;
  }).immediate());
}

/** Checked by the collector before each new request, including after pause/stop. */
export function isResearchScheduleEnabled(projectId: string, scheduleId: string): boolean {
  return inDatabase(projectId, (db, id) => {
    const row = db.prepare('SELECT status FROM geo_research_schedules WHERE project_id = ? AND id = ?').get(id, scheduleId) as { status: string } | undefined;
    return row?.status === 'active';
  });
}

function ownerIsAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function runCost(run: ResearchRunRecord): { confirmed: number; reserved: number } {
  // Legacy incomplete runs did not separate proven spend from uncertain requests.
  // Preserve their entire amount as reserved, never invent a confirmed bill.
  const cost = run as ResearchRunRecord & { confirmedSpentCny?: number; reservedCny?: number };
  const confirmed = typeof cost.confirmedSpentCny === 'number' ? cost.confirmedSpentCny : run.status === 'completed' ? run.spent : 0;
  const reserved = typeof cost.reservedCny === 'number' ? cost.reservedCny : Math.max(0, run.spent - confirmed);
  if (![confirmed, reserved].every(value => Number.isFinite(value) && value >= 0)
    || run.budgetLimit === null || run.budgetEnabled === false || confirmed + reserved > run.budgetLimit + 1e-9
    || Math.abs(confirmed + reserved - run.spent) > 1e-9) throw new ResearchTrackingError('研究运行费用记录无效，计划已停止自动执行。');
  return { confirmed: roundCny(confirmed), reserved: roundCny(reserved) };
}

function reconcileClaim(projectId: string, planId: string, now: Date, cancelledBeforeStart = false): void {
  // Read the linked run before opening a write transaction on the same database.
  const snapshot = inDatabase(projectId, (db, id) => readSchedule(db, id, planId));
  if (!snapshot.activeRunId) return;
  const run = getResearchRun(projectId, snapshot.activeRunId);
  const live = run?.status === 'running' && ownerIsAlive(run.ownerPid ?? snapshot.ownerPid);
  const pendingWithoutRun = !run && ownerIsAlive(snapshot.ownerPid) && !cancelledBeforeStart;
  if (pendingWithoutRun) return;
  inDatabase(projectId, (db, id) => db.transaction(() => {
    const plan = readSchedule(db, id, planId);
    if (plan.activeRunId !== snapshot.activeRunId) return;
    let confirmed = plan.activeRunConfirmedCny;
    let reserved = plan.activeRunReservationCny - confirmed;
    let invalidCost = Boolean(run && (run.projectId !== plan.projectId || run.batchId !== plan.batchId
      || run.scheduleId !== plan.id || run.provider !== plan.provider || run.language !== plan.language
      || run.budgetLimit !== plan.activeRunReservationCny || !isDeepStrictEqual(run.questions, plan.questions)));
    if (run) {
      try { ({ confirmed, reserved } = runCost(run)); }
      catch { invalidCost = true; }
    } else if (cancelledBeforeStart) { confirmed = 0; reserved = 0; }
    // Another process may have reconciled a newer running snapshot meanwhile.
    if (confirmed < plan.activeRunConfirmedCny) return;
    if (confirmed + reserved > plan.activeRunReservationCny + 1e-9) invalidCost = true;
    if (invalidCost) { confirmed = plan.activeRunConfirmedCny; reserved = plan.activeRunReservationCny - confirmed; }
    const newlyConfirmed = roundCny(confirmed - plan.activeRunConfirmedCny);
    plan.spentCny = roundCny(plan.spentCny + newlyConfirmed);
    plan.reservedCny = roundCny(plan.reservedCny - newlyConfirmed);
    plan.activeRunConfirmedCny = confirmed;
    if (!live || invalidCost) {
      plan.reservedCny = roundCny(plan.reservedCny - (plan.activeRunReservationCny - confirmed) + reserved);
      const failed = !cancelledBeforeStart && (invalidCost || !run || run.status !== 'completed');
      if (failed) {
        if (plan.status === 'active') plan.status = 'failed';
        plan.nextRunAt = null;
        plan.error = invalidCost ? '费用记录无法核对，已保留本轮费用预留；未自动重试。'
          : run?.error || '上一轮未完成或采集进程已退出，已保留费用预留；未自动重试。';
      } else if (plan.status === 'active' && plan.limitCny - plan.spentCny - plan.reservedCny + 1e-9 < plan.questions.length * QUERY_COST_CNY) {
        plan.status = 'budget_exhausted';
        plan.nextRunAt = null;
        plan.error = '剩余累计预算不足以完成下一轮，跟踪已停止。';
      }
      plan.activeRunId = null;
      plan.activeRunReservationCny = 0;
      plan.activeRunConfirmedCny = 0;
      delete plan.ownerPid;
    }
    plan.updatedAt = now.toISOString();
    writeSchedule(db, plan);
  }).immediate());
}

function claimDueSchedule(projectId: string, planId: string, now: Date): ResearchSchedule | null {
  return inDatabase(projectId, (db, id) => db.transaction(() => {
    const plan = readSchedule(db, id, planId);
    if (plan.status !== 'active' || plan.activeRunId || !plan.nextRunAt || Date.parse(plan.nextRunAt) > now.getTime()) return null;
    // Do not send yesterday's (or older) query after the app has been closed.
    if (localDate(new Date(plan.nextRunAt)) < localDate(now)) {
      plan.nextRunAt = nextRunAt(plan.timeOfDay, now, false);
      plan.updatedAt = now.toISOString();
      writeSchedule(db, plan);
      return null;
    }
    if (db.prepare('SELECT 1 FROM geo_research_schedules WHERE project_id = ? AND active_run_id IS NOT NULL').get(id)) return null;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'geo_research_runs'").get()
      && db.prepare("SELECT 1 FROM geo_research_runs WHERE project_id = ? AND status = 'running'").get(id)) return null;
    const reservation = roundCny(plan.questions.length * QUERY_COST_CNY);
    if (plan.limitCny - plan.spentCny - plan.reservedCny + 1e-9 < reservation) {
      plan.status = 'budget_exhausted';
      plan.nextRunAt = null;
      plan.error = '剩余累计预算不足以完成下一轮，未发送请求。';
      plan.updatedAt = now.toISOString();
      writeSchedule(db, plan);
      return null;
    }
    plan.activeRunId = `${plan.id}_${localDate(now).replaceAll('-', '')}`;
    plan.activeRunReservationCny = reservation;
    plan.activeRunConfirmedCny = 0;
    plan.reservedCny = roundCny(plan.reservedCny + reservation);
    plan.ownerPid = process.pid;
    plan.lastRunId = plan.activeRunId;
    plan.lastRunAt = now.toISOString();
    plan.nextRunAt = nextRunAt(plan.timeOfDay, now);
    plan.updatedAt = now.toISOString();
    delete plan.error;
    writeSchedule(db, plan);
    return plan;
  }).immediate());
}

function failClaim(projectId: string, planId: string, message: string, now: Date): void {
  inDatabase(projectId, (db, id) => db.transaction(() => {
    const plan = readSchedule(db, id, planId);
    if (plan.status === 'active') plan.status = 'failed';
    plan.nextRunAt = null;
    plan.error = message;
    plan.updatedAt = now.toISOString();
    writeSchedule(db, plan);
  }).immediate());
}

/** The application must stay running for ticks to occur; no missed-day catch-up. */
export async function tickResearchSchedules(options: { now?: Date; collect?: Collector } = {}): Promise<void> {
  const now = options.now ?? new Date();
  const collection = options.collect ? null : await import('./research-collection');
  for (const projectId of GEO_PROJECT_IDS) await withGeoProject(projectId, async () => {
    collection?.recoverStoppedResearchRuns();
    for (const plan of listResearchSchedules(projectId)) {
      if (plan.activeRunId) reconcileClaim(projectId, plan.id, now);
    }
    for (const plan of listResearchSchedules(projectId)) {
      const claimed = claimDueSchedule(projectId, plan.id, now);
      if (!claimed) continue;
      if (!isResearchScheduleEnabled(projectId, claimed.id)) {
        reconcileClaim(projectId, claimed.id, now, true);
        continue;
      }
      try {
        const collect: Collector = options.collect ?? ((input, context) => collection!.collectResearch(input, context));
        await collect({ projectId, batchId: claimed.batchId, questionIds: claimed.questionIds,
          language: claimed.language, provider: 'deepseek', budgetLimit: claimed.activeRunReservationCny,
          requestId: claimed.activeRunId }, { scheduleId: claimed.id, shouldContinue: () => isResearchScheduleEnabled(projectId, claimed.id) });
        reconcileClaim(projectId, claimed.id, now);
      } catch (error) {
        const linkedRun = getResearchRun(projectId, claimed.activeRunId!);
        failClaim(projectId, claimed.id, error instanceof Error ? error.message : '跟踪执行失败，未自动重试。', now);
        // The collector saves a run before sending. A thrown validation error
        // without that record is known to precede a request.
        reconcileClaim(projectId, claimed.id, now, !linkedRun);
      }
    }
  });
}

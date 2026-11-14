import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { GeoQuestionPlan, QuestionGenerationCheckpoint, QuestionGenerationJob, QuestionGenerationProgress } from './question-types';

type Owner = { pid: number; token: string };
type SavedJob = QuestionGenerationJob & {
  owner: Owner;
  requestId?: string;
  fingerprint: string;
  basePlanId: string;
  baseRevision: number;
  positioning: string;
};
type StartInput = { planId: unknown; revision: unknown; positioning: unknown; requestId?: unknown };
export type QuestionGenerationDependencies = {
  db: Database.Database;
  projectId: string;
  fingerprint: () => string;
  currentPlan: () => GeoQuestionPlan;
  assertReady: () => void;
  generate: (positioning: string, progress: (value: QuestionGenerationProgress) => void,
    resume?: readonly QuestionGenerationCheckpoint[]) => Promise<GeoQuestionPlan>;
  save: (generated: GeoQuestionPlan, expected: GeoQuestionPlan) => number;
};

export class QuestionGenerationError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

/** Keep source excerpts and structured validation dumps out of persisted user-facing progress. */
export function questionGenerationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/摘录|引用.*原文|证据.*原文|原文.*证据/.test(message)) {
    return '生成的问题未通过原文依据检查，已停止保存。你可以重试，已有内容保持不变。';
  }
  if (/ZodError/.test(error instanceof Error ? error.name : '') || message.startsWith('[\n')) {
    return 'AI 返回的内容不完整，这次未保存新问题。请重试。';
  }
  return message || '问题准备暂时中断，请重试。';
}

const globals = globalThis as typeof globalThis & {
  __openGeoQuestionJobOwner?: Owner;
  __openGeoQuestionJobRuns?: Map<string, Promise<void>>;
};
const owner = globals.__openGeoQuestionJobOwner ??= { pid: process.pid, token: randomUUID() };
const runs = globals.__openGeoQuestionJobRuns ??= new Map<string, Promise<void>>();
const initialized = new WeakSet<Database.Database>();
const active = (job: QuestionGenerationJob) => job.status === 'queued' || job.status === 'running';
function ownerAlive(saved: Owner): boolean {
  if (!Number.isInteger(saved?.pid) || saved.pid <= 0) return false;
  if (saved.pid === process.pid) return saved.token === owner.token;
  try { process.kill(saved.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function publicJob(saved: SavedJob): QuestionGenerationJob {
  const { owner: _owner, requestId: _requestId, fingerprint: _fingerprint,
    basePlanId: _basePlanId, baseRevision: _baseRevision, checkpoint: _checkpoint, checkpoints, ...job } = saved;
  return { ...job, ...(checkpoints ? { checkpoints: checkpoints.map(({ payload: _payload, ...summary }) => summary) } : {}) };
}

/** Persisted work is claimed synchronously; only an explicit start schedules model calls. */
export class QuestionGenerationJobs {
  constructor(private dependencies: QuestionGenerationDependencies) {
    if (!initialized.has(dependencies.db)) {
      dependencies.db.exec(`CREATE TABLE IF NOT EXISTS geo_question_generation_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL, request_id TEXT, payload TEXT NOT NULL,
        UNIQUE(project_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS geo_question_generation_requests (
        project_id TEXT NOT NULL, request_id TEXT NOT NULL, job_id TEXT NOT NULL,
        PRIMARY KEY(project_id, request_id)
      )`);
      initialized.add(dependencies.db);
    }
  }

  private latest(): SavedJob | null {
    const row = this.dependencies.db.prepare('SELECT payload FROM geo_question_generation_jobs WHERE project_id = ? ORDER BY seq DESC LIMIT 1')
      .get(this.dependencies.projectId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }

  private persist(job: SavedJob): void {
    this.dependencies.db.prepare('UPDATE geo_question_generation_jobs SET payload = ? WHERE id = ? AND project_id = ?')
      .run(JSON.stringify(job), job.id, this.dependencies.projectId);
  }

  private rememberRequest(job: SavedJob, requestId: unknown): void {
    if (!requestId) return;
    this.dependencies.db.prepare('INSERT OR IGNORE INTO geo_question_generation_requests (project_id, request_id, job_id) VALUES (?, ?, ?)')
      .run(this.dependencies.projectId, requestId, job.id);
  }

  private settle(job: SavedJob, status: SavedJob['status'], message: string, error?: string): SavedJob {
    const now = new Date().toISOString();
    const next = { ...job, status, message, updatedAt: now, completedAt: now, ...(error ? { error } : {}) };
    this.persist(next);
    return next;
  }

  private current(): SavedJob | null {
    const job = this.latest();
    if (!job) return null;
    if (job.status !== 'superseded' && this.dependencies.fingerprint() !== job.fingerprint) {
      return this.settle(job, 'superseded', '项目理解或资料已更新，旧准备结果不再写入；将按最新理解继续准备。');
    }
    if (active(job) && !ownerAlive(job.owner)) {
      const message = '问题准备因服务重启中断，请重试。已保存的问题仍保留。';
      return this.settle(job, 'interrupted', message, message);
    }
    if (active(job)) {
      const plan = this.dependencies.currentPlan();
      if (plan.id !== job.basePlanId || plan.revision !== job.baseRevision) {
        return this.settle(job, 'superseded', '问题已在其他操作中更新，本次准备结果未覆盖已有问题。');
      }
    }
    return job;
  }

  get(): QuestionGenerationJob | null {
    const job = this.current();
    return job ? publicJob(job) : null;
  }

  private assertCurrent(job: SavedJob): SavedJob {
    const current = this.current();
    const plan = this.dependencies.currentPlan();
    if (!current || current.id !== job.id || !active(current) ||
      plan.id !== job.basePlanId || plan.revision !== job.baseRevision) {
      if (current?.id === job.id && active(current)) {
        this.settle(current, 'superseded', '问题已在其他操作中更新，本次准备结果未覆盖已有问题。');
      }
      throw new QuestionGenerationError('项目理解、资料或问题已更新，本次准备结果未写入。');
    }
    return current;
  }

  start(input: StartInput, onProgress?: (progress: QuestionGenerationProgress) => void): {
    job: QuestionGenerationJob; started: boolean; completion?: Promise<void>;
  } {
    if (typeof input.positioning !== 'string' || !input.positioning.trim() || input.positioning.length > 1000) {
      throw new QuestionGenerationError('项目定位不能为空且不能超过 1000 字。', 400);
    }
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))) {
      throw new QuestionGenerationError('请求标识无效，请刷新后重试。', 400);
    }
    const positioning = input.positioning.trim();
    let expected: GeoQuestionPlan | undefined;
    const result = this.dependencies.db.transaction(() => {
      const current = this.current();
      if (input.requestId) {
        const row = this.dependencies.db.prepare(`SELECT payload FROM geo_question_generation_jobs
          WHERE project_id = ? AND (request_id = ? OR id = (
            SELECT job_id FROM geo_question_generation_requests WHERE project_id = ? AND request_id = ?
          ))`)
          .get(this.dependencies.projectId, input.requestId, this.dependencies.projectId, input.requestId) as { payload: string } | undefined;
        if (row) {
          const saved: SavedJob = JSON.parse(row.payload);
          if (saved.positioning !== positioning || saved.basePlanId !== input.planId || saved.baseRevision !== input.revision) {
            throw new QuestionGenerationError('这个请求标识已用于另一份问题准备，请刷新后重新提交。');
          }
          return { saved, started: false };
        }
      }
      if (current && active(current)) {
        if (current.positioning !== positioning || current.basePlanId !== input.planId || current.baseRevision !== input.revision) {
          throw new QuestionGenerationError('正在按当前理解准备问题，请查看本次进度，完成后再修改定位。');
        }
        // A second page may use a different request ID for the same work. Retain that
        // identity too, so a lost response cannot turn into a paid retry after failure.
        this.rememberRequest(current, input.requestId);
        return { saved: current, started: false };
      }
      expected = this.dependencies.currentPlan();
      if (input.planId !== expected.id || input.revision !== expected.revision) {
        // A lost response can be retried without issuing a second model request.
        if (current?.status === 'completed' && current.basePlanId === input.planId && current.baseRevision === input.revision &&
          current.positioning === positioning && current.planRevision === expected.revision) {
          this.rememberRequest(current, input.requestId);
          return { saved: current, started: false };
        }
        throw new QuestionGenerationError('问题已在其他窗口更新，请刷新后再操作。');
      }
      this.dependencies.assertReady();
      const fingerprint = this.dependencies.fingerprint();
      // Retry only the latest compatible failed work. A failed coverage review may
      // have saved its own draft; any later plan edit still invalidates that work.
      const checkpoints = current && (current.status === 'failed' || current.status === 'interrupted') &&
        current.projectId === this.dependencies.projectId && current.fingerprint === fingerprint &&
        current.positioning === positioning && current.basePlanId === expected.id &&
        (current.planRevision ?? current.baseRevision) === expected.revision
        ? current.checkpoints : undefined;
      const now = new Date().toISOString();
      const saved: SavedJob = { id: randomUUID(), projectId: this.dependencies.projectId,
        status: 'queued', stage: 'preparing', message: '已开始准备推荐问题。', startedAt: now, updatedAt: now,
        owner, requestId: input.requestId as string | undefined, fingerprint,
        basePlanId: expected.id, baseRevision: expected.revision, positioning,
        ...(checkpoints !== undefined ? { checkpoints } : {}) };
      this.dependencies.db.prepare('INSERT INTO geo_question_generation_jobs (id, project_id, request_id, payload) VALUES (?, ?, ?, ?)')
        .run(saved.id, saved.projectId, saved.requestId ?? null, JSON.stringify(saved));
      this.rememberRequest(saved, input.requestId);
      return { saved, started: true };
    }).immediate();
    if (!result.started) return { job: publicJob(result.saved), started: false, completion: runs.get(result.saved.id) };
    // The queued record and in-process guard exist before generation can execute.
    const completion = Promise.resolve().then(() => this.finish(result.saved, expected!, onProgress))
      .finally(() => runs.delete(result.saved.id));
    runs.set(result.saved.id, completion);
    return { job: publicJob(result.saved), started: true, completion };
  }

  private async finish(job: SavedJob, expected: GeoQuestionPlan, onProgress?: (progress: QuestionGenerationProgress) => void): Promise<void> {
    const progress = (value: QuestionGenerationProgress) => {
      const current = this.assertCurrent(job);
      const now = new Date().toISOString();
      const { checkpoint, ...update } = value;
      const checkpoints = checkpoint
        ? [...(current.checkpoints ?? []).filter(item => item.key !== checkpoint.key), { ...checkpoint, completedAt: now }]
        : current.checkpoints;
      this.persist({ ...current, ...update, checkpoints, status: 'running', updatedAt: now });
      // A streaming client can leave while server-owned work continues.
      const safe = checkpoint ? { ...update, checkpoint: { key: checkpoint.key, title: checkpoint.title, items: checkpoint.items } } : update;
      try { onProgress?.(safe); } catch { /* Persisted progress remains available on the next page load. */ }
    };
    try {
      progress({ stage: 'preparing', message: '正在读取产品定位和已有内容。' });
      // Keep the full checkpoints server-side. The planner validates them and must
      // reject malformed saved data instead of silently starting paid work again.
      const generated = await this.dependencies.generate(job.positioning, progress, job.checkpoints);
      const incomplete = generated.coverageReview?.status === 'incomplete';
      const message = incomplete ? '仍有重要需求尚未覆盖，已保存候选问题，本轮未通过整组审核。' : '推荐问题已准备好。';
      progress({ stage: 'saving', message: incomplete ? '正在保存候选问题和仍未解决的需求。' : '审核已完成，正在保存推荐问题。' });
      this.dependencies.db.transaction(() => {
        const current = this.assertCurrent(job);
        const planRevision = this.dependencies.save(generated, expected);
        this.settle({ ...current, planRevision }, incomplete ? 'failed' : 'completed', message, incomplete ? message : undefined);
      }).immediate();
    } catch (error) {
      const current = this.current();
      if (current?.id === job.id && active(current)) {
        const message = questionGenerationErrorMessage(error);
        this.settle(current, 'failed', message, message);
      }
    }
  }
}

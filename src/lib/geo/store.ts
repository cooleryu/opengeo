import { importTaskResearchRuns } from './research-task-import';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getSeed } from './seed';
import { getLatestResearch } from './research';
import { getCompetitorCandidates } from './competitor-candidates';
import { attachOverviewData } from './overview-data';
import { freezeResearchTaskContext, resolveResearchTaskContext } from './research-task-context';
import { updateAssetGovernance } from './asset-governance';
import { buildClaimReview } from './claim-review';
import { validateImplementationDate } from './implementation';
import { normalizeStrategyMemory, validateStrategyMemory, activateStrategyMemory, revertStrategyMemory } from './strategy-lifecycle';
import { currentGeoProject, DEFAULT_PROJECT_ID, listGeoProjects, projectDataDirectory } from './projects';
import { buildVisibility, readImportedDeepSeek } from './visibility';
import { buildResearchGapReview, buildTaskDiagnosisContext, buildTaskPlan, canContinueTaskRevision, continueTaskRevision, getGeoModelSettings, proposalDigest, reviewEditedProposal } from './planner';
import { validateDiagnosis, validateProposal } from './diagnosis';
import { GEO_ACCEPTANCE_CRITERIA_VERSION } from './quality';
import { buildSearchProtocolKey } from './search-protocol';
import { collectionProvider, collectionKey, collectionReservation, collectionStatuses, getCollectionConfig, requireCollectionKey } from './providers/config';
import type { CollectionProvider } from './providers/types';
import { evaluateOutcome, buildStrategyMemory, selectStrategies } from './learning';
import { buildInitialQuestionPlan, generateQuestionPlan, validateQuestionPlan } from './question-planner';
import { reviewManualQuestion, saveManualQuestion } from './question-management';
import type { GeoQuestionPlan } from './question-types';
import type { AssetGovernanceInput, AssetGovernanceRecord, ClaimReviewRecord, GeoEvent, GeoMonitor, GeoRun, GeoState, GeoTask } from './types';
import type { GeoWorkflow, StrategyMemory, WorkflowQuestion } from './workflow-types';

export class GeoError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type Lock = { task_id: string; kind: string; started_at: string; run_id: string | null; mode: string | null; cost: number };
type Runtime = { db?: Database.Database; workflowSchemaReady?: boolean; governanceSchemaReady?: boolean; schedulerRunning: boolean; schedulerVersion?: number; timer?: ReturnType<typeof setInterval>; ticking: boolean; generatingQuestions?: boolean };
const globalGeo = globalThis as typeof globalThis & { __openGeoRuntime?: Runtime; __openGeoProjectRuntimes?: Map<string, Runtime> };
export const geoRuntime = globalGeo.__openGeoRuntime ??= { schedulerRunning: false, ticking: false };
const projectRuntimes = globalGeo.__openGeoProjectRuntimes ??= new Map<string, Runtime>();
function projectRuntime(): Runtime {
  const id = currentGeoProject();
  // Reuse the original connection and database for all pre-existing records.
  if (id === DEFAULT_PROJECT_ID) return geoRuntime;
  let runtime = projectRuntimes.get(id);
  if (!runtime) { runtime = { schedulerRunning: false, ticking: false }; projectRuntimes.set(id, runtime); }
  return runtime;
}
export const dataDirectory = projectDataDirectory;
export const nowISO = () => new Date().toISOString();
const roundCost = (n: number) => Math.round(n * 1000) / 1000;

export function newEvent(title: string, detail: string, kind: GeoEvent['kind'] = 'info'): GeoEvent {
  return { id: randomUUID(), at: nowISO(), title, detail, kind };
}

export function nextDailyRun(timeOfDay: string, now = new Date()): string {
  const [hour, minute] = timeOfDay.split(':').map(Number);
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  let next = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(), hour - 8, minute);
  if (next <= now.getTime()) next += 24 * 60 * 60 * 1000;
  return new Date(next).toISOString();
}

function makeTask(goal: string, id: string = randomUUID()): GeoTask {
  const at = nowISO();
  return {
    id, projectId: currentGeoProject(), title: goal.length > 54 ? `${goal.slice(0, 54)}…` : goal, goal,
    status: 'queued', createdAt: at, updatedAt: at, blocks: [], proposal: null,
    implementation: null, source: 'evidence', runs: [],
    events: [newEvent('任务已接下', `先核对 ${getSeed().project.name} 的现有产出与历史搜索证据，再提出一项可实施的改进。`)],
    monitor: {
      enabled: false, mode: 'replay', timeOfDay: '09:00', days: 7, remaining: 7,
      nextRunAt: null, budgetLimit: 0.5, spent: 0, lastRunAt: null,
      queryIds: getSeed().questions.map(q => q.id),
    },
  };
}

const governanceSchema = `
  CREATE TABLE IF NOT EXISTS geo_governance (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS geo_claim_reviews (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload TEXT NOT NULL, reviewed_at TEXT NOT NULL);
`;
function database(): Database.Database {
  const runtime = projectRuntime();
  if (runtime.db) {
    if (!runtime.governanceSchemaReady) {
      runtime.db.exec(governanceSchema);
      runtime.governanceSchemaReady = true;
    }
    // Development hot reload preserves the existing connection across schema additions.
    if (!runtime.workflowSchemaReady) {
      runtime.db.exec('CREATE TABLE IF NOT EXISTS geo_strategies (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
      runtime.workflowSchemaReady = true;
    }
    return runtime.db;
  }
  fs.mkdirSync(dataDirectory(), { recursive: true });
  const db = new Database(path.join(dataDirectory(), 'db.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS geo_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS geo_task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS geo_task_locks (task_id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, run_id TEXT, mode TEXT, cost REAL NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS geo_question_plans (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_id, revision));
    CREATE TABLE IF NOT EXISTS geo_strategies (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  if (!(db.prepare('PRAGMA table_info(geo_task_locks)').all() as { name: string }[]).some(column => column.name === 'cost')) db.exec('ALTER TABLE geo_task_locks ADD COLUMN cost REAL NOT NULL DEFAULT 0');
  runtime.db = db;
  runtime.workflowSchemaReady = true;
  db.exec(governanceSchema);
  runtime.governanceSchemaReady = true;
  // This runs once per server process, never on a routine state refresh.
  const stale = db.prepare('SELECT * FROM geo_task_locks').all() as Lock[];
  for (const lock of stale) {
    const task = getTask(lock.task_id);
    if (lock.kind === 'investigate') {
      task.status = 'failed';
      task.error = '调查因服务重启中断，可以重新开始；原有记录已保留。';
    } else {
      task.error = '上次观察因服务重启中断，未完成的问题不计为零命中。';
      const exists = task.runs.some(r => r.id === lock.run_id);
      if (!exists && lock.run_id) task.runs.push({
        id: lock.run_id, at: lock.started_at, measurementAt: lock.mode === 'replay' ? getSeed().questions[0]?.measurementAt || '' : lock.started_at,
        mode: lock.mode === 'live' ? 'live' : 'replay', status: 'failed', queryCount: task.monitor.queryIds.length,
        completedCount: 0, hitCount: null, resultCount: 0, cost: lock.cost || 0, questions: [],
        summary: '运行被服务重启中断；已发出的真实查询费用保留在累计金额中，原始响应保留在本地证据目录。', error: task.error,
      });
      task.monitor.nextRunAt = task.monitor.enabled ? nextDailyRun(task.monitor.timeOfDay) : null;
    }
    task.events.push(newEvent('恢复中断的任务', task.error, 'attention'));
    saveTask(task);
  }
  // Older records may have been saved immediately before a lock was written.
  for (const task of listTasks().filter(t => t.status === 'investigating')) {
    task.status = 'failed';
    task.error = '上次调查未完成，可以重新开始。';
    task.events.push(newEvent('调查等待重试', task.error, 'attention'));
    saveTask(task);
  }
  db.prepare('DELETE FROM geo_task_locks').run();
  return db;
}

export function listTasks(): GeoTask[] {
  return (database().prepare('SELECT payload FROM geo_tasks ORDER BY updated_at DESC').all() as { payload: string }[]).map(row => ({ ...JSON.parse(row.payload), projectId: currentGeoProject() }));
}
export function listStrategies(): StrategyMemory[] {
  const db = database();
  return (db.prepare('SELECT payload FROM geo_strategies WHERE project_id = ? ORDER BY created_at DESC').all(currentGeoProject()) as {payload:string}[]).map(row => {
    const original = JSON.parse(row.payload) as StrategyMemory;
    const strategy = normalizeStrategyMemory(original);
    if (strategy !== original) db.prepare('UPDATE geo_strategies SET payload = ?, created_at = ? WHERE id = ? AND project_id = ?').run(JSON.stringify(strategy), strategy.createdAt, strategy.id, currentGeoProject());
    return strategy;
  });
}
export function listGovernanceRecords(): AssetGovernanceRecord[] {
  return (database().prepare('SELECT payload FROM geo_governance WHERE project_id = ? ORDER BY updated_at DESC').all(currentGeoProject()) as {payload:string}[]).map(row => JSON.parse(row.payload));
}
function saveGovernance(record: AssetGovernanceRecord): void {
  database().prepare('INSERT INTO geo_governance (id,project_id,payload,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(record.id, record.projectId, JSON.stringify(record), record.updatedAt);
}
function listClaimReviews(): ClaimReviewRecord[] {
  return (database().prepare('SELECT payload FROM geo_claim_reviews WHERE project_id = ? ORDER BY reviewed_at DESC').all(currentGeoProject()) as {payload:string}[]).map(row => JSON.parse(row.payload));
}

export function refreshTaskOutcome(id: string): void {
  database().transaction(() => {
    const task = getTask(id);
    if (!task.workflow || !task.implementation) return;
    const outcome = evaluateOutcome(task);
    const previous = task.workflow.outcome;
    task.workflow.outcome = outcome;
    if (task.status === 'completed') task.workflow.stage = 'reflection';
    const strategy = buildStrategyMemory(task, getSeed().project.id);
    if (strategy) {
      const added = database().prepare('INSERT OR IGNORE INTO geo_strategies (id,task_id,project_id,payload,created_at) VALUES (?,?,?,?,?)').run(strategy.id, strategy.taskId, strategy.projectId, JSON.stringify(strategy), strategy.createdAt);
      if (added.changes) task.events.push(newEvent('真实结果已进入策略记录', strategy.recommendation, 'success'));
    }
    if (!previous || previous.classification !== outcome.classification || previous.followupRunIds.join() !== outcome.followupRunIds.join()) {
      task.events.push(newEvent('实施效果已复盘', outcome.summary, outcome.classification === 'inconclusive' ? 'attention' : 'info'));
    }
    saveTask(task);
  })();
}
export function getQuestionPlan(): GeoQuestionPlan {
  const seed = getSeed();
  const db = database();
  const row = db.prepare('SELECT payload FROM geo_question_plans WHERE project_id = ? ORDER BY seq DESC LIMIT 1').get(seed.project.id) as { payload: string } | undefined;
  if (row) return JSON.parse(row.payload);
  const plan = buildInitialQuestionPlan(seed);
  db.prepare('INSERT INTO geo_question_plans (project_id,plan_id,revision,payload,created_at) VALUES (?,?,?,?,?)').run(plan.projectId, plan.id, plan.revision, JSON.stringify(plan), plan.createdAt);
  return plan;
}
function currentQuestionPlan(body: Record<string, unknown>): GeoQuestionPlan {
  const plan = getQuestionPlan();
  if (body.planId !== plan.id || body.revision !== plan.revision) throw new GeoError('题单已在其他窗口更新，请刷新后再操作。', 409);
  return plan;
}
function saveQuestionPlan(input: GeoQuestionPlan, expected: GeoQuestionPlan, onlyCandidateId?: string): void {
  database().transaction(() => {
    currentQuestionPlan({ planId: expected.id, revision: expected.revision });
    let plan = validateQuestionPlan({ ...input, id: expected.id, createdAt: expected.createdAt, revision: expected.revision + 1, updatedAt: nowISO() }, getSeed());
    if (onlyCandidateId) {
      const reviewed = plan.candidates.find(item => item.id === onlyCandidateId);
      if (!reviewed || !expected.candidates.some(item => item.id === onlyCandidateId)) throw new GeoError('复评问题已变化，请刷新后重试。', 409);
      plan = { ...plan, candidates: expected.candidates.map(item => item.id === onlyCandidateId ? reviewed : item) };
    }
    database().prepare('INSERT INTO geo_question_plans (project_id,plan_id,revision,payload,created_at) VALUES (?,?,?,?,?)').run(plan.projectId, plan.id, plan.revision, JSON.stringify(plan), plan.updatedAt);
  })();
}
export function getTask(id: string): GeoTask {
  const row = database().prepare('SELECT payload FROM geo_tasks WHERE id = ?').get(id) as { payload: string } | undefined;
  if (!row) throw new GeoError('没有找到这条任务。', 404);
  return { ...JSON.parse(row.payload), projectId: currentGeoProject() };
}
export function saveTask(task: GeoTask): void {
  if ((task.projectId || DEFAULT_PROJECT_ID) !== currentGeoProject()) throw new GeoError('任务与当前项目不匹配。', 404);
  const db = database();
  task.updatedAt = nowISO();
  db.transaction(() => {
    const add = db.prepare('INSERT OR IGNORE INTO geo_task_events (id,task_id,at,payload) VALUES (?,?,?,?)');
    for (const event of task.events) add.run(event.id, task.id, event.at, JSON.stringify(event));
    // Historical events are append-only even if a caller has an older snapshot.
    task.events = (db.prepare('SELECT payload FROM geo_task_events WHERE task_id = ? ORDER BY rowid').all(task.id) as { payload: string }[]).map(row => JSON.parse(row.payload));
    db.prepare('INSERT INTO geo_tasks (id,payload,updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at').run(task.id, JSON.stringify(task), task.updatedAt);
  })();
}
export function updateTask(id: string, change: (task: GeoTask) => void): GeoTask {
  return database().transaction(() => { const task = getTask(id); change(task); saveTask(task); return task; })();
}
export function taskIsBusy(id: string): boolean {
  return Boolean(database().prepare('SELECT task_id FROM geo_task_locks WHERE task_id = ?').get(id));
}
export function claimTask(id: string, kind: 'investigate' | 'monitor', runId?: string, mode?: 'live' | 'replay'): void {
  const db = database();
  db.transaction(() => {
    getTask(id);
    if (taskIsBusy(id)) throw new GeoError('这条任务正在执行，请等本次完成。', 409);
    if (mode === 'live' && db.prepare("SELECT task_id FROM geo_task_locks WHERE mode = 'live'").get()) throw new GeoError('另一条真实观察正在执行，请稍后再试。', 409);
    db.prepare('INSERT INTO geo_task_locks (task_id,kind,started_at,run_id,mode) VALUES (?,?,?,?,?)').run(id, kind, nowISO(), runId || null, mode || null);
  })();
}
export function releaseTask(id: string): void { database().prepare('DELETE FROM geo_task_locks WHERE task_id = ?').run(id); }
export function chargeTask(id: string, cost: number): void {
  database().transaction(() => {
    updateTask(id, t => { t.monitor.spent = Math.max(0, roundCost(t.monitor.spent + cost)); });
    database().prepare('UPDATE geo_task_locks SET cost = ROUND(MAX(0, cost + ?), 3) WHERE task_id = ?').run(cost, id);
  })();
}

export function getGeoState(): GeoState {
  const model = getGeoModelSettings();
  const seed = getSeed();
  const imported = readImportedDeepSeek(seed);
  const tasks = listTasks();
  for (const task of tasks) importTaskResearchRuns(task);
  const completeRuns = tasks.flatMap(task => task.runs).filter(run =>
    !run.protocolKey && !run.phase && run.mode === 'live' && run.status === 'completed' &&
    run.queryCount === seed.questions.length && run.completedCount === seed.questions.length &&
    run.questions.length === seed.questions.length &&
    seed.questions.every(fixed => run.questions.some(question => question.id === fixed.id && question.query === fixed.query && question.provider === 'DeepSeek Search API')),
  ).sort((a, b) => new Date(b.measurementAt).getTime() - new Date(a.measurementAt).getTime());
  const baseline = seed.observations.find(observation => observation.comparableGroup === 'deepseek-search-v1-count50-fixed14');
  const observations = [...completeRuns.map(run => ({
    id: `live-${run.id}`, measurementAt: run.measurementAt, provider: 'DeepSeek Search API',
    comparableGroup: baseline?.comparableGroup || 'deepseek-search-v1-count50-fixed14',
    queryCount: run.questions.length, hitCount: run.questions.filter(question => question.projectHit).length,
    resultCount: run.questions.reduce((sum, question) => sum + question.resultCount, 0), rank: null, aiCited: null,
    sourcePath: `data/geo-evidence/${run.id}/run.json`,
    comparabilityNote: '固定题、同 DeepSeek 搜索入口、count=50、need_content=false。可与 2026-10-18 基线描述性比较；单次变化不证明因果，AI 引用仍未测。',
  })), ...(imported ? [imported.observation] : []), ...seed.observations].sort((a, b) => new Date(b.measurementAt).getTime() - new Date(a.measurementAt).getTime());
  const newest = completeRuns[0];
  const savedQuestions = imported && new Date(imported.observation.measurementAt).getTime() > new Date(seed.questions[0]?.measurementAt || 0).getTime() ? imported.questions : seed.questions;
  const questions = newest && new Date(newest.measurementAt).getTime() > new Date(savedQuestions[0]?.measurementAt || 0).getTime() ? newest.questions : savedQuestions;
  return {
    latestResearch: attachOverviewData(getLatestResearch(seed.project.id)), governanceRecords: listGovernanceRecords(), claimReviews: listClaimReviews(),
    ...seed, projects: listGeoProjects(), questions, observations, tasks: tasks.map(task => ({ ...task, canContinueRevision: canContinueTaskRevision(task) })), questionPlan: getQuestionPlan(), visibility: buildVisibility(seed, questions, tasks), strategies: listStrategies(),
    settings: {
      liveSearchConfigured: Boolean(collectionKey('deepseek')),
      collectionProviders: collectionStatuses(),
      modelConfigured: model.modelConfigured, modelName: model.modelName,
      mode: 'demo', schedulerRunning: geoRuntime.schedulerRunning,
    },
  };
}

function textInput(value: unknown, max: number, label: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) throw new GeoError(`${label}不能为空且不能超过 ${max} 字。`);
  return value.trim();
}
function requireStatus(task: GeoTask, statuses: GeoTask['status'][]): void {
  if (!statuses.includes(task.status)) throw new GeoError('这一步暂时不可执行，请先完成上一阶段。', 409);
}

async function finishInvestigation(id: string) {
  try {
    const taskBefore = getTask(id);
    const strategies = selectStrategies(taskBefore, listStrategies(), currentGeoProject());
    const result = await buildTaskPlan(taskBefore, getSeed(), strategies);
    updateTask(id, task => {
      task.proposal = result.proposal; task.blocks = result.blocks; task.source = result.source;
      if (task.workflow) {
        if (task.workflow.quality) (task.workflow.qualityHistory ??= []).push({ proposalRevision: task.workflow.proposalRevision, quality: task.workflow.quality });
        task.workflow.diagnosis = result.diagnosis;
        task.workflow.quality = result.quality;
        task.workflow.proposalRevision += 1;
        task.workflow.appliedStrategyIds = result.appliedStrategyIds;
        task.workflow.stage = 'quality';
      }
      task.status = 'proposal_ready'; delete task.error;
      const passed = result.quality.rounds.some(round => round.review.passed && round.review.proposalDigest === proposalDigest(result.proposal));
      task.events.push(newEvent(passed ? '诊断和复检完成，方案待确认' : '诊断已保存，方案尚未通过审核', passed ? `已完成 ${result.quality.rounds.length} 轮检查，候选达到当前审核标准；外部效果仍待实施后验证。` : result.quality.stopReason === 'needs_configuration' ? '已保留本地预览；请配置生成模型后运行独立审核，未通过的草稿不能确认实施。' : `停止原因：${result.quality.stopReason}。请查看检查问题和证据缺口。`, passed ? 'success' : 'attention'));
    });
  } catch (error) {
    updateTask(id, task => { task.status = 'failed'; task.error = error instanceof Error ? error.message : '调查失败，请重试。'; task.events.push(newEvent('调查未完成', task.error, 'error')); });
  } finally { releaseTask(id); }
}

function freezeQuestions(provider: CollectionProvider = 'deepseek'): GeoWorkflow {
  const seed = getSeed();
  const plan = validateQuestionPlan(getQuestionPlan(), seed);
  if (plan.status !== 'ready') throw new GeoError('请先在题单里审阅并确认要搜索的问题。');
  const selected = plan.candidates.filter(candidate => candidate.selected && candidate.review.decision !== 'exclude');
  if (!selected.length) throw new GeoError('确认的题单没有可搜索的问题。');
  const questions: WorkflowQuestion[] = selected.map(candidate => ({
    id: candidate.originalQuestionId || candidate.id, query: candidate.query,
    language: seed.questions.find(question => question.id === candidate.originalQuestionId)?.language || (/\p{Script=Han}/u.test(candidate.query) ? 'zh-CN' : 'en'),
    category: candidate.category, target: candidate.target, assetIds: [...candidate.assetIds],
    exploratory: candidate.review.decision === 'explore', intent: candidate.intent, expectedResult: candidate.expectedResult,
  }));
  const collection = getCollectionConfig(provider);
  return { version: 1, collection, questionPlanId: plan.id, questionPlanRevision: plan.revision, frozenAt: nowISO(), questions,
    protocolKey: buildSearchProtocolKey(questions, collection), stage: 'search', proposalRevision: 0, appliedStrategyIds: [] };
}

async function finishWorkflowSearch(id: string, mode: 'live'|'replay') {
  try {
    const { collectBaseline } = await import('./monitor');
    const baseline = await collectBaseline(id, mode);
    updateTask(id, task => {
      task.workflow!.baseline = baseline;
      task.workflow!.stage = 'diagnosis';
      task.events.push(newEvent('实施前搜索已记录', baseline.summary, baseline.status === 'completed' ? 'success' : 'attention'));
    });
    // The same lock spans search, diagnosis and quality review.
    await finishInvestigation(id);
  } catch (error) {
    updateTask(id, task => {
      task.status = 'failed'; task.error = error instanceof Error ? error.message : '搜索未完成。';
      task.events.push(newEvent('链路等待处理', task.error, 'error'));
    });
  } finally { releaseTask(id); }
}

async function finishEditedReview(id: string) {
  try {
    const task = getTask(id);
    const quality = await reviewEditedProposal(task, getSeed(), task.proposal!, selectStrategies(task, listStrategies(), currentGeoProject()));
    updateTask(id, current => {
      current.workflow!.quality = quality;
      current.workflow!.stage = 'quality';
      current.status = 'proposal_ready'; delete current.error;
      const passed = quality.rounds.some(round => round.review.passed && round.review.proposalDigest === proposalDigest(current.proposal!));
      current.events.push(newEvent('编辑稿已重新检查', passed ? '当前正文已通过独立审核，可以确认方案。' : '当前正文尚未通过审核，请查看问题；旧审核结果不能用于新正文。', passed ? 'success' : 'attention'));
    });
  } catch (error) {
    updateTask(id, task => { task.status = 'failed'; task.error = error instanceof Error ? error.message : '复检未完成。'; task.events.push(newEvent('复检需要处理', task.error, 'error')); });
  } finally { releaseTask(id); }
}

function hasCurrentApproval(task: GeoTask): boolean {
  if (!task.proposal || !task.workflow?.quality) return false;
  if (task.workflow.savedResearch) {
    const seed = getSeed();
    const context = buildTaskDiagnosisContext(task, seed);
    if (!context.evidenceReady || !task.workflow.diagnosis ||
      validateDiagnosis(task.workflow.diagnosis, context).length ||
      validateProposal(task.proposal, seed, context).length) return false;
  }
  const latest = task.workflow.quality.rounds.filter(round => round.review.proposalDigest === proposalDigest(task.proposal!)).at(-1)?.review;
  if (task.workflow.savedResearch && latest?.criteriaVersion !== GEO_ACCEPTANCE_CRITERIA_VERSION) return false;
  return Boolean(latest?.passed && (!task.reviewContextUpdatedAt || Date.parse(latest.reviewedAt) >= Date.parse(task.reviewContextUpdatedAt)));
}

async function finishContinuation(original: GeoTask, maxAdditionalRounds: number) {
  const id = original.id;
  const assertActive = () => {
    const current = getTask(id);
    if (current.status !== 'investigating' || current.implementation
      || current.workflow?.proposalRevision !== original.workflow!.proposalRevision
      || !current.proposal || proposalDigest(current.proposal) !== proposalDigest(original.proposal!)) {
      throw new GeoError('任务或稿件已变化，自动续改已停止，原有内容保留。', 409);
    }
  };
  try {
    const result = await continueTaskRevision(original, getSeed(), selectStrategies(original, listStrategies(), currentGeoProject()), maxAdditionalRounds, assertActive);
    assertActive();
    updateTask(id, task => {
      const workflow = task.workflow!;
      (workflow.qualityHistory ??= []).push({ proposalRevision: workflow.proposalRevision, quality: workflow.quality! });
      workflow.proposalRevision += 1;
      workflow.quality = result.quality;
      workflow.stage = 'quality';
      task.proposal = result.proposal; task.blocks = result.blocks;
      task.status = 'proposal_ready'; delete task.error;
      const reason = { target_reached: '当前稿已达到审核标准，等待确认方案。', no_progress: '修改没有继续改善，已停止并保留较好版本。', round_limit: '追加轮次已用完，未通过的候选仍为待修改。', needs_configuration: '需要补齐配置。', needs_evidence: '需要补齐证据。' }[result.quality.stopReason];
      task.events.push(newEvent('自动续改完成', `沿用原搜索和诊断，追加 ${result.quality.rounds.length - 1} 轮改稿复检。${reason}`,
        result.quality.stopReason === 'target_reached' ? 'success' : 'attention'));
    });
  } catch (error) {
    updateTask(id, task => {
      if (task.status !== 'paused') task.status = 'failed';
      task.error = error instanceof Error ? error.message : '自动续改未完成，原稿和审核记录已保留。';
      task.events.push(newEvent('自动续改已停止', task.error, 'attention'));
    });
  } finally { releaseTask(id); }
}

export async function handleGeoAction(body: Record<string, unknown>): Promise<GeoState> {
  const action = body.action;
  if (action === 'save_claim_review') {
    try {
      const review = buildClaimReview(body.review, getLatestResearch(currentGeoProject()), currentGeoProject());
      database().prepare('INSERT INTO geo_claim_reviews (id,project_id,payload,reviewed_at) VALUES (?,?,?,?)').run(review.id, review.projectId, JSON.stringify(review), review.reviewedAt);
    } catch (error) { throw new GeoError(error instanceof Error ? error.message : '无法保存核查。'); }
    return getGeoState();
  }
  if (action === 'save_asset_governance') {
    if (!body.governance || typeof body.governance !== 'object' || Array.isArray(body.governance)) throw new GeoError('核查记录格式无效。');
    try {
      const input = body.governance as AssetGovernanceInput;
      database().transaction(() => {
        const record = updateAssetGovernance(input, getLatestResearch(currentGeoProject()), currentGeoProject(), listTasks(), listGovernanceRecords().find(item => item.gapId === input.gapId));
        saveGovernance(record);
        for (const taskId of record.taskIds) {
          const linked = getTask(taskId);
          if (linked.implementation || linked.researchContext?.gapId !== record.gapId) continue;
          if (taskIsBusy(taskId)) throw new GeoError('关联任务正在审核，请待本次完成后更新依据。', 409);
          updateTask(taskId, t => {
            t.assetGovernance = record;
            delete t.researchGapReview;
            if (input.evidence || input.resolution !== undefined) {
              t.reviewContextUpdatedAt = record.updatedAt;
              if (t.proposal) { t.proposal.status = 'draft'; t.status = 'proposal_ready'; }
              t.events.push(newEvent('核查依据已更新', '新登记的依据随任务保存；已有候选需完整复检后才能确认实施。'));
            }
          });
        }
      })();
    } catch (error) { throw new GeoError(error instanceof Error ? error.message : '无法保存核查记录。'); }
    return getGeoState();
  }
  if (['generate_questions', 'audit_question', 'save_question', 'review_question', 'select_question', 'confirm_questions'].includes(String(action))) {
    const plan = currentQuestionPlan(body);
    if (action === 'audit_question') {
      const runtime = projectRuntime();
      if (runtime.generatingQuestions) throw new GeoError('正在拟题或复评，请等本次完成。', 409);
      const candidateId = textInput(body.candidateId, 180, '候选问题');
      runtime.generatingQuestions = true;
      try {
        const { reviewQuestionCandidate } = await import('./question-planner');
        const updated = await reviewQuestionCandidate(getSeed(), plan, candidateId);
        saveQuestionPlan(updated, plan, candidateId);
      } catch (error) {
        if (error instanceof GeoError) throw error;
        throw new GeoError(error instanceof Error ? error.message : 'AI 复评未完成，原判断已保留。');
      } finally { runtime.generatingQuestions = false; }
    } else if (action === 'save_question' || action === 'review_question') {
      try {
        const updated = action === 'save_question'
          ? saveManualQuestion(plan, getSeed(), body, getLatestResearch(currentGeoProject()))
          : reviewManualQuestion(plan, getSeed(), body);
        if (updated !== plan) saveQuestionPlan(updated, plan);
      } catch (error) {
        if (error instanceof GeoError) throw error;
        throw new GeoError(error instanceof Error ? error.message : '无法保存问题。');
      }
    } else if (action === 'generate_questions') {
      const runtime = projectRuntime();
      if (runtime.generatingQuestions) throw new GeoError('正在拟题和审核，请等本次完成。', 409);
      const positioning = textInput(body.positioning, 1000, '项目定位');
      runtime.generatingQuestions = true;
      try {
        const generated = await generateQuestionPlan(getSeed(), positioning);
        const previousSelections = new Map(plan.candidates.filter(item => item.origin === 'existing').map(item => [item.originalQuestionId, item.selected]));
        saveQuestionPlan({ ...generated, status: 'draft', candidates: generated.candidates.map(item => item.origin === 'existing' && previousSelections.has(item.originalQuestionId) ? { ...item, selected: previousSelections.get(item.originalQuestionId)! } : item) }, plan);
      } finally { runtime.generatingQuestions = false; }
    } else if (action === 'select_question') {
      const candidate = plan.candidates.find(item => item.id === body.candidateId);
      if (!candidate) throw new GeoError('没有找到这道候选题。', 404);
      if (typeof body.selected !== 'boolean') throw new GeoError('请选择是否纳入题单。');
      if (body.selected && candidate.supersededByCandidateId) throw new GeoError('这道问题已有新版本，请选择最新版本。');
      if (body.selected && candidate.review.status === 'pending') throw new GeoError('请先完成人工审阅，再纳入题单。');
      if (body.selected && candidate.review.decision === 'exclude') throw new GeoError('这道题未通过审核，不能纳入题单。');
      if (body.selected && !candidate.selected && plan.candidates.filter(item => item.selected).length >= 8) throw new GeoError('每批最多 8 题，请先移出其他问题；候选内容会保留。');
      saveQuestionPlan({ ...plan, status: 'draft', candidates: plan.candidates.map(item => item.id === candidate.id ? { ...item, selected: body.selected as boolean } : item) }, plan);
    } else {
      if (!plan.candidates.some(item => item.selected)) throw new GeoError('请至少选择一道问题。');
      if (plan.candidates.filter(item => item.selected).length > 8) throw new GeoError('每批最多 8 题，请精简选择后再确认。');
      if (plan.candidates.some(item => item.selected && (item.review.status === 'pending' || item.supersededByCandidateId))) throw new GeoError('题单中有待审阅或已被新版替代的问题。');
      if (plan.candidates.some(item => item.selected && item.review.decision === 'exclude')) throw new GeoError('题单中有未通过审核的问题。');
      const { saveResearchBatchFromPlan } = await import('./research-batch-plan');
      database().transaction(() => {
        currentQuestionPlan({ planId: plan.id, revision: plan.revision });
        if (plan.status !== 'ready') saveQuestionPlan({ ...plan, status: 'ready' }, plan);
        saveResearchBatchFromPlan(getQuestionPlan(), getSeed(), database());
      })();
    }
    return getGeoState();
  }
  if (action === 'create_task') {
    const goal = textInput(body.goal, 2000, '任务描述');
    const created = { ...makeTask(goal), collectionProvider: collectionProvider(body.collectionProvider) };
    if (body.researchContext !== undefined) {
      try {
        const batch = getLatestResearch(currentGeoProject());
        const input = body.researchContext as Record<string, unknown> | null;
        const competitors = input && typeof input === 'object' && input.candidateId !== undefined
          ? getCompetitorCandidates(batch?.id) : undefined;
        const { context, question, observations } = resolveResearchTaskContext(body.researchContext, batch, currentGeoProject(), getSeed().assets, competitors);
        created.researchContext = context;
        created.monitor.queryIds = [question.id];
        created.events.push(newEvent('研究题已关联', `${context.questionId} · ${context.language} · ${context.engine}，关联 ${observations.length} 条原始观测。历史网页记录仅供参考，不是新任务基线；个人 ChatGPT 或 Google 网页条件不等同于后续 API 采集条件。`));
        if (context.snapshot?.competitorReference) created.events.push(newEvent('参照已保存', `参照：${context.snapshot.competitorReference.name}。分别验证自身是否改善、与该参照的差距是否缩小；缺少同条件复测时保持待验证。`));
      } catch (error) { throw new GeoError(error instanceof Error ? error.message : '研究题来源无效。'); }
    } else if (getLatestResearch(currentGeoProject()) && body.legacyQuestionPlan !== true) {
      throw new GeoError('请选择本轮要解决的问题；如需旧题单，请明确选择旧题单入口。');
    }
    database().transaction(() => {
      saveTask(created);
      const context = created.researchContext;
      if (context?.gapId) {
        const record = updateAssetGovernance({ batchId: context.batchId, questionId: context.questionId, gapId: context.gapId, taskIds: [created.id], status: 'investigating' }, getLatestResearch(currentGeoProject()), currentGeoProject(), listTasks(), listGovernanceRecords().find(item => item.gapId === context.gapId));
        saveGovernance(record);
        updateTask(created.id, t => { t.assetGovernance = record; });
      }
    })();
    return getGeoState();
  }
  const id = textInput(body.taskId, 120, '任务 ID');
  const task = getTask(id);
  if (taskIsBusy(id) && !['pause'].includes(String(action))) throw new GeoError('这条任务正在执行，请稍等片刻。', 409);
  if (task.workflow && ['continue_revision', 'review_plan', 'accept_plan', 'confirm_implementation'].includes(String(action)) && body.proposalRevision !== task.workflow.proposalRevision) {
    throw new GeoError('方案已在其他窗口更新，请刷新并查看当前版本后再操作。', 409);
  }
  switch (action) {
    case 'plan_from_saved': {
      requireStatus(task, ['queued', 'failed', 'proposal_ready']);
      if (task.implementation) throw new GeoError('已实施任务保留原方案，请新建下一条改进任务。');
      if (task.proposal?.status === 'accepted') throw new GeoError('这条方案已经确认，请保留原方案或新建任务。');
      if (!getGeoModelSettings().modelConfigured) throw new GeoError('请先在设置中配置分析模型。');
      const rounds = body.maxQualityRounds ?? 2;
      if (!Number.isInteger(rounds) || Number(rounds) < 1 || Number(rounds) > 3) throw new GeoError('审核轮次上限应为 1 到 3。');
      let workflow: GeoWorkflow;
      try {
        const { prepareSavedResearchWorkflow } = await import('./planner');
        workflow = prepareSavedResearchWorkflow(task, getSeed());
      } catch (error) { throw new GeoError(error instanceof Error ? error.message : '已有回答的证据不足。'); }
      workflow.maxQualityRounds = Number(rounds);
      claimTask(id, 'investigate');
      try {
        updateTask(id, t => {
          if (t.workflow) (t.workflowHistory ??= []).push(structuredClone(t.workflow));
          t.workflow = workflow; t.proposal = null; t.blocks = []; t.status = 'investigating'; delete t.error;
          t.monitor = { ...t.monitor, enabled: false, nextRunAt: null, queryIds: workflow.questions.map(question => question.id) };
          t.events.push(newEvent('开始制定改进方案', '使用该题已保存的真实回答和自有内容进行比较、生成方案并独立审核；本次未重新搜索，原始采集时间与条件保持不变。'));
        });
      } catch (error) { releaseTask(id); throw error; }
      void finishInvestigation(id);
      break;
    }
    case 'review_research_gap': {
      if (!task.researchContext) throw new GeoError('这条任务没有已保存的研究来源。');
      const review = buildResearchGapReview(task, getSeed());
      updateTask(id, t => {
        t.researchGapReview = review;
        t.events.push(newEvent('已有材料核对完成', '已核对原问题、缺口和可读取材料；没有启动搜索、确认产品能力或批准改稿。'));
      });
      break;
    }
    case 'validate_strategy':
    case 'activate_strategy':
    case 'revert_strategy': {
      const strategyId = textInput(body.strategyId, 180, '策略记录');
      try {
        database().transaction(() => {
          const strategy = listStrategies().find(item => item.id === strategyId && item.taskId === id);
          if (!strategy) throw new Error('没有找到这条任务的策略记录。');
          if (body.version !== strategy.version) throw new Error('策略已更新，请刷新后重试。');
          const next = action === 'validate_strategy' ? validateStrategyMemory(strategy, getTask(id)) : action === 'activate_strategy' ? activateStrategyMemory(strategy) : revertStrategyMemory(strategy, textInput(body.reason, 1000, '回退原因'));
          if (next.status === 'active') {
            for (const previous of listStrategies().filter(item => item.id !== next.id && item.status === 'active' && item.protocolKey === next.protocolKey && item.targetAssetId === next.targetAssetId)) {
              const retired = revertStrategyMemory(previous, `已由策略 ${next.id} 替代`);
              database().prepare('UPDATE geo_strategies SET payload = ? WHERE id = ? AND project_id = ?').run(JSON.stringify(retired), retired.id, currentGeoProject());
            }
          }
          database().prepare('UPDATE geo_strategies SET payload = ? WHERE id = ? AND project_id = ?').run(JSON.stringify(next), next.id, currentGeoProject());
          updateTask(id, t => t.events.push(newEvent(action === 'validate_strategy' ? '已核对策略验证记录' : action === 'activate_strategy' ? '策略已生效' : '策略已回退', next.validation?.summary || next.recommendation)));
        })();
      } catch (error) { throw new GeoError(error instanceof Error ? error.message : '无法更新策略。'); }
      break;
    }
    case 'start_workflow': {
      requireStatus(task, ['queued', 'failed', 'proposal_ready']);
      if (task.implementation) throw new GeoError('实施后的任务请使用原题单跟测；新题单请新建任务。');
      if (task.workflow?.baseline?.mode === 'live' && task.workflow.baseline.status === 'completed') throw new GeoError('已经有真实基线，请继续诊断和审核；更换题单请新建任务。');
      if (body.mode !== 'live' && body.mode !== 'replay') throw new GeoError('请选择真实搜索或历史预览。');
      let workflow: GeoWorkflow;
      let researchContext = task.researchContext;
      if (researchContext) {
        try {
          if (!researchContext.snapshot) researchContext = resolveResearchTaskContext(researchContext, getLatestResearch(currentGeoProject()), currentGeoProject(), getSeed().assets).context;
          workflow = freezeResearchTaskContext(researchContext, getLatestResearch(currentGeoProject()), currentGeoProject(), getCollectionConfig(task.collectionProvider), nowISO(), body.mode);
        } catch (error) { throw new GeoError(error instanceof Error ? error.message : '研究题无法冻结。'); }
      } else {
        workflow = freezeQuestions(task.collectionProvider);
      }
      const rounds = body.maxQualityRounds ?? 3;
      if (!Number.isInteger(rounds) || Number(rounds) < 1 || Number(rounds) > 3) throw new GeoError('审核轮次上限应为 1 到 3。');
      workflow.maxQualityRounds = Number(rounds);
      const mode = body.mode;
      if (mode === 'replay' && workflow.collection!.provider !== 'deepseek') throw new GeoError('豆包、千问尚无可匹配的历史回放，请选择真实联网回答。');
      let budgetLimit = task.monitor.budgetLimit;
      if (mode === 'live') {
        const dateKey = (value: string) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10);
        const baselines = [task.workflow, ...(task.workflowHistory || [])].flatMap(workflow => workflow?.baseline ? [workflow.baseline] : []);
        if (baselines.some(run => run.mode === 'live' && dateKey(run.at) === dateKey(nowISO()))) throw new GeoError('这条任务今天已尝试真实基线采集，失败记录和费用预留已保留；请明天再采集。');
        requireCollectionKey(workflow.collection!.provider);
        if (!getGeoModelSettings().modelConfigured) throw new GeoError('请先在设置中配置 AI 模型，才能在搜索后继续诊断和独立审核。');
        if (typeof body.budgetLimit !== 'number' || !Number.isFinite(body.budgetLimit) || body.budgetLimit > 100 || body.budgetLimit < task.monitor.spent + workflow.questions.length * collectionReservation(workflow.collection!.provider)) throw new GeoError('请明确填写足够完成本轮搜索的预算，且不超过 100 元。');
        budgetLimit = roundCost(body.budgetLimit);
      }
      claimTask(id, 'investigate', undefined, mode);
      updateTask(id, t => {
        if (t.workflow) (t.workflowHistory ??= []).push(structuredClone(t.workflow));
        if (researchContext) t.researchContext = researchContext;
        t.workflow = workflow; t.proposal = null; t.blocks = []; t.status = 'investigating'; delete t.error;
        t.monitor = { ...t.monitor, enabled: false, nextRunAt: null, queryIds: workflow.questions.map(question => question.id), budgetLimit };
        t.events.push(newEvent('题单已冻结，开始搜索', `题单第 ${workflow.questionPlanRevision} 版，共 ${workflow.questions.length} 题；${mode === 'live' ? '真实搜索后自动诊断、生成候选并独立审核。' : '只匹配已有历史证据，未测新题保持缺失；不产生真实效果或通过审核的建议。'}`));
      });
      void finishWorkflowSearch(id, mode);
      break;
    }
    case 'investigate': {
      requireStatus(task, ['queued', 'failed', 'proposal_ready']);
      if (!task.workflow) throw new GeoError('请先确认题单，再选择搜索方式启动完整任务。');
      if (!task.workflow.baseline) throw new GeoError('请先完成实施前搜索。');
      if (task.implementation) throw new GeoError('实施后的任务保留原方案；请复盘结果或新建下一条任务。');
      claimTask(id, 'investigate');
      updateTask(id, t => { t.status = 'investigating'; delete t.error; t.events.push(newEvent('开始调查', '正在对齐项目身份、已发布内容和固定题搜索记录。')); });
      void finishInvestigation(id);
      break;
    }
    case 'continue_revision': {
      requireStatus(task, ['proposal_ready', 'failed']);
      if (!canContinueTaskRevision(task)) throw new GeoError('当前稿没有匹配的未通过审核，或证据、配置不完整；不能继续自动改稿。');
      const maxAdditionalRounds = body.maxAdditionalRounds ?? 2;
      if (!Number.isInteger(maxAdditionalRounds) || Number(maxAdditionalRounds) < 1 || Number(maxAdditionalRounds) > 2) throw new GeoError('每次续改只能追加 1 到 2 轮。');
      claimTask(id, 'investigate');
      updateTask(id, current => {
        current.status = 'investigating'; delete current.error;
        current.events.push(newEvent('按审核意见继续自动改', `复用当前稿、审核意见、搜索证据和诊断，最多追加 ${maxAdditionalRounds} 轮；达标、无进步或轮次用完即停止。`));
      });
      void finishContinuation(task, Number(maxAdditionalRounds));
      break;
    }
    case 'review_plan': {
      requireStatus(task, ['proposal_ready', 'failed']);
      if (!task.workflow || !task.proposal || task.implementation) throw new GeoError('当前没有可重新审核的候选方案。');
      const after = textInput(body.after, 50000, '修改内容');
      claimTask(id, 'investigate');
      updateTask(id, t => {
        t.proposal = { ...t.proposal!, after, status: 'draft' };
        if (t.workflow!.quality) (t.workflow!.qualityHistory ??= []).push({ proposalRevision: t.workflow!.proposalRevision, quality: t.workflow!.quality! });
        t.workflow!.proposalRevision += 1;
        delete t.workflow!.quality;
        t.status = 'investigating'; delete t.error;
        t.events.push(newEvent('修改稿等待复检', '正文修改后旧审核已失效，正在重新检查当前完整候选。'));
      });
      void finishEditedReview(id);
      break;
    }
    case 'accept_plan': {
      requireStatus(task, ['proposal_ready']);
      if (!task.proposal) throw new GeoError('还没有可确认的方案。');
      const after = body.after === undefined ? task.proposal.after : textInput(body.after, 50000, '修改内容');
      if (after !== task.proposal.after || !hasCurrentApproval(task)) throw new GeoError('当前版本尚未通过审核，或正文已修改。请先完整复检再确认方案。');
      updateTask(id, t => { t.proposal = { ...t.proposal!, after, status: 'accepted' }; t.status = 'awaiting_implementation'; t.workflow!.stage = 'implementation'; t.events.push(newEvent('已确认改进方案', '通过审核的具体修改已保存。请实施后记录改动和链接；系统不会自动修改线上内容。', 'success')); });
      break;
    }
    case 'confirm_implementation': {
      const supplementDate = task.implementation?.kind === 'user_confirmed' && !task.implementation.occurredAt && body.kind === 'user_confirmed';
      requireStatus(task, supplementDate ? ['awaiting_implementation', 'monitoring', 'paused', 'completed', 'failed'] : ['awaiting_implementation', 'monitoring', 'paused']);
      if (!task.proposal || task.proposal.status !== 'accepted') throw new GeoError('请先确认改进方案。');
      if (task.workflow && !hasCurrentApproval(task)) throw new GeoError('当前方案审核已失效，请重新检查。');
      if (task.implementation?.kind === 'user_confirmed') {
        if (task.implementation.occurredAt) throw new GeoError('当前方案的真实实施已经记录。追加内容变更请新建任务，避免改写前后比较条件。');
        const approvedAt = task.workflow?.quality?.rounds.find(round => round.review.passed && round.review.proposalDigest === proposalDigest(task.proposal!))?.review.reviewedAt;
        try {
          const occurredAt = validateImplementationDate(body.occurredAt, task.implementation.at, approvedAt);
          updateTask(id, t => {
            t.implementation = { ...t.implementation!, occurredAt };
            if (t.workflow) delete t.workflow.outcome;
            t.events.push(newEvent('已补充实际实施时间', `实际发生：${occurredAt}；原登记时间与修改内容保留。`));
          });
        } catch (error) { throw new GeoError(error instanceof Error ? error.message : '实际时间无效。'); }
        refreshTaskOutcome(id);
        break;
      }
      if (body.kind !== 'rehearsal' && body.kind !== 'user_confirmed') throw new GeoError('请选择演练或确认已经实际实施。');
      const kind = body.kind;
      const note = body.note === undefined ? '' : textInput(body.note, 3000, '实施说明', false);
      const url = body.url === undefined ? task.proposal.targetUrl : textInput(body.url, 2000, '实施链接', false);
      if (url) { try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); } catch { throw new GeoError('请填写有效的 http 或 https 页面链接。'); } }
      if (kind === 'user_confirmed' && (!note || !url)) throw new GeoError('实际实施需要填写改了什么，以及已经修改的页面链接。');
      if (kind === 'user_confirmed' && task.workflow) {
        const submitted = new URL(url);
        const proposed = new URL(task.proposal.targetUrl);
        if (submitted.origin !== proposed.origin || submitted.pathname.replace(/\/+$/, '') !== proposed.pathname.replace(/\/+$/, '')) throw new GeoError('实施链接须对应通过审核的目标页面；更换目标请重新生成并审核方案。');
      }
      const recordedAt = nowISO();
      let occurredAt: string | undefined;
      if (kind === 'user_confirmed') {
        const approvedAt = task.workflow?.quality?.rounds.find(round => round.review.passed && round.review.proposalDigest === proposalDigest(task.proposal!))?.review.reviewedAt;
        try { occurredAt = validateImplementationDate(body.occurredAt, recordedAt, approvedAt); }
        catch (error) { throw new GeoError(error instanceof Error ? error.message : '请填写实际实施时间。'); }
      }
      updateTask(id, t => {
        t.implementation = { kind, note, url, at: recordedAt, ...(occurredAt ? { occurredAt } : {}), ...(t.workflow ? { proposalRevision: t.workflow.proposalRevision, proposalDigest: proposalDigest(t.proposal!) } : {}) }; t.status = 'monitoring'; delete t.error;
        if (t.workflow) { t.workflow.stage = 'monitoring'; delete t.workflow.outcome; }
        // Confirming implementation never silently switches on paid collection.
        t.monitor.mode = 'replay'; t.monitor.enabled = !t.workflow; t.monitor.nextRunAt = t.workflow ? null : nextDailyRun(t.monitor.timeOfDay);
        t.events.push(newEvent(kind === 'rehearsal' ? '已记录演练实施' : '已记录用户确认的实施', kind === 'rehearsal' ? '这只是本地流程演练，没有修改线上内容。后续回放仍使用原始测量日期，不能据此判断效果。' : `用户确认：${note}。实施链接已保存，尚未独立核验。${t.workflow ? '请设置同题跟测计划并确认搜索预算。' : '监控先使用历史回放，真实采集需单独启用。'}`, 'success'));
      });
      break;
    }
    case 'reflect': {
      if (!task.workflow || !task.implementation) throw new GeoError('请先记录实际实施与后续观察，再评价结果。');
      refreshTaskOutcome(id);
      break;
    }
    case 'run_monitor': {
      if (body.mode !== 'live' && body.mode !== 'replay') throw new GeoError('请选择历史回放或真实观察。');
      const { startMonitor } = await import('./monitor');
      startMonitor(id, body.mode, false);
      break;
    }
    case 'update_monitor': {
      if (!body.monitor || typeof body.monitor !== 'object' || Array.isArray(body.monitor)) throw new GeoError('监控设置格式无效。');
      const input = body.monitor as Record<string, unknown>;
      const next: GeoMonitor = { ...task.monitor };
      const provider = task.workflow?.collection?.provider || task.collectionProvider || 'deepseek';
      if (input.mode !== undefined) { if (!['live', 'replay'].includes(String(input.mode))) throw new GeoError('无效的观察模式。'); next.mode = input.mode as GeoMonitor['mode']; }
      if (input.timeOfDay !== undefined) { if (typeof input.timeOfDay !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay)) throw new GeoError('时间请使用 HH:MM 格式。'); next.timeOfDay = input.timeOfDay; }
      if (input.days !== undefined) { if (!Number.isInteger(input.days) || Number(input.days) < 1 || Number(input.days) > 90) throw new GeoError('观察天数应为 1 到 90 天。'); next.days = Number(input.days); next.remaining = Math.max(0, next.days - (task.monitor.days - task.monitor.remaining)); }
      if (input.budgetLimit !== undefined) { if (typeof input.budgetLimit !== 'number' || !Number.isFinite(input.budgetLimit) || input.budgetLimit < task.monitor.spent || input.budgetLimit > 100) throw new GeoError('预算必须不少于已用金额，且不超过 100 元。'); next.budgetLimit = roundCost(input.budgetLimit); }
      if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') throw new GeoError('监控开关格式无效。'); next.enabled = input.enabled; }
      if (next.mode === 'live') {
        if (task.monitor.mode !== 'live' && input.budgetLimit === undefined) throw new GeoError('启用真实观察时需要明确填写预算。联网回答采用费用预留，实际费用以供应商账单为准。');
        requireCollectionKey(provider);
        if (task.implementation?.kind !== 'user_confirmed') throw new GeoError('请先确认已经实际实施；演练任务不能启用付费真实观察。');
        if (next.budgetLimit - next.spent + 1e-9 < next.queryIds.length * collectionReservation(provider)) throw new GeoError('剩余预算不足以完成一轮固定题观察。');
      }
      if (next.mode === 'replay' && provider !== 'deepseek') throw new GeoError('该入口没有可匹配的历史回放，请使用真实观察。');
      if (next.enabled && !task.implementation) throw new GeoError('请先确认实施，再启用每日观察。');
      if (next.enabled && next.remaining <= 0) throw new GeoError('观察计划已经结束，请增加观察天数后再启用。');
      next.nextRunAt = next.enabled ? nextDailyRun(next.timeOfDay) : null;
      // Daily scheduling is independent of a user's explicit one-off recheck.
      updateTask(id, t => { t.monitor = next; if (t.implementation) t.status = 'monitoring'; t.events.push(newEvent('每日观察设置已更新', `北京时间 ${next.timeOfDay}，${next.days} 天；${next.mode === 'live' ? `真实采集，预算 ¥${next.budgetLimit.toFixed(3)}` : '历史回放，不会产生新的实测数据'}；${next.enabled ? '已启用' : '未启用'}。`)); });
      break;
    }
    case 'pause': {
      requireStatus(task, ['monitoring', 'failed']);
      updateTask(id, t => { t.status = 'paused'; t.monitor.enabled = false; t.monitor.nextRunAt = null; t.events.push(newEvent('观察已暂停', '不会再发起每日观察；已发出的单次请求仍会保存结果。')); });
      break;
    }
    case 'resume': {
      requireStatus(task, ['paused', 'failed']);
      if (!task.implementation) throw new GeoError('请先完成调查、确认方案和实施。');
      if (task.monitor.remaining <= 0) throw new GeoError('观察计划已经结束，请先增加观察天数。');
      if (task.monitor.mode === 'live' && (!collectionKey(task.workflow?.collection?.provider || 'deepseek') || task.implementation.kind !== 'user_confirmed' || task.monitor.budgetLimit - task.monitor.spent + 1e-9 < task.monitor.queryIds.length * collectionReservation(task.workflow?.collection?.provider || 'deepseek'))) throw new GeoError('真实观察需要有效配置、实际实施确认和充足的剩余预算。');
      updateTask(id, t => { t.status = 'monitoring'; t.monitor.enabled = true; t.monitor.nextRunAt = nextDailyRun(t.monitor.timeOfDay); delete t.error; t.events.push(newEvent('每日观察已恢复', '从下一个北京时间计划时点继续，不补造离线期间的数据。', 'success')); });
      break;
    }
    default: throw new GeoError('不支持的任务操作。');
  }
  return getGeoState();
}

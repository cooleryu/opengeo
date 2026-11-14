import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { QuestionGenerationJobs, type QuestionGenerationDependencies } from './question-generation-job';
import type { GeoQuestionPlan, QuestionGenerationCheckpoint } from './question-types';

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function harness(generate?: QuestionGenerationDependencies['generate'], db?: Database.Database, projectId = 'synthetic') {
  if (!db) { db = new Database(':memory:'); databases.push(db); }
  let fingerprint = 'original';
  let plan: GeoQuestionPlan = { id: `${projectId}-plan`, projectId, revision: 1,
    createdAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z',
    source: 'model', status: 'draft', positioning: 'Synthetic purpose', candidates: [], notes: [] };
  let calls = 0;
  let saves = 0;
  const dependencies: QuestionGenerationDependencies = { db, projectId, fingerprint: () => fingerprint,
    currentPlan: () => plan, assertReady: () => {},
    generate: async (positioning, progress, resume) => { calls++; return generate ? generate(positioning, progress, resume) : plan; },
    save: (generated, expected) => { assert.equal(plan.revision, expected.revision); saves++;
      plan = { ...generated, id: plan.id, revision: plan.revision + 1 }; return plan.revision; } };
  return { jobs: new QuestionGenerationJobs(dependencies), dependencies, db,
    input: (requestId = 'request-1') => ({ planId: plan.id, revision: plan.revision, positioning: 'Synthetic purpose', requestId }),
    changeInput: () => { fingerprint += '-changed'; }, changePlan: () => { plan = { ...plan, revision: plan.revision + 1 }; },
    changePlanId: () => { plan = { ...plan, id: `${plan.id}-changed` }; },
    calls: () => calls, saves: () => saves };
}

const directionCheckpoint = { key: 'directions', title: 'Needs', items: ['Find a document tool'],
  payload: { directions: [{ title: 'Find a document tool', audience: 'New users', trigger: 'Choosing a document tool', assetIds: [] }], executionVersion: 2 },
};
function savedJob(db: Database.Database, id: string) {
  const row = db.prepare('SELECT payload FROM geo_question_generation_jobs WHERE id = ?').get(id) as { payload: string };
  return JSON.parse(row.payload);
}

test('queues before calls, persists progress, and deduplicates concurrent and completed request replays', async () => {
  const held = deferred();
  const h = harness(async (_positioning, progress) => { progress({ stage: 'reviewing', message: 'Independent review' });
    await held.promise; return h.dependencies.currentPlan(); });
  const input = h.input();
  const first = h.jobs.start(input);
  assert.equal(first.job.status, 'queued');
  assert.equal(h.calls(), 0);
  assert.equal(h.jobs.start(h.input('another-window')).job.id, first.job.id);
  assert.equal(h.jobs.start(input).completion, first.completion);
  await Promise.resolve();
  const reopened = new QuestionGenerationJobs(h.dependencies);
  assert.equal(reopened.get()?.stage, 'reviewing');
  assert.equal(reopened.get()?.status, 'running');
  held.resolve();
  await first.completion;
  assert.equal(reopened.get()?.status, 'completed');
  assert.equal(reopened.get()?.planRevision, 2);
  assert.equal(h.jobs.start(input).job.id, first.job.id);
  assert.equal(h.jobs.start({ ...input, requestId: undefined }).job.id, first.job.id);
  assert.equal(h.calls(), 1);
  assert.equal(h.saves(), 1);
  assert.equal('fingerprint' in reopened.get()!, false);
  assert.equal('owner' in reopened.get()!, false);
});

test('failure never restarts from reads or the same request; explicit retry uses a new request', async () => {
  const h = harness(async () => { throw new Error('Synthetic failure'); });
  const input = h.input();
  const run = h.jobs.start(input);
  const otherPage = h.input('other-page');
  assert.equal(h.jobs.start(otherPage).job.id, run.job.id);
  await run.completion;
  for (let i = 0; i < 3; i++) assert.equal(h.jobs.get()?.status, 'failed');
  assert.equal(h.jobs.start(input).started, false);
  assert.equal(h.jobs.start(otherPage).started, false, 'a deduplicated request also remains idempotent after failure');
  assert.equal(h.calls(), 1);
  await h.jobs.start(h.input('retry')).completion;
  assert.equal(h.calls(), 2);
  assert.equal(h.saves(), 0);
});

test('an incomplete coverage review saves the draft without reporting successful completion', async () => {
  const h = harness(async () => ({ ...h.dependencies.currentPlan(), coverageReview: {
    needs: [{ id: 'discovery', title: 'Find a suitable tool', audience: 'New users', trigger: 'Choosing a tool', importance: 'high', assetIds: [] }],
    selectionAdvantages: [], selectedIds: [],
    coverage: [{ needId: 'discovery', candidateIds: [], status: 'missing', reason: 'No suitable reviewed question yet.' }],
    duplicates: [], reason: 'Discovery remains uncovered.', status: 'incomplete', refinementRounds: 1,
  } }));
  await h.jobs.start(h.input()).completion;
  assert.equal(h.saves(), 1);
  assert.equal(h.jobs.get()?.status, 'failed');
  assert.equal(h.jobs.get()?.planRevision, 2);
  assert.match(h.jobs.get()?.message ?? '', /未通过整组审核/);
  assert.equal(h.dependencies.currentPlan().coverageReview?.status, 'incomplete');
});

test('completed stages survive later failure and page responses omit full local stage data', async () => {
  const observed: unknown[] = [];
  const h = harness(async (_positioning, progress) => {
    progress({ stage: 'planning', message: 'Direction ready', checkpoint: {
      key: 'directions', title: 'Needs', items: ['Find a document tool'], payload: { privateStage: 'full-local-evidence' },
    } });
    progress({ stage: 'generating', message: 'Writing questions', request: {
      phase: 'receiving', elapsedMs: 22, eventCount: 1, outputCharacters: 3,
    } });
    throw new Error('Synthetic later failure');
  });
  await h.jobs.start(h.input(), value => observed.push(value)).completion;
  const reopened = new QuestionGenerationJobs(h.dependencies).get()!;
  assert.equal(reopened.status, 'failed');
  assert.equal(reopened.checkpoints?.length, 1);
  assert.deepEqual(reopened.checkpoints?.[0].items, ['Find a document tool']);
  assert.equal(reopened.request?.eventCount, 1);
  assert.ok(reopened.checkpoints?.[0].completedAt);
  assert.ok(!JSON.stringify(reopened).includes('full-local-evidence'));
  assert.ok(!JSON.stringify(observed).includes('full-local-evidence'));
  const saved = h.db.prepare('SELECT payload FROM geo_question_generation_jobs').get() as { payload: string };
  assert.equal(JSON.parse(saved.payload).checkpoints[0].payload.privateStage, 'full-local-evidence');
  assert.equal(h.saves(), 0, 'incomplete final questions never replace the plan');
});

test('explicit retries retain checkpoints across a second interruption and leave prior jobs unchanged', async () => {
  const resumes: Array<readonly QuestionGenerationCheckpoint[] | undefined> = [];
  const h = harness(async (_positioning, progress, resume) => {
    resumes.push(resume);
    if (resumes.length === 1) {
      progress({ stage: 'planning', message: 'Directions ready', checkpoint: directionCheckpoint });
      throw new Error('First interruption');
    }
    if (resumes.length === 2) {
      // A resumed planner need not re-emit earlier checkpoints before stopping.
      progress({ stage: 'generating', message: 'One batch ready', checkpoint: {
        key: 'draft-1', title: 'Drafts', items: ['Synthetic question'], payload: { candidates: [] },
      } });
      throw new Error('Second interruption');
    }
    return h.dependencies.currentPlan();
  });
  const firstInput = h.input();
  const first = h.jobs.start(firstInput);
  const otherPageInput = h.input('other-page');
  assert.equal(h.jobs.start(otherPageInput).job.id, first.job.id);
  await first.completion;
  const original = savedJob(h.db, first.job.id);
  const second = h.jobs.start(h.input('retry-1'));
  assert.equal(second.started, true);
  assert.deepEqual(savedJob(h.db, second.job.id).checkpoints, original.checkpoints,
    'checkpoint payloads are committed before the retry can run');
  assert.ok(!JSON.stringify(second.job).includes('executionVersion'), 'page response omits saved payloads');
  assert.equal(h.jobs.start(h.input('duplicate-retry')).job.id, second.job.id);
  await second.completion;
  assert.equal(h.jobs.start(firstInput).started, false);
  assert.equal(h.jobs.start(otherPageInput).started, false);
  assert.equal(h.jobs.start(h.input('duplicate-retry')).started, false);
  assert.equal(h.calls(), 2);
  const third = h.jobs.start(h.input('retry-2'));
  await third.completion;
  assert.equal(resumes[0], undefined);
  assert.deepEqual(resumes[1], original.checkpoints);
  assert.deepEqual(resumes[2]?.map(checkpoint => checkpoint.key), ['directions', 'draft-1']);
  assert.deepEqual(savedJob(h.db, first.job.id), original, 'a retry does not rewrite the failed job');
  assert.equal(savedJob(h.db, second.job.id).status, 'failed');
  assert.equal(h.jobs.get()?.status, 'completed');
  assert.equal(h.calls(), 3);
  assert.equal(h.saves(), 1);
});

test('persisted checkpoints resume after reopening a database without calls on reads or request replays', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opengeo-question-resume-'));
  directories.push(directory);
  const path = join(directory, 'jobs.sqlite');
  const db = new Database(path);
  databases.push(db);
  let resumed: readonly QuestionGenerationCheckpoint[] | undefined;
  const h = harness(async (_positioning, progress, resume) => {
    if (!resume) {
      progress({ stage: 'planning', message: 'Directions ready', checkpoint: directionCheckpoint });
      throw new Error('Simulated interrupted process');
    }
    resumed = resume;
    return h.dependencies.currentPlan();
  }, db);
  const input = h.input();
  const first = h.jobs.start(input);
  await first.completion;
  const persisted = savedJob(db, first.job.id);
  persisted.status = 'running';
  persisted.owner.token = 'previous-process-token';
  delete persisted.completedAt;
  delete persisted.error;
  db.prepare('UPDATE geo_question_generation_jobs SET payload = ? WHERE id = ?').run(JSON.stringify(persisted), first.job.id);
  db.close();
  const reopenedDb = new Database(path);
  databases.push(reopenedDb);
  const reopened = new QuestionGenerationJobs({ ...h.dependencies, db: reopenedDb });
  assert.equal(reopened.get()?.status, 'interrupted');
  assert.equal(reopened.get()?.checkpoints?.length, 1);
  assert.equal(reopened.start(input).started, false);
  assert.equal(h.calls(), 1);
  await reopened.start(h.input('restart-retry')).completion;
  assert.deepEqual(resumed, persisted.checkpoints);
  assert.equal(reopened.get()?.status, 'completed');
  assert.equal(savedJob(reopenedDb, first.job.id).status, 'interrupted');
  assert.equal(h.calls(), 2);
});

test('input, positioning, and plan changes each prevent reuse of old checkpoints', async () => {
  for (const changed of ['input', 'positioning', 'revision', 'plan-id'] as const) {
    const resumes: Array<readonly QuestionGenerationCheckpoint[] | undefined> = [];
    const h = harness(async (_positioning, progress, resume) => {
      resumes.push(resume);
      progress({ stage: 'planning', message: 'Directions ready', checkpoint: directionCheckpoint });
      throw new Error('Synthetic failure');
    });
    await h.jobs.start(h.input()).completion;
    if (changed === 'input') h.changeInput();
    if (changed === 'revision') h.changePlan();
    if (changed === 'plan-id') h.changePlanId();
    const retry = h.input('changed-retry');
    if (changed === 'positioning') retry.positioning = 'Changed product positioning';
    await h.jobs.start(retry).completion;
    assert.deepEqual(resumes, [undefined, undefined], changed);
    assert.equal(h.saves(), 0);
  }
});

test('a failed coverage review may resume its own saved revision, but never a later edit', async () => {
  const resumes: Array<readonly QuestionGenerationCheckpoint[] | undefined> = [];
  const h = harness(async (_positioning, progress, resume) => {
    resumes.push(resume);
    progress({ stage: 'planning', message: 'Directions ready', checkpoint: directionCheckpoint });
    return { ...h.dependencies.currentPlan(), coverageReview: { needs: [], selectionAdvantages: [], selectedIds: [],
      coverage: [], duplicates: [], reason: 'Important needs remain uncovered.', status: 'incomplete', refinementRounds: 1 } };
  });
  const firstInput = h.input();
  const first = h.jobs.start(firstInput);
  await first.completion;
  assert.equal(h.jobs.get()?.planRevision, 2);
  assert.equal(h.jobs.start(firstInput).started, false);
  await h.jobs.start(h.input('coverage-retry')).completion;
  assert.deepEqual(resumes[1], savedJob(h.db, first.job.id).checkpoints);
  assert.equal(h.jobs.get()?.planRevision, 3);
  h.changePlan();
  await h.jobs.start(h.input('edited-retry')).completion;
  assert.equal(resumes[2], undefined);
  assert.equal(h.jobs.get()?.status, 'failed');
});

test('a new run after completion does not reuse completed checkpoints', async () => {
  const resumes: Array<readonly QuestionGenerationCheckpoint[] | undefined> = [];
  const h = harness(async (_positioning, progress, resume) => {
    resumes.push(resume);
    progress({ stage: 'planning', message: 'Directions ready', checkpoint: directionCheckpoint });
    return h.dependencies.currentPlan();
  });
  const input = h.input();
  await h.jobs.start(input).completion;
  assert.equal(h.jobs.start(input).started, false);
  await h.jobs.start(h.input('new-run')).completion;
  assert.deepEqual(resumes, [undefined, undefined]);
  assert.equal(h.saves(), 2);
});

test('a server restart becomes interrupted without a model call and permits explicit retry', async () => {
  const h = harness();
  const initial = h.jobs.start(h.input());
  await initial.completion;
  const row = h.db.prepare('SELECT payload FROM geo_question_generation_jobs WHERE id = ?').get(initial.job.id) as { payload: string };
  const saved = JSON.parse(row.payload);
  saved.status = 'running';
  saved.baseRevision = h.dependencies.currentPlan().revision;
  saved.owner.token = 'previous-process-token';
  h.db.prepare('UPDATE geo_question_generation_jobs SET payload = ? WHERE id = ?').run(JSON.stringify(saved), initial.job.id);
  assert.equal(new QuestionGenerationJobs(h.dependencies).get()?.status, 'interrupted');
  assert.equal(h.calls(), 1);
  await h.jobs.start(h.input('retry')).completion;
  assert.equal(h.calls(), 2);
  assert.equal(h.jobs.get()?.status, 'completed');
});

test('new understanding supersedes the old run and starts latest work while old output cannot save', async () => {
  const held = deferred();
  let executions = 0;
  const h = harness(async (_positioning, progress) => {
    if (++executions === 1) { await held.promise; progress({ stage: 'reviewing', message: 'Old review must stop' }); }
    return h.dependencies.currentPlan();
  });
  const old = h.jobs.start(h.input());
  await Promise.resolve();
  h.changeInput();
  assert.equal(h.jobs.get()?.status, 'superseded');
  const latest = h.jobs.start(h.input('latest-understanding'));
  assert.notEqual(latest.job.id, old.job.id);
  await latest.completion;
  held.resolve();
  await old.completion;
  assert.equal(h.saves(), 1);
  assert.equal(h.calls(), 2);
  assert.equal(h.jobs.get()?.id, latest.job.id);
  assert.equal(h.jobs.get()?.status, 'completed');
});

test('editing the plan during generation preserves the edit and discards the late model result', async () => {
  const held = deferred();
  const h = harness(async () => { await held.promise; return h.dependencies.currentPlan(); });
  const run = h.jobs.start(h.input());
  await Promise.resolve();
  h.changePlan();
  held.resolve();
  await run.completion;
  assert.equal(h.jobs.get()?.status, 'superseded');
  assert.equal(h.saves(), 0);
});

test('projects have separate jobs and leaving a streaming page does not stop persisted work', async () => {
  const a = harness();
  const b = harness(undefined, a.db, 'synthetic-two');
  await Promise.all([a.jobs.start(a.input(), () => { throw new Error('Disconnected client'); }).completion,
    b.jobs.start(b.input()).completion]);
  assert.equal(a.jobs.get()?.status, 'completed');
  assert.equal(b.jobs.get()?.status, 'completed');
  assert.notEqual(a.jobs.get()?.id, b.jobs.get()?.id);
  assert.equal(a.saves(), 1);
  assert.equal(b.saves(), 1);
});

test('request IDs cannot silently change their input', async () => {
  const h = harness();
  const input = h.input();
  await h.jobs.start(input).completion;
  assert.throws(() => h.jobs.start({ ...input, positioning: 'Different input' }), /请求标识/);
  assert.throws(() => h.jobs.start({ ...input, requestId: '../unsafe' }), /请求标识/);
  assert.equal(h.calls(), 1);
});

test('failed work preserves strict rejection while persisted errors omit raw excerpts and schema dumps', async () => {
  const excerpt = harness(async () => { throw new Error('摘录必须来自原文（问题 model-1，摘录：synthetic-private-source-text）'); });
  await excerpt.jobs.start(excerpt.input()).completion;
  assert.equal(excerpt.jobs.get()?.status, 'failed');
  assert.match(excerpt.jobs.get()?.error ?? '', /未通过原文依据检查/);
  assert.equal(JSON.stringify(excerpt.jobs.get()).includes('synthetic-private-source-text'), false);
  assert.equal(excerpt.saves(), 0);
  const malformed = harness(async () => { const error = new Error('Synthetic structured field dump'); error.name = 'ZodError'; throw error; });
  await malformed.jobs.start(malformed.input()).completion;
  assert.match(malformed.jobs.get()?.error ?? '', /内容不完整/);
  assert.equal(JSON.stringify(malformed.jobs.get()).includes('structured field dump'), false);
  assert.equal(malformed.saves(), 0);
});

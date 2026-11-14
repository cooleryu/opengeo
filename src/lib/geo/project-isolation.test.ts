import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET as readEvidence } from '@/app/api/geo/evidence/route';
import { currentGeoProject, evidenceLocation, withGeoProject } from './projects';
import { claimTask, dataDirectory, getGeoState, getTask, handleGeoAction, releaseTask, saveTask, taskIsBusy, updateTask } from './store';
import { tickGeoScheduler } from './scheduler';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-project-isolation-'));
const previousDataDirectory = process.env.DATA_DIR;
process.env.DATA_DIR = temporary;
// The test never invokes any provider, even if the host has keys configured.
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Unexpected network request in project isolation test'); };
after(() => {
  globalThis.fetch = previousFetch;
  if (previousDataDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('project seeds, question plans and task storage stay separate', async () => {
  const sampleProject = getGeoState();
  assert.equal(sampleProject.project.id, 'sample-project');
  assert.equal(sampleProject.projects.length, 2);
  assert.equal(dataDirectory(), path.join(temporary, 'data'));
  assert.deepEqual(sampleProject.tasks, []);
  const created = await handleGeoAction({ action: 'create_task', legacyQuestionPlan: true, goal: 'Synthetic project isolation task' });
  const primaryTask = created.tasks.find(task => task.goal === 'Synthetic project isolation task')!;
  withGeoProject('sample-project-two', () => {
    const replays = getGeoState();
    assert.equal(dataDirectory(), path.join(temporary, 'data/projects/sample-project-two'));
    assert.equal(replays.project.id, 'sample-project-two');
    assert.equal(replays.assets.length, 2);
    assert.equal(replays.questionPlan.projectId, 'sample-project-two');
    assert.deepEqual(replays.questionPlan.candidates, []);
    for (const records of [replays.tasks, replays.questions, replays.observations, replays.strategies, replays.visibility.questions]) assert.deepEqual(records, []);
    assert.throws(() => getTask(primaryTask.id), /没有找到/);
    assert.throws(() => saveTask(primaryTask), /不匹配/);
    assert.throws(() => claimTask(primaryTask.id, 'investigate'), /没有找到/);
  });
  assert.throws(() => withGeoProject('../sample-project', getGeoState), /没有找到这个项目/);
});

test('concurrent async operations and locks retain their own project', async () => {
  const create = (projectId: string) => withGeoProject(projectId, async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(currentGeoProject(), projectId);
    const state = await handleGeoAction({ action: 'create_task', legacyQuestionPlan: true, goal: `${projectId} isolation check` });
    const task = state.tasks.find(item => item.goal === `${projectId} isolation check`)!;
    claimTask(task.id, 'investigate', undefined, 'live');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(taskIsBusy(task.id), true);
    releaseTask(task.id);
    return task;
  });
  const [sampleProject, replays] = await Promise.all([create('sample-project'), create('sample-project-two')]);
  assert.throws(() => getTask(replays.id), /没有找到/);
  await withGeoProject('sample-project-two', async () => {
    await assert.rejects(handleGeoAction({ action: 'pause', taskId: sampleProject.id }), /没有找到/);
    assert.equal(getTask(replays.id).goal, replays.goal);
  });
});

test('scheduler visits both projects and evidence reads use the selected project root', async () => {
  for (const projectId of ['sample-project', 'sample-project-two']) withGeoProject(projectId, () => {
    const task = getGeoState().tasks.find(item => item.goal === `${projectId} isolation check`)!;
    updateTask(task.id, current => {
      current.status = 'monitoring';
      current.implementation = { kind: 'rehearsal', note: 'test only', url: '', at: new Date().toISOString() };
      current.monitor.enabled = true;
      current.monitor.nextRunAt = '2000-01-01T00:00:00.000Z';
      current.monitor.queryIds = []; // Fails before any collection can start.
      current.runs.push({ id: 'same-run-id', at: '', measurementAt: '', mode: 'replay', status: 'failed', queryCount: 0, completedCount: 0, hitCount: null, resultCount: 0, cost: 0, summary: 'test only', questions: [] });
    });
    const { target } = evidenceLocation('data/geo-evidence/same-run-id/run.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ projectId }));
  });
  await withGeoProject('sample-project-two', tickGeoScheduler);
  for (const projectId of ['sample-project', 'sample-project-two']) {
    withGeoProject(projectId, () => {
      const task = getGeoState().tasks.find(item => item.goal === `${projectId} isolation check`)!;
      assert.equal(task.status, 'failed');
      assert.equal(task.monitor.enabled, false);
    });
    const response = await readEvidence(new NextRequest(`http://localhost/api/geo/evidence?project=${projectId}&path=data/geo-evidence/same-run-id/run.json`));
    assert.equal(response.status, 200);
    assert.equal(JSON.parse((await response.json()).content).projectId, projectId);
  }
  const foreign = await readEvidence(new NextRequest('http://localhost/api/geo/evidence?project=sample-project-two&path=fixtures/another-project/not-registered.json'));
  assert.equal(foreign.status, 404);
});

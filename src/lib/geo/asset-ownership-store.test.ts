import { seedData } from './test-fixtures';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { geoRuntime, getTask, handleGeoAction, saveTask } from './store';
import type { GeoTask } from './types';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No network in ownership checks'); };
after(() => {
  globalThis.fetch = previousFetch;
  geoRuntime.db?.close(); delete geoRuntime.db;
});

function savedTask(id: string, external: boolean): GeoTask {
  const target = { ...seedData.assets[0], ...(external ? { id: 'external-reference', ownership: 'external' as const,
    publicUrl: 'https://third-party.example/tutorial' } : {}) };
  const at = new Date().toISOString();
  return {
    id, projectId: seedData.project.id, title: id, goal: id, status: 'awaiting_implementation', createdAt: at, updatedAt: at,
    blocks: [], events: [], runs: [], source: 'evidence', implementation: null,
    proposal: { ...seedData.proposal, status: 'accepted', targetAssetId: target.id, targetUrl: target.publicUrl! },
    researchContext: { snapshot: { targetAsset: target } } as GeoTask['researchContext'],
    monitor: { enabled: false, mode: 'replay', timeOfDay: '09:00', days: 1, remaining: 1,
      nextRunAt: null, budgetLimit: 0.1, spent: 0, lastRunAt: null, queryIds: [] },
  };
}

test('old proposals cannot bypass ownership at acceptance or first implementation', async () => {
  const task = savedTask('external-old-proposal', true);
  task.status = 'proposal_ready'; task.proposal!.status = 'reviewed'; saveTask(task);
  await assert.rejects(handleGeoAction({ action: 'accept_plan', taskId: task.id }), /外部参考/);
  task.status = 'awaiting_implementation'; task.proposal!.status = 'accepted'; saveTask(task);
  await assert.rejects(handleGeoAction({ action: 'confirm_implementation', taskId: task.id, kind: 'rehearsal' }), /外部参考/);
  assert.equal(getTask(task.id).implementation, null);
});

test('legacy own material remains usable without an ownership tag, and past implementation remains intact', async () => {
  const own = savedTask('legacy-own-proposal', false);
  saveTask(own);
  await handleGeoAction({ action: 'confirm_implementation', taskId: own.id, kind: 'rehearsal' });
  assert.equal(getTask(own.id).implementation?.kind, 'rehearsal');
  const historical = savedTask('historic-implementation', true);
  historical.status = 'completed';
  historical.implementation = { kind: 'user_confirmed', at: new Date().toISOString(), note: 'Past record', url: historical.proposal!.targetUrl };
  saveTask(historical);
  await handleGeoAction({ action: 'confirm_implementation', taskId: historical.id, kind: 'user_confirmed', occurredAt: '2026-10-24T01:00:00Z' });
  assert.equal(getTask(historical.id).implementation?.note, 'Past record');
  assert.equal(getTask(historical.id).implementation?.occurredAt, '2026-10-24T01:00:00.000Z');
});

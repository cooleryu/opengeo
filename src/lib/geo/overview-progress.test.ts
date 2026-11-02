import './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLatestResearch } from './research';
import { overviewProgress } from './overview-progress';
import type { GeoTask } from './types';

const batch = getLatestResearch('sample-project')!;
const task = (changes: Partial<GeoTask> = {}) => ({
  id: 'current', projectId: batch.projectId, status: 'queued', proposal: null,
  implementation: null, researchContext: { batchId: batch.id }, ...changes,
}) as GeoTask;

test('historical or other-project tasks cannot advance the current batch', () => {
  const progress = overviewProgress(batch, [
    task({ projectId: 'sample-project-two', proposal: {} as GeoTask['proposal'] }),
    task({ researchContext: undefined, implementation: { kind: 'user_confirmed' } as GeoTask['implementation'] }),
  ]);
  assert.equal(progress.taskId, undefined);
  assert.equal(progress.step, 3);
  assert.equal(progress.steps[3].status, '尚无方案');
  assert.equal(progress.steps[4].status, '尚未实施');
});

test('material investigation leads to its actual task, not a fabricated proposal', () => {
  const progress = overviewProgress(batch, [task({ researchGapReview: {} as GeoTask['researchGapReview'] })]);
  assert.equal(progress.taskId, 'current');
  assert.equal(progress.action, '继续核查');
  assert.match(progress.steps[2].status, /32 条观测/);
  assert.match(progress.steps[2].status, /1 项材料核查/);
  assert.doesNotMatch(progress.steps[2].status, /1 项诊断/);
});

test('a rehearsal does not advance implementation; a saved real implementation does', () => {
  const proposal = {} as NonNullable<GeoTask['proposal']>;
  const rehearsal = task({ proposal, implementation: { kind: 'rehearsal' } as GeoTask['implementation'] });
  assert.equal(overviewProgress(batch, [rehearsal]).step, 4);
  assert.equal(overviewProgress(batch, [rehearsal]).steps[4].status, '尚未实施');
  const real = task({ proposal, implementation: { kind: 'user_confirmed' } as GeoTask['implementation'] });
  assert.equal(overviewProgress(batch, [real]).step, 5);
  assert.match(overviewProgress(batch, [real]).steps[4].status, /真实实施/);
  assert.doesNotMatch(overviewProgress(batch, [real]).steps[4].status, /有效|已完成/);
});

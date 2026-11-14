import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProjectOptimization } from '@/lib/geo/project-optimization-types';
import type { GeoTask } from '@/lib/geo/types';
import {
  getProjectOptimizationProgress,
  getProjectTaskProgress,
  isOpenProjectOptimizationTask,
} from './project-optimization-progress';

const review = (passed: boolean) => ({
  passed,
  reviewedAt: '2026-11-02T00:00:00Z',
  issues: [],
  actions: [],
});

test('overview exposes saved drafts without claiming implementation or reusing an old review', () => {
  const assessment = review(true);
  const task = {
    status: 'proposal_ready',
    projectOptimization: {
      phase: 'awaiting_review', review: assessment, actions: [{}, {}, {}],
      draftsReviewedAt: assessment.reviewedAt,
    },
  } as unknown as GeoTask;
  const ready = getProjectTaskProgress(task);
  assert.equal(ready.ready, true);
  assert.equal(ready.actionLabel, '查看稿件');
  assert.match(ready.message, /3 项.*确认后/);
  task.projectOptimization!.draftsReviewedAt = 'older';
  assert.equal(getProjectTaskProgress(task).ready, false);
  assert.equal(getProjectTaskProgress(task).actionLabel, '查看优先改动');
  task.projectOptimization!.draftsReviewedAt = assessment.reviewedAt;
  task.projectOptimization!.review!.passed = false;
  assert.equal(getProjectTaskProgress(task).ready, false);
});

test('unfinished review never becomes a ready proposal in the shared UI state', () => {
  for (const assessment of [null, review(false)]) {
    const state = getProjectOptimizationProgress({
      phase: 'awaiting_review',
      review: assessment,
    });
    assert.equal(state.ready, false);
    assert.equal(state.actionLabel, '查看原因');
    assert.notEqual(state.stage, 2);
  }
  assert.equal(
    getProjectOptimizationProgress({
      phase: 'awaiting_review',
      review: review(true),
    }).actionLabel,
    '审阅方案',
  );
});

test('saved revision progress is shown verbatim while old records have a fallback', () => {
  const saved = getProjectOptimizationProgress({
    phase: 'revising',
    review: review(false),
    progress: {
      message: '正在根据第 1 轮审核意见补齐引用。',
      round: 2,
      maxRounds: 2,
      updatedAt: '2026-11-02T00:01:00Z',
    },
  });
  assert.equal(saved.message, '正在根据第 1 轮审核意见补齐引用。');
  assert.equal(saved.roundLabel, '第 2 / 2 轮');
  assert.equal(saved.running, true);
  assert.equal(saved.ready, false);
  const legacy = getProjectOptimizationProgress({
    phase: 'blocked',
    review: null,
  });
  assert.ok(legacy.message);
  assert.equal(legacy.roundLabel, '');
  assert.equal(legacy.running, false);
});

test('only a closed project optimization releases the overview entry', () => {
  for (const phase of [
    'failed',
    'blocked',
    'revising',
    'awaiting_review',
  ] as const) {
    assert.equal(
      isOpenProjectOptimizationTask({
        projectOptimization: { phase } as ProjectOptimization,
      }),
      true,
    );
  }
  assert.equal(
    isOpenProjectOptimizationTask({
      projectOptimization: { phase: 'closed' } as ProjectOptimization,
    }),
    false,
  );
  assert.equal(isOpenProjectOptimizationTask({}), false);
});

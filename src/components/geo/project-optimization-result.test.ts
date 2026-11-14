import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ProjectOptimization,
  ProjectOptimizationActionReview,
} from '@/lib/geo/project-optimization-types';
import {
  getActionReviewNeeds,
  getOptimizationResultCopy,
} from './project-optimization-result';

const actionReview = (
  overrides: Partial<ProjectOptimizationActionReview> = {},
): ProjectOptimizationActionReview => ({
  actionId: 'action',
  scores: { evidence: 70, relevance: 70, actionability: 70, verifiability: 70 },
  preservesGoal: 'pass',
  evidenceGrounded: 'pass',
  passed: false,
  issues: ['C01 observation: internal audit text'],
  ...overrides,
});

const optimization = (
  overrides: Partial<ProjectOptimization> = {},
): ProjectOptimization =>
  ({
    phase: 'blocked',
    summary: 'Internal C01 observation summary',
    review: null,
    history: [
      {
        review: {
          passed: false,
          actions: [actionReview({ evidenceGrounded: 'fail' })],
        },
      },
    ],
    ...overrides,
  }) as ProjectOptimization;

test('review needs use structured thresholds and gates without treating missing review as failure', () => {
  assert.deepEqual(getActionReviewNeeds(undefined), []);
  assert.deepEqual(getActionReviewNeeds(actionReview()), []);
  const weak = actionReview({
    scores: {
      evidence: 69,
      relevance: 69,
      actionability: 69,
      verifiability: 69,
    },
  });
  assert.deepEqual(getActionReviewNeeds(weak), [
    '依据还需核实',
    '改法还不够具体',
    '复测方法还需明确',
    '需要重新对齐原问题',
  ]);
  assert.deepEqual(getActionReviewNeeds({ ...weak, passed: true }), []);
  assert.deepEqual(
    getActionReviewNeeds(
      actionReview({ evidenceGrounded: 'unknown', preservesGoal: 'unknown' }),
    ),
    ['依据还需核实', '需要重新对齐原问题'],
  );
});

test('result issues only use current review and never surface internal prose', () => {
  const current = actionReview({ evidenceGrounded: 'fail' });
  const result = getOptimizationResultCopy(
    optimization({
      review: {
        passed: false,
        reviewedAt: '',
        issues: ['Private internal prose'],
        actions: [current, current],
      },
    }),
  );
  assert.deepEqual(result.issues, ['依据还需核实']);
  assert.doesNotMatch(JSON.stringify(result), /C01|observation|Private/);
  assert.deepEqual(getOptimizationResultCopy(optimization()).issues, []);
});

test('stopped results explain stopping and do not promise automatic evidence collection', () => {
  const limited = getOptimizationResultCopy(
    optimization({ stopReason: 'round_limit' }),
  );
  assert.match(limited.description, /已停止.*未通过/);
  assert.doesNotMatch(limited.description + limited.nextStep, /等待/);
  assert.match(limited.nextStep, /需要补齐/);
  const missing = getOptimizationResultCopy(
    optimization({ stopReason: 'no_evidence' }),
  );
  assert.match(missing.description, /现有材料/);
  assert.match(missing.nextStep, /补齐可用回答/);
  const unchanged = getOptimizationResultCopy(
    optimization({ stopReason: 'no_progress' }),
  );
  assert.match(unchanged.description, /未再次审核/);
  assert.deepEqual(unchanged.issues, []);
});

test('only reviewed awaiting-review results are ready and still disclose the execution boundary', () => {
  for (const review of [
    null,
    { passed: false, reviewedAt: '', issues: [], actions: [] },
  ]) {
    const result = getOptimizationResultCopy(
      optimization({ phase: 'awaiting_review', review }),
    );
    assert.notEqual(result.title, '方案已通过审核');
  }
  const passed = { passed: true, reviewedAt: '', issues: [], actions: [] };
  const ready = getOptimizationResultCopy(
    optimization({ phase: 'awaiting_review', review: passed }),
  );
  assert.equal(ready.title, '方案已通过审核');
  assert.match(ready.description, /尚未实施/);
  assert.match(ready.nextStep, /读取.*原文.*修改稿.*独立审核/);
  assert.notEqual(
    getOptimizationResultCopy(optimization({ review: passed })).title,
    ready.title,
  );
  assert.equal(
    getOptimizationResultCopy(optimization({ phase: 'closed', review: passed }))
      .title,
    '本轮已结束',
  );
  assert.equal(
    getOptimizationResultCopy(optimization({ phase: 'failed', review: passed }))
      .title,
    '本次任务中断',
  );
});

test('complete drafts are ready only when their marker matches the passed review', () => {
  const reviewedAt = '2026-11-11T09:00:00Z';
  const plan = optimization({
    phase: 'awaiting_review',
    draftsReviewedAt: reviewedAt,
    actions: [{}, {}, {}] as ProjectOptimization['actions'],
    review: { passed: true, reviewedAt, issues: [], actions: [] },
  });
  const ready = getOptimizationResultCopy(plan);
  assert.equal(ready.title, '3 项稿件已准备好');
  assert.match(ready.nextStep, /确认后.*修改原文件或发布/);
  assert.equal(getOptimizationResultCopy({ ...plan, draftsReviewedAt: 'older' }).title, '方案已通过审核');
  assert.notEqual(getOptimizationResultCopy({ ...plan, review: { ...plan.review!, passed: false } }).title, ready.title);
});

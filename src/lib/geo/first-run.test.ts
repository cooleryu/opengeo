import './test-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeFirstRunState } from './store';
import type { ResearchBatch } from './research-types';

function makeBatch(
  observations: Array<{ engine: 'chatgpt' | 'google'; entryType?: 'web_answer' | 'api_answer' | 'web_search' }> = [],
  questionCount = 1,
): ResearchBatch {
  return {
    id: 'batch-1',
    projectId: 'proj-1',
    date: '2026-11-19',
    reportPath: 'report.md',
    questions: Array.from({ length: questionCount }, (_, idx) => ({
      id: `q-${idx + 1}`,
      kind: 'discovery',
      category: 'general',
      zh: `问题 ${idx + 1}`,
      en: `Question ${idx + 1}`,
      observations:
        idx === 0
          ? observations.map((obs, oIdx) => ({
              engine: obs.engine,
              entryType: obs.entryType,
              language: 'en',
              query: 'Question 1',
              status: 'not_observed',
              recordedAt: '2026-11-19T00:00:00Z',
              conditions: '{}',
              summary: 'Observed',
              evidencePath: `obs-${oIdx}.md`,
              sources: [],
            }))
          : [],
    })),
    deferredQuestions: [],
  } as unknown as ResearchBatch;
}

function countDone(state: ReturnType<typeof computeFirstRunState>): number {
  return Object.values(state).filter(Boolean).length;
}

test('firstRun checklist: 0/5 when no key, no product, no questions, no answers, no plan', () => {
  const state = computeFirstRunState({
    modelConfigured: false,
    projectDescription: '',
    onboardingStatus: null,
    questionCount: 0,
    latestResearch: null,
    hasPageAudit: false,
    latestRunStatus: null,
  });
  assert.deepEqual(state, {
    modelReady: false,
    productReady: false,
    questionsReady: false,
    answersReady: false,
    actionPlanReady: false,
  });
  assert.equal(countDone(state), 0);
});

test('firstRun checklist: 1/5 no key with product ready; 2/5 key + product ready, no questions', () => {
  const noKey = computeFirstRunState({
    modelConfigured: false,
    projectDescription: 'Local-first GEO workbench',
    onboardingStatus: null,
    questionCount: 0,
    latestResearch: null,
    hasPageAudit: false,
    latestRunStatus: null,
  });
  assert.equal(noKey.modelReady, false);
  assert.equal(noKey.productReady, true);
  assert.equal(countDone(noKey), 1);

  const keyNoQuestions = computeFirstRunState({
    modelConfigured: true,
    projectDescription: '',
    onboardingStatus: 'ready',
    questionCount: 0,
    latestResearch: null,
    hasPageAudit: false,
    latestRunStatus: null,
  });
  assert.deepEqual(keyNoQuestions, {
    modelReady: true,
    productReady: true,
    questionsReady: false,
    answersReady: false,
    actionPlanReady: false,
  });
  assert.equal(countDone(keyNoQuestions), 2);
});

test('firstRun checklist: 3/5 questions confirmed but no AI answers (Google web_search does not count)', () => {
  const webSearchOnly = computeFirstRunState({
    modelConfigured: true,
    onboardingStatus: 'ready',
    questionCount: 0,
    latestResearch: makeBatch([{ engine: 'google', entryType: 'web_search' }], 4),
    hasPageAudit: false,
    latestRunStatus: null,
  });
  assert.equal(webSearchOnly.questionsReady, true);
  assert.equal(webSearchOnly.answersReady, false);
  assert.equal(countDone(webSearchOnly), 3);
});

test('firstRun checklist: 4/5 AI answers collected (web_answer, api_answer, or legacy chatgpt) but no plan (failed run does not count)', () => {
  for (const obs of [
    { engine: 'chatgpt' as const, entryType: 'web_answer' as const },
    { engine: 'google' as const, entryType: 'web_answer' as const },
    { engine: 'chatgpt' as const, entryType: 'api_answer' as const },
    { engine: 'chatgpt' as const },
  ]) {
    const state = computeFirstRunState({
      modelConfigured: true,
      onboardingStatus: 'ready',
      questionCount: 4,
      latestResearch: makeBatch([obs], 4),
      hasPageAudit: false,
      latestRunStatus: 'failed',
    });
    assert.equal(state.answersReady, true);
    assert.equal(state.actionPlanReady, false);
    assert.equal(countDone(state), 4);
  }
});

test('firstRun checklist: 5/5 (hidden) reached via Page Audit alone OR non-failed OptimizationRun', () => {
  const pageAuditOnly = computeFirstRunState({
    modelConfigured: true,
    onboardingStatus: 'ready',
    questionCount: 4,
    latestResearch: makeBatch([{ engine: 'chatgpt', entryType: 'web_answer' }], 4),
    hasPageAudit: true,
    latestRunStatus: null,
  });
  assert.equal(pageAuditOnly.actionPlanReady, true);
  assert.equal(countDone(pageAuditOnly), 5);

  const runOnly = computeFirstRunState({
    modelConfigured: true,
    onboardingStatus: 'ready',
    questionCount: 4,
    latestResearch: makeBatch([{ engine: 'chatgpt', entryType: 'web_answer' }], 4),
    hasPageAudit: false,
    latestRunStatus: 'awaiting_approval',
  });
  assert.equal(runOnly.actionPlanReady, true);
  assert.equal(countDone(runOnly), 5);
});

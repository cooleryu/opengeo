import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStrategyMemory, evaluateOutcome, selectStrategies } from './learning';
import { validateImplementationDate } from './implementation';
import { activateStrategyMemory, normalizeStrategyMemory, revertStrategyMemory, validateStrategyMemory } from './strategy-lifecycle';
import { buildSearchProtocolKey, frozenQuestion, matchHistoricalQuestions, matchesProjectURL, matchesQuestionTarget } from './search-protocol';
import type { GeoRun, GeoSeed, GeoTask } from './types';
import type { WorkflowQuestion } from './workflow-types';

const questions: WorkflowQuestion[] = ['q1', 'q2'].map(id => ({ id, query: `How does ${id} work?`, language: 'en',
  category: 'content', target: 'article', assetIds: ['article'], exploratory: false,
  intent: 'Find the relevant explanation.', expectedResult: 'The corresponding public article.' }));
const protocolKey = buildSearchProtocolKey(questions);

function run(id: string, phase: 'baseline' | 'followup', day: string, hits: boolean[]): GeoRun {
  const at = `2026-10-${day}T01:00:00.000Z`;
  return { id, at, completedAt: `2026-10-${day}T01:02:00.000Z`, measurementAt: at,
    mode: 'live', status: 'completed', phase, protocolKey, implementationRevision: phase === 'baseline' ? 0 : 1,
    queryCount: questions.length, completedCount: questions.length, hitCount: hits.filter(Boolean).length,
    resultCount: questions.length * 2, cost: 0.01, summary: 'Synthetic test fixture.',
    questions: questions.map((question, index) => ({ ...frozenQuestion(question), measurementAt: at,
      resultCount: 2, projectHit: hits[index], rank: hits[index] ? 1 : null,
      evidencePath: `data/geo-evidence/${id}/${question.id}.json` })) };
}

function task(): GeoTask {
  return { id: 'task-1', projectId: 'project', title: 'Test fixture', goal: 'Measure the actual implementation.', status: 'monitoring',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-04T02:00:00Z', blocks: [], events: [], source: 'evidence',
    proposal: { id: 'p1', title: 'Clarify the article', status: 'approved', rationale: 'An observed information gap.',
      targetAssetId: 'article', targetUrl: 'https://example.com/docs/article', before: 'Before.', after: 'After.',
      changes: ['Add the missing explanation'], evidencePaths: ['article.md'], successCriteria: ['Repeat frozen questions'], limitations: ['Observational only'] },
    implementation: { kind: 'user_confirmed', note: 'Applied the explanation to the public article.', url: 'https://example.com/docs/article',
      at: '2026-10-03T00:00:00Z', occurredAt: '2026-10-03T00:00:00Z', proposalRevision: 1, proposalDigest: 'fixture' },
    monitor: { enabled: true, mode: 'live', timeOfDay: '09:00', days: 7, remaining: 5,
      nextRunAt: null, budgetLimit: 1, spent: 0.02, queryIds: questions.map(question => question.id), lastRunAt: null },
    runs: [run('f1', 'followup', '04', [true, true])],
    workflow: { version: 1, questionPlanId: 'plan', questionPlanRevision: 1, frozenAt: '2026-10-01T00:00:00Z',
      questions: structuredClone(questions), protocolKey, stage: 'monitoring', proposalRevision: 1,
      appliedStrategyIds: [], baseline: run('b1', 'baseline', '02', [true, false]) } };
}

test('only comparable real measurements classify improvement, no change and decline', () => {
  for (const [hits, expected] of [[[true, true], 'improved'], [[true, false], 'unchanged'], [[false, false], 'worse']] as const) {
    const current = task(); current.runs = [run('f1', 'followup', '04', [...hits])];
    const outcome = evaluateOutcome(current);
    assert.equal(outcome.classification, expected);
    assert.equal(outcome.beforeRate, 0.5);
    assert.deepEqual(outcome.followupRunIds, ['f1']);
    assert.ok(outcome.limitations.some(text => text.includes('不能证明因果')));
  }
});

test('replay, partial, missing evidence, altered queries, provider, protocol and implementation versions are excluded', () => {
  const changes: Array<(run: GeoRun) => void> = [
    item => { item.mode = 'replay'; },
    item => { item.status = 'partial'; item.completedCount = 1; },
    item => { item.error = 'Unresolved collection error'; },
    item => { item.questions[0].evidencePath = ''; },
    item => { item.questions[0].query = 'A different question'; },
    item => { item.questions[0].provider = 'Gemini'; },
    item => { item.protocolKey = 'different-parameters'; },
    item => { item.implementationRevision = 2; },
  ];
  for (const change of changes) {
    const current = task(); change(current.runs[0]);
    assert.equal(evaluateOutcome(current).classification, 'inconclusive');
    assert.equal(buildStrategyMemory(current, 'project'), null);
  }
});

test('baseline must finish before actual implementation and followup must start afterwards', () => {
  const replay = task(); replay.workflow!.baseline!.mode = 'replay';
  assert.equal(evaluateOutcome(replay).classification, 'inconclusive');
  const late = task(); late.workflow!.baseline!.completedAt = '2026-10-03T00:01:00Z';
  assert.equal(evaluateOutcome(late).classification, 'inconclusive');
  const unfinished = task(); delete unfinished.workflow!.baseline!.completedAt;
  assert.equal(evaluateOutcome(unfinished).classification, 'inconclusive');
  const early = task(); early.runs = [run('early', 'followup', '02', [true, true])];
  assert.equal(evaluateOutcome(early).classification, 'inconclusive');
  const rehearsal = task(); rehearsal.implementation!.kind = 'rehearsal';
  assert.equal(evaluateOutcome(rehearsal).classification, 'inconclusive');
});

test('actual implementation date is required and registration does not change measurement ordering', () => {
  const legacy = task(); delete legacy.implementation!.occurredAt;
  assert.equal(evaluateOutcome(legacy).classification, 'inconclusive');
  assert.equal(buildStrategyMemory(legacy, 'project'), null);
  const registeredLater = task(); registeredLater.implementation!.at = '2026-10-05T00:00:00Z';
  assert.equal(evaluateOutcome(registeredLater).classification, 'improved');
  registeredLater.implementation!.occurredAt = '2026-10-01T00:00:00Z';
  assert.equal(evaluateOutcome(registeredLater).classification, 'inconclusive');
  const future = task(); future.implementation!.occurredAt = '2026-10-04T00:00:00Z';
  assert.equal(evaluateOutcome(future).classification, 'inconclusive');
});

test('implementation date validates calendar, timezone, review and registration bounds', () => {
  const registeredAt = '2026-10-04T00:00:00Z';
  const reviewedAt = '2026-10-02T02:00:00Z';
  assert.equal(validateImplementationDate('2026-10-03T08:00:00+08:00', registeredAt, reviewedAt), '2026-10-03T00:00:00.000Z');
  for (const value of [undefined, '', '2026-02-30T00:00:00Z', '2026-10-03T00:00:00', '2026-10-04T00:00:01Z', '2026-10-02T01:59:59Z']) {
    assert.throws(() => validateImplementationDate(value, registeredAt, reviewedAt));
  }
});

test('article matching requires the selected public page while project matching respects path boundaries', () => {
  const seed = { project: { siteUrl: 'https://example.com/docs', repositoryUrl: 'https://github.com/owner/project' },
    assets: [{ id: 'article', publicUrl: 'https://example.com/docs/article' }] } as unknown as GeoSeed;
  assert.equal(matchesQuestionTarget('https://example.com/docs/article/?utm_source=fixture#section', questions[0], seed), true);
  for (const url of ['https://example.com/docs', 'https://example.com/docs/other', 'https://example.com/docs/article/comments', 'https://example.com.evil.test/docs/article']) {
    assert.equal(matchesQuestionTarget(url, questions[0], seed), false);
  }
  assert.equal(matchesProjectURL('https://example.com/docs/other', seed), true);
  assert.equal(matchesProjectURL('https://example.com/docs2/other', seed), false);
  assert.equal(matchesProjectURL('https://github.com/owner/project/issues/1', seed), true);
  assert.equal(matchesProjectURL('https://github.com/owner/project-copy', seed), false);
});

test('historical replay never fills a new or rewritten question from a similar old question', () => {
  const historical = run('b', 'baseline', '02', [true, false]).questions;
  const requested = [frozenQuestion(questions[0]), { ...frozenQuestion(questions[1]), query: 'Rewritten question' },
    { ...frozenQuestion(questions[0]), id: 'new-id' }];
  const replayed = matchHistoricalQuestions(requested, historical);
  assert.deepEqual(replayed.map(item => item.id), ['q1']);
  assert.equal(replayed[0].measurementAt, historical[0].measurementAt);
  assert.equal(replayed[0].evidencePath, historical[0].evidencePath);
});

test('observations produce candidates and do not silently influence later proposals', () => {
  const current = task();
  const first = buildStrategyMemory(current, 'project', '2026-10-04T02:00:00Z')!;
  assert.equal(first.outcome, 'improved');
  assert.equal(first.status, 'candidate');
  current.runs.push(run('f2', 'followup', '05', [false, false]), run('f3', 'followup', '06', [false, false]));
  const latest = buildStrategyMemory(current, 'project', '2026-10-06T02:00:00Z')!;
  assert.equal(latest.outcome, 'worse');
  assert.notEqual(first.id, latest.id);
  assert.equal(latest.createdAt, '2026-10-06T02:00:00Z');
  assert.equal(buildStrategyMemory(current, 'project')!.id, latest.id);
  const next = task(); next.id = 'next-task';
  assert.deepEqual(selectStrategies(next, [first, latest]), []);
  assert.ok(latest.action.includes(current.implementation!.note));
  assert.deepEqual(selectStrategies(current, [first, latest]), []);
  const legacy = structuredClone(first); delete (legacy as Partial<typeof legacy>).status;
  const migrated = normalizeStrategyMemory(legacy, '2026-10-07T00:00:00Z');
  assert.equal(migrated.status, 'candidate');
  assert.equal(migrated.createdAt, '2026-10-07T00:00:00Z');
  assert.equal(migrated.originalCreatedAt, first.createdAt);
  assert.equal(validateStrategyMemory(migrated, current, '2026-10-07T01:00:00Z').validation!.passed, false);
  assert.deepEqual(selectStrategies(next, [legacy]), []);
  assert.throws(() => activateStrategyMemory(first));
});

test('only new improved real observations allow validation, manual activation and reversible selection', () => {
  const current = task();
  const candidate = buildStrategyMemory(current, 'project', '2026-10-04T02:00:00Z')!;
  const notNew = validateStrategyMemory(candidate, current, '2026-10-04T03:00:00Z');
  assert.equal(notNew.status, 'candidate');
  assert.equal(notNew.validation!.passed, false);
  current.runs.push(run('f2', 'followup', '05', [true, true]));
  const validated = validateStrategyMemory(notNew, current, '2026-10-05T02:00:00Z');
  assert.equal(validated.status, 'validated');
  assert.deepEqual(validated.validation!.runIds, ['f2']);
  const next = task(); next.id = 'next-task';
  assert.deepEqual(selectStrategies(next, [validated]), []);
  const active = activateStrategyMemory(validated, '2026-10-05T03:00:00Z');
  assert.equal(active.version, validated.version + 1);
  assert.deepEqual(selectStrategies(next, [active]).map(item => item.id), [active.id]);
  for (const changed of [
    { ...next, projectId: 'another-project' },
    { ...next, workflow: { ...next.workflow!, protocolKey: 'different' } },
    { ...next, proposal: { ...next.proposal!, targetAssetId: 'other' }, workflow: { ...next.workflow!, questions: questions.map(question => ({ ...question, assetIds: ['other'] })) } },
    { ...next, workflow: { ...next.workflow!, questions: questions.map(question => ({ ...question, category: 'brand' as const })) } },
  ]) assert.deepEqual(selectStrategies(changed, [active]), []);
  const reverted = revertStrategyMemory(active, '后续观察不足以支持继续采用。', '2026-10-05T04:00:00Z');
  assert.equal(reverted.status, 'reverted');
  assert.deepEqual(selectStrategies(next, [reverted]), []);
  assert.equal(reverted.history.at(-1)!.reason, '后续观察不足以支持继续采用。');
  assert.throws(() => activateStrategyMemory(reverted));
  assert.equal(validateStrategyMemory(reverted, current, '2026-10-05T05:00:00Z').status, 'reverted');
  assert.equal(candidate.status, 'candidate');
});

test('no improvement, replay, incomplete and reused evidence never upgrade a candidate', () => {
  for (const change of [
    (item: GeoRun) => { item.questions[1].projectHit = false; item.hitCount = 1; },
    (item: GeoRun) => { item.mode = 'replay'; },
    (item: GeoRun) => { item.status = 'partial'; item.completedCount = 1; },
    (item: GeoRun) => { item.questions[0].evidencePath = 'data/geo-evidence/f1/q1.json'; },
    (item: GeoRun) => { item.protocolKey = 'different'; },
  ]) {
    const current = task();
    const candidate = buildStrategyMemory(current, 'project', '2026-10-04T02:00:00Z')!;
    const fresh = run('f2', 'followup', '05', [true, true]); change(fresh); current.runs.push(fresh);
    const attempted = validateStrategyMemory(candidate, current, '2026-10-05T02:00:00Z');
    assert.equal(attempted.status, 'candidate');
    assert.equal(attempted.validation!.passed, false);
    assert.throws(() => activateStrategyMemory(attempted));
  }
  const current = task();
  const candidate = buildStrategyMemory(current, 'project', '2026-10-04T02:00:00Z')!;
  current.projectId = 'another-project';
  assert.throws(() => validateStrategyMemory(candidate, current));
});

test('protocol is stable under question order and changes when query or target changes', () => {
  assert.equal(buildSearchProtocolKey([...questions].reverse()), protocolKey);
  assert.notEqual(buildSearchProtocolKey(questions.map(question => ({ ...question, query: `${question.query} Updated` }))), protocolKey);
  assert.notEqual(buildSearchProtocolKey(questions.map(question => ({ ...question, target: 'project' }))), protocolKey);
});

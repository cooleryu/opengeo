import './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildClaimReview } from './claim-review';
import { getLatestResearch } from './research';

test('manual claim review binds saved answer text to its original project and observation', () => {
  const batch = getLatestResearch('sample-project')!;
  const input = { projectId: batch.projectId, batchId: batch.id, questionId: 'C01', observationIndex: 0,
    engine: 'chatgpt', language: 'zh', quote: 'SampleProject（example/SampleProject）是一个开源的 AI Agent 上下文管理与执行前校验项目。',
    fact: '项目的实际能力需以仓库文档为依据。', evidenceUrl: 'https://github.com/example/sample-project',
    conclusion: 'uncertain', scope: '人工登记，尚未逐项验证原句中的能力范围。' };
  const saved = buildClaimReview(input, batch, batch.projectId);
  assert.equal(saved.reviewer, 'user');
  assert.equal(saved.conclusion, 'uncertain');
  assert.equal(saved.quote, input.quote);
  assert.ok(Number.isFinite(Date.parse(saved.reviewedAt)));
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  for (const change of [
    { quote: 'SampleProject 已被证实能保证所有调用都安全。' },
    { quote: batch.questions[0].observations[0].summary },
    { projectId: 'sample-project-two' },
    { observationIndex: 1 },
    { observationIndex: 2, engine: 'google' },
    { evidenceUrl: 'https://account:password@example.com/' },
  ]) assert.throws(() => buildClaimReview({ ...input, ...change }, batch, batch.projectId));
  assert.throws(() => buildClaimReview(input, batch, 'sample-project-two'));
});

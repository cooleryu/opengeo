import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { listAnswerAudits, saveAnswerAudit } from './answer-audit-store';
import { analyzeResearchObservation } from './answer-audit';
import { attachOverviewData } from './overview-data';
import { appendResearchObservation, readLatestResearch, saveResearchRun } from './research-store';
import type { CollectedAnswer } from './providers/types';
import type { ResearchObservation } from './research-types';

const previousDirectory = process.env.DATA_DIR;
const previousFetch = globalThis.fetch;
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-overview-data-'));
  process.env.DATA_DIR = temporary;
  globalThis.fetch = async () => { throw new Error('Page reads must not access the network.'); };
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('backend summary keeps unknown citations separate from negatives for each language and engine', () => {
  const batch = readLatestResearch('sample-project')!;
  const original = structuredClone(batch);
  const result = attachOverviewData(batch)!;
  assert.deepEqual(batch, original);
  assert.equal(Object.keys(result.overviewMetrics!).length, 12);
  const zh = result.overviewMetrics!['zh:chatgpt'];
  assert.equal(zh.mention.yes, 1);
  assert.equal(zh.mention.no, 7);
  assert.equal(zh.mention.rate, 12.5);
  assert.equal(zh.citation.yes, 1);
  assert.equal(zh.citation.no, 1);
  assert.equal(zh.citation.unknown, 6);
  assert.equal(zh.citation.rate, null);
  assert.equal(zh.citation.minimumRate, 12.5);
  assert.deepEqual(result.overviewMetrics!['zh:all'], zh);
  assert.equal(result.overviewMetrics!['en:chatgpt'].citation.unknown, 0);
  assert.equal(result.overviewMetrics!['zh:google'].mention.completed, 0);
  assert.equal(result.answerAudits!.length, 16);
  assert.deepEqual(attachOverviewData(batch), result);
});

test('saving a revised review changes summary and updatedAt without changing a research observation', () => {
  const batch = readLatestResearch('sample-project')!;
  const before = attachOverviewData(batch)!;
  const audit = listAnswerAudits(batch.projectId, batch.id).find((record) => record.language === 'zh' && record.citation === 'unknown')!;
  saveAnswerAudit({
    ...audit, citation: 'no', citationEvidence: 'Synthetic completed source review.',
    analysisStatus: 'complete', method: 'model', reviewedAt: '2026-10-26T00:00:00Z',
  });
  const result = attachOverviewData(batch)!;
  assert.equal(result.overviewMetrics!['zh:chatgpt'].citation.unknown, 5);
  assert.ok(Date.parse(result.updatedAt!) > Date.parse(before.updatedAt!));
  assert.deepEqual(result.questions, batch.questions);
  assert.equal(attachOverviewData(batch)!.updatedAt, result.updatedAt);
});

test('latest appended answers replace historical samples without inheriting historical reviews', () => {
  const batch = readLatestResearch('sample-project')!;
  const question = batch.questions[0];
  saveResearchRun(batch.projectId, {
    id: 'overview-test-run', projectId: batch.projectId, batchId: batch.id, provider: 'chatgpt', language: 'zh',
    questions: [{ questionId: question.id, query: question.zh }], status: 'running',
    startedAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T01:00:00Z', budgetLimit: 0, spent: 0,
  });
  appendResearchObservation(batch.projectId, batch.id, question.id, {
    runId: 'overview-test-run', engine: 'chatgpt', language: 'zh', entryType: 'web_answer',
    query: question.zh, recordedAt: '2026-10-28T01:01:00Z', status: 'found',
    summary: 'Synthetic new answer.', conditions: 'No network.', sources: [],
    evidencePath: 'data/geo-evidence/overview-test-run/answer.md',
  });
  const result = attachOverviewData(readLatestResearch(batch.projectId))!;
  const mention = result.overviewMetrics!['zh:chatgpt'].mention;
  assert.equal(mention.completed, 8);
  assert.equal(mention.yes, 0);
  assert.equal(mention.unknown, 1);
  assert.equal(mention.rate, null);
  assert.equal(result.questions[0].observations.length, question.observations.length + 1);
});

test('empty and different project reads stay separate', () => {
  assert.equal(attachOverviewData(null), null);
  const own = attachOverviewData(readLatestResearch('sample-project'))!;
  const other = attachOverviewData(readLatestResearch('sample-project-two'))!;
  assert.ok(other.answerAudits!.every((record) => record.projectId === 'sample-project-two'));
  assert.equal(other.answerAudits!.length, 10);
  assert.equal(own.answerAudits!.length, 16);
  assert.notDeepEqual(own.overviewMetrics!['zh:all'], other.overviewMetrics!['zh:all']);
});

test('offline pipeline persists valid AI review and keeps malformed output unknown in the summary denominator', async () => {
  const batch = readLatestResearch('sample-project')!;
  const questions = batch.questions.slice(0, 2);
  const runId = 'overview-offline-pipeline';
  const official = 'https://github.com/example/sample-project';
  const text = 'SampleProject 是 example 的编码 Agent 证据管理项目。';
  const answer: CollectedAnswer = {
    text, citations: [{ url: official, title: 'SampleProject' }], sources: [],
    searchPerformed: true, usage: {},
    evidence: { answerComplete: true, citationsComplete: true, citationSource: 'native' },
  };
  saveResearchRun(batch.projectId, {
    id: runId, projectId: batch.projectId, batchId: batch.id, provider: 'qwen', language: 'zh',
    questions: questions.map((question) => ({ questionId: question.id, query: question.zh })),
    status: 'running', startedAt: '2026-10-28T08:00:00Z', updatedAt: '2026-10-28T08:00:00Z',
    budgetLimit: 0, spent: 0,
  });
  const directory = path.join(temporary, 'data', 'geo-evidence', runId);
  fs.mkdirSync(directory, { recursive: true });
  const observations: ResearchObservation[] = questions.map((question, index) => {
    fs.writeFileSync(path.join(directory, `${question.id}.json`), JSON.stringify(answer));
    fs.writeFileSync(path.join(directory, `${question.id}.answer.md`), text);
    const observation: ResearchObservation = {
      runId, engine: 'qwen', entryType: 'api_answer', language: 'zh', query: question.zh,
      recordedAt: `2026-10-28T08:0${index + 1}:00Z`, status: 'found', summary: text,
      conditions: 'Isolated offline pipeline fixture; no provider request.',
      sources: [{ url: official, title: 'SampleProject', kind: 'official' }],
      evidencePath: `data/geo-evidence/${runId}/${question.id}.json`,
      answerPath: `data/geo-evidence/${runId}/${question.id}.answer.md`,
    };
    appendResearchObservation(batch.projectId, batch.id, question.id, observation);
    return observation;
  });
  const snapshot = readLatestResearch(batch.projectId)!;
  const before = attachOverviewData(snapshot)!.overviewMetrics!['zh:qwen'];
  assert.equal(before.mention.completed, 2);
  assert.equal(before.mention.unknown, 2);
  assert.equal(before.mention.minimumRate, 0);

  const positive = {
    mention: 'yes', citation: 'yes', mentionEvidence: '正文明确介绍项目及所有者。',
    citationEvidence: '平台原生引用指向项目仓库。', officialUrls: [official],
    answerComplete: true, limitations: [], mentionQuote: text, identity: 'matched',
  };
  let modelCalls = 0;
  const valid = await analyzeResearchObservation(snapshot, questions[0].id, observations[0], answer, {
    model: { generateObject: async () => { modelCalls += 1; return positive; } }, persist: saveAnswerAudit,
  });
  assert.equal(valid.analysisStatus, 'complete');
  assert.equal(valid.mention, 'yes');
  assert.equal(valid.citation, 'yes');
  const afterValid = attachOverviewData(readLatestResearch(batch.projectId))!.overviewMetrics!['zh:qwen'];
  assert.equal(afterValid.mention.yes, 1);
  assert.equal(afterValid.mention.unknown, 1);
  assert.equal(afterValid.mention.minimumRate, 50);

  const malformed: Record<string, unknown> = { ...positive };
  delete malformed.citationEvidence;
  const invalid = await analyzeResearchObservation(snapshot, questions[1].id, observations[1], answer, {
    model: { generateObject: async () => { modelCalls += 1; return malformed; } }, persist: saveAnswerAudit,
  });
  assert.equal(modelCalls, 2);
  assert.equal(invalid.analysisStatus, 'failed');
  assert.equal(invalid.mention, 'unknown');
  assert.equal(invalid.citation, 'unknown');
  const persisted = listAnswerAudits(batch.projectId, batch.id).filter((record) => record.engine === 'qwen');
  assert.deepEqual(persisted, [valid, invalid]);
  const final = attachOverviewData(readLatestResearch(batch.projectId))!.overviewMetrics!['zh:qwen'];
  for (const summary of [final.mention, final.citation]) {
    assert.equal(summary.completed, 2);
    assert.equal(summary.yes, 1);
    assert.equal(summary.no, 0);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.rate, null);
    assert.equal(summary.minimumRate, 50);
  }
  assert.deepEqual(readLatestResearch(batch.projectId)!.questions, snapshot.questions);
  assert.equal(modelCalls, 2, 'summary and history reads never call the model');
});

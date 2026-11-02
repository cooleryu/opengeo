import { legacyAudit } from './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { listAnswerAudits, readAnswerAuditData, saveAnswerAudit } from './answer-audit-store';
import type { AnswerAuditRecord } from './overview-metrics';
import { appendResearchObservation, getResearchBatch, readLatestResearch, saveResearchRun } from './research-store';

const previousDirectory = process.env.DATA_DIR;
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-answer-audit-'));
  process.env.DATA_DIR = temporary;
});
afterEach(() => {
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

function inDb<T>(operation: (db: Database.Database) => T): T {
  const db = new Database(path.join(temporary, 'data', 'db.sqlite'));
  try { return operation(db); } finally { db.close(); }
}

function review(changes: Partial<AnswerAuditRecord> = {}): AnswerAuditRecord {
  const batch = readLatestResearch('sample-project')!;
  const original = legacyAudit.records.find((item) => item.projectId === batch.projectId && item.language === 'zh')!;
  return {
    projectId: batch.projectId, batchId: batch.id, questionId: original.questionId,
    engine: original.engine as AnswerAuditRecord['engine'], language: 'zh',
    recordedAt: original.recordedAt, evidencePath: original.evidencePath,
    answerComplete: true, mention: 'unknown', citation: 'unknown',
    mentionEvidence: 'Test review requires another body check.',
    citationEvidence: 'Test review requires expanded citation members.', officialUrls: [],
    schemaVersion: 1, method: 'model', analysisStatus: 'needs_review',
    limitations: ['Synthetic review in an isolated temporary database.'],
    ...changes,
  };
}

test('legacy reviews migrate once into isolated project databases without changing observations', () => {
  for (const projectId of ['sample-project', 'sample-project-two']) {
    const original = readLatestResearch(projectId)!;
    const expected = legacyAudit.records.filter((record) => record.projectId === projectId);
    const audits = listAnswerAudits(projectId, original.id);
    assert.equal(audits.length, expected.length);
    assert.ok(audits.every((record) => record.projectId === projectId && record.method === 'legacy'));
    assert.deepEqual(listAnswerAudits(projectId, original.id), audits);
    assert.deepEqual(getResearchBatch(projectId, original.id), original);
    assert.deepEqual(listAnswerAudits(projectId, 'no-such-batch'), []);
  }
  inDb((db) => {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM geo_answer_audit_imports').get() as { n: number }).n, 1);
    db.prepare('DELETE FROM geo_answer_audits WHERE seq = (SELECT MIN(seq) FROM geo_answer_audits)').run();
  });
  assert.equal(listAnswerAudits('sample-project', readLatestResearch('sample-project')!.id).length, 15);
});

test('revisions append, identical content is idempotent and the latest review is returned', () => {
  const item = review({ analysisModel: 'gpt-6.1-terra', reasoningEffort: 'max' });
  const original = getResearchBatch(item.projectId, item.batchId)!;
  saveAnswerAudit(item);
  const first = listAnswerAudits(item.projectId, item.batchId);
  const current = first.find((record) => record.questionId === item.questionId && record.language === item.language)!;
  assert.equal(current.mentionEvidence, item.mentionEvidence);
  assert.equal(current.analysisModel, item.analysisModel);
  assert.equal(current.reasoningEffort, item.reasoningEffort);
  assert.ok(current.reviewedAt);
  saveAnswerAudit({ ...item });
  saveAnswerAudit(current);
  assert.deepEqual(listAnswerAudits(item.projectId, item.batchId), first);
  const revised = { ...item, mention: 'no' as const, citation: 'no' as const, analysisStatus: 'complete' as const };
  saveAnswerAudit(revised);
  // A delayed retry of the earlier identical record must not replace a revision.
  saveAnswerAudit(item);
  const result = listAnswerAudits(item.projectId, item.batchId);
  assert.equal(result.length, 16);
  assert.equal(result.find((record) => record.questionId === item.questionId && record.language === item.language)!.mention, 'no');
  assert.deepEqual(getResearchBatch(item.projectId, item.batchId), original);
  inDb((db) => assert.equal((db.prepare('SELECT COUNT(*) AS n FROM geo_answer_audits').get() as { n: number }).n, 18));
});

test('migration never restores a legacy verdict over an existing review', () => {
  const item = review();
  saveAnswerAudit(item);
  inDb((db) => db.prepare('DELETE FROM geo_answer_audit_imports').run());
  const result = listAnswerAudits(item.projectId, item.batchId);
  assert.equal(result.find((record) => record.questionId === item.questionId && record.language === item.language)!.mention, 'unknown');
  inDb((db) => assert.equal((db.prepare('SELECT COUNT(*) AS n FROM geo_answer_audits').get() as { n: number }).n, 17));
});

test('an audit must match one existing observation in every identity field', () => {
  const item = review();
  for (const changed of [
    { projectId: 'sample-project-two' }, { batchId: 'other-batch' }, { questionId: 'missing-question' },
    { language: 'en' }, { engine: 'qwen' }, { recordedAt: '2026-10-28T20:00:00Z' },
    { evidencePath: 'some-other-answer.md' },
  ]) {
    assert.throws(() => saveAnswerAudit({ ...item, ...changed } as AnswerAuditRecord), /唯一的既有观测/);
  }
  assert.throws(() => saveAnswerAudit({ ...item, projectId: '' }), /不能为空/);
  assert.throws(() => saveAnswerAudit({ ...item, projectId: 'unknown-project' }), /没有找到/);
});

test('migration skips unmatched legacy records and does not synthesize an observation', () => {
  const batch = readLatestResearch('sample-project')!;
  const originalCount = batch.questions[0].observations.length;
  batch.questions[0].observations = batch.questions[0].observations.filter((observation) => !(observation.engine === 'chatgpt' && observation.language === 'zh'));
  inDb((db) => db.prepare('UPDATE geo_research_batches SET payload = ? WHERE id = ?').run(JSON.stringify(batch), batch.id));
  const audits = listAnswerAudits(batch.projectId, batch.id);
  assert.equal(audits.length, 15);
  assert.equal(getResearchBatch(batch.projectId, batch.id)!.questions[0].observations.length, originalCount - 1);
});

test('invalid verdicts, evidence, URLs and metadata cannot enter the audit store', () => {
  const item = review();
  for (const changes of [
    { mention: 'maybe' }, { citation: '' }, { mentionEvidence: ' ' }, { citationEvidence: '' },
    { officialUrls: ['javascript:alert(1)'] }, { citation: 'yes' },
    { officialUrls: ['https://example.com'] }, { answerComplete: false, mention: 'no' },
    { schemaVersion: 2 }, { reviewedAt: 'yesterday' }, { method: 'invented' },
    { analysisStatus: 'complete' }, { analysisStatus: 'failed', mention: 'no' },
    { method: 'unavailable', citation: 'no' }, { limitations: [''] },
    { analysisModel: '' }, { analysisModel: 'x'.repeat(129) }, { analysisModel: 'model with spaces' },
    { analysisModel: 'model\nname' }, { analysisModel: 42 }, { reasoningEffort: 'ultra' },
  ]) assert.throws(() => saveAnswerAudit({ ...item, ...changes } as AnswerAuditRecord));
  saveAnswerAudit({ ...item, answerComplete: false, method: 'unavailable', analysisStatus: 'failed' });
});

test('appended API observations can be reviewed while another project stays unchanged', () => {
  const batch = readLatestResearch('sample-project')!;
  const other = readLatestResearch('sample-project-two')!;
  const question = batch.questions[0];
  saveResearchRun(batch.projectId, {
    id: 'audit-test-run', projectId: batch.projectId, batchId: batch.id, provider: 'qwen', language: 'zh',
    questions: [{ questionId: question.id, query: question.zh }], status: 'running',
    startedAt: '2026-10-28T01:00:00Z', updatedAt: '2026-10-28T01:00:00Z', budgetLimit: 0.01, spent: 0,
  });
  const observation = {
    runId: 'audit-test-run', engine: 'qwen' as const, language: 'zh' as const, entryType: 'api_answer' as const,
    query: question.zh, recordedAt: '2026-10-28T01:01:00Z', status: 'not_observed' as const,
    summary: 'Synthetic observation.', conditions: 'No network.', sources: [],
    evidencePath: 'data/geo-evidence/audit-test-run/raw.json', answerPath: 'data/geo-evidence/audit-test-run/answer.md',
  };
  appendResearchObservation(batch.projectId, batch.id, question.id, observation);
  saveAnswerAudit(review({ engine: 'qwen', recordedAt: observation.recordedAt, evidencePath: observation.answerPath }));
  const result = readAnswerAuditData(batch.projectId, batch.id);
  assert.equal(result.records.filter((record) => record.engine === 'qwen').length, 1);
  assert.ok(Date.parse(result.updatedAt!) > Date.parse(legacyAudit.reviewedAt));
  assert.deepEqual(getResearchBatch(other.projectId, other.id), other);
  assert.equal(listAnswerAudits(other.projectId, other.id).some((record) => record.engine === 'qwen'), false);
});

import '../test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { attachOverviewData } from '../overview-data';
import { appendResearchObservation, getLatestResearch, saveResearchRun } from '../research';
import { saveAnswerAudit } from '../answer-audit-store';
import {
  ensureProjectRelationalData,
  getRelationalIntegrityReport,
  ingestRelationalObservation,
  readRelationalOverview,
  readRelationalResearchBatch,
  RELATIONAL_TABLES,
  saveRelationalAuditRevision,
  withProjectDb,
} from './index';

const previousDataDir = process.env.DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-relational-db-'));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('creates all 7 relational tables with PRAGMA foreign_keys = ON and lossless migration parity', () => {
  for (const projectId of ['sample-project', 'sample-project-two']) {
    const legacyOverview = attachOverviewData(getLatestResearch(projectId))!;
    const firstMigration = ensureProjectRelationalData(projectId);
    const secondMigration = ensureProjectRelationalData(projectId);

    assert.equal(secondMigration.observationsInserted, 0);
    assert.equal(secondMigration.auditsInserted, 0);
    assert.ok(firstMigration.observationsInserted > 0);

    const relationalBatch = readRelationalResearchBatch(projectId)!;
    assert.deepEqual(relationalBatch, getLatestResearch(projectId));

    const relationalOverview = readRelationalOverview(projectId)!;
    assert.deepEqual(relationalOverview.overviewMetrics, legacyOverview.overviewMetrics);
    assert.deepEqual(relationalOverview.answerAudits, legacyOverview.answerAudits);

    const report = getRelationalIntegrityReport(projectId);
    assert.equal(report.foreignKeysEnabled, true);
    assert.deepEqual(report.foreignKeyViolations, []);
    assert.deepEqual(report.tablesPresent, [...RELATIONAL_TABLES]);
    assert.deepEqual(report.orphans, {
      assets: 0,
      questions: 0,
      observationsMissingQuestion: 0,
      observationsMissingRun: 0,
      auditsMissingObservation: 0,
      deliverablesMissingRun: 0,
    });
    assert.equal(report.evidenceFiles.missingPaths.length, 0);
  }
});

test('enforces strict SQLite foreign keys and partial unique index on current audits', () => {
  ensureProjectRelationalData('sample-project');

  withProjectDb('sample-project', (db, projectId) => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO opengeo_observations (
              project_id, id, batch_id, question_id, engine, language,
              query_text, status, evidence_path, recorded_at, created_at
            ) VALUES (?, 'bad-obs', 'batch', 'non-existent-question', 'chatgpt', 'zh', 'q', 'not_observed', 'e.json', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`,
          )
          .run(projectId),
      /FOREIGN KEY constraint failed/,
    );

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO opengeo_answer_audits (
              project_id, observation_id, is_current, mention, citation,
              mention_evidence, citation_evidence, answer_complete, audited_at
            ) VALUES (?, 'non-existent-obs', 1, 'no', 'no', 'e1', 'e2', 1, '2026-11-12T00:00:00Z')`,
          )
          .run(projectId),
      /FOREIGN KEY constraint failed/,
    );

    const existingObs = db
      .prepare('SELECT id FROM opengeo_observations WHERE project_id = ? ORDER BY seq ASC LIMIT 1')
      .get(projectId) as { id: string };

    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO opengeo_answer_audits (
              project_id, observation_id, is_current, mention, citation,
              mention_evidence, citation_evidence, answer_complete, audited_at
            ) VALUES (?, ?, 1, 'no', 'no', 'duplicate current', 'duplicate current', 1, '2026-11-12T00:00:01Z')`,
          )
          .run(projectId, existingObs.id),
      /UNIQUE constraint failed/,
    );
  });
});

test('ingestRelationalObservation auto-audits negative mention and updates overview + revision history', async () => {
  const batch = readRelationalResearchBatch('sample-project')!;
  const question = batch.questions[1]; // C02 (previously mention = 'no')

  // Simulate an AI answer that explicitly says "I do not know SampleProject" —
  // semantic review must classify identity='unrecognized' & mention='no', NOT string-contains 'yes'!
  const negativeText = '我不了解 SampleProject 这个具体项目，以下仅提供通用核对流程说明。';
  const ingested = await ingestRelationalObservation(
    {
      projectId: 'sample-project',
      questionId: question.id,
      observation: {
        id: 'live-test:chatgpt:C02',
        runId: 'live-test-run-1',
        engine: 'chatgpt',
        language: 'zh',
        entryType: 'web_answer',
        query: question.zh,
        recordedAt: '2026-11-12T06:00:00.000Z',
        collectedAt: '2026-11-12T06:00:00.000Z',
        status: 'not_observed',
        summary: negativeText,
        conditions: 'Clean logged-out session',
        sources: [],
        evidencePath: 'fixtures/sample-project/C02-chatgpt-zh.md',
        answerPath: 'fixtures/sample-project/C02-chatgpt-zh.md',
      },
      answer: {
        text: negativeText,
        citations: [],
        sources: [],
        evidence: {
          answerComplete: true,
          citationsComplete: true,
          citationSource: 'native',
        },
        searchPerformed: true,
        usage: {},
      },
    },
    {
      model: {
        generateObject: async () =>
          ({
            mention: 'no',
            citation: 'no',
            mentionEvidence: '回答明确表示不了解 SampleProject，未识别我方项目。',
            citationEvidence: '原生引用为空，未引用我方链接。',
            officialUrls: [],
            answerComplete: true,
            limitations: [],
            mentionQuote: '我不了解 SampleProject 这个具体项目',
            identity: 'unrecognized',
          }) as never,
      },
    },
  );

  assert.equal(ingested.audit.mention, 'no');
  assert.equal(ingested.audit.citation, 'no');
  assert.equal(ingested.overview.overviewMetrics?.['zh:chatgpt']?.mention.yes, 1); // Only C01 is yes

  // Now append an audit revision confirming mention + native citation on that observation:
  const revised = saveRelationalAuditRevision('sample-project', ingested.observationId, {
    mention: 'yes',
    citation: 'yes',
    mentionEvidence: '人工复核确认提及 SampleProject。',
    citationEvidence: '确认包含官方仓库链接。',
    officialUrls: ['https://github.com/example/sample-project'],
    answerComplete: true,
    analysisStatus: 'complete',
    method: 'model',
  });
  assert.equal(revised.mention, 'yes');

  const updatedOverview = readRelationalOverview('sample-project')!;
  assert.equal(updatedOverview.overviewMetrics?.['zh:chatgpt']?.mention.yes, 2); // C01 + C02

  const integrity = getRelationalIntegrityReport('sample-project');
  assert.equal(integrity.counts.auditsHistory, 1);
  assert.deepEqual(integrity.foreignKeyViolations, []);
});

test('legacy store write hooks automatically sync observations and audits into relational tables', () => {
  const batch = getLatestResearch('sample-project-two')!;
  const q = batch.questions[0];
  saveResearchRun(batch.projectId, {
    id: 'sync-run-1',
    projectId: batch.projectId,
    batchId: batch.id,
    provider: 'chatgpt',
    language: 'zh',
    questions: [{ questionId: q.id, query: q.zh }],
    status: 'running',
    startedAt: '2026-11-12T07:00:00Z',
    updatedAt: '2026-11-12T07:00:00Z',
    budgetEnabled: false,
    budgetEnforcement: 'disabled',
    budgetLimit: null,
    spent: 0,
  });

  appendResearchObservation(batch.projectId, batch.id, q.id, {
    id: 'sync-obs-1',
    runId: 'sync-run-1',
    engine: 'chatgpt',
    language: 'zh',
    entryType: 'web_answer',
    query: q.zh,
    recordedAt: '2026-11-12T07:01:00Z',
    collectedAt: '2026-11-12T07:01:00Z',
    status: 'not_observed',
    summary: 'No mention.',
    conditions: 'Test sync',
    sources: [],
    evidencePath: 'fixtures/sample-project-two/R01-chatgpt-zh.md',
  });

  saveAnswerAudit({
    projectId: batch.projectId,
    batchId: batch.id,
    questionId: q.id,
    engine: 'chatgpt',
    language: 'zh',
    recordedAt: '2026-11-12T07:01:00Z',
    mention: 'no',
    citation: 'no',
    mentionEvidence: '未提及 SampleProjectTwo。',
    citationEvidence: '未引用官方链接。',
    officialUrls: [],
    evidencePath: 'fixtures/sample-project-two/R01-chatgpt-zh.md',
    answerComplete: true,
    analysisStatus: 'complete',
    method: 'model',
  });

  const overview = readRelationalOverview(batch.projectId)!;
  assert.equal(overview.overviewMetrics?.['zh:chatgpt']?.mention.yes, 0);
  const report = getRelationalIntegrityReport(batch.projectId);
  assert.deepEqual(report.foreignKeyViolations, []);
});

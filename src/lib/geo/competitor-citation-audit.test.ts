import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { auditCompetitorCitations, readCollectedCompetitorAnswer } from './competitor-citation-audit';
import {
  competitorCitationIdentityKey, readCompetitorCitationAuditData, saveCompetitorCitationAudit,
  type CompetitorCitationAuditRecord,
} from './competitor-citation-store';
import { buildCompetitorPerformance } from './competitor-performance';
import { readLatestResearch } from './research-store';
import type { GeoStructuredModel } from './connection-settings';
import type { CollectedAnswer } from './providers/types';
import type { CompetitorCandidate } from './competitor-types';
import type { ResearchBatch, ResearchObservation } from './research-types';

const previousDirectory = process.env.DATA_DIR;
let temporary: string;
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-citation-')); process.env.DATA_DIR = temporary; });
afterEach(() => {
  if (previousDirectory === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previousDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});
const official = 'https://github.com/acme/tool';
function candidate(id = 'tool', officialUrls = [official]): CompetitorCandidate {
  return { id, name: id, aliases: [], officialUrls, description: '', reason: '', saved: true, questions: [] };
}
function observation(changes: Partial<ResearchObservation> = {}): ResearchObservation {
  return { engine: 'chatgpt', language: 'zh', entryType: 'web_answer', query: '有哪些工具？',
    recordedAt: '2026-10-29T01:00:00Z', status: 'not_observed', summary: '', conditions: 'Synthetic',
    sources: [{ title: 'Tool search source', url: official, kind: 'other' }], evidencePath: 'synthetic.json', answerPath: 'synthetic.md', ...changes };
}
function batch(item = observation()): ResearchBatch {
  return { id: 'citation-test-batch', projectId: 'sample-project', date: '2026-10-29', productSummary: '', contributionSummary: '',
    scopeNote: '', reportPath: '', sourceAuditPath: '', reviewPath: '', nextStep: '', deferredQuestions: [],
    questions: [{ id: 'Q1', zh: item.query, en: 'Which tools?', decision: 'search_now', valueReason: '', evidenceBasis: '',
      answerability: '', gaps: [], decisionReason: '', reviewPath: '', diagnosis: { observed: '', hypothesis: '', nextStep: '' }, observations: [item] }] };
}
function answer(urls = [official]): CollectedAnswer {
  return { text: `Try tool. Ordinary URL: ${official}`, citations: urls.map((url) => ({ url, title: url })),
    sources: [{ url: official, title: 'Not a citation' }], searchPerformed: true, usage: {},
    evidence: { answerComplete: true, citationsComplete: true, citationSource: 'native' } };
}
function fakeModel(value: unknown, callback?: (args: unknown) => void): GeoStructuredModel {
  return { generateObject: async (args: unknown) => { callback?.(args); return value; } } as GeoStructuredModel;
}
async function review(collected = answer(), options: Parameters<typeof auditCompetitorCitations>[2] = {}, candidates = [candidate()]) {
  const value = batch();
  return auditCompetitorCitations(value, candidates, { persist: () => {}, existingRecords: [],
    observations: [{ questionId: 'Q1', observation: value.questions[0].observations[0], answer: collected }], ...options });
}

test('native citations and exact official paths determine yes/no independently of search sources and ordinary URLs', async () => {
  const positive = (await review())[0];
  assert.equal(positive.citation, 'yes');
  assert.deepEqual(positive.officialUrls, [official]);
  assert.equal(positive.method, 'evidence');
  for (const urls of [[], ['https://github.com/other/tool'], ['https://github.com/acme/toolkit'], ['https://example.com/?url=' + official]]) {
    const negative = (await review(answer(urls)))[0];
    assert.equal(negative.citation, 'no');
    assert.deepEqual(negative.officialUrls, []);
  }
  assert.equal((await review(answer(['https://github.com/ACME/TOOL/docs'])))[0].citation, 'yes');
  assert.equal((await review(answer(['https://example.com/page?id=2']), {}, [candidate('query-page', ['https://example.com/page?id=1'])]))[0].citation, 'no');
});

test('missing completeness, missing native acquisition and shared-host ownership remain specific unknowns without model calls', async () => {
  let calls = 0;
  const model = fakeModel({}, () => { calls++; });
  const partial = answer(); partial.evidence!.citationsComplete = false;
  const incomplete = answer(); incomplete.evidence!.answerComplete = false;
  const missing = answer(); delete missing.evidence;
  for (const value of [partial, incomplete, missing]) {
    const record = (await review(value, { model }))[0];
    assert.equal(record.citation, 'unknown');
    assert.ok(record.limitations[0].length > 10);
    assert.equal(record.analysisStatus, 'needs_review');
  }
  const unowned = (await review(answer(), { model }, [candidate('unowned', ['https://github.com/'])]))[0];
  assert.equal(unowned.citation, 'unknown');
  assert.match(unowned.citationEvidence, /共享平台/);
  assert.equal((await review(answer(), { model }, [candidate('unowned', ['https://www.github.com/'])]))[0].citation, 'unknown');
  assert.equal(calls, 0);
});

test('one optional model request reviews all candidates, while validating every returned native URL', async () => {
  let calls = 0;
  const other = candidate('other', ['https://other.example/']);
  const model = fakeModel({ records: [
    { candidateId: 'tool', citation: 'yes', citationEvidence: '原生引用指向官方仓库。', officialUrls: [official], limitations: [] },
    { candidateId: 'other', citation: 'no', citationEvidence: '完整原生引用没有该官网。', officialUrls: [], limitations: [] },
  ] }, (args) => {
    calls++;
    const payload = JSON.parse((args as { messages: { content: string }[] }).messages[1].content);
    assert.equal(payload.candidates.length, 2);
    assert.equal(payload.answer.sources, undefined);
  });
  const records = await review(answer(), { model }, [candidate(), other]);
  assert.equal(calls, 1);
  assert.deepEqual(records.map((item) => item.citation), ['yes', 'no']);
  assert.ok(records.every((item) => item.method === 'model'));
  for (const response of [
    { citation: 'yes', officialUrls: ['https://github.com/acme/tool/invented'] },
    { citation: 'no', officialUrls: [] },
  ]) {
    const invalid = (await review(answer(), { model: fakeModel({ records: [{ candidateId: 'tool', ...response,
      citationEvidence: 'Unverified claim', limitations: [] }] }) }))[0];
    assert.equal(invalid.citation, 'unknown');
    assert.equal(invalid.analysisStatus, 'failed');
    assert.match(invalid.citationEvidence, /逐条原生引用/);
  }
});

test('malformed output and provider failure remain saved unknowns, without retries or sensitive error text', async () => {
  let calls = 0;
  const model = { generateObject: async () => { calls++; throw new Error('secret upstream URL'); } } as unknown as GeoStructuredModel;
  const saved: CompetitorCitationAuditRecord[] = [];
  const record = (await review(answer(), { model, persist: (value) => saved.push(value) }))[0];
  assert.equal(calls, 1);
  assert.equal(record.analysisStatus, 'failed');
  assert.equal(record.citation, 'unknown');
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.deepEqual(saved, [record]);
  const malformed = (await review(answer(), { model: fakeModel({ records: [] }) }))[0];
  assert.equal(malformed.analysisStatus, 'failed');
  assert.match(malformed.citationEvidence, /返回/);
});

test('saved provider raw responses preserve native markers rather than promoting all search results', async () => {
  const item = observation({ engine: 'qwen', entryType: 'api_answer' });
  const value = batch(item);
  const qwen = { output: { choices: [{ finish_reason: 'stop', message: { content: 'A different tool [ref_2]' } }],
    search_info: { search_results: [{ index: 1, url: official, title: 'Tool' }, { index: 2, url: 'https://elsewhere.example/', title: 'Other' }] } } };
  const capture = readCollectedCompetitorAnswer(value, 'Q1', item, () => JSON.stringify(qwen));
  assert.equal(capture.issue, undefined);
  assert.equal(capture.answer!.sources.length, 2);
  assert.equal(capture.answer!.citations.length, 1);
  const records = await auditCompetitorCitations(value, [candidate()], { persist: () => {}, existingRecords: [], readEvidence: () => JSON.stringify(qwen) });
  assert.equal(records[0].citation, 'no');
  qwen.output.choices[0].message.content = 'Broken marker [ref_3]';
  const broken = readCollectedCompetitorAnswer(value, 'Q1', item, () => JSON.stringify(qwen));
  assert.match(broken.issue!, /引用清单不完整/);
  const searchOnly = observation({ engine: 'deepseek', entryType: 'api_search' });
  assert.equal(readCollectedCompetitorAnswer(batch(searchOnly), 'Q1', searchOnly, () => JSON.stringify({ results: [{ url: official }] })).notApplicable, true);
});

test('default review uses only current AI samples, while an explicit historical scope remains available', async () => {
  const latest = observation({ recordedAt: '2026-10-29T02:00:00Z', evidencePath: 'latest.json' });
  const value = batch(latest);
  const historical = observation({ evidencePath: 'old.json' });
  value.questions[0].observations.unshift(historical,
    observation({ engine: 'google', entryType: 'web_search', evidencePath: 'search.json' }));
  const records = await auditCompetitorCitations(value, [candidate()], { persist: () => {}, existingRecords: [], readEvidence: () => JSON.stringify(answer()) });
  assert.equal(records.length, 1);
  assert.equal(records[0].evidencePath, latest.evidencePath);
  const old = await auditCompetitorCitations(value, [candidate()], { persist: () => {}, existingRecords: [],
    observations: [{ questionId: 'Q1', observation: historical, answer: answer() }] });
  assert.equal(old.length, 1);
  assert.equal(old[0].evidencePath, historical.evidencePath);
});

test('historical ChatGPT completeness and Body citations are reused without rewriting the capture', () => {
  const value = readLatestResearch('sample-project')!;
  const complete = value.questions.find((question) => question.id === 'C02')!;
  const completeObservation = complete.observations.find((item) => item.engine === 'chatgpt' && item.language === 'zh')!;
  const restored = readCollectedCompetitorAnswer(value, complete.id, completeObservation);
  assert.equal(restored.issue, undefined);
  assert.ok(restored.answer!.citations.some((item) => item.url.startsWith('https://github.com/sample/')));
  const partial = value.questions.find((question) => question.id === 'C01')!;
  const partialObservation = partial.observations.find((item) => item.engine === 'chatgpt' && item.language === 'zh')!;
  assert.match(readCollectedCompetitorAnswer(value, partial.id, partialObservation).issue!, /未展开/);
  const mismatched = { ...completeObservation, recordedAt: '2026-10-29T03:00:00Z' };
  assert.match(readCollectedCompetitorAnswer(value, complete.id, mismatched).issue!, /完整性核实/);
});

test('SQLite appends exact-identity revisions; reads do not create files or change evidence', async () => {
  assert.deepEqual(readCompetitorCitationAuditData('sample-project', 'missing'), { records: [] });
  assert.deepEqual(fs.readdirSync(temporary), []);
  const value = readLatestResearch('sample-project')!;
  const snapshot = structuredClone(value);
  const question = value.questions[0];
  const item = question.observations.find((observed) => observed.engine === 'chatgpt')!;
  const [first] = await auditCompetitorCitations(value, [candidate()], {
    existingRecords: [], observations: [{ questionId: question.id, observation: item, answer: answer() }],
  });
  assert.equal(readCompetitorCitationAuditData(value.projectId, value.id).records[0].citation, 'yes');
  const changed: CompetitorCitationAuditRecord = { ...first, citation: 'unknown', officialUrls: [], analysisStatus: 'needs_review',
    citationEvidence: 'Recheck after explicit reviewer decision.', limitations: ['Recheck after explicit reviewer decision.'] };
  saveCompetitorCitationAudit(changed);
  saveCompetitorCitationAudit(first);
  const latest = readCompetitorCitationAuditData(value.projectId, value.id);
  assert.equal(latest.records.length, 1);
  assert.equal(latest.records[0].citation, 'unknown');
  assert.ok(latest.updatedAt);
  assert.deepEqual(readLatestResearch('sample-project'), snapshot);
  assert.deepEqual(readCompetitorCitationAuditData('sample-project-two', value.id), { records: [] });
  assert.throws(() => saveCompetitorCitationAudit({ ...first, questionId: 'not-in-batch' }), /唯一的既有观测/);
  assert.throws(() => saveCompetitorCitationAudit({ ...first, officialUrls: ['https://github.com/other/tool'] }), /原生引用/);
  const db = new Database(path.join(temporary, 'data', 'db.sqlite'), { readonly: true });
  try { assert.equal((db.prepare('SELECT COUNT(*) AS n FROM geo_competitor_citation_audits').get() as { n: number }).n, 2); }
  finally { db.close(); }
});

test('performance uses saved matching verdicts and exposes concrete unknown causes without reading capture files', async () => {
  const value = batch();
  const [record] = await review();
  const target = { name: candidate().name, aliases: [], officialUrls: [official], updatedAt: '' };
  const comparison = { projectId: value.projectId, batch: { id: value.id, date: value.date },
    own: { name: 'SampleProject', aliases: [], officialUrls: [] }, target, rows: [] };
  const metric = (records: CompetitorCitationAuditRecord[], selection = target) =>
    buildCompetitorPerformance(value, { ...comparison, target: selection }, () => null, records).scopes['zh:chatgpt'].metrics.find((item) => item.id === 'citation')!;
  assert.equal(metric([record]).target.yes, 1);
  assert.equal(metric([record]).target.rate, 100);
  const otherIdentity = { ...target, officialUrls: ['https://other.example/'] };
  assert.notEqual(competitorCitationIdentityKey(otherIdentity), record.identityKey);
  assert.equal(metric([record], otherIdentity).target.unknown, 1);
  assert.equal(metric([{ ...record, recordedAt: 'different' }]).target.unknown, 1);
  const unknown = { ...record, citation: 'unknown' as const, officialUrls: [], limitations: ['引用组 +2 未展开'] };
  assert.equal(metric([unknown]).target.rate, null);
  assert.deepEqual(metric([unknown]).targetLimitations, ['引用组 +2 未展开']);
});

import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { saveAnswerAudit } from './answer-audit-store';
import { browserObservationSchema, getBrowserObservation, ingestBrowserObservation, requireBrowserCollectionRequest, type BrowserObservationInput } from './browser-collection';
import type { GeoStructuredModel } from './connection-settings';
import { evidenceLocation, projectDataDirectory, withGeoProject } from './projects';
import { getResearchBatch, readLatestResearch, listResearchRuns } from './research-store';

let temporary: string;
let previousDirectory: string | undefined;
const previousFetch = globalThis.fetch;
beforeEach(() => {
  previousDirectory = process.env.DATA_DIR;
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-browser-collection-'));
  process.env.DATA_DIR = temporary;
  globalThis.fetch = async () => { throw new Error('Unexpected network request in isolated browser-ingestion tests'); };
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  if (previousDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDirectory;
  fs.rmSync(temporary, { recursive: true, force: true });
});

const answer = 'SampleProject 是 example 的编码 Agent 证据管理项目。';
const official = 'https://github.com/example/sample-project';
function input(changes: Partial<BrowserObservationInput> = {}): BrowserObservationInput {
  const batch = readLatestResearch('sample-project')!;
  return {
    projectId: batch.projectId, batchId: batch.id, questionId: batch.questions[0].id,
    query: batch.questions[0].zh, language: 'zh', engine: 'chatgpt', entryType: 'web_answer',
    captureId: 'synthetic-browser-capture-1', recordedAt: '2026-11-08T04:00:00.000Z',
    pageUrl: 'https://chatgpt.com/c/synthetic-capture', answerText: answer,
    sources: [{ title: 'SampleProject', url: official }], citations: [{ title: 'SampleProject', url: official }],
    citationSource: 'native', answerComplete: true, citationsComplete: true,
    conditions: { mode: 'search', region: 'unknown', loginState: 'signed_in', model: 'visible-model-label', searchMode: 'on' },
    raw: { section: 'assistant response', extraction: 'synthetic DOM fixture' },
    ...changes,
  };
}
function positive() {
  return { mention: 'yes', citation: 'yes', mentionEvidence: '正文明确介绍项目及所有者。',
    citationEvidence: '原生引用指向项目仓库。', officialUrls: [official], answerComplete: true,
    limitations: [], mentionQuote: answer, identity: 'matched' };
}
function maxSequence(table: 'geo_research_observations' | 'geo_answer_audits') {
  return withGeoProject('sample-project', () => {
    const db = new Database(path.join(projectDataDirectory(), 'db.sqlite'));
    try { return (db.prepare(`SELECT MAX(seq) AS seq FROM ${table}`).get() as { seq: number }).seq; }
    finally { db.close(); }
  });
}

test('saves the exact capture before analysis and exposes its saved audit through overview reads', async () => {
  const item = input();
  const otherBefore = readLatestResearch('sample-project-two');
  const beforeCount = getResearchBatch(item.projectId, item.batchId)!.questions[0].observations.length;
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async () => {
    calls += 1;
    const during = getBrowserObservation(item.projectId, item.captureId);
    assert.equal(during.status, 'analyzing');
    assert.equal(during.run?.phase, 'analyzing');
    assert.equal(during.observation?.query, item.query);
    assert.equal(during.observation?.entryType, 'web_answer');
    withGeoProject(item.projectId, () => {
      const rawFile = evidenceLocation(during.observation!.evidencePath).target;
      assert.deepEqual(JSON.parse(fs.readFileSync(rawFile, 'utf8')).input, item);
      assert.equal(fs.readFileSync(evidenceLocation(during.observation!.answerPath!).target, 'utf8'), answer);
    });
    return positive();
  } };
  const result = await ingestBrowserObservation(item, { model });
  assert.equal(calls, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.run?.status, 'completed');
  assert.equal(result.audit?.mention, 'yes');
  assert.equal(result.audit?.citation, 'yes');
  assert.equal(result.audit?.method, 'model');
  assert.equal(result.originalURL, item.pageUrl);
  assert.equal(result.batch!.questions[0].observations.length, beforeCount + 1);
  assert.ok(result.batch!.overviewMetrics!['zh:chatgpt'].mention.yes > 0);
  assert.ok(maxSequence('geo_research_observations') > 0);
  assert.ok(maxSequence('geo_answer_audits') > 0);
  assert.deepEqual(readLatestResearch('sample-project-two'), otherBefore);
  const repeated = await ingestBrowserObservation(item, { model });
  assert.equal(repeated.duplicate, true);
  assert.equal(calls, 1, 'ordinary retries do not incur another model call');
  assert.equal(listResearchRuns(item.projectId).length, 1);
  assert.deepEqual(repeated.audit, result.audit);
  await assert.rejects(ingestBrowserObservation({ ...item, answerText: 'different answer' }, { model }), { status: 409 });
  assert.equal(calls, 1);
});

test('new native captures cannot omit the separate citations list', async () => {
  const item = input();
  delete item.citations;
  let calls = 0;
  await assert.rejects(ingestBrowserObservation(item, { model: {
    generateObject: async () => { calls += 1; return positive(); },
  } }), /必须显式提供 citations/);
  assert.equal(calls, 0);
  assert.equal(listResearchRuns(item.projectId).length, 0);
  const file = withGeoProject(item.projectId, () => evidenceLocation(`data/geo-evidence/browser-${item.captureId}/capture.json`).target);
  assert.equal(fs.existsSync(file), false);
});

test('an already saved native capture without citations remains readable without reanalysis or rewriting', async () => {
  const item = input();
  const saved = await ingestBrowserObservation(item, { model: { generateObject: async () => positive() } });
  const legacy = { ...item };
  delete legacy.citations;
  const file = withGeoProject(item.projectId, () => evidenceLocation(saved.observation!.evidencePath).target);
  const capture = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Reproduce only the pre-citations capture format in the synthetic test directory.
  capture.input = legacy;
  const original = JSON.stringify(capture, null, 2);
  fs.writeFileSync(file, original, { mode: 0o600 });
  const before = maxSequence('geo_answer_audits');
  let calls = 0;
  const repeated = await ingestBrowserObservation(legacy, { model: {
    generateObject: async () => { calls += 1; return positive(); },
  } });
  assert.equal(calls, 0);
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(repeated.audit, saved.audit);
  assert.equal(maxSequence('geo_answer_audits'), before);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('concurrent duplicate submission does not run a second model request', async () => {
  const item = input();
  let finish!: (value: unknown) => void;
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async () => {
    calls += 1;
    return await new Promise(resolve => { finish = resolve; });
  } };
  const first = ingestBrowserObservation(item, { model });
  const second = await ingestBrowserObservation(item, { model });
  assert.equal(second.status, 'analyzing');
  assert.equal(second.duplicate, true);
  assert.equal(calls, 1);
  finish(positive());
  assert.equal((await first).status, 'complete');
});

test('rechecks persisted audits after acquiring the lease when a different worker finishes in between', async () => {
  const item = input();
  const completed = await ingestBrowserObservation(item, { model: { generateObject: async () => positive() } });
  const db = new Database(path.join(temporary, 'data', 'db.sqlite'));
  try {
    db.prepare('DELETE FROM geo_answer_audits WHERE project_id = ? AND observation_key = ?').run(item.projectId,
      JSON.stringify([item.questionId, item.engine, item.language, item.recordedAt, completed.observation!.answerPath]));
    const running = { ...completed.run!, status: 'running', phase: 'analyzing', completedAt: undefined };
    db.prepare('UPDATE geo_research_runs SET status = ?, payload = ? WHERE id = ?')
      .run('running', JSON.stringify(running), running.id);
  } finally { db.close(); }
  const write = fs.writeFileSync;
  let injected = false;
  let calls = 0;
  fs.writeFileSync = ((file, ...arguments_) => {
    if (!injected && String(file).endsWith('.analysis.lock')) {
      injected = true;
      // Represents the first worker persisting its audit and finishing after
      // the second worker's preflight read, but before its lease acquisition.
      saveAnswerAudit(completed.audit!);
    }
    return write(file, ...arguments_);
  }) as typeof fs.writeFileSync;
  try {
    const repeated = await ingestBrowserObservation(item, { model: { generateObject: async () => { calls += 1; return positive(); } } });
    assert.equal(injected, true);
    assert.equal(calls, 0);
    assert.equal(repeated.status, 'complete');
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.audit?.mention, 'yes');
  } finally { fs.writeFileSync = write; }
});

test('a model failure retains raw evidence and unknown metrics, and explicit retry appends only an audit', async () => {
  const item = input();
  const failed = await ingestBrowserObservation(item, { model: { generateObject: async () => { throw new Error('secret provider error body'); } } });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.audit?.mention, 'unknown');
  assert.equal(failed.run?.status, 'partial');
  assert.equal(failed.retryable, true);
  assert.equal(JSON.stringify(failed).includes('secret provider error body'), false);
  const observations = maxSequence('geo_research_observations');
  const audits = maxSequence('geo_answer_audits');
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async () => { calls += 1; return positive(); } };
  await ingestBrowserObservation(item, { model });
  assert.equal(calls, 0);
  const retried = await ingestBrowserObservation({ ...item, retryAnalysis: true }, { model });
  assert.equal(calls, 1);
  assert.equal(retried.status, 'complete');
  assert.equal(retried.retryable, false);
  assert.equal(maxSequence('geo_research_observations'), observations);
  assert.ok(maxSequence('geo_answer_audits') > audits, 'existing overview polling observes the audit revision');
  assert.equal(retried.observation!.evidencePath, failed.observation!.evidencePath);
  assert.equal(getBrowserObservation(item.projectId, item.captureId).audit?.mention, 'yes');
});

test('incomplete acquisition stays unresolved and plain Google results are not AI answers', async () => {
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async () => { calls += 1; return positive(); } };
  const incomplete = await ingestBrowserObservation(input({ answerComplete: false, citationsComplete: false }), { model });
  assert.equal(incomplete.status, 'needs_review');
  assert.equal(incomplete.audit?.mention, 'unknown');
  assert.equal(incomplete.run?.status, 'partial');
  assert.equal(calls, 0);
  const web = await ingestBrowserObservation(input({ captureId: 'google-search-capture', engine: 'google',
    entryType: 'web_search', pageUrl: 'https://www.google.com/search?q=synthetic', answerText: '',
    conditions: { mode: 'web_search', region: 'unknown', loginState: 'unknown' },
  }), { model });
  assert.equal(web.status, 'not_applicable');
  assert.equal(web.audit?.mention, 'unknown');
  assert.equal(web.observation?.answerPath, undefined);
  assert.equal(web.observation?.sources[0].position, 1);
  assert.equal(calls, 0);
});

test('ordinary owned links stay outside native citations and do not prevent a confirmed citation absence', async () => {
  const thirdParty = { title: '第三方资料', url: 'https://independent.example/review' };
  const item = input({
    answerText: `${answer}\n项目地址：${official}`,
    sources: [{ title: '正文中的项目地址', url: official }, thirdParty],
    citations: [thirdParty], citationSource: 'native', citationsComplete: true,
  });
  let calls = 0;
  const result = await ingestBrowserObservation(item, { model: { generateObject: async request => {
    calls += 1;
    const supplied = JSON.parse(request.messages[1].content as string).answer;
    assert.deepEqual(supplied.nativeCitations, [thirdParty]);
    assert.ok(supplied.text.includes(official), 'the ordinary body link remains in the saved answer');
    assert.equal(supplied.evidence.citationSource, 'native');
    assert.equal(supplied.evidence.citationsComplete, true);
    return { ...positive(), citation: 'no', officialUrls: [],
      citationEvidence: '完整原生引用清单仅含第三方资料，正文普通链接不属于原生引用。' };
  } } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'complete');
  assert.equal(result.audit?.mention, 'yes');
  assert.equal(result.audit?.citation, 'no');
  assert.deepEqual(result.audit?.officialUrls, []);
  assert.ok(result.observation?.sources.some(source => source.url === official), 'ordinary links remain available as source evidence');
  assert.equal(getBrowserObservation(item.projectId, item.captureId).audit?.citation, 'no');
});

test('unknown or absent citation provenance never promotes captured links into native citations', async () => {
  for (const citationSource of ['unknown', 'none'] as const) {
    let calls = 0;
    const item = input({ captureId: `non-native-${citationSource}`, citationSource });
    const result = await ingestBrowserObservation(item, { model: { generateObject: async request => {
      calls += 1;
      const supplied = JSON.parse(request.messages[1].content as string).answer;
      assert.deepEqual(supplied.nativeCitations, []);
      assert.equal(supplied.evidence.citationSource, citationSource);
      return { ...positive(), citation: 'unknown', officialUrls: [], citationEvidence: '引用来源未经核实。',
        limitations: ['引用来源未经核实。'] };
    } } });
    assert.equal(calls, 1, 'complete answer text can still be analyzed for brand mention');
    assert.equal(result.audit?.mention, 'yes');
    assert.equal(result.audit?.citation, 'unknown');
    assert.equal(result.status, 'needs_review');
    assert.equal(result.citationSource, citationSource);
    assert.deepEqual(result.audit?.officialUrls, []);
  }
});

test('question identity, original wording, source URLs and credential-bearing raw input are validated before storage', async () => {
  const original = input();
  for (const changed of [
    { query: original.query + ' ' }, { questionId: 'missing' }, { batchId: 'another-batch' },
    { projectId: 'sample-project-two' },
  ]) await assert.rejects(ingestBrowserObservation({ ...original, ...changed }), { status: 409 });
  const invalid = [
    { captureId: '../../outside' }, { entryType: 'api_answer' }, { recordedAt: 'yesterday' },
    { pageUrl: 'bad-url' }, { pageUrl: 'https://evil.example/c/capture' },
    { sources: [{ title: 'unsafe', url: 'javascript:alert(1)' }] },
    { raw: { headers: { Authorization: 'secret' } } },
    { conditions: { mode: 'search', loginState: 'unknown' } },
    { citationSource: undefined }, { citationSource: 'organic_search' },
  ];
  for (const changed of invalid) assert.equal(browserObservationSchema.safeParse({ ...original, ...changed }).success, false);
  assert.equal(listResearchRuns(original.projectId).length, 0);
  assert.equal(fs.existsSync(path.join(temporary, 'data', 'geo-evidence')), false);
  const deferredBatch = readLatestResearch('sample-project-two')!;
  const deferred = deferredBatch.deferredQuestions[0];
  await assert.rejects(ingestBrowserObservation({ ...original, projectId: deferredBatch.projectId,
    batchId: deferredBatch.id, questionId: deferred.id, query: deferred.zh }), { status: 409 });
});

test('local mutation requires literal loopback Host, matching Origin, and JSON', () => {
  const headers = { host: '127.0.0.1:4327', origin: 'http://127.0.0.1:4327', 'content-type': 'application/json' };
  const request = (changes: Record<string, string> = {}) => new Request('http://localhost:4327/api/geo/browser-observations', { method: 'POST', headers: { ...headers, ...changes } });
  assert.doesNotThrow(() => requireBrowserCollectionRequest(request(), true));
  const rejected: Array<Record<string, string>> = [{ host: 'example.com' }, { host: '127.0.0.1.evil.test' }, { origin: '' },
    { origin: 'https://example.com' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }];
  for (const changes of rejected) {
    assert.throws(() => requireBrowserCollectionRequest(request(changes), true), { status: 403 });
  }
});

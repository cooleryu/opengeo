import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { analyzeResearchObservation } from './answer-audit';
import type { GeoStructuredModel } from './connection-settings';
import type { AnswerAuditRecord } from './overview-metrics';
import type { CollectedAnswer } from './providers/types';
import type { ResearchBatch, ResearchObservation } from './research-types';
import { getSeed } from './seed';
import { withGeoProject } from './projects';

const official = 'https://github.com/example/sample-project';
const text = 'SampleProject 是 example 的编码 Agent 证据管理项目。';
const observation = (changes: Partial<ResearchObservation> = {}): ResearchObservation => ({
  engine: 'qwen', entryType: 'api_answer', language: 'zh', query: '有哪些编码 Agent 证据管理项目？',
  recordedAt: '2026-10-28T08:00:00.000Z', status: 'found', summary: '已采集', conditions: 'API',
  sources: [], evidencePath: 'data/geo-evidence/answer-run/raw.json',
  answerPath: 'data/geo-evidence/answer-run/answer.json', ...changes,
});
const batch = (item: ResearchObservation, projectId = 'sample-project'): ResearchBatch => ({
  id: 'audit-test-batch', projectId, date: '2026-10-28', productSummary: '', contributionSummary: '',
  scopeNote: '', reportPath: '', sourceAuditPath: '', reviewPath: '', deferredQuestions: [], nextStep: '',
  questions: [{ id: 'q1', zh: item.query, en: 'Which coding agent evidence projects exist?',
    decision: 'search_now', valueReason: '', evidenceBasis: '', answerability: '', gaps: [],
    decisionReason: '', reviewPath: '', observations: [item], diagnosis: { observed: '', hypothesis: '', nextStep: '' } }],
});
const answer = (changes: Partial<CollectedAnswer> = {}): CollectedAnswer => ({
  text, citations: [{ url: official, title: 'SampleProject' }], sources: [], searchPerformed: true, usage: {},
  evidence: { answerComplete: true, citationsComplete: true, citationSource: 'native' }, ...changes,
});
const positive = () => ({
  mention: 'yes', citation: 'yes', mentionEvidence: '正文明确介绍项目及所有者。',
  citationEvidence: '原生引用指向项目仓库。', officialUrls: [official], answerComplete: true,
  limitations: [], mentionQuote: text, identity: 'matched',
});
const negative = () => ({
  mention: 'no', citation: 'no', mentionEvidence: '完整正文没有项目名称或别名。',
  citationEvidence: '完整原生引用列表没有自有链接。', officialUrls: [], answerComplete: true,
  limitations: [], mentionQuote: '', identity: 'absent',
});

let temporary: string;
let previousEnvironment: Array<[string, string | undefined]>;
const previousFetch = globalThis.fetch;
const envNames = ['DATA_DIR', 'OPENGEO_LLM_MODEL', 'OPENGEO_LLM_API_KEY', 'OPENGEO_LLM_BASE_URL', 'OPENGEO_VANE_PROVIDER_ID'];
beforeEach(() => {
  previousEnvironment = envNames.map((name) => [name, process.env[name]]);
  for (const name of envNames) delete process.env[name];
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-answer-audit-'));
  process.env.DATA_DIR = temporary;
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
});
afterEach(() => {
  globalThis.fetch = previousFetch;
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function review(result: unknown, collected = answer(), item = observation(), projectId = 'sample-project') {
  const saved: AnswerAuditRecord[] = [];
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async (input) => {
    calls += 1;
    assert.equal(input.messages.length, 2);
    const skill = fs.readFileSync(path.join(process.cwd(), 'skills/answer-evidence-review/SKILL.md'), 'utf8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
    assert.equal(input.messages[0].content, skill, 'the model receives the actual Skill body');
    assert.equal(JSON.stringify(input.messages).includes('markdown'), false, 'does not send full project assets');
    return result;
  } };
  const record = await analyzeResearchObservation(batch(item, projectId), 'q1', item, collected,
    { model, persist: (record) => saved.push(record) });
  assert.deepEqual(saved, [record]);
  assert.equal(calls, 1);
  return record;
}

test('valid positive and negative audits bind to the exact observation and remain independent', async () => {
  const item = observation();
  const yes = await review(positive(), answer(), item);
  assert.equal(yes.analysisStatus, 'complete');
  assert.equal(yes.method, 'model');
  assert.equal(yes.mention, 'yes');
  assert.equal(yes.citation, 'yes');
  assert.equal(yes.evidencePath, item.answerPath);
  assert.equal(yes.recordedAt, item.recordedAt);
  assert.equal(yes.projectId, 'sample-project');
  assert.equal(yes.batchId, 'audit-test-batch');
  assert.equal(yes.questionId, 'q1');
  assert.equal(yes.engine, 'qwen');
  assert.equal(yes.language, 'zh');
  assert.equal(yes.schemaVersion, 1);
  assert.ok(Number.isFinite(Date.parse(yes.reviewedAt!)));
  assert.ok(yes.mentionEvidence.includes(text));

  const withoutName = answer({ text: '可以从已列出的工具开始调查。', citations: [] });
  const no = await review(negative(), withoutName, observation({ answerPath: undefined }));
  assert.equal(no.analysisStatus, 'complete');
  assert.equal(no.mention, 'no');
  assert.equal(no.citation, 'no');
  assert.equal(no.evidencePath, item.evidencePath);
  const mentionOnly = await review({ ...positive(), citation: 'no', officialUrls: [],
    citationEvidence: '平台完整引用列表为空。' }, answer({ citations: [] }));
  assert.equal(mentionOnly.mention, 'yes');
  assert.equal(mentionOnly.citation, 'no');
  const citationOnly = await review({ ...negative(), citation: 'yes', officialUrls: [official],
    citationEvidence: '原生引用指向仓库。' }, { ...withoutName, citations: answer().citations });
  assert.equal(citationOnly.mention, 'no');
  assert.equal(citationOnly.citation, 'yes');
});

test('a Qwen answer that cannot identify the named project saves a confirmed non-mention', async () => {
  const unrecognized = '由于 "SampleProject" 未在任何参考资料中被定义，无法提供其官方仓库和使用文档。';
  const record = await review({ ...negative(), identity: 'unrecognized', mentionQuote: unrecognized,
    mentionEvidence: '回答只是复述名称，并明确无法识别项目或提供其官方资料。' },
  answer({ text: unrecognized, citations: [] }));

  assert.equal(record.analysisStatus, 'complete');
  assert.equal(record.method, 'model');
  assert.equal(record.mention, 'no');
  assert.equal(record.citation, 'no');
  assert.equal(record.answerComplete, true);
  assert.ok(record.mentionEvidence.includes(unrecognized));
});

test('unrecognized identity cannot confirm a mention or omit a verbatim named quote', async () => {
  const unrecognized = '我不知道 SampleProject 是什么项目，无法提供其官方仓库。';
  const collected = answer({ text: unrecognized, citations: [] });
  const result = { ...negative(), identity: 'unrecognized', mentionQuote: unrecognized,
    mentionEvidence: '回答明确表示不知道该项目。' };
  for (const invalid of [
    { ...result, mention: 'yes' },
    { ...result, mentionQuote: '' },
    { ...result, mentionQuote: '我找不到 SampleProject 的官方仓库。' },
    { ...result, mentionQuote: '无法提供其官方仓库。' },
  ]) {
    const record = await review(invalid, collected);
    assert.equal(record.analysisStatus, 'failed');
    assert.equal(record.mention, 'unknown');
    assert.equal(record.citation, 'unknown');
  }
});

test('a correctly identified project remains mentioned when the answer criticizes or does not recommend it', async () => {
  const criticism = `${text}但我不知道它是否适合大型团队，也不推荐未经验证就用于生产。`;
  const record = await review({ ...positive(), mentionQuote: criticism,
    mentionEvidence: '回答正确识别项目和所有者；对适用性有疑问并不推荐生产使用。',
    citation: 'no', officialUrls: [], citationEvidence: '完整原生引用列表为空。' },
  answer({ text: criticism, citations: [] }));

  assert.equal(record.analysisStatus, 'complete');
  assert.equal(record.mention, 'yes');
  assert.equal(record.citation, 'no');
  assert.ok(record.mentionEvidence.includes(criticism));
});

test('a deferred question in the same batch reaches the model and saves its audit', async () => {
  const item = observation();
  const current = batch(item);
  current.deferredQuestions = current.questions;
  current.questions = [];
  const saved: AnswerAuditRecord[] = [];
  let calls = 0;
  const result = await analyzeResearchObservation(current, 'q1', item, answer(), {
    model: { generateObject: async () => { calls += 1; return positive(); } },
    persist: (audit) => saved.push(audit),
  });
  assert.equal(calls, 1);
  assert.equal(result.analysisStatus, 'complete');
  assert.equal(result.mention, 'yes');
  assert.equal(result.citation, 'yes');
  assert.equal(result.questionId, 'q1');
  assert.equal(result.batchId, current.id);
  assert.deepEqual(saved, [result]);
});

test('every omitted field, wrong field type, and identity injection fails closed', async () => {
  for (const key of Object.keys(positive())) {
    const missing: Record<string, unknown> = { ...positive() };
    delete missing[key];
    const badType = { ...positive(), [key]: null };
    for (const invalid of [missing, badType]) {
      const record = await review(invalid);
      assert.equal(record.analysisStatus, 'failed', key);
      assert.equal(record.mention, 'unknown', key);
      assert.equal(record.citation, 'unknown', key);
      assert.equal(record.answerComplete, false, key);
      assert.ok(record.limitations?.length, key);
    }
  }
  for (const invalid of [
    { ...positive(), projectId: 'sample-project-two' },
    { ...positive(), mentionEvidence: ' ' },
    { ...positive(), citationEvidence: 'x'.repeat(1201) },
  ]) assert.equal((await review(invalid)).analysisStatus, 'failed');
});

test('invented quotes, sources posing as citations, foreign URLs and inconsistent negatives are rejected', async () => {
  for (const [result, collected] of [
    [{ ...positive(), mentionQuote: '正文里不存在的 SampleProject。' }, answer()],
    [{ ...positive(), mentionQuote: 'example' }, answer()],
    [positive(), answer({ citations: [], sources: [{ url: official, title: 'Search result' }] })],
    [{ ...positive(), officialUrls: ['https://example.com/SampleProject'] }, answer()],
    [{ ...positive(), citation: 'no', officialUrls: [] }, answer()],
    [{ ...negative() }, answer({ citations: [] })],
  ] as Array<[unknown, CollectedAnswer]>) {
    const record = await review(result, collected);
    assert.equal(record.analysisStatus, 'failed');
    assert.equal(record.mention, 'unknown');
    assert.equal(record.citation, 'unknown');
  }
  const homonym = 'SampleProject 是 Alice Writer 与 Bob Researcher 的论文。';
  assert.equal((await review({ ...positive(), mentionQuote: homonym }, answer({ text: homonym }))).analysisStatus, 'failed');
  const excluded = await review({ ...negative(), identity: 'excluded', mentionQuote: homonym,
    mentionEvidence: '只有已知同名论文，作者与本项目不符。' }, answer({ text: homonym, citations: [] }));
  assert.equal(excluded.mention, 'no');
  assert.equal(excluded.analysisStatus, 'complete');
  const mixed = await review({ ...negative(), identity: 'excluded', mentionQuote: homonym },
    answer({ text: `${homonym}\n${text}`, citations: [] }));
  assert.equal(mixed.analysisStatus, 'failed');
});

test('correct project identification can explicitly distinguish a known homonym', async () => {
  for (const clarification of [
    'SampleProject 是 example 的编码 Agent 证据管理项目，不是 Alice Writer 的同名论文。',
    'SampleProject is a coding agent evidence project by example. It is not the paper by Alice Writer.',
    `SampleProject 的官方仓库是 ${official}，不是 Alice Writer 的同名论文。`,
  ]) {
    const record = await review({ ...positive(), mentionQuote: clarification,
      mentionEvidence: '回答给出本项目的明确身份，并澄清与同名论文的区别。',
      citation: 'no', officialUrls: [], citationEvidence: '完整原生引用列表为空。' },
    answer({ text: clarification, citations: [] }));
    assert.equal(record.analysisStatus, 'complete');
    assert.equal(record.mention, 'yes');
    assert.equal(record.citation, 'no');
  }
  const foreign = 'SampleProject 是 Alice Writer 的论文，资料见 https://example.com/example。';
  const rejected = await review({ ...positive(), mentionQuote: foreign,
    citation: 'no', officialUrls: [], citationEvidence: '完整原生引用列表为空。' },
  answer({ text: foreign, citations: [] }));
  assert.equal(rejected.analysisStatus, 'failed');
  assert.equal(rejected.mention, 'unknown');
});

test('a model-confirmed different homonym need not appear in the predefined exclusion', async () => {
  const homonym = 'SampleProject 是 Acme Vision 开发的医学影像分类工具，官网是 https://acme-vision.example/SampleProject。';
  const result = { ...negative(), identity: 'excluded', mentionQuote: homonym,
    mentionEvidence: '回答介绍的是开发者、领域和官网均不相符的同名工具。' };
  const collected = answer({ text: homonym, citations: [] });
  const record = await review(result, collected);
  assert.equal(record.analysisStatus, 'complete');
  assert.equal(record.mention, 'no');
  for (const mentionQuote of ['', 'SampleProject 是其他公司的项目。', 'Acme Vision 开发的医学影像分类工具']) {
    const rejected = await review({ ...result, mentionQuote }, collected);
    assert.equal(rejected.analysisStatus, 'failed');
    assert.equal(rejected.mention, 'unknown');
  }
});

test('unknowns require reasons and remain pending; model-declared incomplete answers cannot become negatives', async () => {
  const unknown = { ...negative(), mention: 'unknown', citation: 'unknown', identity: 'ambiguous',
    mentionEvidence: '名称的上下文不足以区分项目与同名对象。', citationEvidence: '引用归属尚有歧义。',
    limitations: ['需要人工核实项目身份。'] };
  const record = await review(unknown);
  assert.equal(record.analysisStatus, 'needs_review');
  assert.equal(record.answerComplete, true);
  assert.equal(record.mention, 'unknown');
  assert.equal(record.citation, 'unknown');
  assert.equal((await review({ ...unknown, limitations: [] })).analysisStatus, 'failed');
  assert.equal((await review({ ...negative(), answerComplete: false,
    limitations: ['模型认为正文截断。'] }, answer({ text: '其他工具', citations: [] }))).analysisStatus, 'failed');
});

test('missing, incomplete and oversized evidence skips the model; web search is not applicable', async () => {
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async () => { calls += 1; return positive(); } };
  for (const collected of [undefined, answer({ text: '' }), answer({ evidence: undefined }),
    answer({ evidence: { answerComplete: true, citationsComplete: false, citationSource: 'native' } }),
    answer({ evidence: { answerComplete: false, citationsComplete: true, citationSource: 'native' } }),
    answer({ text: '汉'.repeat(11_000) }),
    answer({ citations: [{ url: 'javascript:alert(1)', title: 'invalid' }] }),
  ]) {
    const item = observation();
    const saved: AnswerAuditRecord[] = [];
    const result = await analyzeResearchObservation(batch(item), 'q1', item, collected, { model, persist: (audit) => saved.push(audit) });
    assert.equal(result.analysisStatus, 'needs_review');
    assert.equal(result.mention, 'unknown');
    assert.equal(result.citation, 'unknown');
    assert.deepEqual(saved, [result]);
  }
  for (const entryType of ['web_search', 'api_search'] as const) {
    const item = observation({ entryType });
    const result = await analyzeResearchObservation(batch(item), 'q1', item, answer(), { model, persist: () => {} });
    assert.equal(result.analysisStatus, 'not_applicable');
    assert.equal(result.citation, 'unknown');
  }
  assert.equal(calls, 0);
});

test('unavailable configuration and model failures save safe unknowns once; persistence errors escape', async () => {
  const item = observation();
  const unavailable = await analyzeResearchObservation(batch(item), 'q1', item, answer(), { persist: () => {} });
  assert.equal(unavailable.method, 'unavailable');
  assert.equal(unavailable.analysisStatus, 'needs_review');
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async () => {
    calls += 1;
    throw new Error('secret-test-key https://private.test/v1?credential=secret');
  } };
  const failed = await analyzeResearchObservation(batch(item), 'q1', item, answer(), { model, persist: () => {} });
  assert.equal(calls, 1);
  assert.equal(failed.analysisStatus, 'failed');
  assert.equal(failed.mention, 'unknown');
  assert.equal(failed.citation, 'unknown');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal(JSON.stringify(failed).includes('private.test'), false);
  const persistenceError = new Error('storage unavailable');
  await assert.rejects(analyzeResearchObservation(batch(item), 'q1', item, answer(), {
    model: { generateObject: async () => positive() }, persist: () => { throw persistenceError; },
  }), (error) => error === persistenceError);
});

test('enabled ChatGPT automatic audits use Terra Max and never fall back to the retained DeepSeek connection', async () => {
  const privateDirectory = path.join(temporary, 'data/chatgpt-private');
  fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(privateDirectory, 'connection.json'), JSON.stringify({
    version: 1, hostId: 'synthetic-audit-host', enabled: true,
    model: 'gpt-6.1-terra', reasoningEffort: 'max',
    registration: { clientId: 'oaiapp_synthetic_audit', subject: 'synthetic-subject', email: 'synthetic@example.test' },
    credentials: { accessToken: 'synthetic-audit-access', refreshToken: 'synthetic-audit-refresh',
      idToken: 'synthetic-audit-identity', expiresAt: Date.now() + 3600_000, scopes: ['chatgpt.tokens.use.direct'] },
  }), { mode: 0o600 });
  const settingsFile = path.join(temporary, 'data/geo-settings.json');
  const deepseekSettings = JSON.stringify({ version: 1, model: { provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1', model: 'synthetic-deepseek', apiKey: 'synthetic-deepseek-key' } });
  fs.writeFileSync(settingsFile, deepseekSettings, { mode: 0o600 });

  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let modelResult: unknown = positive();
  let requestFails = false;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected synthetic audit endpoint');
    if (requestFails) return Response.json({ error: { message: 'synthetic-private-error' } }, { status: 500 });
    const event = { type: 'response.completed', response: {
      id: 'resp_synthetic_audit', status: 'completed', model: 'gpt-6.1-terra',
      output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify(modelResult) }] }],
    } };
    return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const item = observation();
  const saved: AnswerAuditRecord[] = [];
  const audit = () => analyzeResearchObservation(batch(item), 'q1', item, answer(), { persist: (record) => saved.push(record) });
  const result = await audit();
  assert.equal(result.analysisStatus, 'complete');
  assert.equal(result.analysisModel, 'gpt-6.1-terra');
  assert.equal(result.reasoningEffort, 'max');
  assert.equal(result.method, 'model');
  assert.equal(result.mention, 'yes');
  assert.equal(result.citation, 'yes');
  assert.equal(result.answerComplete, true);
  assert.deepEqual(result.officialUrls, [official]);
  assert.ok(result.mentionEvidence.includes(text));
  assert.deepEqual(saved, [result]);
  assert.equal(requests.length, 1);

  const { mentionQuote: _requiredQuote, ...missingField } = positive();
  for (const invalid of [missingField, { ...positive(), mentionQuote: 'SampleProject 的虚构正文。' }]) {
    modelResult = invalid;
    const failed = await audit();
    assert.equal(failed.analysisStatus, 'failed');
    assert.equal(failed.mention, 'unknown');
    assert.equal(failed.citation, 'unknown');
  }
  requestFails = true;
  const failed = await audit();
  assert.equal(failed.analysisStatus, 'failed');
  assert.equal(failed.mention, 'unknown');
  assert.equal(failed.citation, 'unknown');
  assert.equal(JSON.stringify(failed).includes('synthetic-private-error'), false);
  assert.equal(requests.length, 4, 'each audit sends one request, without retry or provider fallback');
  assert.equal(saved.length, 4, 'both successful and failed audits are persisted');
  for (const request of requests) {
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    assert.equal(new Headers(request.init?.headers).get('authorization'), 'Bearer synthetic-audit-access');
    const body = JSON.parse(String(request.init?.body));
    assert.equal(body.model, 'gpt-6.1-terra');
    assert.deepEqual(body.reasoning, { effort: 'max' });
    assert.equal(body.stream, true);
  }
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), deepseekSettings, 'DeepSeek settings are preserved');
});

test('published owned assets are accepted exactly and project scope does not leak from the caller', async () => {
  const seed = withGeoProject('sample-project', getSeed);
  const externalAsset = seed.assets.find((asset) => asset.status === 'published' && asset.publicUrl?.startsWith('https://social.example/'))!;
  assert.ok(externalAsset);
  const url = externalAsset.publicUrl!;
  const owned = await review({ ...positive(), officialUrls: [url] }, answer({ citations: [{ url, title: externalAsset.title }] }));
  assert.equal(owned.citation, 'yes');
  const foreign = `${url}-other`;
  assert.equal((await review({ ...positive(), officialUrls: [foreign] },
    answer({ citations: [{ url: foreign, title: 'Different post' }] }))).analysisStatus, 'failed');

  const item = observation({ language: 'en', query: 'Which workflow recording tool can I run locally?' });
  const replayUrl = 'https://github.com/example/sample-project-two';
  const replayText = 'sample-project-two is example’s local workflow recording tool.';
  const result = await withGeoProject('sample-project', () => review({ ...positive(), mentionQuote: replayText, officialUrls: [replayUrl] },
    answer({ text: replayText, citations: [{ url: replayUrl, title: 'Workflow tool' }] }), item, 'sample-project-two'));
  assert.equal(result.projectId, 'sample-project-two');
  assert.equal(result.mention, 'yes');
  assert.equal(result.citation, 'yes');
  assert.equal(result.language, 'en');
});

import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { analyzeCompetitorCandidates, getCompetitorCandidates, updateCompetitorCandidate } from './competitor-candidates';
import { analyzePreparedCompetitors, parseCompetitorAssessment, prepareCompetitorAnalysis, rankCompetitorCandidates, readActiveCompetitorAnalysis, readDisplayedCompetitorAnalysis, type PreparedCompetitorAnalysis } from './competitor-analysis';
import { getCompetitorSelection, readCompetitorAnalysis, readStoredCompetitors, saveCompetitorAnalysis, saveStoredCompetitor, competitorCandidateId } from './competitor-store';
import { getResearchBatch, getLatestResearch } from './research';
import { getSeed } from './seed';
import { projectDataDirectory, withGeoProject } from './projects';
import type { CompetitorCandidate, CompetitorRankingScope } from './competitor-types';
import type { GeoStructuredModel } from './connection-settings';
import type { MetricSummary } from './overview-metrics';

function modelResult(input: PreparedCompetitorAnalysis['input']) {
  return { summary: '依据现有记录对照共同需求与学习价值。', assessments: input.candidates.map((candidate) => ({
    candidateId: candidate.id, recommended: true, description: '提供与当前研究问题相关的工具与方法。', reason: '现有同题证据提供了具体可对照的实现。',
    strengths: ['现有记录描述了具体的使用方式。'],
    opportunities: [{ questionId: candidate.evidence[0].questionId, title: '补齐可验证的使用案例', observed: '已保存记录包含此对象。',
      hypothesis: '具体案例可能有助于解释适用范围，仍需验证。', action: '为该问题补充可复现的案例并复测。', evidenceIds: [candidate.evidence[0].id] }],
    limitations: ['仅依据当前采集记录，不代表真实效果。'], quotes: [{ evidenceId: candidate.evidence[0].id, quote: candidate.evidence[0].excerpt.slice(0, 80) }],
  })) };
}
const fakeModel = (counter?: { calls: number }): GeoStructuredModel => ({
  async generateObject(input) { if (counter) counter.calls++; return modelResult(JSON.parse(input.messages[1].content as string)); },
});

test('AI recommendations are limited to three, reused, isolated, and never change selection or original records', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-analysis-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    await withGeoProject('sample-project', async () => {
      const batch = getLatestResearch('sample-project')!;
      const original = JSON.stringify(getResearchBatch('sample-project', batch.id));
      const counter = { calls: 0 };
      assert.deepEqual(getCompetitorCandidates().candidates, []);
      const model: GeoStructuredModel = { async generateObject(input) {
        const directory = path.join(process.cwd(), 'skills/competitor-analysis');
        const instructions = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')
          .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
        const parameters = JSON.parse(fs.readFileSync(path.join(directory, 'parameters.json'), 'utf8'));
        assert.equal(input.messages[0].content, instructions);
        assert.deepEqual(input.options, { temperature: parameters.temperature, maxTokens: parameters.maxTokens });
        return fakeModel(counter).generateObject(input);
      } };
      const ready = await analyzeCompetitorCandidates(batch.id, { model });
      assert.equal(ready.analysis.status, 'ready');
      assert.ok(ready.candidates.length > 0 && ready.candidates.length <= 3);
      assert.equal(ready.analysis.summary, ready.ranking!.reason);
      assert.equal(counter.calls, 1);
      assert.ok(ready.candidates.every((candidate) => candidate.analysis?.scores === undefined));
      assert.ok(ready.candidates.every((candidate) => candidate.recommendation?.reason !== candidate.analysis?.reason));
      for (const candidate of ready.candidates) {
        const evidence = candidate.recommendation!.evidence!;
        const preview = getCompetitorCandidates(batch.id, candidate.id);
        assert.equal(evidence.batchId, batch.id);
        assert.ok(preview.comparison?.rows.some((row) => row.questionId === evidence.questionId &&
          row.observationIndex === evidence.observationIndex && row.engine === evidence.engine &&
          row.language === evidence.language && row.targetMention.status === 'matched'));
      }
      const id = ready.candidates[0].id;
      getCompetitorCandidates(batch.id, id);
      assert.equal(getCompetitorSelection(), null);
      const selected = updateCompetitorCandidate('select', id, batch.id);
      assert.equal(selected.selectedCandidate?.id, id);
      assert.ok(selected.selectedCandidate?.analysis?.description);
      assert.ok(selected.comparison?.rows.length);
      const baseline = JSON.stringify(getCompetitorSelection());
      const chinese = getCompetitorCandidates(batch.id, undefined, { language: 'zh', engine: 'chatgpt' });
      const english = getCompetitorCandidates(batch.id, undefined, { language: 'en', engine: 'qwen' });
      assert.deepEqual(chinese.ranking?.scope, { language: 'zh', engine: 'chatgpt' });
      assert.deepEqual(english.ranking?.scope, { language: 'en', engine: 'qwen' });
      assert.equal(JSON.stringify(getCompetitorSelection()), baseline);
      assert.equal(counter.calls, 1);
      updateCompetitorCandidate('select', id, batch.id);
      await analyzeCompetitorCandidates(batch.id, { model: fakeModel(counter) });
      assert.equal(counter.calls, 1);
      assert.equal(JSON.stringify(getCompetitorSelection()), baseline);
      assert.equal(JSON.stringify(getResearchBatch('sample-project', batch.id)), original);
      assert.ok(readStoredCompetitors().length >= 3);
      const dbPath = path.join(projectDataDirectory(), 'db.sqlite');
      assert.ok(fs.existsSync(dbPath));
    });
    withGeoProject('sample-project-two', () => {
      assert.equal(getCompetitorSelection(), null);
      assert.equal(readStoredCompetitors().length, 0);
      assert.equal(getCompetitorCandidates().analysis.status, 'pending');
    });
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('failed AI produces no scores or heuristic ranking and retries only with explicit force', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-failure-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    let calls = 0;
    const model: GeoStructuredModel = { async generateObject() { calls++; throw new Error('secret provider body'); } };
    const failed = await analyzeCompetitorCandidates(undefined, { model });
    assert.equal(failed.analysis.status, 'failed');
    assert.deepEqual(failed.candidates, []);
    assert.equal(JSON.stringify(failed).includes('secret provider body'), false);
    await analyzeCompetitorCandidates(undefined, { model });
    assert.equal(calls, 1);
    const ready = await analyzeCompetitorCandidates(undefined, { force: true, model: fakeModel() });
    assert.equal(ready.analysis.status, 'ready');
    assert.ok(ready.candidates.length <= 3);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function preparedFixture(): PreparedCompetitorAnalysis {
  const project = getSeed().project;
  const url = 'https://github.com/example/tool';
  const candidate: CompetitorCandidate = { id: competitorCandidateId(project.id, url), name: 'Tool', aliases: [], officialUrls: [url],
    description: '', reason: '', saved: false, questions: [{ evidenceId: 'evidence-1', batchId: 'test', questionId: 'Q1', question: 'Which tool?', engine: 'chatgpt', language: 'en',
      recordedAt: '2026-10-29T00:00:00Z', evidencePath: 'one.md', observationIndex: 0, sourceUrl: url, excerpt: 'Tool provides a repeatable comparison of context reduction.' }] };
  return prepareCompetitorAnalysis(project, 'test', [candidate], new Map());
}

test('new fifth evidence refreshes the key while only the newest four excerpts enter the prompt', () => {
  const candidate = structuredClone(preparedFixture().candidates[0]);
  const original = candidate.questions[0];
  candidate.questions = Array.from({ length: 4 }, (_, index) => ({ ...original,
    evidenceId: `evidence-${index + 1}`, questionId: `Q${index + 1}`, observationIndex: index,
    recordedAt: 'historical observation window', collectedAt: `2026-10-29T0${index + 1}:00:00Z`,
  }));
  const prepare = () => prepareCompetitorAnalysis(getSeed().project, 'test', [candidate], new Map());
  const before = prepare();
  candidate.questions.push({ ...original, evidenceId: 'evidence-5', questionId: 'Q5', observationIndex: 4,
    recordedAt: 'a later captured answer', collectedAt: '2026-10-29T05:00:00Z' });
  const fifth = prepare();
  assert.notEqual(fifth.inputKey, before.inputKey);
  assert.deepEqual(fifth.input.candidates[0].evidence.map((item) => item.questionId), ['Q5', 'Q4', 'Q3', 'Q2']);
  candidate.questions.push({ ...original, evidenceId: 'evidence-6', questionId: 'Q6', observationIndex: 5,
    recordedAt: 'late import of an older observation', collectedAt: '2026-10-28T01:00:00Z' });
  const omitted = prepare();
  assert.deepEqual(omitted.input, fifth.input);
  assert.notEqual(omitted.inputKey, fifth.inputKey);
});

test('same full evidence migrates a ready legacy cache without a model call or metadata-only invalidation', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-cache-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const legacyPrepared = preparedFixture();
    const legacy = parseCompetitorAssessment(modelResult(legacyPrepared.input), legacyPrepared);
    saveCompetitorAnalysis({ ...legacy, inputKey: legacyPrepared.legacyInputKey });
    const candidate = structuredClone(legacyPrepared.candidates[0]);
    candidate.questions[0].collectedAt = candidate.questions[0].recordedAt;
    const current = prepareCompetitorAnalysis(getSeed().project, 'test', [candidate], new Map());
    assert.equal(current.legacyInputKey, legacyPrepared.legacyInputKey);
    assert.notEqual(current.inputKey, legacyPrepared.legacyInputKey);
    const counter = { calls: 0 };
    const reused = await analyzePreparedCompetitors(current, { model: fakeModel(counter) });
    assert.equal(counter.calls, 0);
    assert.equal(reused.state.status, 'ready');
    assert.equal(reused.state.generatedAt, legacy.state.generatedAt);
    assert.equal(reused.inputKey, current.inputKey);
    assert.deepEqual(reused.candidates, legacy.candidates);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('schema, candidate IDs, quotes and question IDs are validated without generating assessment scores', () => {
  const prepared = preparedFixture();
  const valid = modelResult(prepared.input);
  assert.match(parseCompetitorAssessment(valid, prepared).state.summary, /尚无.*推荐参照/);
  assert.throws(() => parseCompetitorAssessment({ ...valid, extra: true }, prepared));
  const unknown = structuredClone(valid);
  unknown.assessments[0].candidateId = 'unknown';
  assert.throws(() => parseCompetitorAssessment(unknown, prepared));
  const badQuote = structuredClone(valid);
  badQuote.assessments[0].quotes[0].quote = 'Not in the stored evidence';
  assert.throws(() => parseCompetitorAssessment(badQuote, prepared));
  const badEvidence = structuredClone(valid);
  badEvidence.assessments[0].quotes[0].evidenceId = 'unknown';
  assert.throws(() => parseCompetitorAssessment(badEvidence, prepared));
  const badQuestion = structuredClone(valid);
  badQuestion.assessments[0].opportunities[0].questionId = 'Q2';
  assert.throws(() => parseCompetitorAssessment(badQuestion, prepared));
  assert.equal(parseCompetitorAssessment(valid, prepared).candidates[0].analysis?.recommended, true);
  assert.equal(parseCompetitorAssessment(valid, prepared).candidates[0].analysis?.scores, undefined);
  assert.throws(() => parseCompetitorAssessment({ ...valid, assessments: valid.assessments.map((item) => ({
    ...item, scores: { relevance: 100, evidence: 100, learning: 100, visibility: 100 },
  })) }, prepared));
});

const observedMetric = (yes: number, no: number, unknown = 0, unmeasured = 0): MetricSummary => ({
  yes, no, unknown, unmeasured, completed: yes + no + unknown, questions: yes + no + unknown + unmeasured,
  rate: unknown || !yes && !no ? null : yes / (yes + no) * 100,
  minimumRate: yes + no + unknown ? yes / (yes + no + unknown) * 100 : null,
});

function rankedFixture(id: string, legacyScore: number, scopeMetrics: Record<string, { mention: MetricSummary; citation?: MetricSummary }>): CompetitorCandidate {
  const prepared = preparedFixture();
  const candidate = parseCompetitorAssessment(modelResult(prepared.input), prepared).candidates[0];
  return { ...candidate, id, name: id, analysis: { ...candidate.analysis!, scores: {
    relevance: legacyScore, evidence: legacyScore, learning: legacyScore, visibility: legacyScore, total: legacyScore,
  } }, performance: { ownName: 'Own', targetName: id, scopes: Object.fromEntries(Object.entries(scopeMetrics).map(([scope, metrics]) => [scope, {
    metrics: [
      { id: 'mention', label: 'AI 提及率', target: metrics.mention, own: observedMetric(0, metrics.mention.completed) },
      ...(metrics.citation ? [{ id: 'citation', label: '官方引用率', target: metrics.citation, own: observedMetric(0, metrics.citation.completed) }] : []),
    ],
  }])) } };
}

function rankTestCandidates(candidates: CompetitorCandidate[], scope: CompetitorRankingScope = { language: 'zh', engine: 'all' }) {
  return rankCompetitorCandidates(candidates, scope, new Map(candidates.map((candidate) => [candidate.id, {
    batchId: 'test', questionId: 'Q1', question: 'Which tool?', language: scope.language,
    engine: scope.engine === 'all' ? 'chatgpt' as const : scope.engine, observationIndex: 0,
  }])));
}

test('all reviewed candidates are ranked by scoped observations before the three-card limit, ignoring legacy AI scores', () => {
  const candidates = [1, 2, 3, 4].map((index) => rankedFixture(`candidate-${index}`, index === 4 ? 1 : 100, {
    'zh:chatgpt': { mention: observedMetric(index, 4 - index) },
    'en:chatgpt': { mention: observedMetric(5 - index, index - 1) },
    'zh:qwen': { mention: observedMetric(5 - index, index - 1) },
  }));
  const original = JSON.stringify(candidates);
  const chinese = rankTestCandidates(candidates, { language: 'zh', engine: 'chatgpt' });
  assert.deepEqual(chinese.candidates.map((candidate) => candidate.id), ['candidate-4', 'candidate-3', 'candidate-2']);
  assert.equal(chinese.ranking.eligibleCount, 4);
  assert.equal(chinese.ranking.leaderId, 'candidate-4');
  assert.equal(chinese.candidates[0].recommendation?.isLeader, true);
  assert.match(chinese.candidates[0].reason, /4\/4 条回答/);
  assert.match(chinese.candidates[0].reason, /ChatGPT.*Which tool.*明确提及 candidate-4/);
  assert.equal(chinese.candidates[0].recommendation?.evidence?.questionId, 'Q1');
  const english = rankTestCandidates(candidates, { language: 'en', engine: 'chatgpt' });
  const qwen = rankTestCandidates(candidates, { language: 'zh', engine: 'qwen' });
  assert.equal(english.ranking.leaderId, 'candidate-1');
  assert.equal(qwen.ranking.leaderId, 'candidate-1');
  assert.equal(JSON.stringify(candidates), original);
});

test('unverified and zero-hit candidates stay internal without blocking confirmed recommendations', () => {
  const confirmed = rankedFixture('confirmed', 1, { 'zh:all': { mention: observedMetric(1, 3) } });
  const unknown = rankedFixture('unknown', 100, { 'zh:all': { mention: observedMetric(1, 0, 3) } });
  const zero = rankedFixture('zero', 100, { 'zh:all': { mention: observedMetric(0, 4) } });
  const missing = rankedFixture('missing', 100, {});
  const ranked = rankTestCandidates([unknown, zero, missing, confirmed]);
  assert.deepEqual(ranked.candidates.map((candidate) => candidate.id), ['confirmed']);
  assert.equal(ranked.allCandidates.length, 4);
  assert.equal(ranked.ranking.leaderId, undefined);
  assert.doesNotMatch(ranked.candidates[0].reason, /待核实|未测|不能确定/);
  assert.deepEqual(rankTestCandidates([unknown, zero, missing]).candidates, []);
  assert.deepEqual(rankCompetitorCandidates([confirmed]).candidates, []);
  const mismatchedEvidence = new Map([[confirmed.id, { batchId: 'test', questionId: 'Q1', question: 'Which tool?',
    language: 'en' as const, engine: 'chatgpt' as const, observationIndex: 0 }]]);
  assert.deepEqual(rankCompetitorCandidates([confirmed], { language: 'zh', engine: 'all' }, mismatchedEvidence).candidates, []);
  for (const metric of [observedMetric(1, 1), observedMetric(1, 3, 0, 1)]) {
    const different = rankTestCandidates([confirmed, rankedFixture('different', 100, { 'zh:all': { mention: metric } })]);
    assert.equal(different.candidates.length, 2);
    assert.equal(different.ranking.leaderId, undefined);
    assert.ok(different.candidates.every((candidate) => candidate.recommendation?.rank === undefined));
  }
});

test('equal mention rates share rank regardless of old AI scores; only comparable verified citations can break the tie', () => {
  const first = rankedFixture('a', 1, { 'zh:all': { mention: observedMetric(2, 2), citation: observedMetric(1, 3) } });
  const second = rankedFixture('b', 100, { 'zh:all': { mention: observedMetric(2, 2), citation: observedMetric(0, 0, 4) } });
  const tied = rankTestCandidates([second, first]);
  assert.deepEqual(tied.candidates.map((candidate) => candidate.id), ['a', 'b']);
  assert.deepEqual(tied.candidates.map((candidate) => candidate.recommendation?.rank), [1, 1]);
  assert.equal(tied.ranking.leaderId, undefined);
  second.performance!.scopes['zh:all'].metrics[1].target = observedMetric(0, 4);
  const citations = rankTestCandidates([second, first]);
  assert.equal(citations.ranking.leaderId, 'a');
  assert.match(citations.candidates[0].reason, /官方引用率 25%/);
  second.performance!.scopes['zh:all'].metrics[1].target = observedMetric(0, 2);
  assert.equal(rankTestCandidates([second, first]).ranking.leaderId, undefined);
});

test('the same missing planned samples do not prevent comparing the same measured answers', () => {
  const candidates = [
    rankedFixture('a', 1, { 'zh:all': { mention: observedMetric(2, 0, 0, 7) } }),
    rankedFixture('b', 100, { 'zh:all': { mention: observedMetric(1, 1, 0, 7) } }),
  ];
  const ranked = rankTestCandidates(candidates);
  assert.equal(ranked.ranking.status, 'ranked');
  assert.equal(ranked.ranking.leaderId, 'a');
  assert.match(ranked.ranking.reason, /当前已核实的同题回答/);
  assert.doesNotMatch(ranked.candidates[0].reason, /尚未测量/);
  assert.equal(ranked.candidates[0].performance?.scopes['zh:all'].metrics[0].target.unmeasured, 7);
  assert.equal(ranked.allCandidates.length, 2);
});

test('legacy fallback with rejected identities retains references but cannot declare a measured leader before a new relevance review', () => {
  const candidates = [
    rankedFixture('a', 80, { 'zh:all': { mention: observedMetric(4, 0) } }),
    rankedFixture('b', 90, { 'zh:all': { mention: observedMetric(1, 3) } }),
    rankedFixture('c', 40, { 'zh:all': { mention: observedMetric(3, 1) } }),
  ];
  for (const candidate of candidates) candidate.analysis!.version = 'competitor-v1-r40-e30-l20-v10';
  candidates[2].analysis!.recommended = false;
  const legacy = rankTestCandidates(candidates);
  assert.deepEqual(legacy.candidates, []);
  assert.equal(legacy.ranking.status, 'candidate');
  assert.equal(legacy.ranking.leaderId, undefined);
  assert.ok(legacy.allCandidates.every((candidate) => /旧候选资格待新版审核/.test(candidate.recommendation!.reason)));
  assert.ok(legacy.allCandidates.every((candidate) => candidate.recommendation?.rank === undefined && !candidate.recommendation?.isLeader));
  const refreshed = structuredClone(candidates);
  for (const candidate of refreshed) candidate.analysis!.version = 'competitor-v2-relevance-only';
  assert.equal(rankTestCandidates(refreshed).ranking.leaderId, 'a');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-legacy-eligibility-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const batch = getLatestResearch('sample-project')!;
    for (const candidate of candidates) {
      candidate.officialUrls = [`https://example.test/${candidate.name}`];
      candidate.id = competitorCandidateId('sample-project', candidate.officialUrls[0]);
      candidate.questions[0].batchId = batch.id;
    }
    const prepared = prepareCompetitorAnalysis(getSeed().project, batch.id, candidates, new Map());
    saveCompetitorAnalysis({ inputKey: prepared.inputKey, batchId: batch.id, candidates,
      state: { status: 'ready', summary: 'Historical review', generatedAt: new Date().toISOString() } });
    const fallback = getCompetitorCandidates(batch.id);
    assert.equal(fallback.analysis.stale, true);
    assert.equal(fallback.candidates.length, 0);
    assert.equal(fallback.ranking?.status, 'candidate');
    assert.equal(fallback.ranking?.leaderId, undefined);
    assert.match(fallback.ranking!.reason, /尚无.*推荐参照/);
    assert.ok(fallback.candidates.every((candidate) => /旧候选资格待新版审核/.test(candidate.recommendation!.reason)));
    assert.equal(getCompetitorSelection(), null);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('one opportunity cannot combine different engines or languages even for the same question', () => {
  for (const variant of [{ engine: 'qwen' as const }, { language: 'zh' as const }]) {
    const base = preparedFixture();
    const candidate = structuredClone(base.candidates[0]);
    candidate.questions.push({ ...candidate.questions[0], ...variant, evidenceId: 'evidence-2', observationIndex: 1 });
    const prepared = prepareCompetitorAnalysis(getSeed().project, 'test', [candidate], new Map());
    const output = modelResult(prepared.input);
    const evidence = prepared.input.candidates[0].evidence;
    assert.equal(new Set(evidence.map((item) => item.id)).size, 2);
    output.assessments[0].opportunities[0].evidenceIds = evidence.map((item) => item.id);
    output.assessments[0].quotes = evidence.map((item) => ({ evidenceId: item.id, quote: item.excerpt }));
    assert.throws(() => parseCompetitorAssessment(output, prepared), /同一问题、引擎和语言/);
  }
});

test('selected identity stays available but old analysis is not reused for different evidence', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-stale-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    withGeoProject('sample-project', () => {
      const prepared = preparedFixture();
      const candidate = parseCompetitorAssessment(modelResult(prepared.input), prepared).candidates[0];
      saveStoredCompetitor(candidate);
      const result = updateCompetitorCandidate('select', candidate.id);
      assert.equal(result.target?.name, candidate.name);
      assert.equal(result.analysis.status, 'pending');
      assert.equal(result.selectedCandidate?.analysis?.status, 'pending');
      assert.equal(result.selectedCandidate?.analysis?.scores, undefined);
      assert.deepEqual(result.selectedCandidate?.analysis?.opportunities, []);
      assert.equal(readStoredCompetitors()[0].analysis?.status, 'ready');
    });
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('interrupted persisted analysis becomes failed without retry, and legacy JSON choices migrate once', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-migration-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const directory = projectDataDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const prepared = preparedFixture();
    const candidate = prepared.candidates[0];
    const legacy = JSON.stringify({ version: 1, projectId: 'sample-project', candidates: [candidate] });
    fs.writeFileSync(path.join(directory, 'competitor-candidates.json'), legacy);
    fs.writeFileSync(path.join(directory, 'competitor.json'), JSON.stringify({ projectId: 'sample-project', target: { ...candidate, updatedAt: '2026-10-28T00:00:00Z' } }));
    assert.equal(readStoredCompetitors()[0].saved, true);
    assert.equal(getCompetitorSelection()?.candidateId, candidate.id);
    assert.equal(getCompetitorSelection()?.selectedAt, '2026-10-28T00:00:00Z');
    assert.deepEqual(getCompetitorSelection()?.baseline.rows, []);
    assert.equal(fs.readFileSync(path.join(directory, 'competitor-candidates.json'), 'utf8'), legacy);
    saveCompetitorAnalysis({ inputKey: prepared.inputKey, batchId: 'test', ownerPid: process.pid,
      state: { status: 'running', summary: 'running' }, candidates: [] });
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'failed');
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'failed');
    assert.equal(readStoredCompetitors()[0].saved, true);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('GET preserves bounded live requests but expired or unverifiable owners become failed', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-owner-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  const originalKill = process.kill;
  try {
    const prepared = preparedFixture();
    const base = { inputKey: prepared.inputKey, batchId: 'test', state: { status: 'running' as const, summary: 'running', startedAt: new Date().toISOString() }, candidates: [] };
    saveCompetitorAnalysis(base);
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'running');
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'running');
    // Signal 0 only probes process existence; stub it to cover worker ownership
    // without depending on host process visibility or sending any real signal.
    const otherPid = process.pid + 1;
    process.kill = ((pid: number, signal: string | number) => {
      assert.equal(pid, otherPid);
      assert.equal(signal, 0);
      return true;
    }) as typeof process.kill;
    saveCompetitorAnalysis({ ...base, ownerPid: otherPid });
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'running');
    process.kill = (() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); }) as typeof process.kill;
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'running');
    saveCompetitorAnalysis({ ...base, ownerPid: otherPid, expiresAt: '2000-01-01T00:00:00.000Z' });
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'failed');
    saveCompetitorAnalysis({ ...base, state: { status: 'running', summary: 'unknown historical request' } });
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'failed');
    saveCompetitorAnalysis({ ...base, ownerPid: otherPid });
    process.kill = (() => { throw Object.assign(new Error('process ended'), { code: 'ESRCH' }); }) as typeof process.kill;
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'failed');
    assert.equal(readActiveCompetitorAnalysis(prepared)?.state.status, 'failed');
  } finally {
    process.kill = originalKill;
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('GET preserves previous same-batch assessments in preview without recommending an unmeasured identity', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-previous-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const batch = getLatestResearch('sample-project')!;
    const before = JSON.stringify(batch);
    const candidate = structuredClone(preparedFixture().candidates[0]);
    candidate.questions[0].batchId = batch.id;
    const prepared = prepareCompetitorAnalysis(getSeed().project, batch.id, [candidate], new Map());
    const result = parseCompetitorAssessment(modelResult(prepared.input), prepared);
    result.state.generatedAt = '2026-10-28T00:00:00.000Z';
    result.candidates[0].analysis!.generatedAt = result.state.generatedAt;
    saveCompetitorAnalysis(result);
    const displayed = getCompetitorCandidates(batch.id, candidate.id);
    assert.equal(displayed.analysis.status, 'ready');
    assert.equal(displayed.analysis.stale, true);
    assert.equal(displayed.analysis.generatedAt, result.state.generatedAt);
    assert.equal(displayed.candidates.length, 0);
    assert.equal(displayed.previewCandidate?.analysis?.stale, true);
    assert.deepEqual(displayed.previewCandidate?.analysis?.quotes, result.candidates[0].analysis?.quotes);
    assert.equal(getCompetitorSelection(), null);
    const selected = updateCompetitorCandidate('select', candidate.id, batch.id);
    assert.equal(selected.selectedCandidate?.id, candidate.id);
    assert.equal(selected.selectedCandidate?.analysis?.stale, true);
    assert.ok(selected.comparison?.rows.length);
    assert.equal(JSON.stringify(getResearchBatch('sample-project', batch.id)), before);
    const otherBatch = prepareCompetitorAnalysis(getSeed().project, 'new-batch', [], new Map());
    assert.equal(readDisplayedCompetitorAnalysis(otherBatch).result, null);
    withGeoProject('sample-project-two', () => {
      assert.equal(readDisplayedCompetitorAnalysis(prepared).result, null);
      assert.deepEqual(getCompetitorCandidates().candidates, []);
    });
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('same-input retry exposes real generating and validating phases without discarding its previous success', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-stages-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const prepared = preparedFixture();
    const first = await analyzePreparedCompetitors(prepared, { model: fakeModel() });
    let complete!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { complete = resolve; });
    let calls = 0;
    const model: GeoStructuredModel = { async generateObject() {
      calls++;
      assert.equal(readCompetitorAnalysis(prepared.inputKey)?.state.phase, 'generating');
      return await pending;
    } };
    const retry = analyzePreparedCompetitors(prepared, { force: true, model });
    const working = readDisplayedCompetitorAnalysis(prepared);
    assert.equal(working.active?.state.status, 'running');
    assert.equal(working.active?.state.phase, 'generating');
    assert.ok(working.active?.state.startedAt);
    assert.equal(working.active?.state.candidateCount, 1);
    assert.equal(working.active?.state.evidenceCount, 1);
    assert.equal(working.result?.state.generatedAt, first.state.generatedAt);
    assert.equal(working.stale, true);
    const candidate = structuredClone(prepared.candidates[0]);
    candidate.questions[0].collectedAt = '2026-10-29T01:00:00Z';
    const changed = prepareCompetitorAnalysis(getSeed().project, 'test', [candidate], new Map());
    assert.notEqual(changed.inputKey, prepared.inputKey);
    assert.equal(readDisplayedCompetitorAnalysis(changed).active?.state.phase, 'generating');
    assert.equal((await analyzePreparedCompetitors(changed, { force: true, model })).state.status, 'running');
    const second = analyzePreparedCompetitors(prepared, { force: true, model });
    assert.equal(calls, 1);
    const output = modelResult(prepared.input);
    complete({ ...output, get summary() {
      assert.equal(readCompetitorAnalysis(prepared.inputKey)?.state.phase, 'validating');
      return output.summary;
    } });
    const ready = await retry;
    assert.equal((await second).state.status, 'ready');
    assert.equal(ready.state.status, 'ready');
    assert.equal(readDisplayedCompetitorAnalysis(prepared).stale, false);
    const failed = await analyzePreparedCompetitors(prepared, { force: true,
      model: { async generateObject() { throw new Error('provider error'); } } });
    assert.equal(failed.state.status, 'failed');
    const fallback = readDisplayedCompetitorAnalysis(prepared);
    assert.equal(fallback.active?.state.status, 'failed');
    assert.equal(fallback.result?.state.generatedAt, ready.state.generatedAt);
    assert.equal(fallback.stale, true);
    assert.equal(readDisplayedCompetitorAnalysis(changed).active?.state.status, 'failed');
    assert.equal(readDisplayedCompetitorAnalysis(changed).active?.state.status, 'failed');
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('a bounded model timeout becomes a retryable failure and preserves its previous result', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-competitor-timeout-'));
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const prepared = preparedFixture();
    const ready = await analyzePreparedCompetitors(prepared, { model: fakeModel() });
    const failed = await analyzePreparedCompetitors(prepared, { force: true, timeoutMs: 5,
      model: { async generateObject() { return new Promise(() => {}); } } });
    assert.equal(failed.state.status, 'failed');
    assert.match(failed.state.error!, /超时/);
    assert.equal(readDisplayedCompetitorAnalysis(prepared).result?.state.generatedAt, ready.state.generatedAt);
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

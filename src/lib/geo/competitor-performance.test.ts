import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { attachCompetitorPerformance, buildCompetitorPerformance } from './competitor-performance';
import { buildCompetitorComparison, getCompetitorComparison } from './competitors';
import { isCompetitorAnswerRow, latestCompetitorRows } from './competitor-metrics';
import { auditRows, summarizeMetric, type AnswerAuditRecord } from './overview-metrics';
import { attachOverviewData } from './overview-data';
import { getResearchMetrics, getResearchRows } from './research-view';
import { discoverCompetitorCandidates, getCompetitorCandidates, updateCompetitorCandidate } from './competitor-candidates';
import { getLatestResearch } from './research';
import { getSeed } from './seed';
import { readStoredCompetitors } from './competitor-store';
import { withGeoProject } from './projects';
import type { CompetitorComparison } from './competitor-types';
import type { ResearchBatch, ResearchObservation } from './research-types';

const official = 'https://github.com/acme/tool';
function observation(overrides: Partial<ResearchObservation> = {}): ResearchObservation {
  return {
    engine: 'chatgpt', language: 'zh', entryType: 'web_answer', query: '有哪些工具？',
    recordedAt: '2026-10-29T01:00:00Z', status: 'not_observed', summary: '', conditions: 'same conditions',
    sources: [], evidencePath: 'q1.json', answerPath: 'q1.md', ...overrides,
  };
}
function batch(groups: ResearchObservation[][]): ResearchBatch {
  const result: ResearchBatch = {
    id: 'performance-batch', projectId: 'sample-project', date: '2026-10-29', productSummary: '',
    contributionSummary: '', scopeNote: '', reportPath: '', sourceAuditPath: '', reviewPath: '',
    nextStep: '', deferredQuestions: [], questions: groups.map((observations, index) => ({
      id: `Q${index + 1}`, zh: '有哪些工具？', en: 'Which tools?', decision: 'search_now',
      valueReason: '', evidenceBasis: '', answerability: '', gaps: [], decisionReason: '', reviewPath: '',
      diagnosis: { observed: '', hypothesis: '', nextStep: '' }, observations,
    })),
  };
  result.answerAudits = result.questions.flatMap((question) => question.observations.map((item): AnswerAuditRecord => ({
    projectId: result.projectId, batchId: result.id, questionId: question.id,
    engine: item.engine, language: item.language, recordedAt: item.recordedAt,
    evidencePath: item.answerPath ?? item.evidencePath, answerComplete: true,
    mention: item.status === 'found' ? 'yes' : 'no', citation: 'unknown',
    mentionEvidence: 'Saved exact observation review.', citationEvidence: 'Not reviewed.', officialUrls: [],
  })));
  result.overviewMetrics = {};
  for (const language of ['zh', 'en'] as const) {
    for (const engine of ['all', 'chatgpt', 'qwen', 'doubao', 'google', 'deepseek'] as const) {
      const rows = auditRows(result, getResearchRows(result, { language, engine, kind: 'all', result: 'all' }), result.answerAudits);
      result.overviewMetrics[`${language}:${engine}`] = { mention: summarizeMetric(rows, 'mention'), citation: summarizeMetric(rows, 'citation') };
    }
  }
  return result;
}
function comparison(value: ResearchBatch): CompetitorComparison {
  return {
    projectId: value.projectId, batch: { id: value.id, date: value.date },
    own: { name: 'SampleProject', aliases: [], officialUrls: ['https://github.com/example/sample-project'] },
    target: { name: 'Tool', aliases: [], officialUrls: [official], updatedAt: '' }, rows: [],
  };
}
function evidence(files: Record<string, string>) {
  return (file: string) => files[file] ?? null;
}
function assertRowsMatchPerformance(value: CompetitorComparison) {
  for (const [scope, result] of Object.entries(value.performance!.scopes)) {
    const [language, engine] = scope.split(':');
    const mention = result.metrics.find((metric) => metric.id === 'mention')?.target;
    if (!mention) continue;
    const rows = latestCompetitorRows(value.rows.filter((row) => row.language === language &&
      (engine === 'all' || row.engine === engine))).filter(isCompetitorAnswerRow);
    assert.equal(mention.completed, rows.length, scope);
    assert.equal(mention.yes, rows.filter((row) => row.targetMention.status === 'matched').length, scope);
    assert.equal(mention.no, rows.filter((row) => row.targetMention.status === 'not_seen').length, scope);
    assert.equal(mention.unknown, rows.filter((row) => row.targetMention.status === 'unknown').length, scope);
  }
}

test('own values are exactly the overview summaries even when original evidence is no longer readable', () => {
  const value = batch([
    [observation({ status: 'found' }), observation({ engine: 'google', entryType: 'web_search', status: 'found' })],
    [observation({ evidencePath: 'q2.json', answerPath: 'q2.md' })],
  ]);
  const result = buildCompetitorPerformance(value, comparison(value), () => null);
  for (const language of ['zh', 'en'] as const) {
    for (const engine of ['all', 'chatgpt'] as const) {
      const metrics = result.scopes[`${language}:${engine}`].metrics;
      for (const metric of ['mention', 'citation'] as const) {
        assert.deepEqual(metrics.find((item) => item.id === metric)!.own, value.overviewMetrics![`${language}:${engine}`][metric]);
      }
    }
    const rows = getResearchRows(value, { language, engine: 'google', kind: 'all', result: 'all' });
    const overview = getResearchMetrics(rows);
    const own = result.scopes[`${language}:google`].metrics[0].own;
    assert.equal(own.rate, overview.rate);
    assert.equal(own.yes, overview.found);
    assert.equal(own.completed, overview.completed);
    assert.equal(own.unmeasured, overview.unmeasured);
  }
  assert.equal(result.scopes['zh:all'].metrics[0].target.unknown, 2);
  assert.equal(result.scopes['en:all'].metrics[0].target.completed, 0);
  assert.equal(result.scopes['en:all'].metrics[0].target.unmeasured, 2);
  assert.deepEqual(result.scopes['zh:google'].metrics.map((metric) => metric.id), ['google']);
  assert.equal(result.scopes['zh:deepseek'], undefined);
});

test('target uses full same-question samples and shared question weights, while sources never imply AI citations', () => {
  const value = batch([
    [observation(), observation({ engine: 'qwen', entryType: 'api_answer', answerPath: 'qwen.answer.md' })],
    [observation({ evidencePath: 'q2.json', answerPath: 'q2.md' })],
  ]);
  const read = evidence({
    'q1.md': `## Answer text\nTry [Tool](${official}).`,
    'qwen.answer.md': `Try [Tool](${official}).`,
    'q2.md': '## Answer text\nAnother product.',
  });
  const result = buildCompetitorPerformance(value, comparison(value), read).scopes['zh:all'];
  const mention = result.metrics.find((item) => item.id === 'mention')!.target;
  assert.equal(mention.rate, 50);
  assert.equal(mention.yes, 2);
  assert.equal(mention.no, 1);
  assert.equal(mention.completed, 3);
  assert.equal(mention.unmeasured, 1);
  const citation = result.metrics.find((item) => item.id === 'citation')!.target;
  assert.equal(citation.rate, null);
  assert.equal(citation.unknown, 3);
  assert.equal(citation.yes, 0);
});

test('same-name occurrences and incomplete negatives remain unknown rather than supplying zeroes', () => {
  const value = batch([
    [observation()],
    [observation({ evidencePath: 'q2.json', answerPath: 'q2.md' })],
    [observation({ evidencePath: 'q3.json', answerPath: 'q3.md' })],
  ]);
  value.answerAudits![1].answerComplete = false;
  const result = buildCompetitorPerformance(value, comparison(value), evidence({
    'q1.md': '## Answer text\nTry Tool.',
    'q2.md': '## Answer text\nAnother product.',
    'q3.json': '{"partial":true}',
    'q3.md': `## Answer text\nTry [Tool](${official}).`,
  }));
  const target = result.scopes['zh:chatgpt'].metrics[0].target;
  assert.equal(target.unknown, 3);
  assert.equal(target.no, 0);
  assert.equal(target.yes, 0);
  assert.equal(target.rate, null);
});

test('detail rows use the same identity verdict as performance and retain the original quoted evidence', () => {
  const value = batch([[observation()], [observation({ evidencePath: 'q2.json', answerPath: 'q2.md' })]]);
  const read = evidence({
    'q1.md': '## Answer text\nTry Tool.',
    'q2.md': `## Answer text\nTry [Tool](${official}).`,
  });
  const original = buildCompetitorComparison(getSeed().project, value, comparison(value).target, read);
  assert.deepEqual(original.rows.map((row) => row.targetMention.status), ['matched', 'matched']);
  const originalSnapshot = structuredClone(original);
  const result = attachCompetitorPerformance(value, original, read);
  assert.deepEqual(result.rows.map((row) => row.targetMention.status), ['unknown', 'matched']);
  assert.deepEqual(result.rows[0].targetMention.excerpts, original.rows[0].targetMention.excerpts);
  assert.deepEqual(original, originalSnapshot);
  const metric = result.performance!.scopes['zh:chatgpt'].metrics.find((metric) => metric.id === 'mention')!.target;
  assert.equal(metric.yes, result.rows.filter((row) => row.targetMention.status === 'matched').length);
  assert.equal(metric.unknown, result.rows.filter((row) => row.targetMention.status === 'unknown').length);
  assert.equal(metric.rate, null);
  assert.equal(metric.minimumRate, 50);
  assert.equal(result.rows.filter((row) => row.ownMention.status === 'not_seen' && row.targetMention.status === 'matched').length, 1);
});

test('latest selection occurs before AI filtering, exactly as in the overview', () => {
  const value = batch([[
    observation({ answerPath: 'current.md' }),
    observation({ engine: 'qwen', entryType: 'api_answer', status: 'found', answerPath: 'old.answer.md' }),
    observation({ engine: 'qwen', entryType: 'api_search', recordedAt: '2026-10-29T02:00:00Z', answerPath: undefined }),
  ]]);
  const result = buildCompetitorPerformance(value, comparison(value), () => `Try [Tool](${official}).`);
  const own = result.scopes['zh:all'].metrics.find((metric) => metric.id === 'mention')!.own;
  assert.deepEqual(own, value.overviewMetrics!['zh:all'].mention);
  assert.equal(own.completed, 1);
  assert.equal(result.scopes['zh:all'].metrics[0].target.completed, 1);
  assert.deepEqual(result.scopes['zh:qwen'].metrics, []);
  assert.equal(result.scopes['zh:all'].measuredAt, '2026-10-29T02:00:00Z');
});

test('source positives match actual URLs, Google ignores unranked links, and complete empty API results are a real zero', () => {
  const source = { title: 'Tool', url: official, kind: 'other' as const };
  const value = batch([
    [observation({ engine: 'google', entryType: 'web_search', sources: [source], evidencePath: 'g1' }),
      observation({ engine: 'deepseek', entryType: 'api_search', sources: [], evidencePath: 'd1' })],
    [observation({ engine: 'google', entryType: 'web_search', sources: [{ ...source, position: 1 }], evidencePath: 'g2' }),
      observation({ engine: 'deepseek', entryType: 'api_search', sources: [source], evidencePath: 'd2' })],
    [observation({ engine: 'google', entryType: 'web_search', sources: [{ ...source, position: 1 }], evidencePath: 'g3' })],
  ]);
  const result = buildCompetitorPerformance(value, comparison(value), evidence({
    d1: '{"results":[]}', d2: '{"partial":true}', g3: '{"sourcesComplete":false}',
  }));
  const google = result.scopes['zh:google'].metrics[0].target;
  assert.equal(google.yes, 1);
  assert.equal(google.no, 0);
  assert.equal(google.unknown, 2);
  assert.equal(google.minimumRate, (1 / 3) * 100);
  const deepseek = result.scopes['zh:deepseek'].metrics[0].target;
  assert.equal(deepseek.no, 1);
  assert.equal(deepseek.unknown, 1);
  assert.equal(deepseek.unmeasured, 1);
  assert.equal(deepseek.rate, null);
  const wrong = buildCompetitorPerformance({ ...value, projectId: 'other' }, comparison(value), () => null);
  assert.deepEqual(wrong.scopes, {});
});

test('empty and Qwen-only batches expose only the same available platforms as ProjectOverview', () => {
  const empty = batch([[]]);
  const noData = buildCompetitorPerformance(empty, comparison(empty), () => null);
  assert.deepEqual(Object.keys(noData.scopes), ['zh:all', 'en:all']);
  assert.deepEqual(noData.scopes['zh:all'].metrics, []);
  const onlyQwen = batch([[observation({ engine: 'qwen', entryType: 'api_answer', answerPath: 'qwen.answer.md' })]]);
  const result = buildCompetitorPerformance(onlyQwen, comparison(onlyQwen), () => null);
  assert.deepEqual(Object.keys(result.scopes), ['zh:all', 'zh:qwen', 'en:all', 'en:qwen']);
  assert.deepEqual(result.scopes['zh:all'].metrics.map((metric) => metric.id), ['mention', 'citation']);
  assert.deepEqual(result.scopes['zh:all'].metrics[0].own, onlyQwen.overviewMetrics!['zh:all'].mention);
  assert.equal(result.scopes['zh:all'].metrics[0].target.completed, result.scopes['zh:all'].metrics[0].own.completed);
  assert.equal(result.scopes['zh:all'].metrics[0].target.unmeasured, result.scopes['zh:all'].metrics[0].own.unmeasured);
});

test('read-time candidate and comparison projections match persisted overview values without network or saving performance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-performance-'));
  const previousDirectory = process.env.DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.DATA_DIR = directory;
  globalThis.fetch = async () => { throw new Error('Reading metrics must not call a provider.'); };
  try {
    withGeoProject('sample-project', () => {
      const value = attachOverviewData(getLatestResearch('sample-project'))!;
      const candidate = discoverCompetitorCandidates(getSeed().project, value)[0];
      assert.ok(candidate);
      const preview = getCompetitorCandidates(value.id, candidate.id);
      assert.deepEqual(preview.previewCandidate!.performance, preview.comparison!.performance);
      assertRowsMatchPerformance(preview.comparison!);
      for (const [scope, metrics] of Object.entries(preview.comparison!.performance!.scopes)) {
        for (const metric of metrics.metrics.filter((metric) => metric.id === 'mention' || metric.id === 'citation')) {
          assert.deepEqual(metric.own, value.overviewMetrics![scope][metric.id as 'mention' | 'citation']);
        }
      }
      const selected = updateCompetitorCandidate('select', candidate.id, value.id);
      assert.ok(selected.selectedCandidate?.performance);
      assert.deepEqual(selected.selectedCandidate.performance, selected.comparison!.performance);
      assertRowsMatchPerformance(selected.comparison!);
      const standalone = getCompetitorComparison(value.id);
      assert.deepEqual(standalone.rows, selected.comparison!.rows);
      assert.deepEqual(standalone.performance, selected.comparison!.performance);
      assert.deepEqual(standalone.selection, selected.selection);
      assertRowsMatchPerformance(standalone);
      assert.ok(readStoredCompetitors().every((item) => item.performance === undefined));
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDirectory === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

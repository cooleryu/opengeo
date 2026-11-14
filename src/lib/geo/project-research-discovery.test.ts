import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GeoStructuredModel } from './connection-settings';
import { discoverProjectResearch, researchDocumentId } from './project-research-discovery';
import type { ProjectResearchDocument } from './project-research-types';

const readAt = '2026-11-11T00:00:00.000Z';
const document = (markdown: string, overrides: Partial<ProjectResearchDocument> = {}): ProjectResearchDocument => ({
  id: 'entry-source', title: 'Synthetic project', url: 'https://example.com/project', markdown,
  readAt, type: 'website', origin: 'entry', sourcePath: 'saved/entry.md', ...overrides,
});
type ModelInput = Parameters<GeoStructuredModel['generateObject']>[0];
type Context = {
  sources: { id: string; markdown: string; excerpt: boolean; origin: string; ownership: string }[];
  allowedReadUrls?: string[];
  searchResults?: { url: string; title: string }[];
  remaining?: { rounds: number; reads: number; searches: number };
};
const contextOf = (input: ModelInput): Context => JSON.parse(String(input.messages[1].content));
const relation = (sourceId: string, quote: string) => ({
  kind: 'capability', statement: '资料说明该项目提供工作流恢复功能。', audience: '需要恢复工作流的开发者',
  basis: 'source', evidence: [{ sourceId, quote }],
});

test('model follows actual links into a second layer and relates newly read material', async () => {
  const initial = document('项目介绍。\n[使用场景](docs/scenarios.md)', {
    url: 'https://github.com/example/synthetic/blob/main/README.md', type: 'readme',
  });
  const original = structuredClone(initial);
  const firstUrl = 'https://github.com/example/synthetic/blob/main/docs/scenarios.md';
  const secondUrl = 'https://github.com/example/synthetic/blob/main/research.md';
  const quote = '该研究说明如何恢复中断的工作流。';
  const reads: string[] = [];
  const saved: ProjectResearchDocument[] = [];
  let calls = 0;
  const model: GeoStructuredModel = { async generateObject(input) {
    const context = contextOf(input);
    calls += 1;
    if (calls === 1) {
      assert.deepEqual(context.allowedReadUrls, [firstUrl]);
      return { readUrls: [firstUrl], searchQueries: [], done: false };
    }
    if (calls === 2) {
      assert.equal(saved.length, 1, 'persist the first page before asking about its links');
      assert.ok(context.sources.some(source => source.markdown.includes('[研究](../research.md)')));
      assert.equal(context.sources.find(source => source.id === saved[0].id)?.ownership, 'owned');
      assert.equal(context.sources.find(source => source.id === saved[0].id)?.origin, 'linked');
      assert.ok(context.allowedReadUrls?.includes(secondUrl));
      return { readUrls: [secondUrl], searchQueries: [], done: true };
    }
    const source = context.sources.find(item => item.markdown === quote)!;
    assert.equal(saved.length, 2);
    return { relations: [{ ...relation(source.id, quote), kind: 'contribution' }] };
  } };
  const result = await discoverProjectResearch({
    documents: [initial], notes: '', model, onDocument: source => { source.ownership = 'owned'; saved.push(source); },
    readDocument: async url => {
      reads.push(url);
      return { title: 'Synthetic material', url, readAt, type: 'document',
        markdown: reads.length === 1 ? '使用场景说明。\n[研究](../research.md)' : quote };
    },
  });
  assert.deepEqual(reads, [
    'https://raw.githubusercontent.com/example/synthetic/main/docs/scenarios.md',
    'https://raw.githubusercontent.com/example/synthetic/main/research.md',
  ]);
  assert.deepEqual(initial, original);
  assert.deepEqual(result.documents[0], original);
  assert.equal(result.documents[1].url, firstUrl);
  assert.equal(result.documents[2].url, secondUrl);
  assert.equal(result.documents[2].id, researchDocumentId(secondUrl, quote));
  assert.equal(result.documents[2].sourcePath, '');
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].kind, 'contribution');
  assert.deepEqual(result.relations[0].evidence, [{ sourceId: result.documents[2].id, quote }]);
  assert.match(result.relations[0].id, /^r-[0-9a-f]{20}$/);
  assert.ok(result.limitations.some(item => item.includes('外部搜索未配置')));
  assert.equal(calls, 3);
});

test('invented URLs, unknown sources and quotes absent from the supplied excerpt are rejected', async () => {
  const visibleQuote = '项目资料说明可恢复工作流。';
  const hiddenQuote = '这句话只在未提供的全文部分。';
  const initial = document(`${visibleQuote}${'文'.repeat(6100)}${hiddenQuote}`);
  let calls = 0;
  let reads = 0;
  const model: GeoStructuredModel = { async generateObject(input) {
    const context = contextOf(input);
    calls += 1;
    assert.ok(context.sources.every(source => source.markdown.length <= 6000));
    assert.ok(context.sources.reduce((total, source) => total + source.markdown.length, 0) <= 24000);
    assert.equal(context.sources[0].excerpt, true);
    assert.equal(context.sources[0].markdown.includes(hiddenQuote), false);
    if (calls === 1) return { readUrls: ['https://invented.example.com/fake'], searchQueries: [], done: true };
    return { relations: [
      { ...relation(initial.id, visibleQuote), kind: 'need', basis: 'inferred', statement: '根据资料推导，开发者可能需要恢复中断的工作流。' },
      relation('unknown-source', visibleQuote), relation(initial.id, hiddenQuote), relation(initial.id, '模型编造的引文。'),
    ] };
  } };
  const result = await discoverProjectResearch({ documents: [initial], notes: '', model,
    readDocument: async () => { reads += 1; throw new Error('should not read'); } });
  assert.equal(reads, 0);
  assert.deepEqual(result.documents, [initial]);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].basis, 'inferred');
  assert.ok(result.limitations.some(item => item.includes('部分链接不在已读资料')));
  assert.ok(result.limitations.some(item => item.includes('关系整理仅部分完成')));
  assert.equal(JSON.stringify(result.limitations).includes('invented.example.com'), false);
});

test('search, page and model failures retain original and successfully read documents without error details', async () => {
  const initial = document('[有效资料](/good)\n[失败资料](/bad)');
  const saved: ProjectResearchDocument[] = [];
  let calls = 0;
  let searches = 0;
  const model: GeoStructuredModel = { async generateObject() {
    calls += 1;
    if (calls === 1) return { readUrls: ['https://example.com/good', 'https://example.com/bad'],
      searchQueries: ['synthetic workflow recovery case'], done: false };
    throw new Error('secret-api-key-provider-body');
  } };
  const result = await discoverProjectResearch({ documents: [initial], notes: '', model,
    search: async () => { searches += 1; throw new Error('secret-api-key-search'); },
    readDocument: async url => {
      if (url.endsWith('/bad')) throw new Error('secret-api-key-read');
      return { title: 'Retained source', url, markdown: '成功读取的完整原文。', readAt, type: 'document' };
    }, onDocument: source => { saved.push(source); },
  });
  assert.equal(calls, 3);
  assert.equal(searches, 1);
  assert.deepEqual(result.documents[0], initial);
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[1].markdown, '成功读取的完整原文。');
  assert.deepEqual(saved, [result.documents[1]]);
  assert.deepEqual(result.relations, []);
  assert.ok(result.limitations.some(item => item.includes('外部搜索失败')));
  assert.ok(result.limitations.some(item => item.includes('页面读取失败')));
  assert.ok(result.limitations.some(item => item.includes('补充调查调用失败')));
  assert.ok(result.limitations.some(item => item.includes('关系整理调用失败')));
  assert.equal(JSON.stringify(result).includes('secret-api-key'), false);
});

test('only actual search result links can be read on the following round and search runs once', async () => {
  const resultUrl = 'https://public.example.com/case';
  let calls = 0;
  let searches = 0;
  const reads: string[] = [];
  const model: GeoStructuredModel = { async generateObject(input) {
    const context = contextOf(input);
    calls += 1;
    if (calls === 1) return { readUrls: [], searchQueries: ['synthetic project case'], done: false };
    if (calls === 2) {
      assert.deepEqual(context.allowedReadUrls, [resultUrl]);
      assert.deepEqual(context.searchResults, [{ url: resultUrl, title: 'Public case' }]);
      assert.equal(context.remaining?.searches, 0);
      return { readUrls: [resultUrl], searchQueries: ['must not run again'], done: true };
    }
    return { relations: [] };
  } };
  const result = await discoverProjectResearch({ documents: [document('Synthetic project introduction.')], notes: '', model,
    search: async () => { searches += 1; return [{ url: resultUrl, title: 'Public case' }]; },
    readDocument: async url => { reads.push(url); return { title: 'Public case', url, markdown: '已读外部案例。', readAt, type: 'article' }; },
  });
  assert.equal(searches, 1);
  assert.deepEqual(reads, [resultUrl]);
  assert.equal(result.documents[1].origin, 'external');
  assert.ok(result.limitations.some(item => item.includes('外部搜索次数上限')));
});

test('four additional read attempts stop exploration and persistence errors propagate', async () => {
  const urls = ['a', 'b', 'c', 'd'].map(name => `https://example.com/${name}`);
  const initial = document(urls.map(url => `[资料](${url})`).join('\n') + '文'.repeat(6100));
  let calls = 0;
  let reads = 0;
  const model: GeoStructuredModel = { async generateObject(input) {
    calls += 1;
    if (calls === 1) return { readUrls: urls, searchQueries: [], done: false };
    const context = contextOf(input);
    assert.ok(context.sources.reduce((total, source) => total + source.markdown.length, 0) <= 24000);
    assert.equal(context.sources.length, 5);
    return { relations: [] };
  } };
  const result = await discoverProjectResearch({ documents: [initial], notes: '', model,
    readDocument: async url => { reads += 1; return { title: 'Page', url, markdown: '文'.repeat(6100), readAt, type: 'document' }; } });
  assert.equal(reads, 4);
  assert.equal(calls, 2, 'do not call an exploration round after the read allowance is exhausted');
  assert.ok(result.limitations.some(item => item.includes('补充资料读取上限')));
  const storageError = new Error('storage failure');
  await assert.rejects(discoverProjectResearch({ documents: [initial], notes: '',
    model: { async generateObject() { return { readUrls: [urls[0]], searchQueries: [], done: true }; } },
    readDocument: async url => ({ title: 'Page', url, markdown: '已读正文。', readAt, type: 'document' }),
    onDocument: () => { throw storageError; },
  }), error => error === storageError);
});

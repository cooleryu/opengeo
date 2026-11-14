import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { analyzeProjectOnboarding } from './project-onboarding-analysis';
import { createProjectOnboarding, getProjectOnboarding } from './project-onboarding-store';
import { loadProjectSeed, readRuntimeProjects, runtimeProjectsFile } from './project-data';
import { projectResearch, projectResearchContext } from './project-research-context';
import { readProjectResearchHistory } from './project-research-store';
import { projectDataDirectory, withGeoProject } from './projects';
import { buildInitialQuestionPlan } from './question-planner';
import { getQuestionGeneration, getQuestionPlan } from './store';
import type { GeoStructuredModel } from './connection-settings';
import type { ProjectResearchSnapshot } from './project-research-types';
import type { PublicSource } from './project-public-source';

const priorData = process.env.DATA_DIR;
const priorProjects = process.env.GEO_LOCAL_PROJECTS_DIR;
const priorFetch = globalThis.fetch;
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-project-research-chain-'));
  process.env.DATA_DIR = temporary;
  process.env.GEO_LOCAL_PROJECTS_DIR = path.join(temporary, 'empty-local-projects');
  globalThis.fetch = async () => { throw new Error('Research chain must not make live network requests'); };
});
afterEach(() => {
  if (priorData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorData;
  if (priorProjects === undefined) delete process.env.GEO_LOCAL_PROJECTS_DIR; else process.env.GEO_LOCAL_PROJECTS_DIR = priorProjects;
  globalThis.fetch = priorFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
});

const readAt = '2026-11-11T08:00:00.000Z';
const understood = { summary: '根据已读取资料，项目提供文档素材整理与复用方法。', audience: '需要整理和复用公开文档的作者。',
  capabilities: ['公开资料介绍了保留原文出处的方法，尚未实测。'], unknowns: ['实际效果和 AI 可见性尚未验证。'] };
function source(url: string, text: string, contentType = 'text/plain'): PublicSource {
  return { url, text, contentType, readAt };
}
function history(projectId: string) {
  return readProjectResearchHistory(withGeoProject(projectId, projectDataDirectory), projectId);
}
async function settled(projectId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const job = withGeoProject(projectId, getQuestionGeneration);
    if (job && !['queued', 'running'].includes(job.status)) return job;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.fail('Synthetic question preparation did not settle');
}

test('entry research follows a real link and one search, preserves quotes in SQLite, and automatically prepares questions', async () => {
  const entry = 'https://research.example.com/entry';
  const linked = 'https://research.example.com/entry/docs/reuse';
  const external = 'https://authors.example.org/reuse-needs';
  const projectId = createProjectOnboarding({ kind: 'company', url: entry, notes: '只根据已读公开资料判断。' }).project.id;
  const readUrls: string[] = [];
  let discoveryCalls = 0;
  let relationCalls = 0;
  let understandingCalls = 0;
  let searchCalls = 0;
  let generationCalls = 0;
  let firstRead: ProjectResearchSnapshot | undefined;
  const model: GeoStructuredModel = { generateObject: async input => {
    const payload = JSON.parse(String(input.messages[1].content));
    if ('allowedReadUrls' in payload) {
      discoveryCalls++;
      if (discoveryCalls === 1) {
        assert.deepEqual(payload.allowedReadUrls, [linked]);
        assert.equal(payload.sources.length, 1);
        firstRead = history(projectId).at(-1)!;
        assert.equal(firstRead.status, 'partial');
        assert.equal(firstRead.documents[0].markdown, payload.sources[0].markdown);
        return { readUrls: [linked], searchQueries: ['authors source-backed note reuse needs'], done: false };
      }
      assert.equal(discoveryCalls, 2);
      assert.equal(payload.sources.length, 2);
      assert.deepEqual(payload.searchResults, [{ title: 'Authors discuss reuse needs', url: external }]);
      assert.deepEqual(payload.allowedReadUrls, [external]);
      return { readUrls: [external], searchQueries: [], done: true };
    }
    if (!('kind' in payload)) {
      relationCalls++;
      assert.equal(payload.sources.length, 3);
      const idFor = (url: string) => payload.sources.find((item: { url: string }) => item.url === url).id;
      return { relations: [
        { kind: 'capability', statement: '项目资料介绍了文档素材整理能力。', audience: '整理文档的作者', basis: 'source',
          evidence: [{ sourceId: idFor(entry), quote: 'organizes reusable guides' }] },
        { kind: 'contribution', statement: '已有指南解释如何保留原文和出处。', audience: '复用素材的作者', basis: 'source',
          evidence: [{ sourceId: idFor(linked), quote: 'Keep source passages with their original links' }] },
        { kind: 'need', statement: '作者需要可重复使用且有来源依据的笔记。', audience: '整理笔记的作者', basis: 'inferred',
          evidence: [{ sourceId: idFor(external), quote: 'Authors need a repeatable way to reuse source-backed notes' }] },
      ] };
    }
    understandingCalls++;
    assert.equal(getProjectOnboarding(projectId)?.status, 'analyzing');
    assert.equal(payload.sources.length, 3);
    assert.equal(payload.sources.find((item: { url: string }) => item.url === external).ownership, 'external');
    assert.equal(projectResearch(projectId)?.relations.length, 3, 'relations are saved before understanding');
    return understood;
  } };
  await analyzeProjectOnboarding(projectId, {
    model,
    readSource: async url => {
      readUrls.push(url);
      if (url === entry) return source(url, `<html><head><title>Reusable guides</title></head><body>
        <nav><a href="/entry/docs/reuse">Read the reuse guide</a></nav><main>
        This documentation editor organizes reusable guides for authors. Its public material explains how to collect source passages,
        keep their original links and reuse them in later writing. These are documentation claims and do not establish measured results.
        </main></body></html>`, 'text/html');
      if (url === linked) return source(url, '# Reuse guide\n\nKeep source passages with their original links. The guide explains a repeatable editing process and separates original evidence from interpretation.');
      assert.equal(url, external);
      return source(url, '# Author needs\n\nAuthors need a repeatable way to reuse source-backed notes. This external discussion describes a writing need without making any claim about the project.');
    },
    research: { search: async query => {
      searchCalls++;
      assert.equal(query, 'authors source-backed note reuse needs');
      const savedSearch = projectResearch(projectId)?.searches?.[0];
      assert.equal(savedSearch?.status, 'pending', 'the request is recorded before the search starts');
      assert.equal(savedSearch?.confirmedCostCny, null);
      return { results: [{ title: 'Authors discuss reuse needs', url: external }], confirmedCostCny: 0.005, reservedCostCny: 0 };
    } },
    questionGeneration: { generate: async (seed, positioning, runtime) => {
      generationCalls++;
      assert.equal(seed.assets.length, 3);
      assert.deepEqual(seed.assets, loadProjectSeed(projectId).assets);
      assert.deepEqual(readRuntimeProjects().find(item => item.seed.project.id === projectId)?.seed.assets, []);
      const context = projectResearchContext(projectId)!;
      assert.equal(context.status, 'completed');
      assert.equal(context.relations.length, 3);
      for (const relation of context.relations) for (const evidence of relation.evidence) {
        const asset = seed.assets.find(item => item.id === evidence.assetId);
        assert.ok(asset?.markdown.includes(evidence.quote));
      }
      const outside = seed.assets.find(asset => asset.publicUrl === external)!;
      assert.equal(outside.ownership, 'external');
      assert.equal(outside.status, 'external-reference');
      runtime?.onProgress?.({ stage: 'reviewing', message: 'Checking the saved source relationships' });
      return { ...buildInitialQuestionPlan(seed), positioning, source: 'model' };
    } },
  });
  assert.equal(getProjectOnboarding(projectId)?.status, 'ready');
  assert.equal((await settled(projectId)).status, 'completed');
  assert.equal(withGeoProject(projectId, getQuestionPlan).revision, 2);
  assert.deepEqual(readUrls, [entry, linked, external]);
  assert.deepEqual([discoveryCalls, relationCalls, understandingCalls, searchCalls, generationCalls], [2, 1, 1, 1, 1]);
  const saved = projectResearch(projectId)!;
  assert.equal(saved.status, 'completed');
  assert.equal(saved.searches?.[0].confirmedCostCny, 0.005);
  assert.equal(saved.searches?.[0].reservedCostCny, 0);
  assert.deepEqual(saved.documents.map(document => document.ownership), ['owned', 'owned', 'external']);
  assert.deepEqual(history(projectId).find(run => run.runId === firstRead!.runId), firstRead);
  assert.equal(fs.readFileSync(runtimeProjectsFile(), 'utf8').includes('Keep source passages with their original links'), false);
  assert.deepEqual(loadProjectSeed(projectId).assets.map(asset => asset.markdown), saved.documents.map(document => document.markdown));
});

test('failed supplemental search stays partial with its original history and cannot mix material with another project', async () => {
  const firstId = createProjectOnboarding({ kind: 'company', url: 'https://partial.example.com/intro' }).project.id;
  const firstText = 'Project Alpha keeps documented source passages for its authors. The public introduction describes its current workflow and does not verify any visibility improvement.';
  await analyzeProjectOnboarding(firstId, {
    questionGeneration: false,
    readSource: async url => source(url, firstText),
    research: { search: async () => ({ results: [], confirmedCostCny: null, reservedCostCny: 0.005, error: 'Synthetic unavailable search' }) },
    model: { generateObject: async input => {
      const payload = JSON.parse(String(input.messages[1].content));
      if ('allowedReadUrls' in payload) return { readUrls: [], searchQueries: ['author reuse needs'], done: true };
      if (!('kind' in payload)) return { relations: [{ kind: 'capability', statement: '资料介绍了来源记录方法。', audience: '作者', basis: 'source',
        evidence: [{ sourceId: payload.sources[0].id, quote: 'keeps documented source passages' }] }] };
      assert.ok(payload.readLimitations.some((limitation: string) => limitation.includes('搜索失败')));
      return understood;
    } },
  });
  assert.equal(getProjectOnboarding(firstId)?.status, 'ready');
  const firstHistory = history(firstId);
  const firstLatest = projectResearch(firstId)!;
  assert.equal(firstLatest.status, 'partial');
  assert.deepEqual(firstLatest.searches?.map(search => ({ status: search.status, confirmed: search.confirmedCostCny, reserved: search.reservedCostCny })),
    [{ status: 'failed', confirmed: null, reserved: 0.005 }]);
  assert.ok(firstHistory.some(run => run.searches?.[0]?.status === 'pending'));
  assert.ok(firstHistory.every(run => run.documents[0].markdown === firstText));

  const secondId = createProjectOnboarding({ kind: 'company', url: 'https://separate.example.com/intro' }).project.id;
  const secondText = 'Project Beta provides an independent catalog for editors. Its public introduction covers a separate publishing workflow and makes no claims about Project Alpha.';
  await analyzeProjectOnboarding(secondId, { research: false, questionGeneration: false,
    readSource: async url => source(url, secondText), model: { generateObject: async () => understood } });
  assert.equal(getProjectOnboarding(secondId)?.status, 'ready');
  assert.deepEqual(loadProjectSeed(firstId).assets.map(asset => asset.markdown), [firstText]);
  assert.deepEqual(loadProjectSeed(secondId).assets.map(asset => asset.markdown), [secondText]);
  assert.deepEqual(history(firstId), firstHistory);
  assert.deepEqual(projectResearch(firstId), firstLatest);
  assert.equal(projectResearch(secondId)?.status, 'completed');
  assert.deepEqual(projectResearchContext(secondId)?.relations, []);
  assert.ok(history(secondId).every(run => run.projectId === secondId));
  assert.equal(JSON.stringify(readRuntimeProjects().map(entry => entry.seed.assets)), '[[],[]]');
});

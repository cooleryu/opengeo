import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { z } from 'zod';
import { analyzeProjectOnboarding as analyze, startProjectOnboarding as start, type OnboardingRuntime } from './project-onboarding-analysis';
import { createProjectOnboarding, getProjectOnboarding, getProjectOnboardingPlanningContext,
  retryProjectOnboarding, reviseProjectOnboarding, updateRuntimeProjectSeed } from './project-onboarding-store';
import { loadProjectSeed, readRuntimeProjects, writeRuntimeProjects } from './project-data';
import { evidenceLocation, projectDataDirectory, withGeoProject } from './projects';
import type { PublicSource } from './project-public-source';
import type { GeoStructuredModel } from './connection-settings';

// These tests isolate understanding; the continuous chain has its own injected-model tests.
const analyzeProjectOnboarding = (id: string, runtime: OnboardingRuntime) => analyze(id, { ...runtime, research: false, questionGeneration: false });
const startProjectOnboarding = (id: string, runtime: OnboardingRuntime) => start(id, { ...runtime, research: false, questionGeneration: false });

const priorData = process.env.DATA_DIR;
const priorProjects = process.env.GEO_LOCAL_PROJECTS_DIR;
let temporary: string;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-onboarding-analysis-'));
  process.env.DATA_DIR = temporary;
  process.env.GEO_LOCAL_PROJECTS_DIR = path.join(temporary, 'empty-local-projects');
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
});
afterEach(() => {
  if (priorData === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorData;
  if (priorProjects === undefined) delete process.env.GEO_LOCAL_PROJECTS_DIR; else process.env.GEO_LOCAL_PROJECTS_DIR = priorProjects;
  globalThis.fetch = originalFetch;
  fs.rmSync(temporary, { recursive: true, force: true });
});
const markdown = '# Example\n\nAn open source documentation editor. The README describes local editing, source export and reusable examples. This statement has not been validated by running the product.\n\n[Documentation](docs/guide.md)\n[Official guide](https://docs.example.com/guide)\n[Another guide](https://docs.example.com/extra)';
const understood = { summary: '公开资料介绍了一个文档编辑工具。', audience: '根据文档推导，适合需要管理文档的开发者。',
  capabilities: ['README 声明可编辑并导出文档，尚未实测。'], unknowns: ['未运行产品、验证效果或测量 AI 可见性。'] };
const readAt = '2026-11-02T08:00:00.000Z';
function source(url: string, text: string, contentType = 'text/plain'): PublicSource { return { url, text, contentType, readAt }; }
function readmeSource(url: string, content = markdown) {
  return source(url, JSON.stringify({ encoding: 'base64', content: Buffer.from(content).toString('base64'),
    html_url: 'https://github.com/synthetic/onboarding/blob/main/README.md', name: 'README.md' }), 'application/json');
}

test('reads README plus at most two related documents; persists real sources and a single model result', async () => {
  const created = createProjectOnboarding({ kind: 'repository', url: 'https://github.com/synthetic/onboarding', notes: 'I want guaranteed revenue.' });
  const projectId = created.project.id;
  const readUrls: string[] = [];
  let modelCalls = 0;
  const model: GeoStructuredModel = { generateObject: async (input) => {
    modelCalls += 1;
    assert.equal(getProjectOnboarding(projectId)?.status, 'analyzing');
    const payload = JSON.parse(input.messages[1].content as string);
    assert.equal(payload.userGoalsAndConstraints, 'I want guaranteed revenue.');
    assert.equal(payload.sources.length, 3);
    assert.equal(payload.sources.some((item: { text: string }) => item.text.includes('guaranteed revenue')), false);
    assert.equal(input.messages[0].content, fs.readFileSync('skills/project-onboarding/understand.md', 'utf8').trim());
    return understood;
  } };
  await analyzeProjectOnboarding(projectId, { model, readSource: async (url, options) => {
    readUrls.push(url);
    assert.equal(getProjectOnboarding(projectId)?.status, 'reading');
    assert.ok(options.maxBytes <= 262144);
    if (url.includes('api.github.com')) return readmeSource(url);
    return source(url, 'A complete guide explaining local document editing and export. '.repeat(4));
  } });
  assert.equal(modelCalls, 1);
  assert.deepEqual(readUrls, ['https://api.github.com/repos/synthetic/onboarding/readme',
    'https://raw.githubusercontent.com/synthetic/onboarding/main/docs/guide.md', 'https://docs.example.com/guide']);
  const record = getProjectOnboarding(projectId)!;
  assert.equal(record.status, 'ready');
  assert.equal(record.analysis?.sources?.length, 3);
  assert.equal(record.analysis?.sources?.[0].url, 'https://github.com/synthetic/onboarding/blob/main/README.md');
  const seed = loadProjectSeed(projectId);
  assert.equal(seed.project.description, understood.summary);
  assert.equal(seed.assets.length, 3);
  assert.equal(seed.assets[0].markdown, markdown);
  assert.equal(seed.assets[0].publishedAt, null, 'reading date is not a publication date');
  const location = withGeoProject(projectId, () => evidenceLocation(seed.assets[0].sourcePath));
  assert.equal(fs.readFileSync(location.target, 'utf8'), markdown);
  assert.deepEqual(seed.questions, []);
  assert.deepEqual(seed.observations, []);
});

test('a public company page is read without executing scripts and access walls never reach the model', async () => {
  const created = createProjectOnboarding({ kind: 'company', url: 'https://www.example.com/intro' });
  let calls = 0;
  await analyzeProjectOnboarding(created.project.id, { model: { generateObject: async input => {
    calls += 1;
    assert.ok(!JSON.stringify(input.messages).includes('do-not-run-this-script'));
    return understood;
  } }, readSource: async url => source(url, `<html><head><title>Company introduction</title></head><body><main>${'We build documentation tools for local teams. '.repeat(8)}</main><script>do-not-run-this-script</script></body></html>`, 'text/html') });
  assert.equal(calls, 1);
  assert.equal(getProjectOnboarding(created.project.id)?.status, 'ready');
  const blocked = createProjectOnboarding({ kind: 'creator', url: 'https://www.example.com/creator' });
  await analyzeProjectOnboarding(blocked.project.id, { model: { generateObject: async () => { calls += 1; return understood; } },
    readSource: async url => source(url, '<html><head><title>Just a moment...</title></head><body>Verify you are human.</body></html>', 'text/html') });
  assert.equal(calls, 1);
  assert.equal(getProjectOnboarding(blocked.project.id)?.status, 'failed');
  assert.match(getProjectOnboarding(blocked.project.id)?.error ?? '', /验证/);
  assert.deepEqual(loadProjectSeed(blocked.project.id).assets, []);
});

test('model failure preserves actual material and safe errors; explicit retry runs once with concurrent starts', async () => {
  const projectId = createProjectOnboarding({ kind: 'store', url: 'https://www.example.com/store' }).project.id;
  const readSource = async (url: string) => source(url, 'A public shop introduction with descriptions of available products. '.repeat(5));
  await analyzeProjectOnboarding(projectId, { readSource, model: { generateObject: async () => { throw new Error('secret-model-key'); } } });
  assert.equal(getProjectOnboarding(projectId)?.status, 'failed');
  assert.equal(getProjectOnboarding(projectId)?.error?.includes('secret-model-key'), false);
  assert.equal(loadProjectSeed(projectId).assets.length, 1);
  retryProjectOnboarding(projectId);
  let calls = 0;
  const runtime = { readSource, model: { generateObject: async () => { calls += 1; return understood; } } };
  const one = startProjectOnboarding(projectId, runtime);
  const two = startProjectOnboarding(projectId, runtime);
  assert.equal(one, two);
  await Promise.all([one, two]);
  assert.equal(calls, 1);
  assert.equal(getProjectOnboarding(projectId)?.status, 'ready');
});

test('related-document failures remain explicit and malformed model output is not accepted', async () => {
  const projectId = createProjectOnboarding({ kind: 'repository', url: 'https://github.com/synthetic/onboarding' }).project.id;
  await analyzeProjectOnboarding(projectId, { readSource: async url => {
    if (url.includes('api.github.com')) return readmeSource(url);
    throw new Error('private upstream data');
  }, model: { generateObject: async input => {
    const payload = JSON.parse(input.messages[1].content as string);
    assert.equal(payload.readLimitations.length, 2);
    assert.equal(JSON.stringify(payload).includes('private upstream data'), false);
    return { summary: 'Incomplete output' };
  } } });
  assert.equal(getProjectOnboarding(projectId)?.status, 'failed');
  assert.equal(getProjectOnboarding(projectId)?.analysis, undefined);
  assert.equal(loadProjectSeed(projectId).assets.length, 1);
});

test('related materials are found by docs and README paths even when link labels are not technical', async () => {
  const projectId = createProjectOnboarding({ kind: 'repository', url: 'https://github.com/synthetic/onboarding' }).project.id;
  const urls: string[] = [];
  const content = `${'A public project description with local editing and export. '.repeat(4)}\n` +
    '[添加项目资料与连接服务](docs/getting-started.md)\n[更多内容](packages/tool/README.md)\n[Third](docs/extra.md)\n[Account](account)';
  await analyzeProjectOnboarding(projectId, { model: { generateObject: async () => ({ ...understood, unknowns: [] }) }, readSource: async url => {
    urls.push(url);
    return url.includes('api.github.com') ? readmeSource(url, content) : source(url, 'Supporting public project documentation. '.repeat(5));
  } });
  assert.deepEqual(urls, ['https://api.github.com/repos/synthetic/onboarding/readme',
    'https://raw.githubusercontent.com/synthetic/onboarding/main/docs/getting-started.md',
    'https://raw.githubusercontent.com/synthetic/onboarding/main/packages/tool/README.md']);
  assert.equal(getProjectOnboarding(projectId)?.status, 'ready');
  assert.deepEqual(getProjectOnboarding(projectId)?.analysis?.unknowns, []);
});

test('revision applies user intent to a new saved understanding without re-reading or changing public evidence', async () => {
  const projectId = createProjectOnboarding({ kind: 'company', url: 'https://www.example.com/intro', notes: '原始目标：更方便地管理文档。' }).project.id;
  await analyzeProjectOnboarding(projectId, { model: { generateObject: async () => understood },
    readSource: async url => source(url, 'We build a documentation editor with export and reusable examples. '.repeat(5)) });
  const original = getProjectOnboarding(projectId)!;
  const assets = loadProjectSeed(projectId).assets;
  const sourceFile = withGeoProject(projectId, () => evidenceLocation(assets[0].sourcePath)).target;
  const savedSource = fs.readFileSync(sourceFile, 'utf8');
  // Historical records without newer metadata fields must still revise from their source bundle.
  const entries = readRuntimeProjects();
  delete entries[0].onboarding.sourceReads;
  delete entries[0].onboarding.readLimitations;
  writeRuntimeProjects(entries);
  const feedback = '我们面向独立作者，核心是复用文章素材，不是给开发团队写接口文档。只考虑中文内容。';
  reviseProjectOnboarding(projectId, feedback, 'revision-1');
  const revised = { summary: '面向独立作者的中文文章素材管理与复用工具。', audience: '需要整理与复用中文文章素材的独立作者。',
    capabilities: ['文档管理：整理内容并导出，支持复用已有素材。'], unknowns: [] };
  let calls = 0;
  await analyzeProjectOnboarding(projectId, { readSource: async () => { throw new Error('Revision must reuse saved public sources'); },
    model: { generateObject: async input => {
      calls += 1;
      const payload = JSON.parse(input.messages[1].content as string);
      assert.deepEqual(payload.priorUnderstanding, original.analysis);
      assert.equal(payload.currentRevisionId, 'revision-1');
      assert.deepEqual(payload.userCorrections, [{ id: 'revision-1', feedback }]);
      assert.equal(payload.userGoalsAndConstraints, '原始目标：更方便地管理文档。');
      assert.equal(payload.sources[0].readAt, readAt);
      assert.equal(payload.sources[0].text, assets[0].markdown);
      assert.equal(JSON.stringify(payload.sources).includes(feedback), false);
      assert.match(input.messages[0].content as string, /重新判断 summary、audience、capabilities 和 unknowns/);
      assert.match(input.messages[0].content as string, /用户补充，尚待核实/);
      assert.equal(getProjectOnboarding(projectId)?.revision?.completedAt, undefined);
      return revised;
    } } });
  assert.equal(calls, 1);
  const finished = getProjectOnboarding(projectId)!;
  assert.equal(finished.status, 'ready');
  assert.ok(finished.revision?.completedAt);
  assert.deepEqual(finished.revision?.previousAnalysis, original.analysis);
  assert.equal(finished.analysis?.summary, revised.summary);
  assert.equal(loadProjectSeed(projectId).project.description, revised.summary);
  assert.equal(loadProjectSeed(projectId).project.asOf, readAt.slice(0, 10));
  assert.deepEqual(loadProjectSeed(projectId).assets, assets);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), savedSource);
  assert.deepEqual(finished.analysis?.sources, original.analysis?.sources);
  assert.deepEqual(readRuntimeProjects()[0].onboarding, finished);
  assert.deepEqual(getProjectOnboardingPlanningContext(projectId)?.userCorrections, [{ id: 'revision-1', feedback }]);
  assert.deepEqual(loadProjectSeed(projectId).questions, []);
});

test('failed revisions retain feedback and previous results, run only after explicit retry, and do not duplicate calls', async () => {
  const projectId = createProjectOnboarding({ kind: 'company', url: 'https://www.example.com/intro' }).project.id;
  await analyzeProjectOnboarding(projectId, { model: { generateObject: async () => understood },
    readSource: async url => source(url, 'Public documentation editor introduction. '.repeat(5)) });
  const original = getProjectOnboarding(projectId)!;
  reviseProjectOnboarding(projectId, '只为作者服务', 'revision-failure');
  let calls = 0;
  const failing = { model: { generateObject: async () => { calls += 1; throw new Error('private provider detail'); } } };
  await startProjectOnboarding(projectId, failing);
  assert.equal(calls, 1);
  assert.equal(getProjectOnboarding(projectId)?.status, 'failed');
  assert.equal(getProjectOnboarding(projectId)?.error?.includes('private provider detail'), false);
  assert.equal(getProjectOnboarding(projectId)?.revision?.feedback, '只为作者服务');
  assert.equal(getProjectOnboarding(projectId)?.revision?.completedAt, undefined);
  assert.deepEqual(getProjectOnboarding(projectId)?.analysis, original.analysis);
  assert.equal(loadProjectSeed(projectId).project.description, understood.summary);
  assert.equal(reviseProjectOnboarding(projectId, '只为作者服务', 'revision-failure').started, false);
  await startProjectOnboarding(projectId, failing);
  assert.equal(calls, 1, 'failed work is not implicitly retried');
  assert.equal(retryProjectOnboarding(projectId, 'revision-failure').started, true);
  const runtime = { model: { generateObject: async () => { calls += 1; return { ...understood, audience: '作者', unknowns: [] }; } } };
  const first = startProjectOnboarding(projectId, runtime);
  const second = startProjectOnboarding(projectId, runtime);
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  assert.equal(getProjectOnboarding(projectId)?.status, 'ready');
  assert.ok(getProjectOnboarding(projectId)?.revision?.completedAt);
});

test('revision reuses SQLite evidence after JSON assets are cleared and blocks only when saved evidence is missing', async () => {
  const projectId = createProjectOnboarding({ kind: 'company', url: 'https://www.example.com/intro' }).project.id;
  await analyzeProjectOnboarding(projectId, { model: { generateObject: async () => understood },
    readSource: async url => source(url, 'Public documentation editor introduction. '.repeat(5)) });
  updateRuntimeProjectSeed(projectId, { assets: [] });
  reviseProjectOnboarding(projectId, '先用已保存的资料更新定位', 'sqlite-source');
  let calls = 0;
  await analyzeProjectOnboarding(projectId, { model: { generateObject: async () => { calls += 1; return understood; } } });
  assert.equal(calls, 1);
  assert.equal(getProjectOnboarding(projectId)?.status, 'ready');
  const directory = withGeoProject(projectId, projectDataDirectory);
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(directory, `db.sqlite${suffix}`), { force: true });
  reviseProjectOnboarding(projectId, '再次更新定位', 'missing-source');
  await analyzeProjectOnboarding(projectId, { model: { generateObject: async () => { calls += 1; return understood; } } });
  assert.equal(calls, 1, 'missing SQLite and JSON evidence blocks before another model call');
  assert.equal(getProjectOnboarding(projectId)?.status, 'failed');
  assert.match(getProjectOnboarding(projectId)?.error ?? '', /公开正文不足/);
  assert.equal(getProjectOnboarding(projectId)?.analysis?.summary, understood.summary);
});

test('long corrections preserve full local history while model and planning handoffs stay bounded', async () => {
  const projectId = createProjectOnboarding({ kind: 'company', url: 'https://www.example.com/intro', notes: '目标'.repeat(2000) }).project.id;
  let calls = 0;
  const model: GeoStructuredModel = { generateObject: async input => {
    calls += 1;
    const payload = JSON.parse(input.messages[1].content as string);
    assert.ok(Buffer.byteLength(JSON.stringify({ messages: input.messages, schema: z.toJSONSchema(input.schema) }), 'utf8') <= 98304);
    assert.ok(payload.sources[0].text.length > 0);
    assert.equal(payload.sources[0].excerpt, true);
    if (payload.currentRevisionId) {
      assert.equal(payload.userCorrections.length, 1);
      assert.equal(payload.userCorrections[0].id, payload.currentRevisionId);
      assert.equal(payload.userCorrections[0].feedback.length, 4000);
    }
    return { ...understood, unknowns: [] };
  } };
  await analyzeProjectOnboarding(projectId, { model,
    readSource: async url => source(url, 'Documentation "quoted" input and output. '.repeat(4000)) });
  for (let index = 0; index < 8; index++) {
    reviseProjectOnboarding(projectId, `第${index}次` + '补'.repeat(3997), `long-${index}`);
    await analyzeProjectOnboarding(projectId, { model });
    assert.equal(getProjectOnboarding(projectId)?.status, 'ready');
  }
  assert.equal(calls, 9);
  const record = getProjectOnboarding(projectId)!;
  assert.equal(record.revisionHistory?.length, 7);
  assert.equal(record.revisionHistory?.[0].feedback.length, 4000);
  const handoff = getProjectOnboardingPlanningContext(projectId)!;
  assert.equal(handoff.userCorrections.length, 1);
  assert.equal(handoff.userCorrections[0].id, 'long-7');
});

test('uiLanguage=en forwards outputLanguage=en and accepts natural English understanding lengths', async () => {
  const created = createProjectOnboarding({
    kind: 'company',
    url: 'https://www.example.com/en-app',
    targetLanguage: 'en',
    uiLanguage: 'en',
  });
  const englishSummary =
    'Open-source AI search visibility workbench that tracks how ChatGPT and Google AI Overview cite your product and tears down top cited competitor pages.';
  const englishOutput = {
    summary: englishSummary,
    audience: 'Best suited for indie SaaS founders, open-source maintainers, and AI coding builders seeking organic AI search discovery.',
    capabilities: [
      'AI Visibility Audit: Track brand mentions and citations across ChatGPT and Google AI Overview on real buyer queries.',
      'Winner Teardown: Extract opening hooks and structure from top cited pages before drafting English articles.',
    ],
    unknowns: ['Live ChatGPT and Google answers have not yet been collected for this project.'],
  };
  await analyzeProjectOnboarding(created.project.id, {
    readSource: async (url) =>
      source(url, 'A public product homepage explaining AI search visibility tracking and citation audits. '.repeat(4)),
    model: {
      generateObject: async (input) => {
        const payload = JSON.parse(input.messages[1].content as string);
        assert.equal(payload.outputLanguage, 'en');
        return englishOutput;
      },
    },
  });
  const record = getProjectOnboarding(created.project.id)!;
  assert.equal(record.status, 'ready');
  assert.equal(record.uiLanguage, 'en');
  assert.equal(record.analysis?.summary, englishSummary);
});

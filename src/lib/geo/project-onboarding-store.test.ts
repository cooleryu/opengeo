import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/geo/projects/route';
import { loadProjectSeed, readProjectCatalog, readRuntimeProjects, writeRuntimeProjects } from './project-data';
import { listGeoProjectIds, listGeoProjects, projectDataDirectory, resolveGeoProject, withGeoProject } from './projects';
import { createProjectOnboarding, getProjectOnboarding, isPublicProjectAddress, normalizeProjectEntryUrl,
  completeProjectOnboarding, getProjectOnboardingPlanningContext, retryProjectOnboarding, reviseProjectOnboarding,
  updateProjectOnboarding, updateRuntimeProjectSeed } from './project-onboarding-store';

const prior = { data: process.env.DATA_DIR, projects: process.env.GEO_LOCAL_PROJECTS_DIR };
let temporary: string;
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-onboarding-store-'));
  process.env.DATA_DIR = temporary;
  process.env.GEO_LOCAL_PROJECTS_DIR = prior.projects;
});
afterEach(() => {
  process.env.DATA_DIR = prior.data;
  process.env.GEO_LOCAL_PROJECTS_DIR = prior.projects;
  fs.rmSync(temporary, { recursive: true, force: true });
});
const input = { kind: 'repository', url: 'https://github.com/synthetic/new-project', notes: 'Synthetic offline input.', requestId: 'request-1' };
const request = (body: unknown, extra: Record<string, string> = {}) => new NextRequest('http://localhost/api/geo/projects', {
  method: 'POST', headers: { host: '127.0.0.1:4327', origin: 'http://127.0.0.1:4327', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
});

test('empty installations exclude examples and first real project uses its own data directory', async () => {
  process.env.GEO_LOCAL_PROJECTS_DIR = path.join(temporary, 'empty-local-projects');
  assert.deepEqual(readProjectCatalog().ids, []);
  const initial = await GET(new NextRequest('http://localhost/api/geo/projects'));
  assert.deepEqual(await initial.json(), { projects: [], hasProjects: false });
  const created = createProjectOnboarding(input);
  assert.equal(created.created, true);
  assert.match(created.project.id, /^project-[a-f0-9]{24}$/);
  assert.equal(resolveGeoProject(null), created.project.id);
  assert.deepEqual(listGeoProjects(), [created.project]);
  assert.equal(withGeoProject(created.project.id, projectDataDirectory), path.join(temporary, 'data/projects', created.project.id));
  assert.equal(fs.existsSync(path.join(temporary, 'data/db.sqlite')), false);
});

test('new catalog entries persist without changing old manifest, project IDs or data roots', () => {
  const manifestFile = path.join(prior.projects!, 'projects.json');
  const manifest = fs.readFileSync(manifestFile, 'utf8');
  const oldSeed = loadProjectSeed('sample-project');
  const first = createProjectOnboarding(input);
  const second = createProjectOnboarding({ ...input, url: 'https://www.example.com/product', requestId: 'request-2', kind: 'company' });
  assert.deepEqual(listGeoProjectIds(), ['sample-project', 'sample-project-two', first.project.id, second.project.id]);
  assert.equal(withGeoProject('sample-project', projectDataDirectory), path.join(temporary, 'data'));
  assert.equal(withGeoProject('sample-project-two', projectDataDirectory), path.join(temporary, 'data/projects/sample-project-two'));
  assert.notEqual(withGeoProject(first.project.id, projectDataDirectory), withGeoProject(second.project.id, projectDataDirectory));
  assert.deepEqual(loadProjectSeed('sample-project'), oldSeed);
  assert.equal(fs.readFileSync(manifestFile, 'utf8'), manifest);
  assert.equal(readRuntimeProjects().length, 2);
  assert.throws(() => resolveGeoProject('../sample-project'), /没有找到/);
});

test('canonical URL and request duplicates reuse the record without replacing user input or restarting', () => {
  const created = createProjectOnboarding(input);
  updateProjectOnboarding(created.project.id, { status: 'failed', message: 'Synthetic failure', error: 'Offline test' });
  const again = createProjectOnboarding({ ...input, url: 'https://GITHUB.com/Synthetic/New-Project.git/?utm_source=test#readme', notes: 'must not overwrite' });
  assert.equal(again.created, false);
  assert.equal(again.project.id, created.project.id);
  assert.equal(again.onboarding?.status, 'failed');
  assert.equal(again.onboarding?.notes, input.notes);
  assert.equal(readRuntimeProjects().length, 1);
  assert.throws(() => createProjectOnboarding({ ...input, url: 'https://example.com/other' }), /已用于另一条链接/);
});

test('existing read-only project URL returns null onboarding and never writes a runtime entry', async () => {
  const existing = createProjectOnboarding({ ...input, url: 'https://github.com/example/sample-project' });
  assert.equal(existing.project.id, 'sample-project');
  assert.equal(existing.onboarding, null);
  assert.equal(existing.created, false);
  const response = await POST(request({ ...input, url: 'https://github.com/example/sample-project' }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).onboarding, null);
  assert.equal(readRuntimeProjects().length, 0);
});

test('interrupted work becomes failed; explicit retry is idempotent and analysis updates only the new seed', async () => {
  const created = createProjectOnboarding(input);
  const entries = readRuntimeProjects();
  entries[0].owner = { pid: process.pid, token: 'previous-process' };
  entries[0].onboarding.status = 'analyzing';
  writeRuntimeProjects(entries);
  assert.equal(getProjectOnboarding(created.project.id)?.status, 'failed');
  assert.equal(retryProjectOnboarding(created.project.id).started, true);
  assert.equal(retryProjectOnboarding(created.project.id).started, false);
  const analysis = { summary: 'Synthetic tested summary', audience: 'Test users', capabilities: ['Declared capability'], unknowns: ['Actual effect unverified'] };
  updateRuntimeProjectSeed(created.project.id, { project: { ...created.project, description: analysis.summary } });
  updateProjectOnboarding(created.project.id, { status: 'ready', message: '已完成', analysis });
  const response = await GET(new NextRequest(`http://localhost/api/geo/projects?project=${created.project.id}`));
  const result = await response.json();
  assert.equal(result.project.description, analysis.summary);
  assert.deepEqual(result.onboarding.analysis, analysis);
  assert.equal(result.onboarding.error, undefined);
  assert.equal(retryProjectOnboarding(created.project.id).started, false);
  assert.throws(() => updateRuntimeProjectSeed('sample-project', { assets: [] }), /没有找到/);
});

test('unsafe, credential-bearing and overlong input is rejected before persistence', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/file', 'http://localhost', 'http://sub.localhost', 'http://intranet',
    'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://10.0.0.1', 'http://192.168.1.1', 'http://[::1]',
    'http://[::ffff:127.0.0.1]', 'https://example.com:8080', 'https://user:secret@example.com', 'https://example.com?api_key=secret']) {
    assert.throws(() => createProjectOnboarding({ ...input, url }), /公开|账号密码|端口|密钥/);
  }
  assert.throws(() => createProjectOnboarding({ ...input, notes: 'x'.repeat(4001) }), /4000/);
  assert.throws(() => createProjectOnboarding({ ...input, requestId: '../unsafe' }), /标识/);
  assert.equal(readRuntimeProjects().length, 0);
  assert.equal(normalizeProjectEntryUrl('https://example.com/path/?b=2&a=1#x'), 'https://example.com/path?a=1&b=2');
  for (const address of ['0.0.0.0', '100.64.0.1', '169.254.169.254', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '::ffff:8.8.8.8', '2001:0000::1', '2001:0db8::1', '2001:2::1', '2002:7f00:1::1', '3fff::1', 'fc00::1']) {
    assert.equal(isPublicProjectAddress(address), false, address);
  }
  assert.equal(isPublicProjectAddress('8.8.8.8'), true);
  assert.equal(isPublicProjectAddress('2606:4700:4700::1111'), true);
});

test('POST rejects cross-origin and malformed input before any creation or analysis', async () => {
  const headers: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: '' }, { 'sec-fetch-site': 'cross-site' }];
  for (const extra of headers) {
    assert.equal((await POST(request(input, extra))).status, 403);
  }
  assert.equal((await POST(request(input, { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await POST(request({ kind: 'company', url: 'http://127.0.0.1' }))).status, 400);
  assert.equal((await POST(request({ ...input, notes: 'x'.repeat(21_000) }))).status, 413);
  assert.equal((await POST(request({ action: 'retry', projectId: '../unsafe' }))).status, 404);
  assert.equal((await GET(new NextRequest('http://localhost/api/geo/projects?project=unknown'))).status, 404);
  assert.equal(readRuntimeProjects().length, 0);
});

test('revisions save feedback before execution, retain old understanding and are idempotent across status reads', async () => {
  const { project } = createProjectOnboarding(input);
  const original = { summary: '原项目定位', audience: '原受众', capabilities: ['原能力声明'], unknowns: [] };
  completeProjectOnboarding(project.id, original);
  const body = { action: 'revise', projectId: project.id, feedback: ' 面向独立作者，优先内容复用。 ', requestId: 'revision-1' };
  const saved = reviseProjectOnboarding(project.id, body.feedback, body.requestId);
  assert.equal(saved.started, true);
  assert.equal(saved.onboarding.status, 'queued');
  assert.equal(saved.onboarding.revision?.feedback, body.feedback.trim());
  assert.equal(saved.onboarding.revision?.completedAt, undefined);
  assert.deepEqual(saved.onboarding.revision?.previousAnalysis, original);
  assert.deepEqual(saved.onboarding.analysis, original);
  assert.equal(saved.project.description, original.summary);
  assert.equal(saved.onboarding.notes, input.notes);
  assert.throws(() => getProjectOnboardingPlanningContext(project.id), /先完成项目理解/);
  assert.throws(() => reviseProjectOnboarding(project.id, '另一条反馈', body.requestId), /已保存其他/);
  assert.throws(() => reviseProjectOnboarding(project.id, '另一条反馈', 'revision-2'), /正在理解/);
  const stored = fs.readFileSync(path.join(temporary, 'data/created-projects/projects.json'), 'utf8');
  for (let index = 0; index < 2; index++) {
    const get = await GET(new NextRequest(`http://localhost/api/geo/projects?project=${project.id}`));
    assert.equal((await get.json()).onboarding.status, 'queued');
    const post = await POST(request(body));
    assert.equal(post.status, 200);
    assert.equal((await post.json()).onboarding.revision.id, body.requestId);
  }
  assert.equal(fs.readFileSync(path.join(temporary, 'data/created-projects/projects.json'), 'utf8'), stored);
  assert.equal(reviseProjectOnboarding(project.id, body.feedback, body.requestId).started, false);
});

test('revision failure requires explicit retry; completed revision and prior results survive later requests', () => {
  const { project } = createProjectOnboarding(input);
  const original = { summary: '原定位', audience: '原受众', capabilities: ['原能力'], unknowns: [] };
  completeProjectOnboarding(project.id, original);
  reviseProjectOnboarding(project.id, '独立作者需要内容复用', 'revision-1');
  updateProjectOnboarding(project.id, { status: 'failed', message: 'Synthetic failure', error: 'Offline test' });
  assert.equal(reviseProjectOnboarding(project.id, '独立作者需要内容复用', 'revision-1').started, false);
  assert.throws(() => retryProjectOnboarding(project.id, 'wrong-request'), /修订已变化/);
  assert.equal(retryProjectOnboarding(project.id, 'revision-1').started, true);
  assert.equal(retryProjectOnboarding(project.id, 'revision-1').started, false);
  const revised = { ...original, summary: '独立作者的内容复用工具', audience: '独立作者' };
  completeProjectOnboarding(project.id, revised);
  const record = getProjectOnboarding(project.id)!;
  assert.ok(record.revision?.completedAt);
  assert.equal(record.error, undefined);
  assert.equal(loadProjectSeed(project.id).project.description, revised.summary);
  assert.deepEqual(readRuntimeProjects()[0].onboarding.analysis, revised);
  const context = getProjectOnboardingPlanningContext(project.id)!;
  assert.equal(context.summary, revised.summary);
  assert.equal(context.audience, revised.audience);
  assert.equal(context.userGoalsAndConstraints, input.notes);
  assert.deepEqual(context.userCorrections, [{ id: 'revision-1', feedback: '独立作者需要内容复用' }]);
  assert.equal(context.userInputIsPublicEvidence, false);
  reviseProjectOnboarding(project.id, '只考虑中文内容', 'revision-2');
  const second = getProjectOnboarding(project.id)!;
  assert.deepEqual(second.revision?.previousAnalysis, revised);
  assert.deepEqual(second.revisionHistory?.[0].previousAnalysis, original);
  assert.equal(reviseProjectOnboarding(project.id, '独立作者需要内容复用', 'revision-1').started, false);
  assert.equal(getProjectOnboarding(project.id)?.revision?.id, 'revision-2');
});

test('invalid revision input and read-only projects cannot create or change a revision', async () => {
  const { project } = createProjectOnboarding(input);
  const original = { summary: '原定位', audience: '原受众', capabilities: [], unknowns: [] };
  completeProjectOnboarding(project.id, original);
  for (const feedback of ['', '  ', null, 'x'.repeat(4001)]) {
    assert.equal((await POST(request({ action: 'revise', projectId: project.id, feedback, requestId: 'revision-1' }))).status, 400);
  }
  for (const requestId of [undefined, '../unsafe', 'x'.repeat(129)]) {
    assert.equal((await POST(request({ action: 'revise', projectId: project.id, feedback: '新定位', requestId }))).status, 400);
  }
  assert.equal((await POST(request({ action: 'revise', projectId: 'sample-project', feedback: '新定位', requestId: 'revision-1' }))).status, 409);
  assert.equal(getProjectOnboardingPlanningContext('sample-project'), null);
  assert.equal(getProjectOnboarding(project.id)?.revision, undefined);
  assert.deepEqual(getProjectOnboarding(project.id)?.analysis, original);
});

test('a failed correction can be replaced explicitly without losing failed feedback or the last successful analysis', () => {
  const { project } = createProjectOnboarding(input);
  const original = { summary: '原定位', audience: '原受众', capabilities: [], unknowns: [] };
  completeProjectOnboarding(project.id, original);
  reviseProjectOnboarding(project.id, '需要修改的旧补充', 'revision-failed');
  updateProjectOnboarding(project.id, { status: 'failed', message: 'Input too long', error: 'Input too long' });
  const next = reviseProjectOnboarding(project.id, '改短后的补充', 'revision-replacement');
  assert.equal(next.started, true);
  assert.equal(next.onboarding.status, 'queued');
  assert.equal(next.onboarding.revision?.feedback, '改短后的补充');
  assert.deepEqual(next.onboarding.revision?.previousAnalysis, original);
  assert.equal(next.onboarding.revisionHistory?.[0].feedback, '需要修改的旧补充');
  assert.equal(next.onboarding.revisionHistory?.[0].completedAt, undefined);
  assert.equal(reviseProjectOnboarding(project.id, '需要修改的旧补充', 'revision-failed').started, false);
});

test('targetLanguage persists on created projects when specified and rejects invalid values', () => {
  const created = createProjectOnboarding({
    ...input,
    url: 'https://github.com/synthetic/en-project',
    requestId: 'request-en-1',
    targetLanguage: 'en',
  });
  assert.equal(created.project.targetLanguage, 'en');
  assert.equal(created.onboarding?.targetLanguage, 'en');
  assert.equal(getProjectOnboarding(created.project.id)?.targetLanguage, 'en');
  assert.throws(
    () =>
      createProjectOnboarding({
        ...input,
        url: 'https://github.com/synthetic/fr-project',
        requestId: 'request-fr-1',
        targetLanguage: 'fr',
      }),
    /推广目标语言/,
  );
});

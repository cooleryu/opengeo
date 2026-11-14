import { NextRequest, NextResponse } from 'next/server';
import { projectResearchContext } from '@/lib/geo/project-research-context';
import { loadProjectSeed } from '@/lib/geo/project-data';
import { GeoProjectError, listGeoProjects, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';
import { getQuestionGeneration } from '@/lib/geo/store';
import { assertPublicProjectEntry, createProjectOnboarding, findExistingProject, getProjectOnboarding,
  ProjectOnboardingError, retryProjectOnboarding, reviseProjectOnboarding, updateProjectOnboarding, validateProjectCreation } from '@/lib/geo/project-onboarding-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('project');
    if (id !== null) {
      const projectId = resolveGeoProject(id);
      return NextResponse.json({ project: loadProjectSeed(projectId).project, onboarding: getProjectOnboarding(projectId),
        research: projectResearchContext(projectId), questionGeneration: withGeoProject(projectId, getQuestionGeneration) }, { headers });
    }
    const projects = listGeoProjects();
    return NextResponse.json({ projects, hasProjects: projects.length > 0 }, { headers });
  } catch (error) { return failure(error); }
}

function start(projectId: string): void {
  void import('@/lib/geo/project-onboarding-analysis').then(module => module.startProjectOnboarding(projectId)).catch(() => {
    updateProjectOnboarding(projectId, { status: 'failed', message: '项目理解未能启动，请重试。', error: '处理服务暂时不可用。' });
  });
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== `${url.protocol}//${authority}` || (site && site !== 'same-origin' && site !== 'none')) {
      throw new ProjectOnboardingError('只接受当前应用页面发起的操作。', 403);
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ProjectOnboardingError('请求须使用 JSON 格式。', 415);
    if (Number(request.headers.get('content-length')) > 20_000) throw new ProjectOnboardingError('提交内容过长。', 413);
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 20_000) throw new ProjectOnboardingError('提交内容过长。', 413);
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProjectOnboardingError('请求格式无效。');
    if (body.action === 'retry') {
      if (typeof body.projectId !== 'string' || !body.projectId) throw new ProjectOnboardingError('请选择需要重试的项目。');
      const result = retryProjectOnboarding(body.projectId, body.requestId, body.uiLanguage);
      if (result.started) start(result.project.id);
      return NextResponse.json({ project: result.project, onboarding: result.onboarding }, { headers });
    }
    if (body.action === 'revise') {
      if (typeof body.projectId !== 'string' || !body.projectId) throw new ProjectOnboardingError('请选择需要修订的项目。');
      const result = reviseProjectOnboarding(body.projectId, body.feedback, body.requestId, body.uiLanguage);
      if (result.started) start(result.project.id);
      return NextResponse.json({ project: result.project, onboarding: result.onboarding }, { headers });
    }
    if (body.action !== undefined) throw new ProjectOnboardingError('不支持这个操作。');
    const input = validateProjectCreation(body);
    if (!findExistingProject(input)) await assertPublicProjectEntry(input.url);
    const result = createProjectOnboarding(input);
    if (result.created) start(result.project.id);
    return NextResponse.json({ project: result.project, onboarding: result.onboarding }, { status: result.created ? 201 : 200, headers });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  const known = error instanceof ProjectOnboardingError || error instanceof GeoProjectError;
  return NextResponse.json({ error: known ? error.message : error instanceof SyntaxError ? '请求格式无效。' : '项目操作失败，请重试。' },
    { status: known ? error.status : error instanceof SyntaxError ? 400 : 500, headers });
}

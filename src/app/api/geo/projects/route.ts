import { NextRequest, NextResponse } from 'next/server';
import {
  localizeOnboardingRecord,
  resolveRequestUiLanguage,
  serverErrorResponse,
  translateServerCode,
} from '@/lib/geo/i18n-server';
import { projectResearchContext } from '@/lib/geo/project-research-context';
import { loadProjectSeed } from '@/lib/geo/project-data';
import { listGeoProjects, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';
import { getQuestionGeneration } from '@/lib/geo/store';
import {
  assertPublicProjectEntry,
  createProjectOnboarding,
  findExistingProject,
  getProjectOnboarding,
  ProjectOnboardingError,
  retryProjectOnboarding,
  reviseProjectOnboarding,
  updateProjectOnboarding,
  validateProjectCreation,
} from '@/lib/geo/project-onboarding-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const lang = resolveRequestUiLanguage(request);
  try {
    const id = request.nextUrl.searchParams.get('project');
    if (id !== null) {
      const projectId = resolveGeoProject(id);
      return NextResponse.json(
        {
          project: loadProjectSeed(projectId).project,
          onboarding: localizeOnboardingRecord(getProjectOnboarding(projectId), lang),
          research: projectResearchContext(projectId),
          questionGeneration: withGeoProject(projectId, getQuestionGeneration),
        },
        { headers },
      );
    }
    const projects = listGeoProjects();
    return NextResponse.json({ projects, hasProjects: projects.length > 0 }, { headers });
  } catch (error) {
    return serverErrorResponse(error, lang);
  }
}

function start(projectId: string): void {
  void import('@/lib/geo/project-onboarding-analysis')
    .then((module) => module.startProjectOnboarding(projectId))
    .catch(() => {
      updateProjectOnboarding(projectId, {
        status: 'failed',
        messageCode: 'onboarding.status.startFailed',
        message: translateServerCode('zh', 'onboarding.status.startFailed'),
        errorCode: 'internal_error',
        error: translateServerCode('zh', 'internal_error'),
      });
    });
}

export async function POST(request: NextRequest) {
  let lang = resolveRequestUiLanguage(request);
  try {
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    const site = request.headers.get('sec-fetch-site');
    if (
      request.headers.get('origin') !== `${url.protocol}//${authority}` ||
      (site && site !== 'same-origin' && site !== 'none')
    ) {
      throw new ProjectOnboardingError('forbidden_origin', 403);
    }
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      throw new ProjectOnboardingError('invalid_request', 415);
    }
    if (Number(request.headers.get('content-length')) > 20_000) {
      throw new ProjectOnboardingError('input_too_large', 413);
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 20_000) {
      throw new ProjectOnboardingError('input_too_large', 413);
    }
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ProjectOnboardingError('invalid_request', 400);
    }
    lang = resolveRequestUiLanguage(request, body);
    if (body.action === 'retry') {
      if (typeof body.projectId !== 'string' || !body.projectId) {
        throw new ProjectOnboardingError('invalid_request', 400);
      }
      const result = retryProjectOnboarding(body.projectId, body.requestId, body.uiLanguage ?? lang);
      if (result.started) start(result.project.id);
      return NextResponse.json(
        { project: result.project, onboarding: localizeOnboardingRecord(result.onboarding, lang) },
        { headers },
      );
    }
    if (body.action === 'revise') {
      if (typeof body.projectId !== 'string' || !body.projectId) {
        throw new ProjectOnboardingError('invalid_request', 400);
      }
      const result = reviseProjectOnboarding(
        body.projectId,
        body.feedback,
        body.requestId,
        body.uiLanguage ?? lang,
      );
      if (result.started) start(result.project.id);
      return NextResponse.json(
        { project: result.project, onboarding: localizeOnboardingRecord(result.onboarding, lang) },
        { headers },
      );
    }
    if (body.action !== undefined) {
      throw new ProjectOnboardingError('invalid_request', 400);
    }
    const input = validateProjectCreation(
      (body.uiLanguage === undefined ? { ...body, uiLanguage: lang } : body) as Parameters<
        typeof validateProjectCreation
      >[0],
    );
    if (!findExistingProject(input)) await assertPublicProjectEntry(input.url);
    const result = createProjectOnboarding(input);
    if (result.created) start(result.project.id);
    return NextResponse.json(
      { project: result.project, onboarding: localizeOnboardingRecord(result.onboarding, lang) },
      { status: result.created ? 201 : 200, headers },
    );
  } catch (error) {
    return serverErrorResponse(error, lang);
  }
}

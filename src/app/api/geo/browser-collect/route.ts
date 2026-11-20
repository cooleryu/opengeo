import { NextRequest, NextResponse } from 'next/server';
import {
  getBrowserCollectStatus,
  startBrowserCollectJob,
  stopBrowserCollectJob,
} from '@/lib/geo/browser-collect-runner';
import { requireBrowserCollectionRequest } from '@/lib/geo/browser-collection';
import {
  localizeBrowserCollectSnapshot,
  resolveRequestUiLanguage,
  serverErrorResponse,
} from '@/lib/geo/i18n-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  const lang = resolveRequestUiLanguage(request);
  try {
    requireBrowserCollectionRequest(request, false);
    const project = request.nextUrl.searchParams.get('project') || undefined;
    return NextResponse.json(
      { job: localizeBrowserCollectSnapshot(getBrowserCollectStatus(project), lang) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return serverErrorResponse(error, lang);
  }
}

export async function POST(request: NextRequest) {
  let lang = resolveRequestUiLanguage(request);
  try {
    requireBrowserCollectionRequest(request, true);
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return serverErrorResponse({ code: 'invalid_request', status: 400 }, lang);
    }
    lang = resolveRequestUiLanguage(request, body);
    const action = body.action;
    if (action === 'stop') {
      return NextResponse.json({ job: localizeBrowserCollectSnapshot(stopBrowserCollectJob(), lang) });
    }
    if (action === 'start') {
      const requestUrl = new URL(request.url);
      const authority = request.headers.get('host') || requestUrl.host;
      const baseOrigin = `${requestUrl.protocol}//${authority}`;
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      const engine =
        body.engine === 'chatgpt' || body.engine === 'google' || body.engine === 'all'
          ? body.engine
          : 'all';
      const force = Boolean(body.force);
      const since = typeof body.since === 'string' ? body.since.trim() : undefined;
      const questionIds = Array.isArray(body.questionIds)
        ? body.questionIds.filter((item): item is string => typeof item === 'string')
        : undefined;
      const optimizationRunId =
        typeof body.optimizationRunId === 'string' ? body.optimizationRunId : undefined;
      const spaceId =
        typeof body.spaceId === 'number' && Number.isSafeInteger(body.spaceId)
          ? body.spaceId
          : undefined;

      const job = startBrowserCollectJob({
        projectId,
        baseOrigin,
        engine,
        force,
        since: since || undefined,
        questionIds,
        optimizationRunId,
        spaceId,
      });
      return NextResponse.json({ job: localizeBrowserCollectSnapshot(job, lang) });
    }
    return serverErrorResponse({ code: 'invalid_request', status: 400 }, lang);
  } catch (error) {
    return serverErrorResponse(error, lang);
  }
}

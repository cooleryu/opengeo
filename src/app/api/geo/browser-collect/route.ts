import { NextRequest, NextResponse } from 'next/server';
import {
  getBrowserCollectStatus,
  startBrowserCollectJob,
  stopBrowserCollectJob,
} from '@/lib/geo/browser-collect-runner';
import {
  BrowserCollectionError,
  requireBrowserCollectionRequest,
} from '@/lib/geo/browser-collection';
import { GeoProjectError } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  try {
    requireBrowserCollectionRequest(request, false);
    const project = request.nextUrl.searchParams.get('project') || undefined;
    return NextResponse.json(
      { job: getBrowserCollectStatus(project) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireBrowserCollectionRequest(request, true);
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: '请求格式无效。' }, { status: 400 });
    }
    const action = body.action;
    if (action === 'stop') {
      return NextResponse.json({ job: stopBrowserCollectJob() });
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
      return NextResponse.json({ job });
    }
    return NextResponse.json({ error: '不支持的浏览器采集操作。' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '浏览器采集请求失败。';
  const status =
    error instanceof BrowserCollectionError || error instanceof GeoProjectError
      ? error.status
      : error instanceof SyntaxError
        ? 400
        : 500;
  return NextResponse.json({ error: message }, { status });
}

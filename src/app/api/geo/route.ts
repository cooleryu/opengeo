import { NextRequest, NextResponse } from 'next/server';
import { GeoError, getGeoState, handleGeoAction } from '@/lib/geo/store';
import { startGeoScheduler } from '@/lib/geo/scheduler';
import { GeoProjectError, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try { return withGeoProject(request.nextUrl.searchParams.get('project'), () => {
    startGeoScheduler();
    return NextResponse.json(getGeoState(), { headers: { 'Cache-Control': 'no-store' } });
  }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    // Next may normalize request.url to localhost even when the browser uses
    // 127.0.0.1. Compare the Origin to the actual request authority instead.
    const requestUrl = new URL(request.url);
    const authority = request.headers.get('host') || requestUrl.host;
    if (origin && origin !== `${requestUrl.protocol}//${authority}`) throw new GeoError('只接受当前应用页面发起的操作。', 403);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GeoError('请求格式无效。');
    return await withGeoProject(body.projectId, async () => {
      startGeoScheduler();
      return NextResponse.json(await handleGeoAction(body), { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) { return failure(error); }
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '操作失败，请重试。';
  return NextResponse.json({ error: message }, { status: error instanceof GeoError || error instanceof GeoProjectError ? error.status : error instanceof SyntaxError ? 400 : 500 });
}

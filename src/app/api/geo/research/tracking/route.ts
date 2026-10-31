import { NextRequest, NextResponse } from 'next/server';
import { GeoProjectError, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';
import { ResearchStoreError } from '@/lib/geo/research-store';
import { createResearchSchedule, listResearchSchedules, ResearchTrackingError, updateResearchSchedule } from '@/lib/geo/research-tracking';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (data: unknown) => NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  try {
    const projectId = resolveGeoProject(request.nextUrl.searchParams.get('project'));
    return withGeoProject(projectId, () => response({ plans: listResearchSchedules(projectId) }));
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    if (origin && origin !== `${url.protocol}//${request.headers.get('host') || url.host}`) throw new ResearchTrackingError('只接受当前应用页面发起的操作。', 403);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResearchTrackingError('请求格式无效。');
    const projectId = resolveGeoProject(body.projectId);
    return withGeoProject(projectId, () => {
      if (body.action === 'create') createResearchSchedule({ ...body, projectId });
      else if (['pause', 'resume', 'stop'].includes(body.action) && typeof body.planId === 'string') updateResearchSchedule(projectId, body.planId, body.action);
      else throw new ResearchTrackingError('请选择创建、暂停、恢复或停止跟踪。');
      return response({ plans: listResearchSchedules(projectId) });
    });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  const status = error instanceof ResearchTrackingError || error instanceof GeoProjectError || error instanceof ResearchStoreError
    ? error.status : error instanceof SyntaxError ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : '跟踪操作失败，未自动重试。' }, { status });
}

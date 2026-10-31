import { NextRequest, NextResponse } from 'next/server';
import { GeoProjectError, resolveGeoProject } from '@/lib/geo/projects';
import {
  getTrafficRange,
  getTrafficSnapshot,
  TrafficRequestError,
} from '@/lib/geo/traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  try {
    const query = request.nextUrl.searchParams;
    const project = query.get('project');
    if (!project) throw new TrafficRequestError('请指定要查看的项目。');
    const projectId = resolveGeoProject(project);
    const range = getTrafficRange(query.get('startDate'), query.get('endDate'));
    return NextResponse.json(await getTrafficSnapshot(projectId, range), {
      headers,
    });
  } catch (error) {
    const known =
      error instanceof TrafficRequestError || error instanceof GeoProjectError;
    return NextResponse.json(
      { error: known ? error.message : '访问统计暂时无法读取。' },
      { status: known ? error.status : 500, headers },
    );
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { GeoProjectError, resolveGeoProject } from '@/lib/geo/projects';
import { checkProjectRobotsTxt } from '@/lib/geo/robots-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const projectId = resolveGeoProject(
      request.nextUrl.searchParams.get('project') || undefined,
    );
    const check = await checkProjectRobotsTxt(projectId);
    return NextResponse.json(
      { check },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'robots.txt 检查失败。';
    const status = error instanceof GeoProjectError ? error.status : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

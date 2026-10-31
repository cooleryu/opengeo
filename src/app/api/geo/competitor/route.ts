import { NextRequest, NextResponse } from 'next/server';
import {
  CompetitorError,
  getCompetitorComparison,
  saveCompetitorTarget,
} from '@/lib/geo/competitors';
import { GeoProjectError, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : '对标设置保存失败。' },
    {
      status:
        error instanceof CompetitorError || error instanceof GeoProjectError
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 500,
    },
  );
}

export async function GET(request: NextRequest) {
  try {
    return withGeoProject(request.nextUrl.searchParams.get('project'), () =>
      NextResponse.json(
        getCompetitorComparison(
          request.nextUrl.searchParams.get('batch') ?? undefined,
        ),
        {
          headers: { 'Cache-Control': 'no-store' },
        },
      ),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    const requestUrl = new URL(request.url);
    const authority = request.headers.get('host') || requestUrl.host;
    if (origin && origin !== `${requestUrl.protocol}//${authority}`)
      throw new CompetitorError('只接受当前应用页面发起的操作。', 403);
    const body = await request.json();
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.projectId !== 'string'
    )
      throw new CompetitorError('请求格式无效。');
    return withGeoProject(body.projectId, () => {
      // Validate the requested batch before changing the project's Target.
      if (body.batchId !== undefined) getCompetitorComparison(body.batchId);
      saveCompetitorTarget(body.target, body.batchId);
      return NextResponse.json(getCompetitorComparison(body.batchId), {
        headers: { 'Cache-Control': 'no-store' },
      });
    });
  } catch (error) {
    return failure(error);
  }
}

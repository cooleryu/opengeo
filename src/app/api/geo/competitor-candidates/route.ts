import { NextRequest, NextResponse } from 'next/server';
import {
  analyzeCompetitorCandidates,
  auditCompetitorCandidateCitations,
  getCompetitorCandidates,
  updateCompetitorCandidate,
} from '@/lib/geo/competitor-candidates';
import { CompetitorError } from '@/lib/geo/competitors';
import { GeoProjectError, withGeoProject } from '@/lib/geo/projects';
import { isResearchEngine } from '@/lib/geo/research-engines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function scope(language: unknown, engine: unknown) {
  if (language != null && language !== 'zh' && language !== 'en')
    throw new CompetitorError('语言范围无效。');
  if (engine != null && engine !== 'all' && !isResearchEngine(engine))
    throw new CompetitorError('平台范围无效。');
  return {
    language: language === 'en' ? 'en' as const : 'zh' as const,
    engine: isResearchEngine(engine) ? engine : 'all' as const,
  };
}

function failure(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : '候选读取失败。' },
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
    const params = request.nextUrl.searchParams;
    return withGeoProject(params.get('project'), () =>
      NextResponse.json(
        getCompetitorCandidates(
          params.get('batch') ?? undefined,
          params.get('candidate') ?? undefined,
          scope(params.get('language'), params.get('engine')),
        ),
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    if (origin && origin !== `${url.protocol}//${authority}`)
      throw new CompetitorError('只接受当前应用页面发起的操作。', 403);
    const body = await request.json();
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.projectId !== 'string'
    )
      throw new CompetitorError('请求格式无效。');
    if (body.force !== undefined && typeof body.force !== 'boolean')
      throw new CompetitorError('重试参数格式无效。');
    const requestedScope = scope(body.language, body.engine);
    return await withGeoProject(body.projectId, async () => {
      if (body.action === 'analyze')
        await analyzeCompetitorCandidates(body.batchId, { force: body.force });
      else if (body.action === 'audit-citations')
        await auditCompetitorCandidateCitations(body.batchId, { force: true });
      else updateCompetitorCandidate(body.action, body.candidateId, body.batchId);
      return NextResponse.json(
        getCompetitorCandidates(body.batchId, undefined, requestedScope),
        { headers: { 'Cache-Control': 'no-store' } },
      );
    });
  } catch (error) {
    return failure(error);
  }
}

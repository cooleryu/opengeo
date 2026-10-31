import { NextRequest, NextResponse } from 'next/server';
import { getGeoState, GeoError } from '@/lib/geo/store';
import { GeoProjectError, withGeoProject, currentGeoProject } from '@/lib/geo/projects';
import { listResearchRuns, getResearchBatch } from '@/lib/geo/research';
import { collectResearch, recoverStoppedResearchRuns } from '@/lib/geo/research-collection';
import { requestResearchStop, ResearchStoreError } from '@/lib/geo/research-store';
import { buildQuestionDetail, parseQuestionDetailFilters } from '@/lib/geo/question-detail';
import { attachOverviewData } from '@/lib/geo/overview-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const response = (data: unknown) => NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  try {
    let filters;
    try { filters = parseQuestionDetailFilters(request.nextUrl.searchParams); }
    catch (error) { throw new GeoError(error instanceof Error ? error.message : '查询参数无效。', 400); }
    return withGeoProject(request.nextUrl.searchParams.get('project'), () => {
    recoverStoppedResearchRuns();
    const state = getGeoState();
    const batchId = request.nextUrl.searchParams.get('batch');
    const batch = batchId ? attachOverviewData(getResearchBatch(currentGeoProject(), batchId)) : state.latestResearch;
    if (batchId && !batch) throw new GeoError('没有找到当前项目的研究批次。', 404);
    const questionId = request.nextUrl.searchParams.get('question');
    const detail = questionId ? buildQuestionDetail(batch, currentGeoProject(), questionId, filters) : null;
    if (questionId && !detail) throw new GeoError('当前项目没有这道问题。', 404);
    return response({ batch, runs: listResearchRuns(currentGeoProject()), providers: state.settings.collectionProviders,
      ...(questionId ? { question: [...batch!.questions, ...batch!.deferredQuestions].find(q => q.id === questionId), detail } : {}) });
  }); } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    if (origin && origin !== `${url.protocol}//${request.headers.get('host') || url.host}`) throw new GeoError('只接受当前应用页面发起的操作。', 403);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GeoError('请求格式无效。');
    if (body.action === 'stop') {
      if (typeof body.projectId !== 'string' || typeof body.runId !== 'string' || !body.runId) throw new GeoError('缺少项目或搜索编号。');
      return withGeoProject(body.projectId, () => response({ run: requestResearchStop(currentGeoProject(), body.runId) }));
    }
    if (body.action !== undefined) throw new GeoError('搜索操作无效。');
    if (body.scheduleId !== undefined) throw new GeoError('跟踪搜索需由已保存的每日计划执行。');
    return await withGeoProject(body.projectId, async () => response(await collectResearch(body)));
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : '操作失败，未自动重试。' }, { status: error instanceof GeoError || error instanceof GeoProjectError || error instanceof ResearchStoreError ? error.status : error instanceof SyntaxError ? 400 : 500 });
}

import { NextRequest, NextResponse } from 'next/server';
import { GeoProjectError } from '@/lib/geo/projects';
import { getOverviewOrder, OverviewOrderError, saveOverviewOrder } from '@/lib/geo/overview-order-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export function GET(request: NextRequest) {
  try {
    return NextResponse.json(getOverviewOrder(request.nextUrl.searchParams.get('project')), { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    const site = request.headers.get('sec-fetch-site');
    if (request.headers.get('origin') !== `${url.protocol}//${authority}` ||
      (site && site !== 'same-origin' && site !== 'none')) {
      throw new OverviewOrderError('只接受当前应用页面发起的操作。', 403);
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      throw new OverviewOrderError('请使用 JSON 提交显示顺序。');
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 1_048_576) throw new OverviewOrderError('显示顺序内容过长。');
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OverviewOrderError('请求格式无效。');
    return NextResponse.json(saveOverviewOrder(body.projectId, body.questionIds), { headers });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  const known = error instanceof OverviewOrderError || error instanceof GeoProjectError;
  return NextResponse.json(
    { error: known ? error.message : error instanceof SyntaxError ? '请求格式无效。' : '暂时无法读取或保存显示顺序。' },
    { status: known ? error.status : error instanceof SyntaxError ? 400 : 500, headers },
  );
}

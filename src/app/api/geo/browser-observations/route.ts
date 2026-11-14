import { NextRequest, NextResponse } from 'next/server';
import { BrowserCollectionError, getBrowserObservation, ingestBrowserObservation, requireBrowserCollectionRequest } from '@/lib/geo/browser-collection';
import { GeoProjectError } from '@/lib/geo/projects';
import { ResearchStoreError } from '@/lib/geo/research-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 900;
const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(request: NextRequest) {
  try {
    requireBrowserCollectionRequest(request, true);
    const body = await request.text();
    if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) throw new BrowserCollectionError('浏览器采集超过 2 MiB，未入库。', 413);
    return response(await ingestBrowserObservation(JSON.parse(body)));
  } catch (error) { return failure(error); }
}

export function GET(request: NextRequest) {
  try {
    requireBrowserCollectionRequest(request);
    const projectId = request.nextUrl.searchParams.get('projectId');
    const captureId = request.nextUrl.searchParams.get('captureId');
    if (!projectId || !captureId) throw new BrowserCollectionError('读取采集进度需要 projectId 和 captureId。');
    return response(getBrowserObservation(projectId, captureId));
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  if (error instanceof BrowserCollectionError || error instanceof GeoProjectError || error instanceof ResearchStoreError) return response({ error: error.message }, error.status);
  return response({ error: error instanceof SyntaxError ? '请求不是有效的 JSON。' : '浏览器采集未完成；已保存的原文保留，请检查采集进度。' }, error instanceof SyntaxError ? 400 : 500);
}

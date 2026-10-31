import { NextRequest, NextResponse } from 'next/server';
import { GeoSettingsError, getGeoConnectionSettings, saveGeoConnectionSettings } from '@/lib/geo/connection-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET() {
  try { return NextResponse.json(getGeoConnectionSettings(), { headers }); }
  catch (error) { return failure(error); }
}

export async function PUT(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    if ((origin && origin !== `${url.protocol}//${authority}`) || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new GeoSettingsError('只接受当前应用页面发起的操作。', 403);
    }
    if (!request.headers.get('content-type')?.includes('application/json')) throw new GeoSettingsError('请使用 JSON 提交设置。');
    const body = await request.text();
    if (body.length > 16_384) throw new GeoSettingsError('设置内容过长。');
    return NextResponse.json(saveGeoConnectionSettings(JSON.parse(body)), { headers });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof GeoSettingsError ? error.message : '设置请求失败，请检查填写内容后重试。' },
    { status: error instanceof GeoSettingsError ? error.status : error instanceof SyntaxError ? 400 : 500, headers });
}

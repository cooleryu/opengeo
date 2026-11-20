import { NextRequest, NextResponse } from 'next/server';
import { GeoSettingsError, getGeoConnectionSettings, saveGeoConnectionSettings } from '@/lib/geo/connection-settings';
import { resolveRequestUiLanguage, serverErrorResponse } from '@/lib/geo/i18n-server';
import { getGeoModelSettings } from '@/lib/geo/planner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  const lang = resolveRequestUiLanguage(request);
  try {
    return NextResponse.json(
      { ...getGeoConnectionSettings(), modelConfigured: getGeoModelSettings().modelConfigured },
      { headers },
    );
  } catch (error) {
    return serverErrorResponse(error, lang);
  }
}

export async function PUT(request: NextRequest) {
  const lang = resolveRequestUiLanguage(request);
  try {
    const origin = request.headers.get('origin');
    const url = new URL(request.url);
    const authority = request.headers.get('host') || url.host;
    if ((origin && origin !== `${url.protocol}//${authority}`) || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new GeoSettingsError('forbidden_origin', 403);
    }
    if (!request.headers.get('content-type')?.includes('application/json')) {
      throw new GeoSettingsError('invalid_request', 400);
    }
    const body = await request.text();
    if (body.length > 16_384) {
      throw new GeoSettingsError('input_too_large', 400);
    }
    const parsed = JSON.parse(body) as { section?: unknown };
    const saved = saveGeoConnectionSettings(parsed);
    if (parsed?.section === 'model') {
      const { setChatGPTAnalysisEnabled } = await import('@/lib/geo/chatgpt-auth');
      await setChatGPTAnalysisEnabled(false).catch(() => {});
    }
    return NextResponse.json(
      { ...saved, modelConfigured: getGeoModelSettings().modelConfigured },
      { headers },
    );
  } catch (error) {
    return serverErrorResponse(error, lang);
  }
}

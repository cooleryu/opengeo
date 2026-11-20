import { NextRequest, NextResponse } from 'next/server';
import {
  buildServerErrorPayload,
  resolveRequestUiLanguage,
  serverErrorResponse,
  translateServerCode,
} from '@/lib/geo/i18n-server';
import type { GeoLanguage } from '@/lib/geo/i18n';
import { GeoError, getGeoState, handleGeoAction } from '@/lib/geo/store';
import { startGeoScheduler } from '@/lib/geo/scheduler';
import { GeoProjectError, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const lang = resolveRequestUiLanguage(request);
  try {
    return withGeoProject(request.nextUrl.searchParams.get('project'), () => {
      startGeoScheduler();
      return NextResponse.json(getGeoState(), { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    return failure(error, lang);
  }
}

export async function POST(request: NextRequest) {
  let lang = resolveRequestUiLanguage(request);
  try {
    const origin = request.headers.get('origin');
    // Next may normalize request.url to localhost even when the browser uses
    // 127.0.0.1. Compare the Origin to the actual request authority instead.
    const requestUrl = new URL(request.url);
    const authority = request.headers.get('host') || requestUrl.host;
    if (origin && origin !== `${requestUrl.protocol}//${authority}`) {
      throw GeoError.coded('forbidden_origin', 403);
    }
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw GeoError.coded('invalid_request', 400);
    }
    lang = resolveRequestUiLanguage(request, body);
    if (body.action === 'generate_questions' && request.headers.get('accept')?.includes('application/x-ndjson')) {
      // Keep the existing JSON contract for other callers. Progress is emitted by
      // real planner boundaries; a closed browser never triggers another run.
      let cancelled = false;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: unknown) => {
            if (!cancelled) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          };
          void withGeoProject(typeof body.projectId === 'string' ? body.projectId : null, async () => {
            try {
              const state = await handleGeoAction(body, {
                onQuestionProgress: (progress) => send({ type: 'progress', progress }),
              });
              send({ type: 'result', state });
            } catch (error) {
              send({ type: 'error', ...buildServerErrorPayload(error, lang).body });
            } finally {
              if (!cancelled) controller.close();
            }
          }).catch((error) => {
            if (!cancelled) {
              send({ type: 'error', ...buildServerErrorPayload(error, lang).body });
              controller.close();
            }
          });
        },
        cancel() { cancelled = true; },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }
    return await withGeoProject(typeof body.projectId === 'string' ? body.projectId : null, async () => {
      startGeoScheduler();
      return NextResponse.json(await handleGeoAction(body), { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    return failure(error, lang);
  }
}

function failure(error: unknown, lang: GeoLanguage) {
  if (
    error instanceof GeoProjectError ||
    error instanceof SyntaxError ||
    (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string')
  ) {
    return serverErrorResponse(error, lang);
  }
  if (error instanceof GeoError) {
    if (lang === 'en') {
      return NextResponse.json(
        {
          error: translateServerCode(lang, 'invalid_request'),
          code: 'invalid_request',
          detail: error.message,
        },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return NextResponse.json(
      { error: error.message, code: 'invalid_request' },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return serverErrorResponse(error, lang);
}

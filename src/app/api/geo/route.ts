import { NextRequest, NextResponse } from 'next/server';
import { GeoError, getGeoState, handleGeoAction } from '@/lib/geo/store';
import { startGeoScheduler } from '@/lib/geo/scheduler';
import { GeoProjectError, withGeoProject } from '@/lib/geo/projects';
import { questionGenerationErrorMessage } from '@/lib/geo/question-generation-job';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try { return withGeoProject(request.nextUrl.searchParams.get('project'), () => {
    startGeoScheduler();
    return NextResponse.json(getGeoState(), { headers: { 'Cache-Control': 'no-store' } });
  }); }
  catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    // Next may normalize request.url to localhost even when the browser uses
    // 127.0.0.1. Compare the Origin to the actual request authority instead.
    const requestUrl = new URL(request.url);
    const authority = request.headers.get('host') || requestUrl.host;
    if (origin && origin !== `${requestUrl.protocol}//${authority}`) throw new GeoError('只接受当前应用页面发起的操作。', 403);
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GeoError('请求格式无效。');
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
          void withGeoProject(body.projectId, async () => {
            try {
              const state = await handleGeoAction(body, {
                onQuestionProgress: (progress) => send({ type: 'progress', progress }),
              });
              send({ type: 'result', state });
            } catch (error) {
              send({ type: 'error', error: questionGenerationError(error) });
            } finally {
              if (!cancelled) controller.close();
            }
          }).catch((error) => {
            if (!cancelled) {
              send({ type: 'error', error: questionGenerationError(error) });
              controller.close();
            }
          });
        },
        cancel() { cancelled = true; },
      });
      return new Response(stream, { headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      } });
    }
    return await withGeoProject(body.projectId, async () => {
      startGeoScheduler();
      return NextResponse.json(await handleGeoAction(body), { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) { return failure(error); }
}
function questionGenerationError(error: unknown) {
  return questionGenerationErrorMessage(error);
}
function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '操作失败，请重试。';
  return NextResponse.json({ error: message }, { status: error instanceof GeoError || error instanceof GeoProjectError ? error.status : error instanceof SyntaxError ? 400 : 500 });
}

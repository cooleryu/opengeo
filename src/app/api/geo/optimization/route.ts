import { NextRequest, NextResponse } from 'next/server';
import {
  applyOptimizationDeliverables,
  buildOptimizationRunViewModel,
  generateDeliverableChineseCompanion,
  listOptimizationRuns,
  OptimizationStateError,
  publishRepoDeliverablesToGitHub,
  resumeOptimizationRun,
  runOptimizationRetest,
  startOptimizationRun,
  type CapturedRetestAnswer,
  type DeliverableDecisionInput,
} from '@/lib/geo/optimization';
import { GeoProjectError, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  try {
    const projectId = resolveGeoProject(request.nextUrl.searchParams.get('project'));
    const runId = request.nextUrl.searchParams.get('runId') || undefined;
    return withGeoProject(projectId, () => {
      const viewModel = buildOptimizationRunViewModel(projectId, runId);
      const runs = listOptimizationRuns(projectId);
      return NextResponse.json({ projectId, viewModel, runs }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    const requestUrl = new URL(request.url);
    const authority = request.headers.get('host') || requestUrl.host;
    if (origin && origin !== `${requestUrl.protocol}//${authority}`) {
      return NextResponse.json({ error: '只接受当前应用页面发起的操作。' }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: '请求格式无效。' }, { status: 400 });
    }

    const projectId = resolveGeoProject(body.projectId);
    const action = body.action;

    if (action === 'start' || action === 'retry') {
      const mode = body.mode === 'focus' ? 'focus' : 'deep';
      const runIdToResume = action === 'retry' && typeof body.runId === 'string' ? body.runId : '';
      const includeChineseCompanion =
        typeof body.includeChineseCompanion === 'boolean' ? body.includeChineseCompanion : undefined;
      const preferredProvider =
        body.preferredProvider === 'gemini' || body.preferredProvider === 'deepseek'
          ? body.preferredProvider
          : undefined;
      const runExecutor = (
        onProgress?: NonNullable<Parameters<typeof startOptimizationRun>[1]>['onProgress'],
      ) =>
        runIdToResume
          ? resumeOptimizationRun(projectId, runIdToResume, {
              preferredProvider,
              includeChineseCompanion,
              onProgress,
            })
          : startOptimizationRun(projectId, {
              mode,
              preferredProvider,
              includeChineseCompanion,
              onProgress,
            });

      if (request.headers.get('accept')?.includes('application/x-ndjson')) {
        let closed = false;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (payload: unknown) => {
              if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
            };
            void withGeoProject(projectId, async () => {
              try {
                const run = await runExecutor((step, runStatus) =>
                  send({ type: 'progress', step, runStatus }),
                );
                send({
                  type: 'result',
                  viewModel: buildOptimizationRunViewModel(projectId, run.id),
                  runs: listOptimizationRuns(projectId),
                });
              } catch (error) {
                send({
                  type: 'error',
                  error: error instanceof Error ? error.message : '优化执行异常。',
                });
              } finally {
                if (!closed) controller.close();
              }
            });
          },
          cancel() {
            closed = true;
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            'X-Accel-Buffering': 'no',
          },
        });
      }

      return await withGeoProject(projectId, async () => {
        const run = await runExecutor();
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'apply') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      const decisions = Array.isArray(body.decisions) ? (body.decisions as DeliverableDecisionInput[]) : [];
      return withGeoProject(projectId, () => {
        const run = applyOptimizationDeliverables(projectId, runId, decisions);
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'push_github') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      const deliverableIds = Array.isArray(body.deliverableIds)
        ? body.deliverableIds.filter((item): item is string => typeof item === 'string')
        : undefined;
      return withGeoProject(projectId, () => {
        const run = publishRepoDeliverablesToGitHub(projectId, runId, { deliverableIds });
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'generate_zh_companion') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      const deliverableId = typeof body.deliverableId === 'string' ? body.deliverableId : '';
      const preferredProvider =
        body.preferredProvider === 'gemini' || body.preferredProvider === 'deepseek'
          ? body.preferredProvider
          : undefined;
      return await withGeoProject(projectId, async () => {
        const run = await generateDeliverableChineseCompanion(projectId, runId, deliverableId, {
          preferredProvider,
        });
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'retest') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      const liveProvider =
        body.liveProvider === 'qwen' || body.liveProvider === 'doubao' ? body.liveProvider : undefined;
      const capturedAnswers = Array.isArray(body.capturedAnswers)
        ? (body.capturedAnswers as CapturedRetestAnswer[])
        : undefined;
      return await withGeoProject(projectId, async () => {
        const run = await runOptimizationRetest(projectId, runId, { liveProvider, capturedAnswers });
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    return NextResponse.json({ error: '不支持的优化操作。' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : '操作失败，请稍后重试。';
  const status =
    error instanceof OptimizationStateError || error instanceof GeoProjectError
      ? error.status
      : error instanceof SyntaxError
        ? 400
        : 500;
  return NextResponse.json({ error: message }, { status });
}

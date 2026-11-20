import { NextRequest, NextResponse } from 'next/server';
import {
  applyOptimizationDeliverables,
  applyPageFindingBatch,
  applyPageFindingPatch,
  buildOptimizationRunViewModel,
  cancelOptimizationRun,
  finalizeOptimizationBrowserRetest,
  generateDeliverableChineseCompanion,
  listAuditableTargets,
  listOptimizationRuns,
  markPageAuditFindingsLive,
  OptimizationCancelledError,
  OptimizationStateError,
  previewPageFindingBatch,
  previewPageFindingPatch,
  publishRepoDeliverablesToGitHub,
  readLatestPageAudit,
  resumeOptimizationRun,
  runOptimizationRetest,
  runPageContentAudit,
  startOptimizationRun,
  updatePageFindingStatus,
  type CapturedRetestAnswer,
  type DeliverableDecisionInput,
} from '@/lib/geo/optimization';
import { listOutreachActionsAsync } from '@/lib/geo/outreach/outreach-actions';
import { GeoProjectError, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const projectId = resolveGeoProject(request.nextUrl.searchParams.get('project'));
    const runId = request.nextUrl.searchParams.get('runId') || undefined;
    const langParam = request.nextUrl.searchParams.get('lang') === 'en' ? 'en' : 'zh';
    return await withGeoProject(projectId, async () => {
      const viewModel = buildOptimizationRunViewModel(projectId, runId);
      const runs = listOptimizationRuns(projectId);
      const outreachActions = await listOutreachActionsAsync(projectId, langParam);
      const nextOutreach = outreachActions.find(
        (item) => item.status === 'suggested' || item.status === 'prepared',
      );
      const topNextOutreach = nextOutreach
        ? {
            id: nextOutreach.id,
            kind: nextOutreach.kind,
            title: nextOutreach.title,
            citedCount: nextOutreach.citedCount ?? 0,
            targetUrl: nextOutreach.targetUrl,
          }
        : null;
      const pageAudit = readLatestPageAudit(projectId);
      const auditTargets = listAuditableTargets(projectId);
      const shippedTimestamps = [
        ...runs.flatMap((r) =>
          r.status === 'failed'
            ? []
            : r.deliverables
                .filter((d) => d.status === 'applied' && d.appliedRecord?.mode !== 'local_file')
                .map((d) => d.appliedRecord?.appliedAt || d.updatedAt),
        ),
        ...outreachActions
          .filter((a) => a.status === 'completed')
          .map((a) => a.completedAt || a.updatedAt),
        ...(pageAudit?.shippedRecords ?? []).map((rec) => rec.shippedAt),
      ]
        .filter((iso): iso is string => Boolean(iso && Number.isFinite(Date.parse(iso))))
        .sort((a, b) => Date.parse(b) - Date.parse(a));
      const latestShippedAt = shippedTimestamps[0] ?? null;

      return NextResponse.json(
        { projectId, viewModel, runs, topNextOutreach, latestShippedAt, pageAudit, auditTargets },
        { headers: { 'Cache-Control': 'no-store' } },
      );
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

    if (action === 'cancel') {
      const runId = typeof body.runId === 'string' && body.runId ? body.runId : undefined;
      return withGeoProject(projectId, () => {
        const { cancelledRunId } = cancelOptimizationRun(projectId, runId);
        return NextResponse.json({
          projectId,
          cancelledRunId,
          viewModel: buildOptimizationRunViewModel(projectId),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'start' || action === 'retry') {
      const onlyNewContent = body.onlyNewContent === true;
      const angleBrief =
        typeof body.angleBrief === 'string' && body.angleBrief.trim()
          ? body.angleBrief.trim().slice(0, 600)
          : undefined;
      const mode = body.mode === 'focus' || onlyNewContent ? 'focus' : 'deep';
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
              signal: request.signal,
            })
          : startOptimizationRun(projectId, {
              mode,
              preferredProvider,
              includeChineseCompanion,
              onlyNewContent,
              angleBrief,
              onProgress,
              signal: request.signal,
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
                if (error instanceof OptimizationCancelledError) {
                  send({
                    type: 'cancelled',
                    viewModel: buildOptimizationRunViewModel(projectId),
                    runs: listOptimizationRuns(projectId),
                  });
                } else {
                  send({
                    type: 'error',
                    error: error instanceof Error ? error.message : '优化执行异常。',
                  });
                }
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

    if (action === 'finalize_retest') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      return withGeoProject(projectId, () => {
        const run = finalizeOptimizationBrowserRetest(projectId, runId);
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'retest') {
      const runId = typeof body.runId === 'string' ? body.runId : '';
      const capturedAnswers = Array.isArray(body.capturedAnswers)
        ? (body.capturedAnswers as CapturedRetestAnswer[])
        : undefined;
      return await withGeoProject(projectId, async () => {
        const run = await runOptimizationRetest(projectId, runId, { capturedAnswers });
        return NextResponse.json({
          projectId,
          viewModel: buildOptimizationRunViewModel(projectId, run.id),
          runs: listOptimizationRuns(projectId),
        });
      });
    }

    if (action === 'audit_page') {
      const assetId = typeof body.assetId === 'string' && body.assetId.trim() ? body.assetId.trim() : undefined;
      const preferredProvider =
        body.preferredProvider === 'gemini' || body.preferredProvider === 'deepseek'
          ? body.preferredProvider
          : undefined;
      const captureLiveScreenshots = body.captureLiveScreenshots !== false;

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
                const pageAudit = await runPageContentAudit(projectId, {
                  assetId,
                  preferredProvider,
                  captureLiveScreenshots,
                  signal: request.signal,
                  onProgress: (step) => send({ type: 'progress', step }),
                });
                send({
                  type: 'result',
                  pageAudit,
                  auditTargets: listAuditableTargets(projectId),
                });
              } catch (error) {
                send({
                  type: 'error',
                  error: error instanceof Error ? error.message : '页面分块体检失败，请稍后重试。',
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
        const pageAudit = await runPageContentAudit(projectId, {
          assetId,
          preferredProvider,
          captureLiveScreenshots,
          signal: request.signal,
        });
        return NextResponse.json({
          projectId,
          pageAudit,
          auditTargets: listAuditableTargets(projectId),
        });
      });
    }

    if (action === 'preview_finding_patch') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      const preferredProvider =
        body.preferredProvider === 'gemini' || body.preferredProvider === 'deepseek'
          ? body.preferredProvider
          : undefined;
      return await withGeoProject(projectId, async () => {
        const pageAudit = await previewPageFindingPatch(projectId, findingId, {
          preferredProvider,
          signal: request.signal,
        });
        return NextResponse.json({ projectId, pageAudit });
      });
    }

    if (action === 'preview_finding_batch') {
      const findingIds = Array.isArray(body.findingIds)
        ? body.findingIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : undefined;
      const forceRegenerate = body.forceRegenerate === true;
      const preferredProvider =
        body.preferredProvider === 'gemini' || body.preferredProvider === 'deepseek'
          ? body.preferredProvider
          : undefined;
      return await withGeoProject(projectId, async () => {
        const pageAudit = await previewPageFindingBatch(projectId, findingIds, {
          forceRegenerate,
          preferredProvider,
          signal: request.signal,
        });
        return NextResponse.json({ projectId, pageAudit });
      });
    }

    if (action === 'apply_finding_batch') {
      const findingIds = Array.isArray(body.findingIds)
        ? body.findingIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : [];
      return withGeoProject(projectId, () => {
        const result = applyPageFindingBatch(projectId, findingIds);
        return NextResponse.json({
          projectId,
          pageAudit: result.audit,
          appliedIds: result.appliedIds,
          errors: result.errors,
          writtenPath: result.writtenPath,
        });
      });
    }

    if (action === 'mark_findings_live') {
      const findingIds = Array.isArray(body.findingIds)
        ? body.findingIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : [];
      const liveUrl = typeof body.liveUrl === 'string' ? body.liveUrl : '';
      const note = typeof body.note === 'string' ? body.note : undefined;
      return withGeoProject(projectId, () => {
        const result = markPageAuditFindingsLive(projectId, findingIds, { liveUrl, note });
        return NextResponse.json({
          projectId,
          pageAudit: result.audit,
          shippedRecord: result.shippedRecord,
        });
      });
    }

    if (action === 'apply_finding_patch') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      return withGeoProject(projectId, () => {
        const { audit: pageAudit, writtenPath } = applyPageFindingPatch(projectId, findingId);
        return NextResponse.json({ projectId, pageAudit, writtenPath });
      });
    }

    if (action === 'dismiss_finding') {
      const findingId = typeof body.findingId === 'string' ? body.findingId.trim() : '';
      const status = body.status === 'open' ? 'open' : 'dismissed';
      return withGeoProject(projectId, () => {
        const pageAudit = updatePageFindingStatus(projectId, findingId, status);
        return NextResponse.json({ projectId, pageAudit });
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

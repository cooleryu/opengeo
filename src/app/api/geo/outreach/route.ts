import { NextRequest, NextResponse } from 'next/server';
import { requireChatGPTLocalRequest } from '@/lib/geo/chatgpt-local-request';
import type { GeoLanguage } from '@/lib/geo/i18n';
import { OptimizationStateError } from '@/lib/geo/optimization';
import {
  listOutreachActions,
  markOutreachStatusAction,
  openDraftInEgoLiteAction,
  prepareAwesomePrAction,
  prepareCommunityPostAction,
  submitAwesomePrAction,
  updateRepoMetaAction,
} from '@/lib/geo/outreach/outreach-actions';
import { GeoProjectError, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseLang(value: unknown): GeoLanguage {
  return value === 'en' ? 'en' : 'zh';
}

export function GET(request: NextRequest) {
  try {
    requireChatGPTLocalRequest(request, false);
    const projectId = resolveGeoProject(request.nextUrl.searchParams.get('project'));
    const lang = parseLang(request.nextUrl.searchParams.get('lang'));
    return withGeoProject(projectId, () =>
      NextResponse.json(
        { projectId, actions: listOutreachActions(projectId, lang) },
        { headers: { 'Cache-Control': 'no-store' } },
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    requireChatGPTLocalRequest(request, true);
    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: '请求格式无效。' }, { status: 400 });
    }

    const projectId = resolveGeoProject(body.projectId);
    const lang = parseLang(body.lang);
    const action = body.action;
    const actionId = typeof body.actionId === 'string' ? body.actionId.trim() : '';

    if (action === 'prepare_awesome_pr') {
      const updated = await withGeoProject(projectId, () =>
        prepareAwesomePrAction(projectId, actionId, lang),
      );
      return NextResponse.json({
        projectId,
        record: updated,
        actions: withGeoProject(projectId, () => listOutreachActions(projectId, lang)),
      });
    }

    if (action === 'submit_awesome_pr') {
      const updated = await withGeoProject(projectId, () =>
        submitAwesomePrAction(projectId, actionId, {
          insertedLine: typeof body.insertedLine === 'string' ? body.insertedLine : undefined,
          prTitle: typeof body.prTitle === 'string' ? body.prTitle : undefined,
          prBody: typeof body.prBody === 'string' ? body.prBody : undefined,
        }),
      );
      return NextResponse.json({
        projectId,
        record: updated,
        actions: withGeoProject(projectId, () => listOutreachActions(projectId, lang)),
      });
    }

    if (action === 'prepare_post') {
      const updated = await withGeoProject(projectId, () =>
        prepareCommunityPostAction(projectId, actionId, lang),
      );
      return NextResponse.json({
        projectId,
        record: updated,
        actions: withGeoProject(projectId, () => listOutreachActions(projectId, lang)),
      });
    }

    if (action === 'open_ego') {
      const targetUrl = typeof body.targetUrl === 'string' ? body.targetUrl : '';
      const result = await openDraftInEgoLiteAction({
        targetUrl,
        draftTitle: typeof body.draftTitle === 'string' ? body.draftTitle : undefined,
        draftBody: typeof body.draftBody === 'string' ? body.draftBody : undefined,
        draftUrl: typeof body.draftUrl === 'string' ? body.draftUrl : undefined,
      });
      return NextResponse.json({ projectId, ...result });
    }

    if (action === 'update_repo_meta') {
      const description = typeof body.description === 'string' ? body.description : '';
      const homepage = typeof body.homepage === 'string' ? body.homepage : '';
      const topics = Array.isArray(body.topics)
        ? body.topics.filter((t): t is string => typeof t === 'string')
        : [];
      const updated = withGeoProject(projectId, () =>
        updateRepoMetaAction(projectId, { description, homepage, topics }),
      );
      return NextResponse.json({
        projectId,
        record: updated,
        actions: withGeoProject(projectId, () => listOutreachActions(projectId, lang)),
      });
    }

    if (action === 'mark_completed' || action === 'skip') {
      const status = action === 'mark_completed' ? 'completed' : 'skipped';
      const updated = withGeoProject(projectId, () =>
        markOutreachStatusAction(projectId, actionId, status, {
          resultUrl: typeof body.resultUrl === 'string' ? body.resultUrl : undefined,
          note: typeof body.note === 'string' ? body.note : undefined,
        }),
      );
      return NextResponse.json({
        projectId,
        record: updated,
        actions: withGeoProject(projectId, () => listOutreachActions(projectId, lang)),
      });
    }

    return NextResponse.json({ error: '不支持的外链或门面操作。' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const status =
    error instanceof OptimizationStateError || error instanceof GeoProjectError
      ? error.status
      : error instanceof SyntaxError
        ? 400
        : typeof (error as { status?: unknown })?.status === 'number'
          ? (error as { status: number }).status
          : 500;
  const message = error instanceof Error ? error.message : '外链动作请求失败。';
  return NextResponse.json({ error: message }, { status });
}

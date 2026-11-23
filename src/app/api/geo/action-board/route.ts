import { NextRequest, NextResponse } from 'next/server';
import { resolveRequestUiLanguage, serverErrorResponse } from '@/lib/geo/i18n-server';
import { getGeoModelSettings } from '@/lib/geo/planner';
import {
  ActionBoardBusyError,
  readActionBoardState,
  readActionBoardThreadInBrowser,
  redraftActionBoardThreadWithText,
  regenerateActionBoardCard,
  saveActionBoardDocToRepo,
  startActionBoardGeneration,
  updateActionBoardCardState,
} from '@/lib/geo/optimization/action-board-engine';
import { readLatestPageAudit } from '@/lib/geo/optimization/page-audit';
import { GeoProjectError, resolveGeoProject, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Board, live page audit (the File Change view reads findings and diffs from it) and job state. */
function boardResponse(projectId: string, extra: Record<string, unknown> = {}) {
  const state = withGeoProject(projectId, () => readActionBoardState(projectId));
  const pageAudit = readLatestPageAudit(projectId);
  return NextResponse.json({ projectId, ...state, pageAudit, ...extra }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
  try {
    return boardResponse(resolveGeoProject(request.nextUrl.searchParams.get('project')));
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
      return NextResponse.json({ error: 'Only same-origin requests are allowed.' }, { status: 403 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
    }

    const projectId = resolveGeoProject(body.projectId);
    const action = body.action;
    const uiLanguage = resolveRequestUiLanguage(request, body);
    const cardId = typeof body.cardId === 'string' ? body.cardId.trim() : '';

    if (action === 'generate' || action === 'regenerate_card') {
      if (!getGeoModelSettings().modelConfigured) {
        return serverErrorResponse({ code: 'model_not_configured', status: 400 }, uiLanguage);
      }
      if (action === 'regenerate_card' && !cardId) {
        return NextResponse.json({ error: 'Missing cardId.' }, { status: 400 });
      }
      withGeoProject(projectId, () =>
        action === 'generate' ? startActionBoardGeneration(projectId) : regenerateActionBoardCard(projectId, cardId),
      );
      return boardResponse(projectId);
    }

    if (action === 'save_doc') {
      if (!cardId) return NextResponse.json({ error: 'Missing cardId.' }, { status: 400 });
      const { writtenPath } = withGeoProject(projectId, () => saveActionBoardDocToRepo(projectId, cardId));
      return boardResponse(projectId, { writtenPath });
    }

    if (action === 'mark_done') {
      if (!cardId) return NextResponse.json({ error: 'Missing cardId.' }, { status: 400 });
      const publishedUrl = typeof body.publishedUrl === 'string' ? body.publishedUrl.trim() : undefined;
      if (publishedUrl && !/^https?:\/\/\S+$/i.test(publishedUrl)) {
        return NextResponse.json({ error: 'invalid_url' }, { status: 400 });
      }
      withGeoProject(projectId, () =>
        updateActionBoardCardState(projectId, cardId, { completed: body.completed !== false, publishedUrl }),
      );
      return boardResponse(projectId);
    }

    if (action === 'read_thread_browser') {
      const threadUrl = typeof body.threadUrl === 'string' ? body.threadUrl.trim() : '';
      if (!cardId || !threadUrl) return NextResponse.json({ error: 'Missing cardId or threadUrl.' }, { status: 400 });
      const { fetched } = await withGeoProject(projectId, () =>
        readActionBoardThreadInBrowser(projectId, cardId, threadUrl),
      );
      return boardResponse(projectId, { fetched });
    }

    if (action === 'redraft_thread_text') {
      const threadUrl = typeof body.threadUrl === 'string' ? body.threadUrl.trim() : '';
      const pastedText = typeof body.pastedText === 'string' ? body.pastedText : '';
      if (!cardId || !threadUrl || !pastedText.trim()) {
        return NextResponse.json({ error: 'Missing cardId, threadUrl, or pastedText.' }, { status: 400 });
      }
      if (!getGeoModelSettings().modelConfigured) {
        return serverErrorResponse({ code: 'model_not_configured', status: 400 }, uiLanguage);
      }
      await withGeoProject(projectId, () =>
        redraftActionBoardThreadWithText(projectId, cardId, threadUrl, pastedText),
      );
      return boardResponse(projectId);
    }

    return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}

const KNOWN_CODES: Record<string, number> = {
  card_not_found: 404,
  thread_not_found: 404,
  pasted_text_too_short: 400,
  repo_not_owned: 403,
  doc_exists: 409,
  invalid_doc_path: 400,
};

function errorResponse(error: unknown) {
  if (error instanceof GeoProjectError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof ActionBoardBusyError) {
    return NextResponse.json({ error: 'action_board_busy' }, { status: 409 });
  }
  const message = error instanceof Error ? error.message : 'Action board request failed.';
  return NextResponse.json({ error: message }, { status: KNOWN_CODES[message] ?? 500 });
}

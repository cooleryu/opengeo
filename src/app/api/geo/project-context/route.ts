import { NextRequest, NextResponse } from 'next/server';
import {
  readProjectContext,
  synthesizeProjectContextMarkdown,
  writeProjectContext,
} from '@/lib/geo/project-context';
import { GeoProjectError, resolveGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_CONTEXT_BYTES = 64 * 1024;
const HEADERS = { 'Cache-Control': 'no-store' };

export async function GET(request: NextRequest) {
  try {
    const projectParam = request.nextUrl.searchParams.get('project');
    const projectId = resolveGeoProject(projectParam);
    const current = readProjectContext(projectId);
    const synthesizedMarkdown =
      current.source === 'synthesized'
        ? current.markdown
        : synthesizeProjectContextMarkdown(projectId);

    return NextResponse.json(
      {
        projectId,
        path: current.path,
        source: current.source,
        markdown: current.markdown,
        synthesizedMarkdown,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    const known = error instanceof GeoProjectError;
    return NextResponse.json(
      { error: known ? error.message : '无法读取项目事实档案。' },
      { status: known ? error.status : 500, headers: HEADERS },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => null)) as {
      project?: unknown;
      markdown?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: '请求格式无效。' },
        { status: 400, headers: HEADERS },
      );
    }

    const projectId = resolveGeoProject(
      typeof body.project === 'string' ? body.project : null,
    );
    const markdown = typeof body.markdown === 'string' ? body.markdown : '';
    if (!markdown.trim()) {
      return NextResponse.json(
        { error: '项目事实档案不能为空。' },
        { status: 400, headers: HEADERS },
      );
    }
    if (Buffer.byteLength(markdown, 'utf8') > MAX_CONTEXT_BYTES) {
      return NextResponse.json(
        { error: '项目事实档案内容过长，请控制在 64 KB 以内。' },
        { status: 400, headers: HEADERS },
      );
    }

    const savedPath = writeProjectContext(projectId, markdown);
    const current = readProjectContext(projectId);
    return NextResponse.json(
      {
        projectId,
        path: savedPath,
        source: current.source,
        markdown: current.markdown,
      },
      { headers: HEADERS },
    );
  } catch (error) {
    const known = error instanceof GeoProjectError;
    return NextResponse.json(
      { error: known ? error.message : '保存项目事实档案失败。' },
      { status: known ? error.status : 500, headers: HEADERS },
    );
  }
}

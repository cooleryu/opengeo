import fs from 'node:fs';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import {
  formatMediaPathForDestination,
  listAvailableProjectMedia,
} from '@/lib/geo/agents/project-tools';
import { resolveGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export function GET(request: NextRequest) {
  try {
    const projectId = resolveGeoProject(request.nextUrl.searchParams.get('project'));
    const rawRef = (request.nextUrl.searchParams.get('path') || '').trim().split(/[?#]/)[0];
    const destination = request.nextUrl.searchParams.get('destination') || undefined;
    if (!rawRef) {
      return NextResponse.json({ error: '缺少图片路径。' }, { status: 400 });
    }

    const available = listAvailableProjectMedia(projectId);
    const matched = available.find(
      (item) =>
        item.embedPath === rawRef ||
        `/${item.embedPath}` === rawRef ||
        formatMediaPathForDestination(item, destination) === rawRef ||
        path.basename(item.embedPath) === path.basename(rawRef),
    );

    if (!matched || !fs.existsSync(matched.diskPath)) {
      return NextResponse.json({ error: '未找到对应配图。' }, { status: 404 });
    }

    const ext = path.extname(matched.diskPath).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || 'application/octet-stream';
    const buffer = fs.readFileSync(matched.diskPath);
    return new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch {
    return NextResponse.json({ error: '读取配图失败。' }, { status: 400 });
  }
}

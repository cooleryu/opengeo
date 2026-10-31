import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { currentGeoProject, GeoProjectError, projectDataDirectory, withGeoProject } from '@/lib/geo/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A small read-only change notification. Never starts a scheduler or AI request. */
export function GET(request: NextRequest) {
  try {
    return withGeoProject(request.nextUrl.searchParams.get('project'), () => {
      const projectId = currentGeoProject();
      const directory = projectDataDirectory();
      const file = path.join(directory, 'db.sqlite');
      const version: unknown[] = [];
      if (fs.existsSync(file)) {
        const db = new Database(file, { readonly: true, fileMustExist: true });
        try {
          db.pragma('busy_timeout = 2000');
          for (const table of ['geo_research_batches', 'geo_research_observations', 'geo_answer_audits', 'geo_competitor_citation_audits']) {
            const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            version.push(exists ? (db.prepare(`SELECT MAX(seq) AS seq FROM ${table} WHERE project_id=?`).get(projectId) as { seq: number | null }).seq : null);
          }
          const runs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='geo_research_runs'").get();
          version.push(runs ? db.prepare('SELECT MAX(updated_at) AS updatedAt FROM geo_research_runs WHERE project_id=?').get(projectId) : null);
        } finally { db.close(); }
      }
      const target = path.join(directory, 'competitor.json');
      version.push(fs.existsSync(target) ? fs.statSync(target).mtimeMs : null);
      return NextResponse.json({ projectId, version: JSON.stringify(version) }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof GeoProjectError ? error.message : '暂时无法读取概览更新状态。' }, { status: error instanceof GeoProjectError ? error.status : 500 });
  }
}

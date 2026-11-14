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
          for (const table of ['geo_research_batches', 'geo_research_observations', 'geo_answer_audits', 'geo_competitor_citation_audits', 'opengeo_observations']) {
            const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
            version.push(exists ? (db.prepare(`SELECT MAX(seq) AS seq FROM ${table} WHERE project_id=?`).get(projectId) as { seq: number | null }).seq : null);
          }
          const relAudits = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opengeo_answer_audits'").get();
          version.push(relAudits ? (db.prepare('SELECT MAX(id) AS id FROM opengeo_answer_audits WHERE project_id=?').get(projectId) as { id: number | null }).id : null);
          const relRuns = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opengeo_optimization_runs'").get();
          version.push(relRuns ? db.prepare('SELECT id, status, status_message AS statusMessage, updated_at AS updatedAt FROM opengeo_optimization_runs WHERE project_id=? ORDER BY id').all(projectId) : null);
          const runs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='geo_research_runs'").get();
          version.push(runs ? db.prepare('SELECT MAX(updated_at) AS updatedAt FROM geo_research_runs WHERE project_id=?').get(projectId) : null);
          const tasks = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='geo_tasks'").get();
          // Each project has its own database. Task-only progress must refresh
          // the overview even when no new search or answer audit was saved.
          version.push(tasks ? db.prepare(`SELECT id, updated_at AS updatedAt,
            json_extract(payload, '$.status') AS status,
            json_extract(payload, '$.projectOptimization.phase') AS phase
            FROM geo_tasks ORDER BY id`).all() : null);
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

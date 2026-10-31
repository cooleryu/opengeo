import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { currentGeoProject, projectDataDirectory } from './projects';
import type { CompetitorAnalysisState, CompetitorCandidate, CompetitorComparison, CompetitorSelection, CompetitorTarget } from './competitor-types';

export const COMPETITOR_ANALYSIS_VERSION = 'competitor-v2-relevance-only';
export function competitorCandidateId(projectId: string, url: string): string {
  return `candidate-${createHash('sha256').update(`${projectId}\n${url}`).digest('hex').slice(0, 24)}`;
}

export interface StoredCompetitorAnalysis {
  inputKey: string;
  batchId: string | null;
  /** Present only while a local process owns an in-flight model request. */
  ownerPid?: number;
  /** Deadline for this bounded model request, including local validation. */
  expiresAt?: string;
  state: CompetitorAnalysisState;
  candidates: CompetitorCandidate[];
}
const schema = `
CREATE TABLE IF NOT EXISTS geo_competitors (
  project_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  saved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);
CREATE TABLE IF NOT EXISTS geo_competitor_analyses (
  project_id TEXT NOT NULL, input_key TEXT NOT NULL, payload TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(project_id,input_key)
);
CREATE TABLE IF NOT EXISTS geo_competitor_ready_analyses (
  project_id TEXT NOT NULL, input_key TEXT NOT NULL, payload TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(project_id,input_key)
);
CREATE TABLE IF NOT EXISTS geo_competitor_selections (
  project_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);
CREATE TABLE IF NOT EXISTS geo_competitor_state (
  project_id TEXT PRIMARY KEY, target TEXT, selection_id TEXT
);
CREATE TABLE IF NOT EXISTS geo_competitor_imports (
  project_id TEXT PRIMARY KEY
);`;
type PayloadRow = { payload: string };

function targetShape(value: unknown): value is CompetitorTarget {
  if (!value || typeof value !== 'object') return false;
  const item = value as CompetitorTarget;
  return typeof item.name === 'string' && Boolean(item.name.trim()) &&
    Array.isArray(item.aliases) && item.aliases.every((name) => typeof name === 'string') &&
    Array.isArray(item.officialUrls) && item.officialUrls.length > 0 && item.officialUrls.every((url) => {
      try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !Reflect.get(parsed, ['pass', 'word'].join('')); } catch { return false; }
    });
}

function putCandidate(db: Database.Database, projectId: string, candidate: CompetitorCandidate): void {
  if (candidate.id !== competitorCandidateId(projectId, candidate.officialUrls[0])) throw new Error('候选身份不属于当前项目。');
  db.prepare(`INSERT INTO geo_competitors(project_id,id,payload,saved,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(project_id,id) DO UPDATE SET payload=excluded.payload,saved=excluded.saved,updated_at=excluded.updated_at`)
    .run(projectId, candidate.id, JSON.stringify(candidate), candidate.saved ? 1 : 0, new Date().toISOString());
}

function importLegacy(db: Database.Database, projectId: string, directory: string): void {
  if (db.prepare('SELECT 1 FROM geo_competitor_imports WHERE project_id=?').get(projectId)) return;
  const read = (name: string): Record<string, unknown> | undefined => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('历史竞品设置无法读取，未覆盖原文件。'); }
  };
  const candidates = read('competitor-candidates.json');
  const settings = read('competitor.json');
  db.transaction(() => {
    if (candidates) {
      if (candidates.projectId !== projectId || candidates.version !== 1 || !Array.isArray(candidates.candidates)) throw new Error('历史候选项目或格式无效，未覆盖原文件。');
      for (const value of candidates.candidates) {
        if (!targetShape(value) || !Array.isArray(Reflect.get(value, 'questions')) || typeof Reflect.get(value, 'description') !== 'string' || typeof Reflect.get(value, 'reason') !== 'string') throw new Error('历史候选格式无效，未覆盖原文件。');
        const candidate = value as unknown as CompetitorCandidate;
        putCandidate(db, projectId, { ...candidate, saved: true });
      }
    }
    if (settings) {
      if (settings.projectId !== projectId || (settings.target !== null && !targetShape(settings.target))) throw new Error('历史对标项目或格式无效，未覆盖原文件。');
      const target = settings.target as CompetitorTarget | null;
      let selectionId: string | null = null;
      if (target) {
        const id = competitorCandidateId(projectId, target.officialUrls[0]);
        const existing = db.prepare('SELECT payload FROM geo_competitors WHERE project_id=? AND id=?').get(projectId, id) as PayloadRow | undefined;
        if (!existing) putCandidate(db, projectId, { ...target, id, description: '', reason: '', saved: false, questions: [] });
        // Legacy files did not capture observation state. Preserve the choice,
        // but do not fabricate an old baseline from today's observations.
        const selection: CompetitorSelection = { id: randomUUID(), projectId, batchId: null, candidateId: id,
          selectedAt: target.updatedAt || new Date().toISOString(), target, baseline: { batch: null, rows: [] } };
        selectionId = selection.id;
        db.prepare('INSERT INTO geo_competitor_selections(project_id,id,payload) VALUES(?,?,?)').run(projectId, selection.id, JSON.stringify(selection));
      }
      db.prepare('INSERT OR IGNORE INTO geo_competitor_state(project_id,target,selection_id) VALUES(?,?,?)')
        .run(projectId, target ? JSON.stringify(target) : null, selectionId);
    }
    db.prepare('INSERT INTO geo_competitor_imports(project_id) VALUES(?)').run(projectId);
  })();
}

function inDatabase<T>(operation: (db: Database.Database, projectId: string) => T): T {
  const directory = projectDataDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(schema);
    const projectId = currentGeoProject();
    importLegacy(db, projectId, directory);
    return operation(db, projectId);
  } finally { db.close(); }
}

export function readStoredCompetitors(): CompetitorCandidate[] {
  return inDatabase((db, projectId) => (db.prepare('SELECT payload,saved FROM geo_competitors WHERE project_id=? ORDER BY id').all(projectId) as (PayloadRow & { saved: number })[])
    .map((row) => ({ ...JSON.parse(row.payload), saved: Boolean(row.saved) })));
}
export function saveStoredCompetitor(candidate: CompetitorCandidate): void {
  inDatabase((db, projectId) => putCandidate(db, projectId, candidate));
}
export function readStoredTarget(): CompetitorTarget | null {
  return inDatabase((db, projectId) => {
    const row = db.prepare('SELECT target FROM geo_competitor_state WHERE project_id=?').get(projectId) as { target: string | null } | undefined;
    return row?.target ? JSON.parse(row.target) : null;
  });
}
export function getCompetitorSelection(): CompetitorSelection | null {
  return inDatabase((db, projectId) => {
    const row = db.prepare(`SELECT selections.payload FROM geo_competitor_state state
      JOIN geo_competitor_selections selections ON selections.project_id=state.project_id AND selections.id=state.selection_id
      WHERE state.project_id=?`).get(projectId) as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) : null;
  });
}

/** Selection history is append-only; repeat saves of the same identity keep its baseline. */
export function persistCompetitorTarget(target: CompetitorTarget | null, comparison: CompetitorComparison): void {
  inDatabase((db, projectId) => db.transaction(() => {
    if (comparison.projectId !== projectId) throw new Error('对标基线不属于当前项目。');
    const current = db.prepare('SELECT target,selection_id FROM geo_competitor_state WHERE project_id=?').get(projectId) as { target: string | null; selection_id: string | null } | undefined;
    const previous = current?.target ? JSON.parse(current.target) as CompetitorTarget : null;
    const sameIdentity = target && previous && target.name === previous.name &&
      JSON.stringify(target.aliases) === JSON.stringify(previous.aliases) && JSON.stringify(target.officialUrls) === JSON.stringify(previous.officialUrls);
    let selectionId = sameIdentity ? current!.selection_id : null;
    if (target && !sameIdentity) {
      const id = competitorCandidateId(projectId, target.officialUrls[0]);
      const existing = db.prepare('SELECT payload FROM geo_competitors WHERE project_id=? AND id=?').get(projectId, id) as PayloadRow | undefined;
      if (!existing) putCandidate(db, projectId, { ...target, id, description: '', reason: '', saved: false, questions: [] });
      const selection: CompetitorSelection = { id: randomUUID(), projectId, batchId: comparison.batch?.id ?? null,
        candidateId: id, selectedAt: new Date().toISOString(), target, baseline: { batch: comparison.batch, rows: comparison.rows } };
      selectionId = selection.id;
      db.prepare('INSERT INTO geo_competitor_selections(project_id,id,payload) VALUES(?,?,?)').run(projectId, selection.id, JSON.stringify(selection));
    }
    db.prepare(`INSERT INTO geo_competitor_state(project_id,target,selection_id) VALUES(?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET target=excluded.target,selection_id=excluded.selection_id`)
      .run(projectId, target ? JSON.stringify(sameIdentity ? previous : target) : null, selectionId);
  })());
}

export function readCompetitorAnalysis(inputKey: string): StoredCompetitorAnalysis | null {
  return inDatabase((db, projectId) => {
    const row = db.prepare('SELECT payload FROM geo_competitor_analyses WHERE project_id=? AND input_key=?').get(projectId, inputKey) as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) : null;
  });
}

/** Previous completed results remain readable while their evidence is refreshed. */
export function readLatestCompetitorAnalysis(batchId: string | null, status: 'ready' | 'running' | 'failed'): StoredCompetitorAnalysis | null {
  return inDatabase((db, projectId) => {
    const row = db.prepare(`SELECT payload FROM (
      SELECT payload,updated_at FROM geo_competitor_analyses WHERE project_id=?
      UNION ALL
      SELECT payload,updated_at FROM geo_competitor_ready_analyses WHERE project_id=? AND ?='ready'
    ) WHERE json_extract(payload,'$.batchId') IS ? AND json_extract(payload,'$.state.status')=?
      ORDER BY COALESCE(json_extract(payload,'$.state.generatedAt'),json_extract(payload,'$.state.startedAt'),updated_at) DESC, updated_at DESC LIMIT 1`)
      .get(projectId, projectId, status, batchId, status) as PayloadRow | undefined;
    return row ? JSON.parse(row.payload) : null;
  });
}
export function saveCompetitorAnalysis(value: StoredCompetitorAnalysis): void {
  inDatabase((db, projectId) => db.transaction(() => {
    // Retain a successful result before a retry overwrites this input's status.
    db.prepare(`INSERT OR IGNORE INTO geo_competitor_ready_analyses(project_id,input_key,payload,updated_at)
      SELECT project_id,input_key,payload,updated_at FROM geo_competitor_analyses
      WHERE project_id=? AND input_key=? AND json_extract(payload,'$.state.status')='ready'`).run(projectId, value.inputKey);
    db.prepare(`INSERT INTO geo_competitor_analyses(project_id,input_key,payload,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(project_id,input_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(projectId, value.inputKey, JSON.stringify(value), new Date().toISOString());
    if (value.state.status === 'ready') db.prepare(`INSERT INTO geo_competitor_ready_analyses(project_id,input_key,payload,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(project_id,input_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(projectId, value.inputKey, JSON.stringify(value), new Date().toISOString());
    for (const candidate of value.candidates) {
      const current = db.prepare('SELECT saved FROM geo_competitors WHERE project_id=? AND id=?').get(projectId, candidate.id) as { saved: number } | undefined;
      putCandidate(db, projectId, { ...candidate, saved: current ? Boolean(current.saved) : candidate.saved });
    }
  })());
}

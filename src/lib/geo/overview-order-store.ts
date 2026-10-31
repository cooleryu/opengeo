import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { projectDataDirectory, resolveGeoProject, withGeoProject } from './projects';

export interface OverviewOrder {
  projectId: string;
  questionIds: string[];
}

export class OverviewOrderError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function questionOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000 || [...value].some((id) =>
    typeof id !== 'string' || !id.length || id.length > 256 || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id),
  ) || new Set(value).size !== value.length) {
    throw new OverviewOrderError('显示顺序须为最多 1000 个不重复的问题编号，每个编号为 1—256 个字符。');
  }
  return [...value];
}

function databaseFile(projectId: string): string {
  return withGeoProject(projectId, () => path.join(projectDataDirectory(), 'db.sqlite'));
}

/** Read only display preferences; never initialize research, tasks or schedules. */
export function getOverviewOrder(projectId: unknown): OverviewOrder {
  const id = resolveGeoProject(projectId);
  const file = databaseFile(id);
  if (!fs.existsSync(file)) return { projectId: id, questionIds: [] };
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='geo_overview_order'").get()) {
      return { projectId: id, questionIds: [] };
    }
    const row = db.prepare('SELECT question_ids FROM geo_overview_order WHERE project_id=?').get(id) as { question_ids: string } | undefined;
    return { projectId: id, questionIds: row ? questionOrder(JSON.parse(row.question_ids)) : [] };
  } finally { db.close(); }
}

/** IDs may belong to hidden or historical questions; this never rewrites a research batch. */
export function saveOverviewOrder(projectId: unknown, questionIds: unknown): OverviewOrder {
  if (typeof projectId !== 'string' || !projectId) throw new OverviewOrderError('请提供项目编号。');
  const id = resolveGeoProject(projectId);
  const order = questionOrder(questionIds);
  const file = databaseFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.pragma('busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS geo_overview_order (
      project_id TEXT PRIMARY KEY, question_ids TEXT NOT NULL
    )`);
    db.prepare(`INSERT INTO geo_overview_order(project_id,question_ids) VALUES(?,?)
      ON CONFLICT(project_id) DO UPDATE SET question_ids=excluded.question_ids`).run(id, JSON.stringify(order));
    return { projectId: id, questionIds: order };
  } finally { db.close(); }
}

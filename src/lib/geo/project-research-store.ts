import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ProjectResearchDocument, ProjectResearchRelation, ProjectResearchSnapshot,
} from './project-research-types';

const schema = `
  CREATE TABLE IF NOT EXISTS geo_project_research_runs (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    limitations TEXT NOT NULL,
    searches TEXT,
    PRIMARY KEY (project_id, run_id)
  );
  CREATE TABLE IF NOT EXISTS geo_project_research_sources (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    markdown TEXT NOT NULL,
    read_at TEXT NOT NULL,
    type TEXT NOT NULL,
    origin TEXT NOT NULL,
    source_path TEXT NOT NULL,
    ownership TEXT,
    PRIMARY KEY (project_id, run_id, source_id),
    FOREIGN KEY (project_id, run_id) REFERENCES geo_project_research_runs(project_id, run_id)
  );
  CREATE TABLE IF NOT EXISTS geo_project_research_relations (
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    relation_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL,
    statement TEXT NOT NULL,
    audience TEXT NOT NULL,
    basis TEXT NOT NULL,
    evidence TEXT NOT NULL,
    PRIMARY KEY (project_id, run_id, relation_id),
    FOREIGN KEY (project_id, run_id) REFERENCES geo_project_research_runs(project_id, run_id)
  );
`;

type RunRow = Omit<ProjectResearchSnapshot, 'documents' | 'relations' | 'limitations' | 'searches'> & { limitations: string; searches: string | null };
type SourceRow = Omit<ProjectResearchDocument, 'ownership'> & { ownership: ProjectResearchDocument['ownership'] | null };
type RelationRow = Omit<ProjectResearchRelation, 'evidence'> & { evidence: string };

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some(item => item.name === column);
}

function selectRuns(db: Database.Database): string {
  const searches = hasColumn(db, 'geo_project_research_runs', 'searches') ? 'searches' : 'NULL AS searches';
  return `SELECT version, project_id AS projectId, run_id AS runId,
    created_at AS createdAt, status, limitations, ${searches} FROM geo_project_research_runs`;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSnapshot(snapshot: ProjectResearchSnapshot): void {
  if (snapshot.version !== 1 || !nonempty(snapshot.projectId) || !nonempty(snapshot.runId)
    || !Number.isFinite(Date.parse(snapshot.createdAt)) || !['completed', 'partial'].includes(snapshot.status)
    || !Array.isArray(snapshot.documents) || !Array.isArray(snapshot.relations)
    || !Array.isArray(snapshot.limitations) || snapshot.limitations.some(value => typeof value !== 'string')) {
    throw new Error('项目资料批次的编号、时间、状态或内容无效。');
  }
  if (snapshot.searches !== undefined && (!Array.isArray(snapshot.searches) || snapshot.searches.some(search =>
    !nonempty(search.query) || !Number.isFinite(Date.parse(search.requestedAt))
    || !['pending', 'completed', 'failed'].includes(search.status)
    || (search.confirmedCostCny !== null && (!Number.isFinite(search.confirmedCostCny) || search.confirmedCostCny < 0))
    || !Number.isFinite(search.reservedCostCny) || search.reservedCostCny < 0
    || !Array.isArray(search.results) || search.results.some(result => typeof result.title !== 'string' || typeof result.url !== 'string')))) {
    throw new Error('项目资料的搜索记录或费用无效。');
  }
  const sources = new Map<string, ProjectResearchDocument>();
  for (const document of snapshot.documents) {
    if (!nonempty(document.id) || sources.has(document.id)) throw new Error('项目资料的文档编号必须唯一且非空。');
    if ([document.title, document.url, document.markdown, document.type, document.sourcePath].some(value => typeof value !== 'string')
      || !Number.isFinite(Date.parse(document.readAt)) || !['entry', 'linked', 'external'].includes(document.origin)
      || (document.ownership !== undefined && !['owned', 'external', 'unknown'].includes(document.ownership))) {
      throw new Error('项目资料必须保留正文和读取信息。');
    }
    sources.set(document.id, document);
  }
  const relations = new Set<string>();
  for (const relation of snapshot.relations) {
    if (!nonempty(relation.id) || relations.has(relation.id)) throw new Error('项目资料的关系编号必须唯一且非空。');
    if (!['capability', 'contribution', 'need'].includes(relation.kind)
      || !['source', 'inferred'].includes(relation.basis) || !nonempty(relation.statement)
      || typeof relation.audience !== 'string' || !Array.isArray(relation.evidence)) {
      throw new Error('项目资料的关系内容无效。');
    }
    relations.add(relation.id);
    for (const evidence of relation.evidence) {
      const document = sources.get(evidence.sourceId);
      if (!document) throw new Error('关系引用的来源必须属于本次项目资料。');
      if (!nonempty(evidence.quote) || !document.markdown.includes(evidence.quote)) {
        throw new Error('关系引用必须逐字存在于来源正文中。');
      }
    }
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
}

function readSnapshot(db: Database.Database, row: RunRow): ProjectResearchSnapshot {
  const ownershipColumn = hasColumn(db, 'geo_project_research_sources', 'ownership') ? 'ownership' : 'NULL AS ownership';
  const documents = (db.prepare(`SELECT source_id AS id, title, url, markdown, read_at AS readAt,
    type, origin, source_path AS sourcePath, ${ownershipColumn} FROM geo_project_research_sources
    WHERE project_id = ? AND run_id = ? ORDER BY position`).all(row.projectId, row.runId) as SourceRow[])
    .map(({ ownership, ...document }) => ({ ...document, ...(ownership === null ? {} : { ownership }) }));
  const relations = (db.prepare(`SELECT relation_id AS id, kind, statement, audience, basis, evidence
    FROM geo_project_research_relations WHERE project_id = ? AND run_id = ? ORDER BY position`)
    .all(row.projectId, row.runId) as RelationRow[]).map(relation => ({ ...relation, evidence: JSON.parse(relation.evidence) }));
  const { searches, ...metadata } = row;
  return { ...metadata, limitations: JSON.parse(row.limitations), documents, relations,
    ...(searches === null ? {} : { searches: JSON.parse(searches) }) };
}

/** Append one immutable research run to the existing project's data directory. */
export function appendProjectResearch(directory: string, snapshot: ProjectResearchSnapshot): void {
  validateSnapshot(snapshot);
  fs.mkdirSync(directory, { recursive: true });
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    db.pragma('busy_timeout = 5000');
    if (db.pragma('journal_mode', { simple: true }) !== 'wal') db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      db.exec(schema);
      if (!hasColumn(db, 'geo_project_research_runs', 'searches')) db.exec('ALTER TABLE geo_project_research_runs ADD COLUMN searches TEXT');
      if (!hasColumn(db, 'geo_project_research_sources', 'ownership')) db.exec('ALTER TABLE geo_project_research_sources ADD COLUMN ownership TEXT');
      const existing = db.prepare(`${selectRuns(db)} WHERE project_id = ? AND run_id = ?`)
        .get(snapshot.projectId, snapshot.runId) as RunRow | undefined;
      if (existing) {
        if (stableJson(readSnapshot(db, existing)) !== stableJson(snapshot)) throw new Error('已经保存的项目资料批次不能覆盖。');
        return;
      }
      db.prepare(`INSERT INTO geo_project_research_runs
        (project_id, run_id, version, created_at, status, limitations, searches) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(snapshot.projectId, snapshot.runId, snapshot.version, snapshot.createdAt, snapshot.status,
          JSON.stringify(snapshot.limitations), snapshot.searches === undefined ? null : JSON.stringify(snapshot.searches));
      const insertSource = db.prepare(`INSERT INTO geo_project_research_sources
        (project_id, run_id, source_id, position, title, url, markdown, read_at, type, origin, source_path, ownership)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      snapshot.documents.forEach((document, position) => insertSource.run(snapshot.projectId, snapshot.runId,
        document.id, position, document.title, document.url, document.markdown, document.readAt,
        document.type, document.origin, document.sourcePath, document.ownership ?? null));
      const insertRelation = db.prepare(`INSERT INTO geo_project_research_relations
        (project_id, run_id, relation_id, position, kind, statement, audience, basis, evidence)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      snapshot.relations.forEach((relation, position) => insertRelation.run(snapshot.projectId, snapshot.runId,
        relation.id, position, relation.kind, relation.statement, relation.audience, relation.basis, JSON.stringify(relation.evidence)));
    }).immediate();
  } finally { db.close(); }
}

function readResearch<T>(directory: string, empty: T, operation: (db: Database.Database) => T): T {
  const file = path.join(directory, 'db.sqlite');
  if (!fs.existsSync(file)) return empty;
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('geo_project_research_runs', 'geo_project_research_sources', 'geo_project_research_relations')`).all();
    return tables.length === 3 ? db.transaction(() => operation(db))() : empty;
  } finally { db.close(); }
}

/** Latest means the most recently appended run, including partial research. */
export function readLatestProjectResearch(directory: string, projectId: string): ProjectResearchSnapshot | null {
  return readResearch(directory, null, db => {
    const row = db.prepare(`${selectRuns(db)} WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`).get(projectId) as RunRow | undefined;
    return row ? readSnapshot(db, row) : null;
  });
}

/** Return immutable runs newest first without creating a database or tables. */
export function readProjectResearchHistory(directory: string, projectId: string): ProjectResearchSnapshot[] {
  return readResearch(directory, [], db => (db.prepare(`${selectRuns(db)} WHERE project_id = ? ORDER BY rowid DESC`)
    .all(projectId) as RunRow[]).map(row => readSnapshot(db, row)));
}

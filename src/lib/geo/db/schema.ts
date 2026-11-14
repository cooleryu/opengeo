import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { projectDataDirectory, resolveGeoProject, withGeoProject } from '../projects';
import type { GeoQuestionPlan, QuestionCategory } from '../question-types';
import type { ResearchEngine, ResearchObservation, ResearchQuestion, ResearchSource } from '../research-types';

export type QuestionStatus = 'active' | 'candidate' | 'archived';
export type OptimizationRunMode = 'focus' | 'deep';
export type OptimizationRunStatus =
  | 'planning'
  | 'drafting'
  | 'reviewing'
  | 'awaiting_approval'
  | 'implementing'
  | 'awaiting_retest'
  | 'remeasuring'
  | 'completed'
  | 'failed';
export type DeliverableKind = 'update_asset' | 'new_content';
export type DeliverableFormat = 'rich_markdown' | 'web_html';
export type DeliverableStatus = 'drafting' | 'ready' | 'approved' | 'skipped' | 'applied';

export interface ProjectProfileMeta {
  productSummary: string;
  contributionSummary: string;
  scopeNote: string;
  nextStep: string;
  asOf: string;
  initialUpdatedAt?: string;
  reportPath?: string;
  sourceAuditPath?: string;
  reviewPath?: string;
  questionPlan?: GeoQuestionPlan;
}

export interface RelationalProjectRow {
  id: string;
  name: string;
  description: string;
  site_url: string;
  repo_url: string;
  owner: string;
  active_batch_id: string;
  batch_date: string;
  profile_json: string;
  created_at: string;
  updated_at: string;
}

export interface RelationalAssetRow {
  project_id: string;
  id: string;
  ownership: 'owned' | 'external' | 'unknown';
  type: string;
  language: string;
  status: string;
  title: string;
  summary: string;
  public_url: string | null;
  content_path: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationalQuestionRow {
  project_id: string;
  id: string;
  batch_id: string;
  status: QuestionStatus;
  decision: ResearchQuestion['decision'];
  category: QuestionCategory | null;
  candidate_id: string | null;
  plan_revision: number | null;
  sort_order: number;
  query_zh: string;
  query_en: string;
  intent_summary: string;
  evidence_basis: string;
  answerability: string;
  decision_reason: string;
  review_path: string;
  gaps_json: string;
  diagnosis_json: string;
  created_at: string;
  updated_at: string;
}

export interface RelationalObservationRow {
  seq: number;
  project_id: string;
  id: string;
  batch_id: string;
  question_id: string;
  optimization_run_id: string | null;
  run_id: string | null;
  engine: ResearchEngine;
  language: 'zh' | 'en';
  entry_type: ResearchObservation['entryType'] | null;
  overview_status: string | null;
  query_text: string;
  status: 'found' | 'not_observed';
  summary: string;
  answer_path: string | null;
  evidence_path: string;
  sources_json: string;
  conditions_text: string;
  recorded_at: string;
  collected_at: string | null;
  created_at: string;
}

export interface RelationalAuditRow {
  id: number;
  project_id: string;
  observation_id: string;
  is_current: 0 | 1;
  mention: 'yes' | 'no' | 'unknown';
  citation: 'yes' | 'no' | 'unknown';
  mention_evidence: string;
  citation_evidence: string;
  official_urls_json: string;
  answer_complete: 0 | 1;
  analysis_status: 'complete' | 'needs_review' | 'failed' | 'not_applicable' | null;
  method: 'model' | 'legacy' | 'unavailable' | null;
  analysis_model: string | null;
  reasoning_effort: string | null;
  limitations_json: string;
  reviewed_at: string | null;
  audited_at: string;
}

export interface RelationalOptimizationRunRow {
  id: string;
  project_id: string;
  mode: OptimizationRunMode;
  status: OptimizationRunStatus;
  status_message: string;
  summary: string;
  progress_json: string;
  baseline_obs_ids_json: string;
  followup_obs_ids_json: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationalDeliverableRow {
  id: string;
  project_id: string;
  run_id: string;
  priority: number;
  kind: DeliverableKind;
  format: DeliverableFormat;
  status: DeliverableStatus;
  title: string;
  target_asset_id: string | null;
  destination: string;
  audience_and_goal: string;
  question_ids_json: string;
  before_content: string;
  after_content: string;
  media_manifest_json: string;
  companion_files_json: string;
  reference_winners_json?: string;
  review_json: string | null;
  applied_record_json: string | null;
  created_at: string;
  updated_at: string;
}

export const RELATIONAL_TABLES = [
  'opengeo_projects',
  'opengeo_assets',
  'opengeo_questions',
  'opengeo_optimization_runs',
  'opengeo_observations',
  'opengeo_answer_audits',
  'opengeo_deliverables',
] as const;

export const RELATIONAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS opengeo_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    active_batch_id TEXT NOT NULL DEFAULT '',
    batch_date TEXT NOT NULL DEFAULT '',
    profile_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS opengeo_assets (
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    ownership TEXT NOT NULL CHECK (ownership IN ('owned', 'external', 'unknown')),
    type TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'zh',
    status TEXT NOT NULL DEFAULT 'published',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    public_url TEXT,
    content_path TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id) REFERENCES opengeo_projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS opengeo_questions (
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    batch_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('active', 'candidate', 'archived')),
    decision TEXT NOT NULL DEFAULT 'search_now' CHECK (decision IN ('search_now', 'keep_and_fill', 'drop_for_now')),
    category TEXT,
    candidate_id TEXT,
    plan_revision INTEGER,
    sort_order INTEGER NOT NULL DEFAULT 0,
    query_zh TEXT NOT NULL DEFAULT '',
    query_en TEXT NOT NULL DEFAULT '',
    intent_summary TEXT NOT NULL DEFAULT '',
    evidence_basis TEXT NOT NULL DEFAULT '',
    answerability TEXT NOT NULL DEFAULT '',
    decision_reason TEXT NOT NULL DEFAULT '',
    review_path TEXT NOT NULL DEFAULT '',
    gaps_json TEXT NOT NULL DEFAULT '[]',
    diagnosis_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project_id, id),
    FOREIGN KEY (project_id) REFERENCES opengeo_projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS opengeo_optimization_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('focus', 'deep')),
    status TEXT NOT NULL CHECK (
      status IN (
        'planning',
        'drafting',
        'reviewing',
        'awaiting_approval',
        'implementing',
        'awaiting_retest',
        'remeasuring',
        'completed',
        'failed'
      )
    ),
    status_message TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    progress_json TEXT NOT NULL DEFAULT '[]',
    baseline_obs_ids_json TEXT NOT NULL DEFAULT '[]',
    followup_obs_ids_json TEXT NOT NULL DEFAULT '[]',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id) REFERENCES opengeo_projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS opengeo_observations (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    id TEXT NOT NULL,
    batch_id TEXT NOT NULL DEFAULT '',
    question_id TEXT NOT NULL,
    optimization_run_id TEXT,
    run_id TEXT,
    engine TEXT NOT NULL CHECK (engine IN ('chatgpt', 'google', 'deepseek', 'qwen', 'doubao')),
    language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
    entry_type TEXT CHECK (
      entry_type IS NULL OR entry_type IN ('web_answer', 'web_search', 'api_answer', 'api_search')
    ),
    overview_status TEXT,
    query_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('found', 'not_observed')),
    summary TEXT NOT NULL DEFAULT '',
    answer_path TEXT,
    evidence_path TEXT NOT NULL,
    sources_json TEXT NOT NULL DEFAULT '[]',
    conditions_text TEXT NOT NULL DEFAULT '',
    recorded_at TEXT NOT NULL,
    collected_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (project_id, id),
    FOREIGN KEY (project_id, question_id) REFERENCES opengeo_questions(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, optimization_run_id) REFERENCES opengeo_optimization_runs(project_id, id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_opengeo_observations_lookup
    ON opengeo_observations(project_id, batch_id, question_id, engine, language, seq);

  CREATE TABLE IF NOT EXISTS opengeo_answer_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
    mention TEXT NOT NULL CHECK (mention IN ('yes', 'no', 'unknown')),
    citation TEXT NOT NULL CHECK (citation IN ('yes', 'no', 'unknown')),
    mention_evidence TEXT NOT NULL,
    citation_evidence TEXT NOT NULL,
    official_urls_json TEXT NOT NULL DEFAULT '[]',
    answer_complete INTEGER NOT NULL CHECK (answer_complete IN (0, 1)),
    analysis_status TEXT CHECK (
      analysis_status IS NULL OR analysis_status IN ('complete', 'needs_review', 'failed', 'not_applicable')
    ),
    method TEXT CHECK (method IS NULL OR method IN ('model', 'legacy', 'unavailable')),
    analysis_model TEXT,
    reasoning_effort TEXT,
    limitations_json TEXT NOT NULL DEFAULT '[]',
    reviewed_at TEXT,
    audited_at TEXT NOT NULL,
    FOREIGN KEY (project_id, observation_id) REFERENCES opengeo_observations(project_id, id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_opengeo_answer_audits_current
    ON opengeo_answer_audits(project_id, observation_id)
    WHERE is_current = 1;

  CREATE INDEX IF NOT EXISTS idx_opengeo_answer_audits_history
    ON opengeo_answer_audits(project_id, observation_id, id);

  CREATE TABLE IF NOT EXISTS opengeo_deliverables (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL CHECK (kind IN ('update_asset', 'new_content')),
    format TEXT NOT NULL DEFAULT 'rich_markdown' CHECK (format IN ('rich_markdown', 'web_html')),
    status TEXT NOT NULL CHECK (status IN ('drafting', 'ready', 'approved', 'skipped', 'applied')),
    title TEXT NOT NULL,
    target_asset_id TEXT,
    destination TEXT NOT NULL DEFAULT '',
    audience_and_goal TEXT NOT NULL DEFAULT '',
    question_ids_json TEXT NOT NULL DEFAULT '[]',
    before_content TEXT NOT NULL DEFAULT '',
    after_content TEXT NOT NULL DEFAULT '',
    media_manifest_json TEXT NOT NULL DEFAULT '[]',
    companion_files_json TEXT NOT NULL DEFAULT '[]',
    reference_winners_json TEXT NOT NULL DEFAULT '[]',
    review_json TEXT,
    applied_record_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id, run_id) REFERENCES opengeo_optimization_runs(project_id, id) ON DELETE CASCADE,
    FOREIGN KEY (project_id, target_asset_id) REFERENCES opengeo_assets(project_id, id) ON DELETE SET NULL
  );
`;

export function projectDatabasePath(projectId: string): string {
  const id = resolveGeoProject(projectId);
  const directory = withGeoProject(id, projectDataDirectory);
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, 'db.sqlite');
}

export function configureSqliteConnection(db: Database.Database): Database.Database {
  db.pragma('busy_timeout = 5000');
  if (db.pragma('journal_mode', { simple: true }) !== 'wal') {
    db.pragma('journal_mode = WAL');
  }
  const existingRunTable = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'opengeo_optimization_runs'")
    .get() as { sql?: string } | undefined;
  if (
    existingRunTable?.sql &&
    (!existingRunTable.sql.includes("'reviewing'") || !existingRunTable.sql.includes('progress_json'))
  ) {
    const hasProgress = existingRunTable.sql.includes('progress_json');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE new_opengeo_optimization_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('focus', 'deep')),
        status TEXT NOT NULL CHECK (
          status IN (
            'planning',
            'drafting',
            'reviewing',
            'awaiting_approval',
            'implementing',
            'awaiting_retest',
            'remeasuring',
            'completed',
            'failed'
          )
        ),
        status_message TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        progress_json TEXT NOT NULL DEFAULT '[]',
        baseline_obs_ids_json TEXT NOT NULL DEFAULT '[]',
        followup_obs_ids_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, id),
        FOREIGN KEY (project_id) REFERENCES opengeo_projects(id) ON DELETE CASCADE
      );
      INSERT INTO new_opengeo_optimization_runs (
        id, project_id, mode, status, status_message, summary, progress_json,
        baseline_obs_ids_json, followup_obs_ids_json, error_message, created_at, updated_at
      )
      SELECT
        id, project_id, mode, status, status_message, summary, ${hasProgress ? 'progress_json' : "'[]'"},
        baseline_obs_ids_json, followup_obs_ids_json, error_message, created_at, updated_at
      FROM opengeo_optimization_runs;
      DROP TABLE opengeo_optimization_runs;
      ALTER TABLE new_opengeo_optimization_runs RENAME TO opengeo_optimization_runs;
      COMMIT;
    `);
  }

  const staleRef = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%opengeo_optimization_runs_legacy_step1%'",
    )
    .all() as Array<{ name: string }>;
  if (staleRef.length > 0) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE new_opengeo_observations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        batch_id TEXT NOT NULL DEFAULT '',
        question_id TEXT NOT NULL,
        optimization_run_id TEXT,
        run_id TEXT,
        engine TEXT NOT NULL CHECK (engine IN ('chatgpt', 'google', 'deepseek', 'qwen', 'doubao')),
        language TEXT NOT NULL CHECK (language IN ('zh', 'en')),
        entry_type TEXT CHECK (
          entry_type IS NULL OR entry_type IN ('web_answer', 'web_search', 'api_answer', 'api_search')
        ),
        overview_status TEXT,
        query_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('found', 'not_observed')),
        summary TEXT NOT NULL DEFAULT '',
        answer_path TEXT,
        evidence_path TEXT NOT NULL,
        sources_json TEXT NOT NULL DEFAULT '[]',
        conditions_text TEXT NOT NULL DEFAULT '',
        recorded_at TEXT NOT NULL,
        collected_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, id),
        FOREIGN KEY (project_id, question_id) REFERENCES opengeo_questions(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, optimization_run_id) REFERENCES opengeo_optimization_runs(project_id, id) ON DELETE SET NULL
      );
      INSERT INTO new_opengeo_observations SELECT * FROM opengeo_observations;
      DROP TABLE opengeo_observations;
      ALTER TABLE new_opengeo_observations RENAME TO opengeo_observations;

      CREATE TABLE new_opengeo_deliverables (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL CHECK (kind IN ('update_asset', 'new_content')),
        format TEXT NOT NULL DEFAULT 'rich_markdown' CHECK (format IN ('rich_markdown', 'web_html')),
        status TEXT NOT NULL CHECK (status IN ('drafting', 'ready', 'approved', 'skipped', 'applied')),
        title TEXT NOT NULL,
        target_asset_id TEXT,
        destination TEXT NOT NULL DEFAULT '',
        audience_and_goal TEXT NOT NULL DEFAULT '',
        question_ids_json TEXT NOT NULL DEFAULT '[]',
        before_content TEXT NOT NULL DEFAULT '',
        after_content TEXT NOT NULL DEFAULT '',
        media_manifest_json TEXT NOT NULL DEFAULT '[]',
        review_json TEXT,
        applied_record_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id, run_id) REFERENCES opengeo_optimization_runs(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, target_asset_id) REFERENCES opengeo_assets(project_id, id) ON DELETE SET NULL
      );
      INSERT INTO new_opengeo_deliverables SELECT * FROM opengeo_deliverables;
      DROP TABLE opengeo_deliverables;
      ALTER TABLE new_opengeo_deliverables RENAME TO opengeo_deliverables;
      COMMIT;
    `);
  }

  db.pragma('foreign_keys = ON');
  db.exec(RELATIONAL_SCHEMA_SQL);
  const delivColumns = db
    .prepare("PRAGMA table_info('opengeo_deliverables')")
    .all() as Array<{ name: string }>;
  if (!delivColumns.some((col) => col.name === 'companion_files_json')) {
    db.exec("ALTER TABLE opengeo_deliverables ADD COLUMN companion_files_json TEXT NOT NULL DEFAULT '[]';");
  }
  if (!delivColumns.some((col) => col.name === 'reference_winners_json')) {
    db.exec("ALTER TABLE opengeo_deliverables ADD COLUMN reference_winners_json TEXT NOT NULL DEFAULT '[]';");
  }
  return db;
}

export function withProjectDb<T>(
  projectId: string,
  operation: (db: Database.Database, resolvedProjectId: string) => T,
  connection?: Database.Database,
): T {
  const id = resolveGeoProject(projectId);
  if (connection) {
    configureSqliteConnection(connection);
    return operation(connection, id);
  }
  const db = new Database(projectDatabasePath(id));
  try {
    configureSqliteConnection(db);
    return operation(db, id);
  } finally {
    db.close();
  }
}

export function parseSourcesJson(raw: string): ResearchSource[] {
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

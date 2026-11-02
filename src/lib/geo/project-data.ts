import fs from 'node:fs';
import path from 'node:path';
import exampleProject from './data/example-project.json';
import exampleProjectTwo from './data/example-project-two.json';
import type { GeoSeed } from './types';
import type { ResearchBatch } from './research-types';
import type { AnswerAuditRecord } from './overview-metrics';

export type LegacyAnswerAuditRecord = AnswerAuditRecord & {
  citationCoverage?: 'complete' | 'partial' | 'unknown';
};
export type LegacyAnswerAudit = {
  reviewedAt: string;
  scope: { limits: string };
  records: LegacyAnswerAuditRecord[];
};
type ProjectManifest = {
  defaultProjectId: string;
  projects: { id: string; seedFile: string }[];
  researchFile?: string;
  answerAudit?: { file: string; source: string };
};

// Local source material is read only at runtime, never statically bundled.
// DATA_DIR continues to select the existing databases independently of this
// optional override, including when tests use an isolated temporary database.
export function localProjectsDirectory(): string {
  return path.resolve(process.env.GEO_LOCAL_PROJECTS_DIR || path.join(process.cwd(), 'data', 'local-projects'));
}

export function readLocalProjectFile<T>(file: string): T {
  if (typeof file !== 'string' || !file || path.isAbsolute(file)) throw new Error('本地项目资料路径无效。');
  const root = localProjectsDirectory();
  const target = path.resolve(root, file);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error('本地项目资料路径无效。');
  }
  return JSON.parse(fs.readFileSync(target, 'utf8')) as T;
}

function readManifest(): ProjectManifest | null {
  if (!fs.existsSync(path.join(localProjectsDirectory(), 'projects.json'))) return null;
  const manifest = readLocalProjectFile<ProjectManifest>('projects.json');
  if (!manifest || !Array.isArray(manifest.projects) || !manifest.projects.length ||
      manifest.projects.some((project) => !project || typeof project.id !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(project.id) || typeof project.seedFile !== 'string') ||
      new Set(manifest.projects.map(project => project.id)).size !== manifest.projects.length ||
      !manifest.projects.some(project => project.id === manifest.defaultProjectId)) {
    throw new Error('本地项目清单无效，请检查 data/local-projects/projects.json。');
  }
  return manifest;
}

export function readProjectCatalog(): { defaultProjectId: string; ids: string[] } {
  const manifest = readManifest();
  return manifest
    ? { defaultProjectId: manifest.defaultProjectId, ids: manifest.projects.map(project => project.id) }
    : { defaultProjectId: exampleProject.project.id, ids: [exampleProject.project.id, exampleProjectTwo.project.id] };
}

export function loadProjectSeed(projectId: string): GeoSeed {
  const manifest = readManifest();
  const entry = manifest?.projects.find(project => project.id === projectId);
  const source = manifest
    ? (entry ? readLocalProjectFile<GeoSeed>(entry.seedFile) : null)
    : [exampleProject, exampleProjectTwo].find(seed => seed.project.id === projectId);
  if (!source || source.project?.id !== projectId) throw new Error('项目种子与本地项目清单不一致。');
  const seed = structuredClone(source) as GeoSeed;
  // Keep the older title/detail proposal format readable without rewriting it.
  seed.proposal.changes = seed.proposal.changes.map((change: string | { title: string; detail: string }) =>
    typeof change === 'string' ? change : `${change.title}：${change.detail}`);
  return seed;
}

export function loadInitialResearch(): ResearchBatch[] {
  const file = readManifest()?.researchFile;
  if (!file) return [];
  const batches = readLocalProjectFile<ResearchBatch[]>(file);
  if (!Array.isArray(batches)) throw new Error('本地研究资料须为批次列表。');
  return batches;
}

export function loadLegacyAnswerAudit(): LegacyAnswerAudit {
  const file = readManifest()?.answerAudit?.file;
  if (!file) return { reviewedAt: '', scope: { limits: '未包含历史审核记录。' }, records: [] };
  const audit = readLocalProjectFile<LegacyAnswerAudit>(file);
  if (!audit || !Array.isArray(audit.records) || typeof audit.reviewedAt !== 'string' || typeof audit.scope?.limits !== 'string') {
    throw new Error('本地回答审核资料格式无效。');
  }
  return audit;
}

export function legacyAnswerAuditSource(): string {
  return readManifest()?.answerAudit?.source || 'local-answer-audit';
}

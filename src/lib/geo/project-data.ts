import fs from 'node:fs';
import path from 'node:path';
import exampleProject from './data/example-project.json';
import exampleProjectTwo from './data/example-project-two.json';
import type { GeoSeed } from './types';
import type { ResearchBatch } from './research-types';
import type { AnswerAuditRecord } from './overview-metrics';
import { resolveProjectUiLanguage } from './i18n';
import type { OnboardingRecord } from './project-onboarding-types';
import { researchDocumentAsset } from './project-research-assets';
import { readLatestProjectResearch } from './project-research-store';

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

export interface RuntimeProjectEntry {
  seed: GeoSeed;
  onboarding: OnboardingRecord;
  requestId?: string;
  owner: { pid: number; token: string };
}
export function runtimeProjectsFile(): string {
  return path.join(process.env.DATA_DIR || process.cwd(), 'data', 'created-projects', 'projects.json');
}
export function readRuntimeProjects(): RuntimeProjectEntry[] {
  const file = runtimeProjectsFile();
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeProjectEntry[];
  if (!Array.isArray(entries) || entries.some(entry => !entry?.seed?.project ||
    !/^project-[a-f0-9]{24}$/.test(entry.seed.project.id) || entry.onboarding?.projectId !== entry.seed.project.id) ||
    new Set(entries.map(entry => entry.seed.project.id)).size !== entries.length) {
    throw new Error('新建项目资料无效。');
  }
  return entries;
}
export function writeRuntimeProjects(entries: RuntimeProjectEntry[]): void {
  const file = runtimeProjectsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function isRuntimeProject(projectId: string): boolean {
  return readRuntimeProjects().some(entry => entry.seed.project.id === projectId);
}

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
  const runtime = readRuntimeProjects();
  const opengeoRuntime = runtime.find(
    (entry) => entry.seed.project.name.trim().toLowerCase() === 'opengeo',
  );
  const ids = [
    ...(opengeoRuntime ? [opengeoRuntime.seed.project.id] : []),
    ...(manifest?.projects.map((project) => project.id) || []),
    ...runtime.map((entry) => entry.seed.project.id),
  ];
  return {
    defaultProjectId:
      opengeoRuntime?.seed.project.id ||
      manifest?.defaultProjectId ||
      ids[0] ||
      exampleProject.project.id,
    ids: [...new Set(ids)],
  };
}
/** The legacy database root is fixed by the read-only manifest, never a newly created project. */
export function legacyDefaultProjectId(): string {
  return readManifest()?.defaultProjectId || exampleProject.project.id;
}

export function loadProjectSeed(projectId: string): GeoSeed {
  const manifest = readManifest();
  const runtime = readRuntimeProjects();
  const entry = manifest?.projects.find(project => project.id === projectId);
  const runtimeEntry = runtime.find(item => item.seed.project.id === projectId);
  const source = entry ? readLocalProjectFile<GeoSeed>(entry.seedFile)
    : runtimeEntry?.seed
      || (!manifest ? [exampleProject, exampleProjectTwo].find(seed => seed.project.id === projectId) : null);
  if (!source || source.project?.id !== projectId) throw new Error('项目种子与本地项目清单不一致。');
  const seed = structuredClone(source) as GeoSeed;
  seed.project.uiLanguage = resolveProjectUiLanguage({
    uiLanguage: runtimeEntry?.onboarding?.uiLanguage ?? seed.project.uiLanguage,
    summaryOrDescription:
      runtimeEntry?.onboarding?.analysis?.summary || seed.project.description,
  });
  // Keep the older title/detail proposal format readable without rewriting it.
  seed.proposal.changes = seed.proposal.changes.map((change: string | { title: string; detail: string }) =>
    typeof change === 'string' ? change : `${change.title}：${change.detail}`);
  // Match projects.projectDataDirectory without importing projects back into its loader.
  const base = path.join(process.env.DATA_DIR || process.cwd(), 'data');
  const legacyId = manifest?.defaultProjectId || exampleProject.project.id;
  const directory = projectId === legacyId && !runtime.some(item => item.seed.project.id === projectId)
    ? base : path.join(base, 'projects', projectId);
  const research = readLatestProjectResearch(directory, projectId);
  if (research) {
    const assets = new Map(seed.assets.map(asset => [asset.id, asset]));
    for (const document of research.documents) {
      const asset = researchDocumentAsset(projectId, document, seed.project);
      assets.set(asset.id, asset);
    }
    seed.assets = [...assets.values()];
  }
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

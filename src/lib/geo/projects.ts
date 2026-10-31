import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import exampleProject from './data/example-project.json';
import exampleProjectTwo from './data/example-project-two.json';
import type { GeoProject } from './types';

export const DEFAULT_PROJECT_ID = 'example-project';
export const GEO_PROJECT_IDS = [DEFAULT_PROJECT_ID, 'example-project-two'] as const;
export type GeoProjectId = typeof GEO_PROJECT_IDS[number];

// Keep request scope stable across reloads without a mutable shared current project.
const globals = globalThis as typeof globalThis & { __openGeoProjectContext?: AsyncLocalStorage<GeoProjectId> };
const context = globals.__openGeoProjectContext ??= new AsyncLocalStorage<GeoProjectId>();

export class GeoProjectError extends Error {
  readonly status = 404;
  constructor() { super('没有找到这个项目。'); }
}
export function resolveGeoProject(value: unknown): GeoProjectId {
  if (value === undefined || value === null || value === '') return DEFAULT_PROJECT_ID;
  if (typeof value !== 'string' || !GEO_PROJECT_IDS.includes(value as GeoProjectId)) throw new GeoProjectError();
  return value as GeoProjectId;
}
export const currentGeoProject = (): GeoProjectId => context.getStore() ?? DEFAULT_PROJECT_ID;
export function withGeoProject<T>(projectId: unknown, operation: () => T): T {
  return context.run(resolveGeoProject(projectId), operation);
}
export function listGeoProjects(): GeoProject[] {
  return structuredClone([exampleProject.project, exampleProjectTwo.project]) as GeoProject[];
}
export function projectDataDirectory(): string {
  const base = path.join(process.env.DATA_DIR || process.cwd(), 'data');
  const id = currentGeoProject();
  return id === DEFAULT_PROJECT_ID ? base : path.join(base, 'projects', id);
}
/** Run references remain stable; the active project selects their physical root. */
export function evidenceLocation(file: string): { root: string; target: string } {
  const runtimeEvidence = file.startsWith('data/geo-evidence/');
  const root = path.resolve(runtimeEvidence ? projectDataDirectory() : process.env.GEO_WORKSPACE || path.join(process.cwd(), '..'));
  return { root, target: path.resolve(root, runtimeEvidence ? file.slice('data/'.length) : file) };
}

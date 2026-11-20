import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isPublicProjectAddress, lookupPublicProjectHost, PublicProjectNetworkError } from './project-public-network';
import { loadProjectSeed, readRuntimeProjects, writeRuntimeProjects } from './project-data';
import {
  projectContextExists,
  synthesizeProjectContextMarkdown,
  writeProjectContext,
} from './project-context';
import { listGeoProjects, resolveGeoProject } from './projects';
import type { GeoProject, GeoSeed } from './types';
import { inferProjectEntryKind, type OnboardingAnalysis, type OnboardingRecord, type ProjectEntryKind } from './project-onboarding-types';
import { translateServerCode, type ServerErrorParams } from './i18n-server';

export class ProjectOnboardingError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public params?: ServerErrorParams,
    public detail?: string,
  ) {
    super(translateServerCode('zh', code, params));
  }
}
const globals = globalThis as typeof globalThis & { __openGeoOnboardingOwner?: { pid: number; token: string } };
const owner = globals.__openGeoOnboardingOwner ??= { pid: process.pid, token: randomUUID() };
const pending = new Set<OnboardingRecord['status']>(['queued', 'reading', 'analyzing']);

export { isPublicProjectAddress } from './project-public-network';

export function normalizeProjectEntryUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.trim())) {
    throw new ProjectOnboardingError('invalid_url', 400, { reason: 'format' });
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ProjectOnboardingError('invalid_url', 400, { reason: 'scheme' }); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new ProjectOnboardingError('invalid_url', 400, { reason: 'credentials' });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
    (isIP(host) ? !isPublicProjectAddress(host) : !host.includes('.'))) {
    throw new ProjectOnboardingError('invalid_url', 400, { reason: 'private_host' });
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new ProjectOnboardingError('invalid_url', 400, { reason: 'port' });
  for (const key of url.searchParams.keys()) {
    if (/^(access[_-]?token|token|api[_-]?key|password|secret|authorization)$/i.test(key)) {
      throw new ProjectOnboardingError('invalid_url', 400, { reason: 'secret' });
    }
  }
  url.hash = '';
  if (!isIP(host)) url.hostname = host;
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (host === 'github.com' && /^\/[^/]+\/[^/]+$/.test(url.pathname)) url.pathname = url.pathname.replace(/\.git$/i, '').toLowerCase();
  return url.toString();
}

export async function assertPublicProjectEntry(url: string): Promise<void> {
  const host = new URL(normalizeProjectEntryUrl(url)).hostname.replace(/^\[|\]$/g, '');
  try { await lookupPublicProjectHost(host); }
  catch (error) {
    throw new ProjectOnboardingError(
      'page_unreadable',
      400,
      { reason: 'private_address' },
      error instanceof PublicProjectNetworkError ? error.message : undefined,
    );
  }
}

type CreateInput = { kind: unknown; url: unknown; notes?: unknown; requestId?: unknown; targetLanguage?: unknown; uiLanguage?: unknown };
export function validateProjectCreation(input: CreateInput): {
  kind: ProjectEntryKind;
  url: string;
  notes: string;
  requestId?: string;
  targetLanguage?: 'en' | 'zh';
  uiLanguage?: 'en' | 'zh';
} {
  const normalizedUrl = normalizeProjectEntryUrl(input.url);
  const rawKind =
    input.kind === undefined || input.kind === ''
      ? inferProjectEntryKind(normalizedUrl)
      : input.kind;
  if (!['repository', 'store', 'company', 'creator'].includes(rawKind as string)) throw new ProjectOnboardingError('invalid_request');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 4000)) {
    throw new ProjectOnboardingError('notes_too_long');
  }
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))) {
    throw new ProjectOnboardingError('invalid_request', 400, { reason: 'request_id' });
  }
  let targetLanguage: 'en' | 'zh' | undefined;
  if (input.targetLanguage !== undefined) {
    if (!['en', 'zh'].includes(input.targetLanguage as string)) {
      throw new ProjectOnboardingError('invalid_request', 400, { reason: 'target_language' });
    }
    targetLanguage = input.targetLanguage as 'en' | 'zh';
  }
  let uiLanguage: 'en' | 'zh' | undefined;
  if (input.uiLanguage !== undefined) {
    if (!['en', 'zh'].includes(input.uiLanguage as string)) {
      throw new ProjectOnboardingError('invalid_request');
    }
    uiLanguage = input.uiLanguage as 'en' | 'zh';
  }
  return {
    kind: rawKind as ProjectEntryKind,
    url: normalizedUrl,
    notes: (input.notes as string || '').trim(),
    requestId: input.requestId as string | undefined,
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(uiLanguage ? { uiLanguage } : {}),
  };
}

function ownerAlive(saved: { pid: number; token: string } | undefined): boolean {
  if (!saved || !Number.isInteger(saved.pid) || saved.pid <= 0) return false;
  if (saved.pid === process.pid) return saved.token === owner.token;
  try { process.kill(saved.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function getProjectOnboarding(projectId: string): OnboardingRecord | null {
  resolveGeoProject(projectId);
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) return null;
  if (pending.has(entry.onboarding.status) && !ownerAlive(entry.owner)) {
    entry.onboarding = {
      ...entry.onboarding,
      status: 'failed',
      messageCode: 'onboarding.status.interrupted',
      message: translateServerCode('zh', 'onboarding.status.interrupted'),
      errorCode: 'onboarding_interrupted',
      error: translateServerCode('zh', 'onboarding_interrupted'),
      updatedAt: new Date().toISOString(),
    };
    writeRuntimeProjects(entries);
  }
  return structuredClone(entry.onboarding);
}

function matchesUrl(project: GeoProject, url: string): boolean {
  return [project.siteUrl, project.repositoryUrl].some(candidate => {
    try { return normalizeProjectEntryUrl(candidate) === url; } catch { return false; }
  });
}
export function findExistingProject(input: ReturnType<typeof validateProjectCreation>): GeoProject | undefined {
  const requested = input.requestId && readRuntimeProjects().find(entry => entry.requestId === input.requestId);
  if (requested) {
    if (requested.onboarding.url !== input.url) throw new ProjectOnboardingError('stale_request', 409, { reason: 'url_conflict' });
    return structuredClone(requested.seed.project);
  }
  return listGeoProjects().find(project => matchesUrl(project, input.url));
}

export function createProjectOnboarding(input: CreateInput): { project: GeoProject; onboarding: OnboardingRecord | null; created: boolean } {
  const validated = validateProjectCreation(input);
  const existing = findExistingProject(validated);
  if (existing) return { project: existing, onboarding: getProjectOnboarding(existing.id), created: false };
  const { kind, url, notes, requestId, targetLanguage, uiLanguage } = validated;
  const projectId = `project-${randomBytes(12).toString('hex')}`;
  const createdAt = new Date().toISOString();
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const name = kind === 'repository' && parts.length > 1 ? parts[parts.length - 1] : parsed.hostname;
  const project: GeoProject = { id: projectId, name, description: '',
    siteUrl: kind === 'repository' ? '' : url, repositoryUrl: kind === 'repository' ? url : '', owner: '', asOf: createdAt.slice(0, 10),
    ...(targetLanguage ? { targetLanguage } : {}) };
  const onboarding: OnboardingRecord = {
    projectId,
    kind,
    url,
    notes,
    ...(targetLanguage ? { targetLanguage } : {}),
    ...(uiLanguage ? { uiLanguage } : {}),
    status: 'queued',
    messageCode: 'onboarding.status.queued',
    message: translateServerCode('zh', 'onboarding.status.queued'),
    createdAt,
    updatedAt: createdAt,
  };
  const seed: GeoSeed = { project, assets: [], questions: [], observations: [], findings: [], gaps: [],
    proposal: { id: `${projectId}-unreviewed`, title: '', status: 'unreviewed', rationale: '',
      targetAssetId: '', targetUrl: '', before: '', after: '', changes: [], evidencePaths: [], successCriteria: [], limitations: [] },
    monitoringPlan: [], boundaries: [] };
  writeRuntimeProjects([...readRuntimeProjects(), { seed, onboarding, requestId, owner }]);
  return { project: structuredClone(project), onboarding: structuredClone(onboarding), created: true };
}

export function updateProjectOnboarding(projectId: string,
  patch: Partial<Pick<OnboardingRecord, 'status' | 'message' | 'messageCode' | 'messageParams' | 'analysis' | 'error' | 'errorCode' | 'errorParams' | 'readLimitations' | 'sourceReads' | 'uiLanguage' | 'outputLanguage'>>): OnboardingRecord {
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) throw new ProjectOnboardingError('project_not_found', 404);
  const nextMessage = patch.message ?? (patch.messageCode ? translateServerCode('zh', patch.messageCode, patch.messageParams) : entry.onboarding.message);
  const nextError = patch.error ?? (patch.errorCode ? translateServerCode('zh', patch.errorCode, patch.errorParams) : entry.onboarding.error);
  entry.onboarding = {
    ...entry.onboarding,
    ...patch,
    message: nextMessage,
    ...(nextError !== undefined ? { error: nextError } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (patch.status && patch.status !== 'failed') {
    delete entry.onboarding.error;
    delete entry.onboarding.errorCode;
    delete entry.onboarding.errorParams;
  }
  entry.owner = owner;
  writeRuntimeProjects(entries);
  return structuredClone(entry.onboarding);
}

type OnboardingOperation = { project: GeoProject; onboarding: OnboardingRecord; started: boolean };

function validRequestId(requestId: unknown): requestId is string {
  return typeof requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId);
}

/** Save user intent before starting a revision. Replaying a request never starts another call. */
export function reviseProjectOnboarding(projectId: unknown, feedback: unknown, requestId: unknown, uiLanguage?: unknown): OnboardingOperation {
  if (typeof feedback !== 'string' || !feedback.trim() || feedback.length > 4000) {
    throw new ProjectOnboardingError('notes_too_long', 400);
  }
  if (!validRequestId(requestId)) throw new ProjectOnboardingError('invalid_request', 400, { reason: 'request_id' });
  const nextUiLanguage: 'en' | 'zh' | undefined = uiLanguage === 'en' || uiLanguage === 'zh' ? uiLanguage : undefined;
  const id = resolveGeoProject(projectId);
  const current = getProjectOnboarding(id);
  if (!current) throw new ProjectOnboardingError('stale_request', 409, { reason: 'no_record' });
  const text = feedback.trim();
  const previous = [current.revision, ...(current.revisionHistory ?? [])].find(item => item?.id === requestId);
  if (previous) {
    if (previous.feedback !== text) throw new ProjectOnboardingError('stale_request', 409, { reason: 'feedback_conflict' });
    return { project: loadProjectSeed(id).project, onboarding: current, started: false };
  }
  if ((current.status !== 'ready' && !(current.status === 'failed' && current.revision)) || !current.analysis) {
    throw new ProjectOnboardingError(
      'stale_request',
      409,
      { reason: current.status === 'failed' ? 'understanding_incomplete' : 'understanding_in_progress' },
    );
  }
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === id)!;
  const now = new Date().toISOString();
  entry.onboarding = {
    ...current,
    ...(nextUiLanguage ? { uiLanguage: nextUiLanguage } : {}),
    status: 'queued',
    messageCode: 'onboarding.status.queuedRevise',
    messageParams: undefined,
    message: translateServerCode('zh', 'onboarding.status.queuedRevise'),
    updatedAt: now,
    revision: { id: requestId, feedback: text, createdAt: now, previousAnalysis: structuredClone(current.analysis) },
    revisionHistory: [...(current.revisionHistory ?? []), ...(current.revision ? [current.revision] : [])],
  };
  delete entry.onboarding.error;
  delete entry.onboarding.errorCode;
  delete entry.onboarding.errorParams;
  entry.owner = owner;
  writeRuntimeProjects(entries);
  return { project: structuredClone(entry.seed.project), onboarding: structuredClone(entry.onboarding), started: true };
}

export function retryProjectOnboarding(projectId: unknown, requestId?: unknown, uiLanguage?: unknown): OnboardingOperation {
  const id = resolveGeoProject(projectId);
  const onboarding = getProjectOnboarding(id);
  if (!onboarding) throw new ProjectOnboardingError('stale_request', 409, { reason: 'already_exists' });
  if (requestId !== undefined && (!validRequestId(requestId) || onboarding.revision?.id !== requestId)) {
    throw new ProjectOnboardingError('stale_request', 409, { reason: 'revision_changed' });
  }
  const nextUiLanguage: 'en' | 'zh' | undefined = uiLanguage === 'en' || uiLanguage === 'zh' ? uiLanguage : undefined;
  if (onboarding.status !== 'failed') return { project: loadProjectSeed(id).project, onboarding, started: false };
  const messageCode = onboarding.revision ? 'onboarding.status.queuedRetryRevise' : 'onboarding.status.queuedRetry';
  return {
    project: loadProjectSeed(id).project,
    onboarding: updateProjectOnboarding(id, {
      status: 'queued',
      ...(nextUiLanguage ? { uiLanguage: nextUiLanguage } : {}),
      messageCode,
      messageParams: undefined,
    }),
    started: true,
  };
}

/** Commit the revised understanding and project summary together, keeping the previous result. */
export function completeProjectOnboarding(
  projectId: string,
  analysis: OnboardingAnalysis,
  asOf?: string,
  outputLanguage?: 'en' | 'zh',
): OnboardingRecord {
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) throw new ProjectOnboardingError('project_not_found', 404);
  const now = new Date().toISOString();
  const messageCode = entry.onboarding.revision ? 'onboarding.status.readyRevised' : 'onboarding.status.ready';
  entry.seed.project = { ...entry.seed.project, description: analysis.summary, ...(asOf ? { asOf } : {}) };
  entry.onboarding = {
    ...entry.onboarding,
    analysis,
    status: 'ready',
    updatedAt: now,
    messageCode,
    messageParams: undefined,
    message: translateServerCode('zh', messageCode),
    ...(outputLanguage ? { outputLanguage } : {}),
    ...(entry.onboarding.revision ? { revision: { ...entry.onboarding.revision, completedAt: now } } : {}),
  };
  delete entry.onboarding.error;
  delete entry.onboarding.errorCode;
  delete entry.onboarding.errorParams;
  entry.owner = owner;
  writeRuntimeProjects(entries);
  try {
    if (!projectContextExists(projectId)) {
      writeProjectContext(projectId, synthesizeProjectContextMarkdown(projectId));
    }
  } catch {
    // Non-fatal: runtime context still synthesizes cleanly on demand
  }
  return structuredClone(entry.onboarding);
}

/** Separate user intent from public sources in both topic generation and independent review. */
export function getProjectOnboardingPlanningContext(projectId: string) {
  const record = getProjectOnboarding(projectId);
  if (!record) return null;
  if (record.status !== 'ready' || !record.analysis || (record.revision && !record.revision.completedAt)) {
    throw new ProjectOnboardingError('stale_request', 409, { reason: 'understanding_incomplete' });
  }
  return {
    summary: record.analysis.summary,
    audience: record.analysis.audience,
    capabilities: record.analysis.capabilities,
    unknowns: record.analysis.unknowns,
    ...(record.outputLanguage || record.uiLanguage ? { outputLanguage: record.outputLanguage ?? record.uiLanguage } : {}),
    userGoalsAndConstraints: record.notes,
    // Earlier feedback is already represented by the revised understanding; retain its full text on disk.
    userCorrections: record.revision?.completedAt ? [{ id: record.revision.id, feedback: record.revision.feedback }] : [],
    userInputIsPublicEvidence: false,
  };
}

export function updateRuntimeProjectSeed(projectId: string, patch: Partial<GeoSeed>): GeoSeed {
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) throw new ProjectOnboardingError('project_not_found', 404);
  entry.seed = { ...entry.seed, ...patch, project: { ...entry.seed.project, ...patch.project, id: projectId } };
  writeRuntimeProjects(entries);
  return structuredClone(entry.seed);
}

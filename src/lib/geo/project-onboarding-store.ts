import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { isPublicProjectAddress, lookupPublicProjectHost, PublicProjectNetworkError } from './project-public-network';
import { loadProjectSeed, readRuntimeProjects, writeRuntimeProjects } from './project-data';
import { listGeoProjects, resolveGeoProject } from './projects';
import type { GeoProject, GeoSeed } from './types';
import type { OnboardingAnalysis, OnboardingRecord, ProjectEntryKind } from './project-onboarding-types';

export class ProjectOnboardingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const globals = globalThis as typeof globalThis & { __openGeoOnboardingOwner?: { pid: number; token: string } };
const owner = globals.__openGeoOnboardingOwner ??= { pid: process.pid, token: randomUUID() };
const pending = new Set<OnboardingRecord['status']>(['queued', 'reading', 'analyzing']);

export { isPublicProjectAddress } from './project-public-network';

export function normalizeProjectEntryUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value.trim())) {
    throw new ProjectOnboardingError('请填写有效的公开链接（不超过 2048 字符）。');
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ProjectOnboardingError('请填写以 https:// 或 http:// 开头的公开链接。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new ProjectOnboardingError('只接受不含账号密码的公开 HTTP 或 HTTPS 链接。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|test|invalid)$/.test(host) ||
    (isIP(host) ? !isPublicProjectAddress(host) : !host.includes('.'))) {
    throw new ProjectOnboardingError('请使用公开网站链接，不能使用本机或内网地址。');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new ProjectOnboardingError('请使用公开网站的标准 HTTP 或 HTTPS 端口。');
  for (const key of url.searchParams.keys()) {
    if (/^(access[_-]?token|token|api[_-]?key|password|secret|authorization)$/i.test(key)) {
      throw new ProjectOnboardingError('入口链接不能包含密钥或登录凭据。');
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
  catch (error) { throw new ProjectOnboardingError(error instanceof PublicProjectNetworkError ? error.message : '暂时无法解析入口域名，请检查链接后重试。'); }
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
  if (!['repository', 'store', 'company', 'creator'].includes(input.kind as string)) throw new ProjectOnboardingError('请选择入口类型。');
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 4000)) {
    throw new ProjectOnboardingError('补充说明不能超过 4000 字符。');
  }
  if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))) {
    throw new ProjectOnboardingError('请求标识无效，请刷新页面后重试。');
  }
  let targetLanguage: 'en' | 'zh' | undefined;
  if (input.targetLanguage !== undefined) {
    if (!['en', 'zh'].includes(input.targetLanguage as string)) {
      throw new ProjectOnboardingError('请选择有效的推广目标语言。');
    }
    targetLanguage = input.targetLanguage as 'en' | 'zh';
  }
  let uiLanguage: 'en' | 'zh' | undefined;
  if (input.uiLanguage !== undefined) {
    if (!['en', 'zh'].includes(input.uiLanguage as string)) {
      throw new ProjectOnboardingError('请选择有效的界面语言。');
    }
    uiLanguage = input.uiLanguage as 'en' | 'zh';
  }
  return {
    kind: input.kind as ProjectEntryKind,
    url: normalizeProjectEntryUrl(input.url),
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
    entry.onboarding = { ...entry.onboarding, status: 'failed', message: '上次理解过程已中断，可以重新尝试。',
      error: '服务重启或处理进程已结束。', updatedAt: new Date().toISOString() };
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
    if (requested.onboarding.url !== input.url) throw new ProjectOnboardingError('这个请求已用于另一条链接，请重新提交。', 409);
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
  const project: GeoProject = { id: projectId, name, description: '项目资料正在读取，尚未完成理解。',
    siteUrl: kind === 'repository' ? '' : url, repositoryUrl: kind === 'repository' ? url : '', owner: '', asOf: createdAt.slice(0, 10),
    ...(targetLanguage ? { targetLanguage } : {}) };
  const onboarding: OnboardingRecord = { projectId, kind, url, notes, ...(targetLanguage ? { targetLanguage } : {}), ...(uiLanguage ? { uiLanguage } : {}), status: 'queued', message: '已保存入口，准备读取公开资料。', createdAt, updatedAt: createdAt };
  const seed: GeoSeed = { project, assets: [], questions: [], observations: [], findings: [], gaps: [],
    proposal: { id: `${projectId}-unreviewed`, title: '尚无改进方案', status: 'unreviewed', rationale: '尚未开展研究与方案审核。',
      targetAssetId: '', targetUrl: '', before: '', after: '', changes: [], evidencePaths: [], successCriteria: [], limitations: ['尚未开展可见性测量或效果验证。'] },
    monitoringPlan: [], boundaries: ['入口理解与能力声明不代表实际验证，尚未开展可见性测量或方案实施。'] };
  writeRuntimeProjects([...readRuntimeProjects(), { seed, onboarding, requestId, owner }]);
  return { project: structuredClone(project), onboarding: structuredClone(onboarding), created: true };
}

export function updateProjectOnboarding(projectId: string,
  patch: Partial<Pick<OnboardingRecord, 'status' | 'message' | 'analysis' | 'error' | 'readLimitations' | 'sourceReads' | 'uiLanguage'>>): OnboardingRecord {
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) throw new ProjectOnboardingError('没有找到这个新建项目。', 404);
  entry.onboarding = { ...entry.onboarding, ...patch, updatedAt: new Date().toISOString() };
  if (patch.status && patch.status !== 'failed') delete entry.onboarding.error;
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
    throw new ProjectOnboardingError('请填写需要纠正或补充的内容，不超过 4000 字符。');
  }
  if (!validRequestId(requestId)) throw new ProjectOnboardingError('请求标识无效，请刷新页面后重试。');
  const nextUiLanguage: 'en' | 'zh' | undefined = uiLanguage === 'en' || uiLanguage === 'zh' ? uiLanguage : undefined;
  const id = resolveGeoProject(projectId);
  const current = getProjectOnboarding(id);
  if (!current) throw new ProjectOnboardingError('这个项目没有首次理解记录，无法在此修订。', 409);
  const text = feedback.trim();
  const previous = [current.revision, ...(current.revisionHistory ?? [])].find(item => item?.id === requestId);
  if (previous) {
    if (previous.feedback !== text) throw new ProjectOnboardingError('这个请求已保存其他纠正内容，请重新提交。', 409);
    return { project: loadProjectSeed(id).project, onboarding: current, started: false };
  }
  if ((current.status !== 'ready' && !(current.status === 'failed' && current.revision)) || !current.analysis) {
    throw new ProjectOnboardingError(current.status === 'failed' ? '上次理解未完成，请先重试。' : '正在理解项目，请完成后再提交纠正。', 409);
  }
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === id)!;
  const now = new Date().toISOString();
  entry.onboarding = { ...current, ...(nextUiLanguage ? { uiLanguage: nextUiLanguage } : {}), status: 'queued', message: '已保存补充，准备修订项目理解。', updatedAt: now,
    revision: { id: requestId, feedback: text, createdAt: now, previousAnalysis: structuredClone(current.analysis) },
    revisionHistory: [...(current.revisionHistory ?? []), ...(current.revision ? [current.revision] : [])] };
  delete entry.onboarding.error;
  entry.owner = owner;
  writeRuntimeProjects(entries);
  return { project: structuredClone(entry.seed.project), onboarding: structuredClone(entry.onboarding), started: true };
}

export function retryProjectOnboarding(projectId: unknown, requestId?: unknown, uiLanguage?: unknown): OnboardingOperation {
  const id = resolveGeoProject(projectId);
  const onboarding = getProjectOnboarding(id);
  if (!onboarding) throw new ProjectOnboardingError('这个项目已存在，无需重新创建。', 409);
  if (requestId !== undefined && (!validRequestId(requestId) || onboarding.revision?.id !== requestId)) {
    throw new ProjectOnboardingError('需要重试的修订已变化，请刷新页面。', 409);
  }
  const nextUiLanguage: 'en' | 'zh' | undefined = uiLanguage === 'en' || uiLanguage === 'zh' ? uiLanguage : undefined;
  if (onboarding.status !== 'failed') return { project: loadProjectSeed(id).project, onboarding, started: false };
  return { project: loadProjectSeed(id).project,
    onboarding: updateProjectOnboarding(id, { status: 'queued', ...(nextUiLanguage ? { uiLanguage: nextUiLanguage } : {}), message: onboarding.revision ? '准备重新修订项目理解。' : '准备重新读取公开资料。' }), started: true };
}

/** Commit the revised understanding and project summary together, keeping the previous result. */
export function completeProjectOnboarding(projectId: string, analysis: OnboardingAnalysis, asOf?: string): OnboardingRecord {
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) throw new ProjectOnboardingError('没有找到这个新建项目。', 404);
  const now = new Date().toISOString();
  entry.seed.project = { ...entry.seed.project, description: analysis.summary, ...(asOf ? { asOf } : {}) };
  entry.onboarding = { ...entry.onboarding, analysis, status: 'ready', updatedAt: now,
    message: entry.onboarding.revision ? '已按补充修订项目理解，可以继续整理问题。' : '已完成项目理解，可以查看资料并确认要监测的问题。',
    ...(entry.onboarding.revision ? { revision: { ...entry.onboarding.revision, completedAt: now } } : {}) };
  delete entry.onboarding.error;
  entry.owner = owner;
  writeRuntimeProjects(entries);
  return structuredClone(entry.onboarding);
}

/** Separate user intent from public sources in both topic generation and independent review. */
export function getProjectOnboardingPlanningContext(projectId: string) {
  const record = getProjectOnboarding(projectId);
  if (!record) return null;
  if (record.status !== 'ready' || !record.analysis || (record.revision && !record.revision.completedAt)) {
    throw new ProjectOnboardingError('请先完成项目理解，再整理问题。', 409);
  }
  return {
    summary: record.analysis.summary,
    audience: record.analysis.audience,
    capabilities: record.analysis.capabilities,
    unknowns: record.analysis.unknowns,
    ...(record.uiLanguage ? { outputLanguage: record.uiLanguage } : {}),
    userGoalsAndConstraints: record.notes,
    // Earlier feedback is already represented by the revised understanding; retain its full text on disk.
    userCorrections: record.revision?.completedAt ? [{ id: record.revision.id, feedback: record.revision.feedback }] : [],
    userInputIsPublicEvidence: false,
  };
}

export function updateRuntimeProjectSeed(projectId: string, patch: Partial<GeoSeed>): GeoSeed {
  const entries = readRuntimeProjects();
  const entry = entries.find(item => item.seed.project.id === projectId);
  if (!entry) throw new ProjectOnboardingError('没有找到这个新建项目。', 404);
  entry.seed = { ...entry.seed, ...patch, project: { ...entry.seed.project, ...patch.project, id: projectId } };
  writeRuntimeProjects(entries);
  return structuredClone(entry.seed);
}

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { analyzeResearchObservation } from './answer-audit';
import { requireChatGPTLocalRequest } from './chatgpt-local-request';
import type { GeoStructuredModel } from './connection-settings';
import { attachOverviewData } from './overview-data';
import { evidenceLocation, resolveGeoProject, withGeoProject } from './projects';
import { appendResearchObservation, getResearchBatch, getResearchRun, ResearchStoreError, saveResearchRun, type ResearchRunRecord } from './research-store';
import type { ResearchObservation } from './research-types';
import { matchesProjectURL } from './search-protocol';
import { getSeed } from './seed';

export class BrowserCollectionError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => Boolean(value.trim()) && !value.includes('\0'));
const secretKey = /^(?:authorization|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;
function webUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
      !/\s/.test(value) && ![...url.searchParams.keys()].some(key => secretKey.test(key));
  } catch { return false; }
}
const url = z.string().max(16000).refine(webUrl, '需要不含凭证的网页地址。');
export const browserObservationSchema = z.object({
  projectId: text(200),
  batchId: text(400),
  questionId: text(200),
  captureId: identifier,
  query: text(16000),
  language: z.enum(['zh', 'en']),
  engine: z.enum(['chatgpt', 'google']),
  entryType: z.enum(['web_answer', 'web_search']),
  recordedAt: z.iso.datetime({ offset: true }),
  pageUrl: url,
  answerText: z.string().max(1000000),
  // For web_answer, only links from the answer or its native AI citation panel.
  // Ordinary search-result links belong exclusively to a separate web_search capture.
  sources: z.array(z.object({ title: z.string().max(4000), url }).strict()).max(1000),
  // Separate native citations from ordinary answer links. Older native captures
  // already used sources exclusively for citations and remain readable.
  citations: z.array(z.object({ title: z.string().max(4000), url }).strict()).max(1000).optional(),
  citationSource: z.enum(['native', 'unknown', 'none']),
  answerComplete: z.boolean(),
  citationsComplete: z.boolean(),
  conditions: z.object({
    mode: text(200),
    region: text(200),
    loginState: z.enum(['signed_in', 'signed_out', 'unknown']),
    model: text(200).optional(),
    searchMode: text(200).optional(),
    resultLanguage: text(100).optional(),
    notes: text(4000).optional(),
  }).strict(),
  raw: z.json().optional(),
  retryAnalysis: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (!webUrl(value.pageUrl)) return;
  const host = new URL(value.pageUrl).hostname;
  if (value.engine === 'chatgpt' && (host !== 'chatgpt.com' || value.entryType !== 'web_answer')) {
    context.addIssue({ code: 'custom', path: ['pageUrl'], message: 'ChatGPT 采集必须来自 chatgpt.com 回答页面。' });
  }
  if (value.engine === 'google' && !/^(?:www\.)?google\.(?:com|[a-z]{2,3}|com\.[a-z]{2}|co\.[a-z]{2})$/.test(host)) {
    context.addIssue({ code: 'custom', path: ['pageUrl'], message: 'Google 采集必须来自 Google 页面。' });
  }
  if (value.entryType === 'web_answer' && value.answerComplete && !value.answerText.trim()) {
    context.addIssue({ code: 'custom', path: ['answerText'], message: '完整回答必须有正文。' });
  }
  const containsSecret = (item: unknown): boolean => Boolean(item && typeof item === 'object' &&
    Object.entries(item).some(([key, child]) => secretKey.test(key) || containsSecret(child)));
  if (containsSecret(value.raw)) context.addIssue({ code: 'custom', path: ['raw'], message: '原始记录不能包含凭证或 Cookie。' });
});

export type BrowserObservationInput = z.infer<typeof browserObservationSchema>;
type CaptureInput = Omit<BrowserObservationInput, 'retryAnalysis'>;
type Capture = { version: 1; storedAt: string; input: CaptureInput };

/** This endpoint may start the configured analysis model, so require local same-origin JSON. */
export function requireBrowserCollectionRequest(request: Request, mutation = false): void {
  try { requireChatGPTLocalRequest(request, mutation); }
  catch { throw new BrowserCollectionError('浏览器采集只接受本机 127.0.0.1 上的同源操作。', 403); }
}

function locations(captureId: string) {
  const evidencePath = `data/geo-evidence/browser-${captureId}/capture.json`;
  const answerPath = evidencePath.replace('capture.json', 'answer.md');
  return { evidencePath, answerPath, rawFile: evidenceLocation(evidencePath).target,
    answerFile: evidenceLocation(answerPath).target, lockFile: evidenceLocation(evidencePath).target + '.analysis.lock' };
}

function readCapture(captureId: string): Capture | null {
  const file = locations(captureId).rawFile;
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Capture;
}

function lockAlive(file: string): boolean {
  try {
    const pid: unknown = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

function observationFromCapture(capture: Capture): ResearchObservation {
  const input = capture.input;
  const seed = getSeed();
  const sources = input.sources.map((source, index) => ({ ...source,
    kind: matchesProjectURL(source.url, seed) ? 'official' as const : 'other' as const,
    ...(input.entryType === 'web_search' ? { position: index + 1 } : {}),
  }));
  const files = locations(input.captureId);
  return {
    id: `browser:${input.captureId}`, runId: `browser-${input.captureId}`,
    engine: input.engine, language: input.language, entryType: input.entryType,
    query: input.query, recordedAt: input.recordedAt, collectedAt: input.recordedAt,
    status: sources.some(source => source.kind === 'official') ? 'found' : 'not_observed',
    summary: input.entryType === 'web_answer' ? input.answerText.slice(0, 260) : `已保存 ${sources.length} 条浏览器网页结果。`,
    conditions: JSON.stringify({ ...input.conditions, originalURL: input.pageUrl,
      answerComplete: input.answerComplete, citationsComplete: input.citationsComplete, citationSource: input.citationSource }),
    sources, evidencePath: files.evidencePath,
    ...(input.entryType === 'web_answer' ? { answerPath: files.answerPath } : {}),
  };
}

function resultFor(capture: Capture, duplicate: boolean, ownsLease = false) {
  const input = capture.input;
  const batch = attachOverviewData(getResearchBatch(input.projectId, input.batchId));
  const observation = batch?.questions.find(question => question.id === input.questionId)?.observations
    .find(item => item.id === `browser:${input.captureId}`) ?? null;
  const audit = observation ? batch?.answerAudits?.find(item => item.questionId === input.questionId &&
    item.engine === input.engine && item.language === input.language && item.recordedAt === input.recordedAt &&
    item.evidencePath === (observation.answerPath ?? observation.evidencePath)) ?? null : null;
  const run = getResearchRun(input.projectId, `browser-${input.captureId}`);
  const analyzing = !ownsLease && lockAlive(locations(input.captureId).lockFile);
  const status = analyzing ? 'analyzing' : audit?.analysisStatus ?? 'stored';
  return { captureId: input.captureId, duplicate, query: input.query, originalURL: input.pageUrl,
    conditions: input.conditions, citationSource: input.citationSource, status,
    retryable: !analyzing && (!audit || audit.analysisStatus === 'failed' || audit.analysisStatus === 'needs_review'),
    run, observation, audit, batch };
}

/** Read-only progress includes the persisted overview; never invokes a model. */
export function getBrowserObservation(projectId: string, captureId: string) {
  if (!identifier.safeParse(captureId).success) throw new BrowserCollectionError('采集编号无效。');
  return withGeoProject(resolveGeoProject(projectId), () => {
    const capture = readCapture(captureId);
    if (!capture || capture.input.projectId !== projectId) throw new BrowserCollectionError('没有找到当前项目的浏览器采集。', 404);
    return resultFor(capture, true);
  });
}

/** Save immutable browser evidence and the observation before awaiting the existing AI audit. */
export async function ingestBrowserObservation(value: unknown, options: { model?: GeoStructuredModel } = {}) {
  const parsed = browserObservationSchema.safeParse(value);
  if (!parsed.success) throw new BrowserCollectionError(`浏览器采集格式无效：${parsed.error.issues[0]?.path.join('.') || '请求'}。`);
  const { retryAnalysis = false, ...input } = parsed.data;
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 2 * 1024 * 1024) throw new BrowserCollectionError('浏览器采集超过 2 MiB，未入库。', 413);
  return withGeoProject(input.projectId, async () => {
    const batch = getResearchBatch(input.projectId, input.batchId);
    const question = batch?.questions.find(item => item.id === input.questionId && item.decision === 'search_now');
    if (!batch || !question || !question[input.language] || question[input.language] !== input.query) {
      throw new BrowserCollectionError('采集必须匹配当前项目已确认的问题及对应语言原文。', 409);
    }
    const files = locations(input.captureId);
    let capture = readCapture(input.captureId);
    const duplicate = Boolean(capture);
    if (capture && !isDeepStrictEqual(capture.input, input)) throw new BrowserCollectionError('此采集编号已保存其他内容，不能覆盖原始记录。', 409);
    if (!capture) {
      if (input.citationSource === 'native' && input.citations === undefined) {
        throw new BrowserCollectionError('新的原生引用采集必须显式提供 citations 清单，普通正文链接不能代替引用。');
      }
      fs.mkdirSync(path.dirname(files.rawFile), { recursive: true });
      capture = { version: 1, storedAt: new Date().toISOString(), input };
      try { fs.writeFileSync(files.rawFile, JSON.stringify(capture, null, 2), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        capture = readCapture(input.captureId)!;
        if (!isDeepStrictEqual(capture.input, input)) throw new BrowserCollectionError('此采集编号已保存其他内容，不能覆盖原始记录。', 409);
      }
    }
    if (input.entryType === 'web_answer' && !fs.existsSync(files.answerFile)) {
      try { fs.writeFileSync(files.answerFile, input.answerText, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const current = resultFor(capture, duplicate);
    if (current.status === 'analyzing') return current;
    if (current.audit && (!retryAnalysis || !current.retryable)) return current;
    if (current.run && current.run.status !== 'running' && !retryAnalysis) return current;
    // A process-owned exclusive lease prevents duplicate model calls across requests or workers.
    if (fs.existsSync(files.lockFile) && !lockAlive(files.lockFile)) fs.unlinkSync(files.lockFile);
    try { fs.writeFileSync(files.lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return resultFor(capture, true);
      throw error;
    }
    let run: ResearchRunRecord | null = null;
    try {
      // Another worker may finish after the preflight read and before this lease.
      // Re-read under the lease, without mistaking our own lease for another analysis.
      const fresh = resultFor(capture, duplicate, true);
      run = fresh.run;
      if (fresh.audit && (!retryAnalysis || !fresh.retryable)) return { ...fresh, duplicate: true };
      if (run && run.status !== 'running' && !retryAnalysis) return { ...fresh, duplicate: true };
      if (!run) run = saveResearchRun(input.projectId, {
        id: `browser-${input.captureId}`, projectId: input.projectId, batchId: input.batchId,
        provider: input.engine, language: input.language, entryType: input.entryType,
        questions: [{ questionId: input.questionId, query: input.query }],
        status: 'running', phase: 'analyzing', startedAt: capture.storedAt, updatedAt: capture.storedAt,
        ownerPid: process.pid, completedCount: 0, budgetEnabled: false, budgetEnforcement: 'disabled',
        budgetLimit: null, spent: 0, evidencePath: files.evidencePath,
      });
      const observation = fresh.observation ?? observationFromCapture(capture);
      appendResearchObservation(input.projectId, input.batchId, input.questionId, observation);
      if (run.status === 'running') run = saveResearchRun(input.projectId, { ...run, completedCount: 1, phase: 'analyzing', updatedAt: new Date().toISOString() });
      const audit = await analyzeResearchObservation(batch, input.questionId, observation,
        input.entryType === 'web_answer' ? {
          text: input.answerText, citations: input.citationSource === 'native' ? (input.citations ?? input.sources) : [], sources: input.sources,
          evidence: { answerComplete: input.answerComplete, citationsComplete: input.citationsComplete, citationSource: input.citationSource },
          searchPerformed: input.conditions.searchMode !== 'off', usage: {},
          ...(input.conditions.model ? { model: input.conditions.model } : {}),
        } : undefined, { ...options, onValidatedResult: (result, issue) => {
          // Keep only schema-validated judgments, never provider responses or credentials.
          // Failed evidence checks remain inspectable without re-searching the question.
          fs.writeFileSync(path.join(path.dirname(files.rawFile), `analysis-${Date.now()}.json`),
            JSON.stringify({ result, issue: issue ?? null }, null, 2), { flag: 'wx', mode: 0o600 });
        } });
      if (run.status === 'running') {
        const complete = audit.analysisStatus === 'complete' || audit.analysisStatus === 'not_applicable';
        saveResearchRun(input.projectId, { ...run, status: complete ? 'completed' : 'partial', phase: undefined,
          updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
          ...(!complete ? { error: '浏览器原文和观测已保存；回答审核尚未完成，可从保存的证据重试。' } : {}),
        });
      }
    } catch (error) {
      if (run?.status === 'running') saveResearchRun(input.projectId, { ...run,
        status: run.completedCount ? 'partial' : 'failed', phase: undefined,
        updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        error: '浏览器证据已保留，入库或审核未完成，可使用同一采集编号重试。',
      });
      if (error instanceof ResearchStoreError) throw error;
      throw new BrowserCollectionError('浏览器证据已保留，入库或审核未完成，可使用同一采集编号重试。', 500);
    } finally { fs.unlinkSync(files.lockFile); }
    return resultFor(capture, duplicate);
  });
}

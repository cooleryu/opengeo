import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMTransport } from '../../agent-hub';
import { withProjectDb } from '../db/schema';
import { resolveProjectTargetLanguage } from '../i18n';
import { loadProjectSeed } from '../project-data';
import { projectDataDirectory, withGeoProject } from '../projects';
import { taskIsBusy } from '../store';
import { readThreadsWithBrowser } from './action-board-browser-fetch';
import {
  ACTION_BOARD_SCHEMA_VERSION,
  isCurrentActionBoard,
  type ActionBoardCard,
  type ActionBoardRecord,
  type ThreadSource,
} from './action-board-catalog';
import { buildProjectIdentityFacts, buildWorkerContext, normalizeEvidenceUrl } from './action-board-context';
import { redraftSingleCommunityThread } from './action-board-message-workers';
import { planActionBoard, summarizeCoverage } from './action-board-planner';
import { hydrateCard } from './action-board-workers';
import { buildOptimizationStrategicBrief, isWorkspaceRepoForProject } from './citation-landscape';
import { listAuditableTargets, readLatestPageAudit } from './page-audit';

const ACTION_BOARD_FILENAME = 'action-board.json';
const LOCK_ID = 'action-board';
const LOCK_STALE_MS = 15 * 60_000;
const HYDRATE_CONCURRENCY = 3;

/** In-process registry of running board jobs; kept on globalThis so dev hot reload doesn't lose it. */
const running: Map<string, Promise<void>> = ((globalThis as { __opengeoActionBoardJobs?: Map<string, Promise<void>> })
  .__opengeoActionBoardJobs ??= new Map());

export class ActionBoardBusyError extends Error {
  constructor() {
    super('action_board_busy');
  }
}

function boardFile(projectId: string): string {
  return withGeoProject(projectId, () => path.join(projectDataDirectory(), ACTION_BOARD_FILENAME));
}

function readRawBoard(projectId: string): unknown {
  try {
    const file = boardFile(projectId);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

export function readLatestActionBoard(projectId: string): ActionBoardRecord | null {
  const raw = readRawBoard(projectId);
  return isCurrentActionBoard(raw) ? raw : null;
}

function saveActionBoard(projectId: string, board: ActionBoardRecord): void {
  const file = boardFile(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(board, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** Read-modify-write one card without awaiting in between, so concurrent card saves never clobber each other. */
function patchCard(projectId: string, boardId: string, cardId: string, patch: (card: ActionBoardCard) => ActionBoardCard) {
  const board = readLatestActionBoard(projectId);
  if (!board || board.id !== boardId) return null;
  const next = { ...board, cards: board.cards.map((c) => (c.id === cardId ? patch(c) : c)), updatedAt: new Date().toISOString() };
  saveActionBoard(projectId, next);
  return next;
}

// --- Lock: one board job per project, shared with the task lock table ---

function acquireLock(projectId: string): void {
  if (running.has(projectId)) throw new ActionBoardBusyError();
  // Opening the store first runs its once-per-process restart cleanup now, so it can't erase this lock later.
  withGeoProject(projectId, () => taskIsBusy(LOCK_ID));
  const acquired = withProjectDb(projectId, (db) => {
    const now = Date.now();
    const held = db.prepare('SELECT started_at FROM geo_task_locks WHERE task_id = ?').get(LOCK_ID) as
      | { started_at: string }
      | undefined;
    if (held && now - Date.parse(held.started_at) < LOCK_STALE_MS) return false;
    db.prepare('DELETE FROM geo_task_locks WHERE task_id = ?').run(LOCK_ID);
    db.prepare("INSERT INTO geo_task_locks (task_id, kind, started_at) VALUES (?, 'action_board', ?)").run(
      LOCK_ID,
      new Date(now).toISOString(),
    );
    return true;
  });
  if (!acquired) throw new ActionBoardBusyError();
}

function releaseLock(projectId: string): void {
  try {
    withProjectDb(projectId, (db) => db.prepare('DELETE FROM geo_task_locks WHERE task_id = ?').run(LOCK_ID));
  } catch {
    // The restart cleanup removes it anyway.
  }
}

function runInBackground(projectId: string, job: () => Promise<void>): void {
  const promise = withGeoProject(projectId, async () => {
    try {
      await job();
    } finally {
      running.delete(projectId);
      releaseLock(projectId);
    }
  });
  running.set(projectId, promise);
  void promise.catch(() => undefined);
}

// --- Hydration ---

interface HydrateOptions {
  transport?: LLMTransport;
  signal?: AbortSignal;
}

async function hydrateCards(projectId: string, board: ActionBoardRecord, cardIds: string[], options: HydrateOptions) {
  const startedAt = Date.now();
  const brief = buildOptimizationStrategicBrief(projectId, { targetLanguage: board.targetLanguage });
  const facts = buildProjectIdentityFacts(projectId);
  const queue = board.cards.filter((c) => cardIds.includes(c.id));
  const work = async () => {
    for (let card = queue.shift(); card; card = queue.shift()) {
      const current = card;
      try {
        const ctx = buildWorkerContext(projectId, current, brief, facts);
        const result = await hydrateCard(current, ctx, {
          projectId,
          targetLanguage: board.targetLanguage,
          transport: options.transport,
          signal: options.signal,
        });
        patchCard(projectId, board.id, current.id, (c) => ({
          ...c,
          status: 'ready',
          payload: result.payload,
          why: result.why,
          telemetry: result.telemetry,
          failure: undefined,
          errorMessage: undefined,
        }));
      } catch (error) {
        patchCard(projectId, board.id, current.id, (c) => ({
          ...c,
          status: 'failed',
          failure: 'model_failed',
          errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, queue.length) }, work));
  const latest = readLatestActionBoard(projectId);
  if (latest && latest.id === board.id) {
    const cards = latest.cards.map((c) => c.telemetry).filter(Boolean);
    saveActionBoard(projectId, {
      ...latest,
      telemetry: {
        ...latest.telemetry,
        hydrationWallMs: Date.now() - startedAt,
        promptTokens: cards.reduce((sum, t) => sum + (t?.promptTokens ?? 0), 0),
        completionTokens: cards.reduce((sum, t) => sum + (t?.completionTokens ?? 0), 0),
      },
    });
  }
}

/** Plans the board in code, saves the skeleton, and fills the cards in the background. */
export function startActionBoardGeneration(projectId: string, options: HydrateOptions = {}): ActionBoardRecord {
  acquireLock(projectId);
  try {
    const t0 = Date.now();
    const seed = loadProjectSeed(projectId);
    const targetLanguage = resolveProjectTargetLanguage(seed.project);
    const brief = buildOptimizationStrategicBrief(projectId, { targetLanguage });
    const audit = readLatestPageAudit(projectId);
    const ownsRepo = isWorkspaceRepoForProject(seed.project);
    const targets = listAuditableTargets(projectId);
    const auditTarget = targets.find((t) => (ownsRepo ? t.localFilePath === 'README.md' : t.targetKind === 'live_web')) ?? targets[0] ?? null;
    const cards = planActionBoard({
      brief,
      audit,
      auditTarget,
      previous: readLatestActionBoard(projectId),
      brandName: seed.project.name,
      repositoryUrl: seed.project.repositoryUrl || '',
    });
    const now = new Date().toISOString();
    const board: ActionBoardRecord = {
      schemaVersion: ACTION_BOARD_SCHEMA_VERSION,
      id: `board-${randomUUID().slice(0, 8)}`,
      projectId,
      brandName: buildProjectIdentityFacts(projectId).name,
      targetLanguage,
      coverage: summarizeCoverage(brief),
      cards,
      telemetry: { skeletonMs: Date.now() - t0, promptTokens: 0, completionTokens: 0 },
      createdAt: now,
      updatedAt: now,
    };
    saveActionBoard(projectId, board);
    runInBackground(projectId, () =>
      hydrateCards(
        projectId,
        board,
        cards.map((c) => c.id),
        options,
      ),
    );
    return board;
  } catch (error) {
    if (!running.has(projectId)) releaseLock(projectId);
    throw error;
  }
}

export function regenerateActionBoardCard(projectId: string, cardId: string, options: HydrateOptions = {}): ActionBoardRecord {
  const board = readLatestActionBoard(projectId);
  if (!board?.cards.some((c) => c.id === cardId)) throw new Error('card_not_found');
  acquireLock(projectId);
  const next = patchCard(projectId, board.id, cardId, (c) => ({ ...c, status: 'pending', failure: undefined, errorMessage: undefined }));
  if (!next) {
    releaseLock(projectId);
    throw new Error('card_not_found');
  }
  runInBackground(projectId, () => hydrateCards(projectId, next, [cardId], options));
  return next;
}

export interface ActionBoardState {
  actionBoard: ActionBoardRecord | null;
  stale: boolean;
  generating: boolean;
}

/** What the page shows. Pending cards with no live job (app restarted mid-run) are marked as interrupted. */
export function readActionBoardState(projectId: string): ActionBoardState {
  const raw = readRawBoard(projectId);
  if (raw && !isCurrentActionBoard(raw)) return { actionBoard: null, stale: true, generating: false };
  let board = raw as ActionBoardRecord | null;
  const generating = running.has(projectId);
  if (board && !generating && board.cards.some((c) => c.status === 'pending')) {
    board = {
      ...board,
      cards: board.cards.map((c) => (c.status === 'pending' ? { ...c, status: 'failed', failure: 'interrupted' } : c)),
    };
    saveActionBoard(projectId, board);
  }
  return { actionBoard: board, stale: false, generating };
}

export function updateActionBoardCardState(
  projectId: string,
  cardId: string,
  updates: { completed?: boolean; publishedUrl?: string },
): ActionBoardRecord {
  const board = readLatestActionBoard(projectId);
  if (!board) throw new Error('card_not_found');
  const next = patchCard(projectId, board.id, cardId, (c) => ({
    ...c,
    completedAt: updates.completed === false ? undefined : c.completedAt || new Date().toISOString(),
    ...(updates.publishedUrl !== undefined ? { publishedUrl: updates.publishedUrl.trim() || undefined } : {}),
  }));
  if (!next) throw new Error('card_not_found');
  return next;
}

/** Writes a drafted doc into this checkout, only when the checkout is the project's own repository. */
export function saveActionBoardDocToRepo(projectId: string, cardId: string): { board: ActionBoardRecord; writtenPath: string } {
  const board = readLatestActionBoard(projectId);
  const card = board?.cards.find((c) => c.id === cardId);
  if (!board || !card || card.payload?.kind !== 'doc_draft') throw new Error('card_not_found');
  const seed = loadProjectSeed(projectId);
  if (!isWorkspaceRepoForProject(seed.project)) throw new Error('repo_not_owned');
  const rel = (card.payload.path ?? '').trim().replace(/^\/+/, '');
  if (!/^docs\/[a-zA-Z0-9._/-]+\.md$/i.test(rel) || rel.includes('..')) throw new Error('invalid_doc_path');
  const root = path.resolve(process.cwd());
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.join(root, 'docs') + path.sep)) throw new Error('invalid_doc_path');
  if (fs.existsSync(abs)) throw new Error('doc_exists');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${card.payload.markdown.trimEnd()}\n`, 'utf8');
  const next = patchCard(projectId, board.id, cardId, (c) => ({ ...c, completedAt: new Date().toISOString() }));
  return { board: next ?? board, writtenPath: rel };
}

async function applyThreadSourceAndRedraft(
  projectId: string,
  cardId: string,
  threadUrl: string,
  source: ThreadSource,
  resolvedTitle?: string,
): Promise<ActionBoardRecord> {
  const board = readLatestActionBoard(projectId);
  const card = board?.cards.find((c) => c.id === cardId);
  if (!board || !card || card.payload?.kind !== 'community_reply') throw new Error('card_not_found');
  const norm = normalizeEvidenceUrl(threadUrl);
  const thread = card.payload.threads.find((t) => normalizeEvidenceUrl(t.url) === norm);
  if (!thread) throw new Error('thread_not_found');
  const brief = buildOptimizationStrategicBrief(projectId, { targetLanguage: board.targetLanguage });
  const ctx = buildWorkerContext(projectId, card, brief, buildProjectIdentityFacts(projectId));
  const updatedThread = await redraftSingleCommunityThread(thread, source, resolvedTitle, ctx, {
    projectId,
    targetLanguage: board.targetLanguage,
  });
  const next = patchCard(projectId, board.id, cardId, (c) => {
    if (c.payload?.kind !== 'community_reply') return c;
    return {
      ...c,
      payload: {
        kind: 'community_reply',
        threads: c.payload.threads.map((t) => (normalizeEvidenceUrl(t.url) === norm ? updatedThread : t)),
      },
    };
  });
  return next ?? board;
}

/** Opens the user's persistent local Chrome profile visibly so they can sign in/verify and load the real thread. */
export async function readActionBoardThreadInBrowser(
  projectId: string,
  cardId: string,
  threadUrl: string,
): Promise<{ board: ActionBoardRecord; fetched: boolean }> {
  const board = readLatestActionBoard(projectId);
  const card = board?.cards.find((c) => c.id === cardId);
  if (!board || !card || card.payload?.kind !== 'community_reply') throw new Error('card_not_found');
  const norm = normalizeEvidenceUrl(threadUrl);
  const thread = card.payload.threads.find((t) => normalizeEvidenceUrl(t.url) === norm);
  if (!thread) throw new Error('thread_not_found');

  const res = await readThreadsWithBrowser([thread.url], { interactive: true, timeoutMs: 25_000 });
  const hit = res.get(thread.url);
  if (!hit?.ok) {
    return { board, fetched: false };
  }
  const source: ThreadSource = {
    status: 'fetched',
    fetchedAt: new Date().toISOString(),
    ...(hit.opBody ? { op: { author: hit.opAuthor, body: hit.opBody } } : {}),
    ...(hit.replies?.length ? { replies: hit.replies } : {}),
    ...(typeof hit.commentCount === 'number' ? { commentCount: hit.commentCount } : {}),
    ...(hit.locked ? { locked: true } : {}),
  };
  const updated = await applyThreadSourceAndRedraft(projectId, cardId, thread.url, source, hit.title);
  return { board: updated, fetched: true };
}

/** Grounds a single thread reply on post/comment text pasted directly by the user from their own browser tab. */
export async function redraftActionBoardThreadWithText(
  projectId: string,
  cardId: string,
  threadUrl: string,
  pastedText: string,
): Promise<ActionBoardRecord> {
  const clean = pastedText.replace(/\r\n/g, '\n').trim().slice(0, 3200);
  if (clean.length < 15) throw new Error('pasted_text_too_short');
  const source: ThreadSource = {
    status: 'fetched',
    fetchedAt: new Date().toISOString(),
    op: { body: clean },
  };
  return applyThreadSourceAndRedraft(projectId, cardId, threadUrl, source);
}

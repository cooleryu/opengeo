import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserCollectJobSnapshot } from './browser-collect-types';
import { BrowserCollectionError } from './browser-collection';
import { translateServerCode, type ServerErrorParams } from './i18n-server';
import { finalizeOptimizationBrowserRetest } from './optimization';
import { resolveGeoProject } from './projects';

const VALID_ID = /^[A-Za-z0-9_-]{1,120}$/;

let cachedPathEgoBrowser: boolean | undefined;

function resolveEgoBrowserBin(): string | null {
  const candidates = [
    process.env.EGO_BROWSER_BIN?.trim(),
    path.join(os.homedir(), '.local', 'bin', 'ego-browser'),
    '/opt/homebrew/bin/ego-browser',
    '/usr/local/bin/ego-browser',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try next candidate path
    }
  }

  if (cachedPathEgoBrowser === undefined) {
    try {
      const probe = spawnSync('ego-browser', ['--version'], {
        timeout: 3000,
        stdio: 'ignore',
      });
      cachedPathEgoBrowser = probe.status === 0;
    } catch {
      cachedPathEgoBrowser = false;
    }
  }
  return cachedPathEgoBrowser ? 'ego-browser' : null;
}

function resolveDriver(spaceId: number | null, egoBin: string | null): 'ego' | 'chrome' {
  if (spaceId) return 'ego';
  const envDriver = process.env.OPENGEO_BROWSER_DRIVER?.trim().toLowerCase();
  if (envDriver === 'ego' || envDriver === 'chrome') return envDriver;
  return egoBin ? 'ego' : 'chrome';
}

function applyStatusCode(
  snap: BrowserCollectJobSnapshot,
  code: string,
  params?: ServerErrorParams,
): void {
  snap.messageCode = code;
  snap.messageParams = params;
  snap.message = translateServerCode('zh', code, params);
}

function applyErrorCode(
  snap: BrowserCollectJobSnapshot,
  code: string,
  params?: ServerErrorParams,
  detail?: string,
): void {
  snap.errorCode = code;
  snap.errorParams = params;
  snap.errorDetail = detail ?? null;
  snap.error = translateServerCode('zh', code, params);
}

interface InternalRunnerState {
  snapshot: BrowserCollectJobSnapshot;
  child: ChildProcess | null;
  driver: 'ego' | 'chrome';
  stoppedByUser: boolean;
  sawHandoff: boolean;
  lastErrorLine: string;
}

const globalKey = '__openGeoBrowserCollectRunnerState';

function idleSnapshot(projectId: string | null = null): BrowserCollectJobSnapshot {
  return {
    jobId: null,
    status: 'idle',
    projectId,
    engine: 'all',
    force: false,
    batchStartedAt: null,
    optimizationRunId: null,
    spaceId: null,
    completedCount: 0,
    totalCount: 0,
    currentIndex: 0,
    currentQuestionId: null,
    currentEngine: null,
    currentQuery: null,
    waitSeconds: null,
    message: '',
    error: null,
    errorCode: null,
    errorDetail: null,
    startedAt: null,
    updatedAt: null,
  };
}

function getRunnerState(): InternalRunnerState {
  const g = globalThis as Record<string, unknown>;
  if (!g[globalKey]) {
    g[globalKey] = {
      snapshot: idleSnapshot(),
      child: null,
      driver: 'ego',
      stoppedByUser: false,
      sawHandoff: false,
      lastErrorLine: '',
    } satisfies InternalRunnerState;
  }
  return g[globalKey] as InternalRunnerState;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

export function getBrowserCollectStatus(projectId?: string): BrowserCollectJobSnapshot {
  const state = getRunnerState();
  const resolved = projectId ? resolveGeoProject(projectId) : null;
  if (resolved && state.snapshot.projectId && state.snapshot.projectId !== resolved) {
    if (state.snapshot.status === 'running' || state.snapshot.status === 'needs_handoff') {
      return {
        ...idleSnapshot(resolved),
        busyOtherProjectId: state.snapshot.projectId,
      };
    }
    return idleSnapshot(resolved);
  }
  return { ...state.snapshot };
}

export function stopBrowserCollectJob(): BrowserCollectJobSnapshot {
  const state = getRunnerState();
  const now = new Date().toISOString();
  if (
    state.child &&
    (state.snapshot.status === 'running' || state.snapshot.status === 'needs_handoff')
  ) {
    state.stoppedByUser = true;
    state.snapshot = {
      ...state.snapshot,
      status: 'stopped',
      waitSeconds: null,
      messageCode: 'collect.stopped',
      messageParams: undefined,
      message: translateServerCode('zh', 'collect.stopped'),
      updatedAt: now,
    };
    try {
      if (state.child.stdin && !state.child.stdin.destroyed) {
        state.child.stdin.write('STOP\n');
      }
      state.child.kill('SIGTERM');
    } catch {
      // Child may have already exited
    }
  }
  return { ...state.snapshot };
}

export interface StartBrowserCollectInput {
  projectId: string;
  baseOrigin: string;
  engine?: 'all' | 'chatgpt' | 'google';
  force?: boolean;
  since?: string;
  questionIds?: string[];
  optimizationRunId?: string;
  spaceId?: number;
}

export function startBrowserCollectJob(
  input: StartBrowserCollectInput,
): BrowserCollectJobSnapshot {
  const state = getRunnerState();
  const projectId = resolveGeoProject(input.projectId);

  if (
    state.child &&
    state.snapshot.status === 'needs_handoff' &&
    state.snapshot.projectId === projectId &&
    state.child.stdin &&
    !state.child.stdin.destroyed
  ) {
    state.sawHandoff = false;
    state.lastErrorLine = '';
    state.snapshot = {
      ...state.snapshot,
      status: 'running',
      waitSeconds: null,
      error: null,
      errorCode: null,
      errorParams: undefined,
      errorDetail: null,
      messageCode: 'collect.resumed',
      messageParams: undefined,
      message: translateServerCode('zh', 'collect.resumed'),
      updatedAt: new Date().toISOString(),
    };
    state.child.stdin.write('RESUME\n');
    return { ...state.snapshot };
  }

  if (
    state.child &&
    (state.snapshot.status === 'running' || state.snapshot.status === 'needs_handoff')
  ) {
    throw BrowserCollectionError.coded('collect_already_running', 409);
  }

  const engine =
    input.engine === 'chatgpt' || input.engine === 'google' ? input.engine : 'all';

  if (input.optimizationRunId && !VALID_ID.test(input.optimizationRunId)) {
    throw BrowserCollectionError.coded('invalid_request', 400);
  }
  const cleanQuestionIds = (input.questionIds ?? []).filter((id) => VALID_ID.test(id));
  if (input.questionIds && cleanQuestionIds.length !== input.questionIds.length) {
    throw BrowserCollectionError.coded('invalid_request', 400);
  }
  const spaceId =
    typeof input.spaceId === 'number' && Number.isSafeInteger(input.spaceId) && input.spaceId > 0
      ? input.spaceId
      : null;

  const scriptPath = path.resolve(process.cwd(), 'scripts', 'browser-collect.mjs');
  if (!fs.existsSync(scriptPath)) {
    throw BrowserCollectionError.coded('collect_script_missing', 500);
  }

  const egoBin = resolveEgoBrowserBin();
  const driver = resolveDriver(spaceId, egoBin);

  const args: string[] = [
    scriptPath,
    '--project',
    projectId,
    '--base',
    input.baseOrigin,
    '--engine',
    engine,
    '--driver',
    driver,
    '--interactive-handoff',
    'true',
  ];
  let validatedSince: string | undefined;
  if (input.since) {
    const trimmedSince = input.since.trim();
    if (
      !/^[0-9TZ:+.\-\s]{10,40}$/.test(trimmedSince) ||
      !Number.isFinite(Date.parse(trimmedSince))
    ) {
      throw BrowserCollectionError.coded('invalid_request', 400);
    }
    validatedSince = trimmedSince;
  } else if (
    input.force &&
    spaceId &&
    state.snapshot.projectId === projectId &&
    state.snapshot.spaceId === spaceId &&
    state.snapshot.batchStartedAt
  ) {
    validatedSince = state.snapshot.batchStartedAt;
  }

  if (input.force) args.push('--force', 'true');
  if (validatedSince) args.push('--since', validatedSince);
  if (cleanQuestionIds.length) args.push('--questions', cleanQuestionIds.join(','));
  if (input.optimizationRunId) args.push('--optimization-run-id', input.optimizationRunId);
  if (spaceId) args.push('--space', String(spaceId));

  const now = new Date().toISOString();
  state.driver = driver;
  state.stoppedByUser = false;
  state.sawHandoff = false;
  state.lastErrorLine = '';
  state.snapshot = {
    jobId: `bcollect-${randomUUID().slice(0, 12)}`,
    status: 'running',
    projectId,
    engine,
    force: Boolean(input.force),
    batchStartedAt: validatedSince || now,
    optimizationRunId: input.optimizationRunId ?? null,
    spaceId,
    completedCount: 0,
    totalCount: 0,
    currentIndex: 0,
    currentQuestionId: null,
    currentEngine: null,
    currentQuery: null,
    waitSeconds: null,
    messageCode: 'collect.starting',
    messageParams: undefined,
    message: translateServerCode('zh', 'collect.starting'),
    error: null,
    errorCode: null,
    errorParams: undefined,
    errorDetail: null,
    startedAt: now,
    updatedAt: now,
  };

  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(egoBin ? { EGO_BROWSER_BIN: egoBin } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.child = child;

  const handleStdoutLine = (rawLine: string) => {
    const line = stripAnsi(rawLine).trim();
    if (!line) return;
    const snap = state.snapshot;
    snap.updatedAt = new Date().toISOString();

    const spaceMatch = line.match(/spaceId:\s*(\d+)/);
    if (spaceMatch) {
      snap.spaceId = Number(spaceMatch[1]);
    }
    const totalMatch = line.match(/\btotal:\s*(\d+)/);
    if (totalMatch) {
      snap.totalCount = Number(totalMatch[1]);
      if (snap.currentIndex === 0 && line.includes('[QUEUE_READY]')) {
        applyStatusCode(snap, 'collect.opening', { total: snap.totalCount });
      }
    }
    if (line.includes('[BROWSER_READY]')) {
      applyStatusCode(snap, 'collect.preparing', { total: snap.totalCount });
      return;
    }
    const stepMatch = line.match(
      /^\[(\d+)\/(\d+)\]\s+(\S+)\s+\((chatgpt|google),\s*(?:en|zh)\):\s*(.+)$/,
    );
    if (stepMatch) {
      const idx = Number(stepMatch[1]);
      const engineLabel = stepMatch[4] === 'chatgpt' ? 'ChatGPT' : 'Google';
      snap.currentIndex = idx;
      snap.totalCount = Number(stepMatch[2]);
      snap.completedCount = Math.max(snap.completedCount, idx - 1);
      snap.currentQuestionId = stepMatch[3];
      snap.currentEngine = stepMatch[4] as 'chatgpt' | 'google';
      snap.currentQuery = stepMatch[5];
      snap.waitSeconds = null;
      applyStatusCode(snap, 'collect.asking', {
        engine: engineLabel,
        index: idx,
        total: snap.totalCount,
      });
      return;
    }
    if (line.includes('等待当前问题的 ChatGPT 回答完成')) {
      applyStatusCode(snap, 'collect.waitingAnswer', {
        index: snap.currentIndex,
        total: snap.totalCount,
      });
      return;
    }
    if (line.includes('回答已采集，正在自动分析并保存')) {
      applyStatusCode(snap, 'collect.saving', {
        index: snap.currentIndex,
        total: snap.totalCount,
      });
      return;
    }
    const waitMatch = line.match(/\[防封停等待\]\s*间隔\s*(\d+)s/);
    if (waitMatch) {
      snap.waitSeconds = Number(waitMatch[1]);
      applyStatusCode(snap, 'collect.cooldown', {
        seconds: snap.waitSeconds,
        done: snap.completedCount,
        total: snap.totalCount,
      });
      return;
    }
    if (line.includes('"captureId":') || line.includes('[已入库待核实]')) {
      if (snap.currentIndex > snap.completedCount) {
        snap.completedCount = snap.currentIndex;
      }
      snap.waitSeconds = null;
      return;
    }
    if (line.includes('无需重复运行')) {
      applyStatusCode(snap, 'collect.alreadyCollected');
    }
  };

  const handleStderrLine = (rawLine: string) => {
    const line = stripAnsi(rawLine).trim();
    if (!line) return;
    const snap = state.snapshot;
    snap.updatedAt = new Date().toISOString();
    if (line.includes('[NEEDS_BROWSER_HANDOFF]')) {
      state.sawHandoff = true;
      snap.status = 'needs_handoff';
      snap.waitSeconds = null;
      applyStatusCode(snap, 'collect.needsHandoff');
      applyErrorCode(snap, 'collect.needsHandoff', undefined, state.lastErrorLine || undefined);
      return;
    }
    const spaceMatch = line.match(/--space\s+(\d+)/);
    if (spaceMatch) {
      snap.spaceId = Number(spaceMatch[1]);
    }
    if (!line.startsWith('浏览器页面已保留') && !line.startsWith("ego's nodejs process exited")) {
      state.lastErrorLine = line;
    }
  };

  let outBuf = '';
  child.stdout?.on('data', (chunk) => {
    outBuf += chunk.toString();
    const parts = outBuf.split(/\r?\n/);
    outBuf = parts.pop() ?? '';
    for (const line of parts) handleStdoutLine(line);
  });

  let errBuf = '';
  child.stderr?.on('data', (chunk) => {
    errBuf += chunk.toString();
    const parts = errBuf.split(/\r?\n/);
    errBuf = parts.pop() ?? '';
    for (const line of parts) handleStderrLine(line);
  });

  child.on('error', (err) => {
    if (state.child === child) state.child = null;
    const next: BrowserCollectJobSnapshot = {
      ...state.snapshot,
      status: 'failed',
      waitSeconds: null,
      updatedAt: new Date().toISOString(),
    };
    applyErrorCode(next, 'collect_spawn_failed', undefined, err.message || undefined);
    state.snapshot = next;
  });

  child.on('exit', (code) => {
    if (outBuf) handleStdoutLine(outBuf);
    if (errBuf) handleStderrLine(errBuf);
    if (state.child === child) state.child = null;
    const exitAt = new Date().toISOString();

    if (state.stoppedByUser || state.snapshot.status === 'stopped') {
      state.snapshot = {
        ...state.snapshot,
        status: 'stopped',
        waitSeconds: null,
        updatedAt: exitAt,
      };
      return;
    }

    if (code === 0) {
      if (state.snapshot.optimizationRunId) {
        try {
          finalizeOptimizationBrowserRetest(projectId, state.snapshot.optimizationRunId);
        } catch {
          // If no observations needed re-finalization or already handled by CLI, keep clean exit
        }
      }
      const next: BrowserCollectJobSnapshot = {
        ...state.snapshot,
        status: 'completed',
        completedCount: state.snapshot.totalCount || state.snapshot.completedCount,
        waitSeconds: null,
        error: null,
        errorCode: null,
        errorParams: undefined,
        errorDetail: null,
        updatedAt: exitAt,
      };
      applyStatusCode(next, 'collect.completed');
      state.snapshot = next;
      return;
    }

    if (state.sawHandoff) {
      const next: BrowserCollectJobSnapshot = {
        ...state.snapshot,
        status: 'needs_handoff',
        waitSeconds: null,
        updatedAt: exitAt,
      };
      applyStatusCode(next, 'collect.needsHandoff');
      applyErrorCode(next, 'collect.needsHandoff', undefined, state.lastErrorLine || undefined);
      state.snapshot = next;
      return;
    }

    const next: BrowserCollectJobSnapshot = {
      ...state.snapshot,
      status: 'failed',
      waitSeconds: null,
      updatedAt: exitAt,
    };
    applyErrorCode(
      next,
      'collect_failed',
      { exitCode: code ?? 1 },
      state.lastErrorLine || undefined,
    );
    state.snapshot = next;
  });

  return { ...state.snapshot };
}

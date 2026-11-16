import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserCollectJobSnapshot } from './browser-collect-types';
import { BrowserCollectionError } from './browser-collection';
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

function browserDisplayName(driver: 'ego' | 'chrome'): string {
  return driver === 'ego' ? 'Ego Lite 浏览器' : '本机 Chrome 浏览器';
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
    const browserName = browserDisplayName(state.driver);
    state.snapshot = {
      ...state.snapshot,
      status: 'stopped',
      waitSeconds: null,
      message: `已停止 ${browserName} 采集。已保存的回答保留在项目记录中。`,
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
    const browserName = browserDisplayName(state.driver);
    state.snapshot = {
      ...state.snapshot,
      status: 'running',
      waitSeconds: null,
      error: null,
      message: `已恢复 ${browserName} 采集，正在继续当前问题…`,
      updatedAt: new Date().toISOString(),
    };
    state.child.stdin.write('RESUME\n');
    return { ...state.snapshot };
  }

  if (
    state.child &&
    (state.snapshot.status === 'running' || state.snapshot.status === 'needs_handoff')
  ) {
    throw new BrowserCollectionError(
      '当前已有本机浏览器采集正在运行或等待验证，请先完成或点击停止。',
      409,
    );
  }

  const engine =
    input.engine === 'chatgpt' || input.engine === 'google' ? input.engine : 'all';

  if (input.optimizationRunId && !VALID_ID.test(input.optimizationRunId)) {
    throw new BrowserCollectionError('优化任务编号无效。');
  }
  const cleanQuestionIds = (input.questionIds ?? []).filter((id) => VALID_ID.test(id));
  if (input.questionIds && cleanQuestionIds.length !== input.questionIds.length) {
    throw new BrowserCollectionError('问题编号格式无效。');
  }
  const spaceId =
    typeof input.spaceId === 'number' && Number.isSafeInteger(input.spaceId) && input.spaceId > 0
      ? input.spaceId
      : null;

  const scriptPath = path.resolve(process.cwd(), 'scripts', 'browser-collect.mjs');
  if (!fs.existsSync(scriptPath)) {
    throw new BrowserCollectionError('未找到本地浏览器采集脚本 scripts/browser-collect.mjs。', 500);
  }

  const egoBin = resolveEgoBrowserBin();
  const driver = resolveDriver(spaceId, egoBin);
  const browserName = browserDisplayName(driver);

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
      throw new BrowserCollectionError('起始时间格式无效。');
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
    message: `正在启动 ${browserName}…`,
    error: null,
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
        snap.message = `正在打开 ${browserName}（共 ${snap.totalCount} 项）…`;
      }
    }
    if (line.includes('[BROWSER_READY]')) {
      snap.message = `已打开 ${browserName}，正在准备第 1 题（共 ${snap.totalCount} 项）…`;
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
      snap.message = `正在 ${engineLabel} 提问（第 ${idx}/${snap.totalCount} 项）`;
      return;
    }
    if (line.includes('等待当前问题的 ChatGPT 回答完成')) {
      snap.message = `正在等待 ChatGPT 生成回答（第 ${snap.currentIndex}/${snap.totalCount} 项）`;
      return;
    }
    if (line.includes('回答已采集，正在自动分析并保存')) {
      snap.message = `已获取网页回答，正在语义判卷入库（第 ${snap.currentIndex}/${snap.totalCount} 项）`;
      return;
    }
    const waitMatch = line.match(/\[防封停等待\]\s*间隔\s*(\d+)s/);
    if (waitMatch) {
      snap.waitSeconds = Number(waitMatch[1]);
      snap.message = `防风控安全间隔倒计时 ${waitMatch[1]}s（已完成 ${snap.completedCount}/${snap.totalCount}）…`;
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
      snap.message = line;
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
      snap.message = `请在打开的 ${browserName} 窗口完成验证或登录，完成后点击继续。`;
      snap.error = state.lastErrorLine || `需要在打开的 ${browserName} 窗口完成一次页面验证或登录。`;
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
    state.snapshot = {
      ...state.snapshot,
      status: 'failed',
      waitSeconds: null,
      error: err.message || `无法启动 ${browserName} 采集进程。`,
      updatedAt: new Date().toISOString(),
    };
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
      state.snapshot = {
        ...state.snapshot,
        status: 'completed',
        completedCount: state.snapshot.totalCount || state.snapshot.completedCount,
        waitSeconds: null,
        message: '本轮 ChatGPT 与 Google 真实回答采集已完成。',
        error: null,
        updatedAt: exitAt,
      };
      return;
    }

    if (state.sawHandoff) {
      state.snapshot = {
        ...state.snapshot,
        status: 'needs_handoff',
        waitSeconds: null,
        message: `请在打开的 ${browserName} 窗口完成一次页面验证或登录后，点击继续采集余下问题。`,
        error: state.lastErrorLine || `需要在 ${browserName} 窗口完成页面验证或登录后继续。`,
        updatedAt: exitAt,
      };
      return;
    }

    state.snapshot = {
      ...state.snapshot,
      status: 'failed',
      waitSeconds: null,
      error: state.lastErrorLine || `${browserName} 采集未完成（退出码 ${code ?? 1}）。`,
      updatedAt: exitAt,
    };
  });

  return { ...state.snapshot };
}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const maxMemMb = Math.max(512, Number(process.env.OPENGEO_DEV_MAX_MEM_MB || 3072) || 3072);
const extraArgs = process.argv.slice(2);
const nextBin = path.join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'next.cmd' : 'next',
);

let stopping = false;
let activeChild = null;
const recentFastCrashes = [];

function buildEnv() {
  const existingOpts = (process.env.NODE_OPTIONS || '').trim();
  const hasHeapCap = /--max-old-space-size(?:=|\s)\d+/i.test(existingOpts);
  const nextOpts = hasHeapCap
    ? existingOpts
    : [existingOpts, `--max-old-space-size=${maxMemMb}`].filter(Boolean).join(' ');
  return { ...process.env, NODE_OPTIONS: nextOpts };
}

function cleanDevCache() {
  try {
    fs.rmSync(path.join(process.cwd(), '.next', 'dev'), { recursive: true, force: true });
  } catch {
    // Non-fatal if cache dir does not exist
  }
}

function launch() {
  if (stopping) return;
  const startedAt = Date.now();
  const args = [
    'dev',
    '--webpack',
    '--hostname',
    '127.0.0.1',
    '--port',
    '4327',
    ...extraArgs,
  ];

  const child = spawn(nextBin, args, {
    stdio: 'inherit',
    env: buildEnv(),
  });
  activeChild = child;

  child.on('exit', (code, signal) => {
    activeChild = null;
    if (stopping || signal === 'SIGINT' || signal === 'SIGTERM' || code === 0) {
      process.exit(code ?? 0);
    }

    const aliveMs = Date.now() - startedAt;
    const now = Date.now();
    if (aliveMs < 15_000) {
      recentFastCrashes.push(now);
      while (recentFastCrashes.length && now - recentFastCrashes[0] > 45_000) {
        recentFastCrashes.shift();
      }
      if (recentFastCrashes.length >= 3) {
        console.error(
          `[opengeo-dev] Stopped after 3 rapid crashes within 45s (last exit code ${code ?? signal}).`,
        );
        process.exit(code ?? 1);
      }
    } else {
      recentFastCrashes.length = 0;
    }

    console.warn(
      `\n[opengeo-dev] Dev server exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}, heap cap=${maxMemMb}MB). Clearing .next/dev and restarting in 1.5s...\n`,
    );
    cleanDevCache();
    setTimeout(launch, 1500);
  });
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    if (activeChild) {
      activeChild.kill(sig);
    } else {
      process.exit(0);
    }
  });
}

launch();

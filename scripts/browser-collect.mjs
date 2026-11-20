#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { collectBrowserQuestion, submitBrowserCapture } from './browser-collector.mjs';

// The browser remains the collection surface. This command never reads cookies
// or subscription credentials and never substitutes an API answer for a web answer.
function resolveEgoBrowserBin() {
  const candidates = [
    process.env.EGO_BROWSER_BIN?.trim(),
    path.join(os.homedir(), '.local', 'bin', 'ego-browser'),
    '/opt/homebrew/bin/ego-browser',
    '/usr/local/bin/ego-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fsSync.existsSync(candidate)) {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try remaining candidate paths
    }
  }

  try {
    const probe = spawnSync('ego-browser', ['--version'], {
      timeout: 3000,
      stdio: 'ignore',
    });
    if (probe.status === 0) return 'ego-browser';
  } catch {
    // Fall through to chrome driver
  }
  return null;
}

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
  return pairs;
}, []));
const base = args.base || process.env.OPENGEO_BASE_URL || 'http://127.0.0.1:4327';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const optimizationRunId = args['optimization-run-id']?.trim() || '';
if (optimizationRunId && !/^[A-Za-z0-9_-]{1,120}$/.test(optimizationRunId)) {
  throw new Error('优化任务编号无效。');
}
const egoBin = resolveEgoBrowserBin();
const driver = (args.driver || process.env.OPENGEO_BROWSER_DRIVER || (args.space || egoBin ? 'ego' : 'chrome')).toLowerCase();
if (!['chrome', 'ego'].includes(driver)) {
  throw new Error('--driver 只支持 chrome 或 ego。');
}
const cdpUrl = (args['cdp-url'] || process.env.OPENGEO_CDP_URL || '').trim();
const interactiveHandoff = args['interactive-handoff'] === 'true';
const questionFilter = args.questions
  ? new Set(String(args.questions).split(',').map((item) => item.trim()).filter(Boolean))
  : null;

async function finalizeRetestIfNeeded() {
  if (!optimizationRunId || !args.project) return;
  try {
    const res = await fetch(`${base}/api/geo/optimization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        projectId: args.project,
        action: 'finalize_retest',
        runId: optimizationRunId,
      }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      console.error(`复测汇总未完成：${payload.error ?? res.status}`);
    }
  } catch (err) {
    console.error(`复测汇总请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

if (args.saved) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(args.saved)) throw new Error('采集编号无效。');
  const payload = JSON.parse(await fs.readFile(path.join(root, 'data', 'browser-captures', `${args.saved}.json`), 'utf8'));
  if (payload.captureId !== args.saved) throw new Error('采集编号与保存文件不一致。');
  if (args['retry-analysis'] === 'true') payload.retryAnalysis = true;
  await submitBrowserCapture({ base, root }, payload);
  process.exit(0);
}

if (!args.project) {
  console.error('用法:');
  console.error('  整批连采（推荐）: npm run collect -- --project PROJECT [--engine chatgpt|google|all] [--language en|zh] [--force true] [--driver chrome|ego] [--cdp-url URL]');
  console.error('  单题采集:         node scripts/browser-collect.mjs --project PROJECT --question QUESTION --engine chatgpt|google [--language en|zh] [--driver chrome|ego]');
  process.exit(1);
}

if (args.space && !/^\d+$/.test(args.space)) throw new Error('浏览器工作区编号无效。');

const response = await fetch(`${base}/api/geo?project=${encodeURIComponent(args.project)}`);
if (!response.ok) throw new Error('无法读取本地项目，请先启动 OpenGEO（npm run dev）。');
const state = await response.json();
const batch = state.latestResearch;
if (!batch?.questions?.length) {
  throw new Error('当前项目还没有已确认的研究问题批次，请先在概览页面确认问题。');
}

function resolveBatchLanguage() {
  if (args.language) return args.language;
  const projectLang = state.project?.targetLanguage;
  const hasEn = batch.questions.some(q => q.observations?.some(o => o.language === 'en'));
  const hasZh = batch.questions.some(q => q.observations?.some(o => o.language === 'zh'));
  if (projectLang === 'en') return hasEn || !hasZh ? 'en' : 'zh';
  if (projectLang === 'zh') return hasZh || !hasEn ? 'zh' : 'en';
  if (hasEn) return 'en';
  if (hasZh) return 'zh';
  return 'en';
}

const language = resolveBatchLanguage();
if (!['zh', 'en'].includes(language)) {
  throw new Error('语言参数只支持 en 或 zh。');
}

const force = args.force === 'true';
const sinceMs = args.since ? Date.parse(args.since) : NaN;
if (args.since && !Number.isFinite(sinceMs)) {
  throw new Error('--since 时间格式无效。');
}
const humanPace = args.pace !== 'false';
const minDelayMs = Number(args['min-delay-ms'] ?? 5000);
const maxDelayMs = Number(args['max-delay-ms'] ?? 9000);
if (!Number.isFinite(minDelayMs) || !Number.isFinite(maxDelayMs) || minDelayMs < 0 || maxDelayMs < minDelayMs) {
  throw new Error('--min-delay-ms / --max-delay-ms 参数无效。');
}
const queue = [];

if (args.question) {
  if (!['chatgpt', 'google'].includes(args.engine)) {
    console.error('单题采集必须指定 --engine chatgpt|google');
    process.exit(1);
  }
  const question = batch.questions.find(q => q.id === args.question && q.decision === 'search_now');
  if (!question || !question[language]) throw new Error('未找到当前已确认的对应语言问题。');
  const captureId = args.capture ?? `browser-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(captureId)) throw new Error('采集编号无效。');
  if (args.resume === 'true' && args.space && !args.capture) {
    throw new Error('继续采集需要原 --space 和 --capture 编号。');
  }
  queue.push({
    base,
    root,
    projectId: args.project,
    batchId: batch.id,
    questionId: question.id,
    query: question[language],
    language,
    engine: args.engine,
    resume: args.resume === 'true',
    humanPause: humanPace,
    captureId,
    ...(optimizationRunId ? { optimizationRunId } : {}),
  });
} else {
  const engineArg = args.engine ?? 'all';
  if (!['chatgpt', 'google', 'all'].includes(engineArg)) {
    throw new Error('--engine 只支持 chatgpt、google 或 all。');
  }
  const engines = engineArg === 'all' ? ['chatgpt', 'google'] : [engineArg];
  const activeQuestions = batch.questions.filter(
    (q) =>
      q.decision === 'search_now' &&
      q[language] &&
      (!questionFilter || questionFilter.has(q.id)),
  );
  // Alternate platforms question by question: each platform's own cooldown then runs
  // while the other platform is being searched, so a round takes about half as long
  // without either site seeing faster traffic.
  for (const q of activeQuestions) {
    for (const engine of engines) {
      const alreadyDone = Number.isFinite(sinceMs)
        ? q.observations?.some(
            (o) =>
              o.engine === engine &&
              o.language === language &&
              Date.parse(o.collectedAt || o.recordedAt || '') >= sinceMs,
          )
        : !force &&
          q.observations?.some((o) => o.engine === engine && o.language === language);
      if (alreadyDone) continue;
      queue.push({
        base,
        root,
        projectId: args.project,
        batchId: batch.id,
        questionId: q.id,
        query: q[language],
        language,
        engine,
        resume: false,
        humanPause: humanPace,
        captureId: `browser-${randomUUID()}`,
        ...(optimizationRunId ? { optimizationRunId } : {}),
      });
    }
  }
  if (!queue.length) {
    console.log(`当前批次全部问题已完成 ${engines.join(' / ')} (${language}) 采集，无需重复运行（如需重采请加 --force true）。`);
    await finalizeRetestIfNeeded();
    process.exit(0);
  }
  console.log(`准备连采项目 ${state.project?.name || args.project}（语言: ${language}，共 ${queue.length} 项，降频=${humanPace ? '开启' : '关闭'}）…`);
}

console.log(`[QUEUE_READY] total: ${queue.length} language: ${language} driver: ${driver}`);

function createLineReader(stream) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const buffered = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) {
      const waiter = waiters.shift();
      waiter(null);
    }
  });

  return {
    nextLine() {
      if (buffered.length) return Promise.resolve(buffered.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      rl.close();
      stream.pause?.();
    },
  };
}

function attachCdp(context, page) {
  if (typeof page.cdp === 'function') return page;
  let sessionPromise = null;
  page.cdp = async (method, params) => {
    sessionPromise ??= context.newCDPSession(page);
    const session = await sessionPromise;
    return session.send(method, params);
  };
  return page;
}

async function openChromeWorkspace() {
  const { chromium } = await import('playwright');
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? await browser.newContext({ viewport: null });
    return {
      context,
      browserLabel: 'Chrome (CDP)',
      close: async () => {},
    };
  }
  const profileDir = path.join(root, 'data', 'browser-profile');
  await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const candidates = [
    { channel: 'chrome', label: 'Google Chrome' },
    { channel: 'msedge', label: 'Microsoft Edge' },
    { channel: undefined, label: 'Chromium' },
  ];
  let lastErr;
  for (const candidate of candidates) {
    try {
      const context = await chromium.launchPersistentContext(profileDir, {
        ...(candidate.channel ? { channel: candidate.channel } : {}),
        headless: false,
        viewport: null,
      });
      return {
        context,
        browserLabel: candidate.label,
        close: () => context.close().catch(() => {}),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  const detail = lastErr instanceof Error ? ` (${lastErr.message})` : '';
  throw new Error(`未检测到可用的本机 Chrome / Edge / Chromium 浏览器，请先安装 Google Chrome。${detail}`);
}

async function runChromeDriver() {
  const workspace = await openChromeWorkspace();
  const lineReader = createLineReader(process.stdin);
  const isBatch = !args.question;
  const engineCooldowns = { chatgpt: [38000, 52000], google: [28000, 42000] };
  const randomBetween = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min + 1));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const lastByEngine = {};
  let activePage = null;
  let stopping = false;

  const ensureActivePage = async () => {
    if (activePage && !activePage.isClosed()) return activePage;
    const openPage = workspace.context.pages().find((p) => !p.isClosed()) ?? await workspace.context.newPage();
    activePage = attachCdp(workspace.context, openPage);
    return activePage;
  };

  const handleSignal = async () => {
    if (stopping) return;
    stopping = true;
    lineReader.close();
    await workspace.close();
    process.exit(130);
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  await ensureActivePage();
  console.log(`[BROWSER_READY] browser: ${workspace.browserLabel} total: ${queue.length} language: ${language} humanPace: ${humanPace}`);

  let reviewPendingCount = 0;
  let skipNextCooldown = false;
  try {
    for (let i = 0; i < queue.length; i += 1) {
      const item = queue[i];
      if (humanPace && i > 0 && !skipNextCooldown) {
        const stepWait = randomBetween(minDelayMs, maxDelayMs);
        const lastAt = lastByEngine[item.engine] ?? 0;
        const [coolMin, coolMax] = engineCooldowns[item.engine] ?? [28000, 40000];
        const targetCooldown = lastAt ? randomBetween(coolMin, coolMax) : 0;
        const engineRemaining = lastAt ? Math.max(0, targetCooldown - (Date.now() - lastAt)) : 0;
        let remainingMs = Math.max(stepWait, engineRemaining);
        while (remainingMs > 0) {
          console.log(`[防封停等待] 间隔 ${Math.ceil(remainingMs / 1000)}s 后采集 ${item.engine} (${item.questionId})…`);
          const chunk = Math.min(5000, remainingMs);
          await sleep(chunk);
          remainingMs -= chunk;
        }
      }
      skipNextCooldown = false;
      await ensureActivePage();
      console.log(`[${i + 1}/${queue.length}] ${item.questionId} (${item.engine}, ${item.language}): ${item.query}`);
      // A platform's cooldown counts from when it was asked, not from when our own review finished.
      lastByEngine[item.engine] = Date.now();
      try {
        await collectBrowserQuestion({ page: () => activePage }, item);
      } catch (stepError) {
        const message = stepError?.message ?? String(stepError);
        if (isBatch && (stepError?.code === 'REVIEW_PENDING' || /回答已入库.*(?:审核仍待核实|模型分析失败)/.test(message))) {
          reviewPendingCount += 1;
          console.log(`[已入库待核实] ${item.questionId} (${item.engine})：${message} — 继续下一题。`);
          continue;
        }
        const needsHumanAction =
          stepError?.code === 'NEEDS_HUMAN_HANDOFF' ||
          /人工验证|风控|限流|人工校验|需要先登录/.test(message);
        if (needsHumanAction) {
          await activePage?.bringToFront().catch(() => {});
          console.error(message);
          console.error('[NEEDS_BROWSER_HANDOFF]');
          if (interactiveHandoff || process.stdin.isTTY) {
            if (process.stdin.isTTY && !interactiveHandoff) {
              console.error('请在打开的 Chrome 窗口完成验证或登录后，按回车继续（输入 stop 并回车可终止）…');
            }
            const line = await lineReader.nextLine();
            if (line !== null && !/^stop$/i.test(line.trim())) {
              item.captureId = `browser-${randomUUID()}`;
              item.resume = false;
              skipNextCooldown = true;
              i -= 1;
              console.log(`[HANDOFF_RESUMED] 已恢复采集 ${item.questionId}`);
              continue;
            }
          }
        }
        throw stepError;
      }
    }
    await finalizeRetestIfNeeded();
    console.log(`本轮批量采集全部完成（待人工核实条数: ${reviewPendingCount}）！请刷新 OpenGEO 概览查看最新表现。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
    lineReader.close();
    await workspace.close();
  }
}

async function runEgoDriver() {
  const defaultSpaceName = `OpenGEO 批量采集 ${args.project}`;
  const requestedSpaceId = args.space ? Number(args.space) : null;
  const collectorUrl = new URL('./browser-collector.mjs', import.meta.url).href;
  const isBatch = !args.question;
  const engineCooldowns = { chatgpt: [38000, 52000], google: [28000, 42000] };
  const randomBetween = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min + 1));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const lastByEngine = {};
  const lineReader = createLineReader(process.stdin);
  let currentChild = null;
  let stopping = false;

  const stopEgoDriver = () => {
    if (stopping) return;
    stopping = true;
    try {
      currentChild?.kill('SIGTERM');
    } catch {
      // Child may have already exited
    }
  };

  process.on('SIGTERM', stopEgoDriver);
  process.on('SIGINT', stopEgoDriver);
  (async () => {
    while (!stopping) {
      const line = await lineReader.nextLine();
      if (line === null) break;
      if (/^stop$/i.test(line.trim())) {
        stopEgoDriver();
        break;
      }
    }
  })().catch(() => {});

  const runEgoScript = (scriptCode, { forwardOutput = true } = {}) =>
    new Promise((resolve) => {
      if (stopping) {
        resolve({ code: 130, outText: '', errText: '', combinedText: '', sawHandoff: false });
        return;
      }
      const child = spawn(egoBin || 'ego-browser', ['nodejs', '-e', scriptCode], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      currentChild = child;
      let outText = '';
      let errText = '';
      let errLineBuf = '';
      let sawHandoff = false;
      let settled = false;

      const routeStderrLine = (rawLine) => {
        const line = rawLine.replace(/\r$/, '');
        if (!line.trim()) return;
        if (line.includes('[NEEDS_BROWSER_HANDOFF]')) sawHandoff = true;
        if (!forwardOutput) return;
        const trimmed = line.trim();
        const isErrorLine =
          /^\[error\]/i.test(trimmed) ||
          trimmed.includes('[NEEDS_BROWSER_HANDOFF]') ||
          trimmed.startsWith("ego's nodejs process exited") ||
          trimmed.startsWith('Error:') ||
          trimmed.startsWith('TypeError:');
        if (isErrorLine) {
          process.stderr.write(`${trimmed.replace(/^\[error\]\s*/i, '')}\n`);
        } else {
          process.stdout.write(`${line}\n`);
        }
      };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (errLineBuf) {
          routeStderrLine(errLineBuf);
          errLineBuf = '';
        }
        if (currentChild === child) currentChild = null;
        resolve({
          ...result,
          combinedText: `${result.outText}\n${result.errText}`,
        });
      };

      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        outText += text;
        if (forwardOutput) process.stdout.write(text);
      });
      child.stderr?.on('data', (chunk) => {
        const text = chunk.toString();
        errText += text;
        errLineBuf += text;
        const lines = errLineBuf.split('\n');
        errLineBuf = lines.pop() ?? '';
        for (const line of lines) routeStderrLine(line);
      });
      child.on('error', (err) => {
        finish({
          code: 1,
          outText,
          errText: errText || (err instanceof Error ? err.message : String(err)),
          sawHandoff,
          spawnError: err,
        });
      });
      child.on('exit', (code) => {
        finish({ code: code ?? 1, outText, errText, sawHandoff });
      });
    });

  const acquireSpaceFn = `
async function acquireCollectionSpace(targetId, fallbackName) {
  const spaces = await listTaskSpaces();
  const found = targetId
    ? spaces.find((s) => s.id === targetId)
    : (fallbackName ? spaces.find((s) => s.name === fallbackName) : null);
  if (!found) {
    if (!fallbackName) throw new Error('未找到指定的 Ego Lite 工作区。');
    const created = await taskSpace(fallbackName);
    return { task: created, activePage: created.page('p1'), ownedByCollector: true };
  }
  const resolvedId = found.id;
  const t = found.ownership === 'agentDelegatedToUser'
    ? await takeOverTaskSpace(resolvedId)
    : found.ownership === 'user'
      ? await claimTaskSpace(resolvedId)
      : await taskSpace(resolvedId);
  const ownedByCollector = Boolean(found.name?.startsWith('OpenGEO 批量采集 '));
  let activePage = (await t.pages())[0] ?? null;
  if (!activePage) {
    const up = typeof t.userPage === 'function' ? t.userPage() : null;
    if (up) {
      activePage = await t.adopt(up);
    } else {
      const tabs = await t.tabs();
      const targetTab = tabs.find((item) => item.active) || tabs[0];
      if (targetTab) {
        activePage = targetTab.label ? t.page(targetTab.label) : await t.adopt(targetTab.page);
      } else {
        activePage = await t.newPage();
      }
    }
  }
  return { task: t, activePage, ownedByCollector };
}
`;

  try {
    const initScript = `
${acquireSpaceFn}
const { task, ownedByCollector } = await acquireCollectionSpace(${JSON.stringify(requestedSpaceId)}, ${JSON.stringify(defaultSpaceName)});
console.log('__EGO_SPACE_INIT__' + JSON.stringify({ spaceId: task.spaceId, ownedByCollector }));
`;
    const initRes = await runEgoScript(initScript, { forwardOutput: false });
    if (initRes.spawnError) {
      console.error('未检测到 ego-browser（可使用 --driver chrome 切换本机 Chrome 驱动）。');
      process.exitCode = 1;
      return;
    }
    const initMatch = initRes.combinedText.match(/__EGO_SPACE_INIT__(\{[^\n\r]+\})/);
    if (initRes.code !== 0 || !initMatch) {
      const cleanedErr = initRes.errText
        .split(/\r?\n/)
        .map((line) => line.replace(/^\[error\]\s*/i, '').trim())
        .filter((line) => line && !line.startsWith("ego's nodejs process exited"))
        .join('\n');
      if (cleanedErr) console.error(cleanedErr);
      else console.error(`无法初始化 Ego Lite 采集工作区（退出码 ${initRes.code}）。`);
      process.exitCode = stopping ? 130 : (initRes.code || 1);
      return;
    }

    const { spaceId, ownedByCollector } = JSON.parse(initMatch[1]);
    console.log(`[BROWSER_READY] browser: Ego Lite spaceId: ${spaceId} total: ${queue.length} language: ${language} humanPace: ${humanPace}`);

    let reviewPendingCount = 0;
    for (let i = 0; i < queue.length; i += 1) {
      if (stopping) break;
      const item = queue[i];
      if (humanPace && i > 0) {
        const stepWait = randomBetween(minDelayMs, maxDelayMs);
        const lastAt = lastByEngine[item.engine] ?? 0;
        const [coolMin, coolMax] = engineCooldowns[item.engine] ?? [28000, 40000];
        const targetCooldown = lastAt ? randomBetween(coolMin, coolMax) : 0;
        const engineRemaining = lastAt ? Math.max(0, targetCooldown - (Date.now() - lastAt)) : 0;
        let remainingMs = Math.max(stepWait, engineRemaining);
        let lastLogAt = 0;
        while (remainingMs > 0 && !stopping) {
          const now = Date.now();
          if (now - lastLogAt >= 4800) {
            console.log(`[防封停等待] 间隔 ${Math.ceil(remainingMs / 1000)}s 后采集 ${item.engine} (${item.questionId})…`);
            lastLogAt = now;
          }
          const chunk = Math.min(1000, remainingMs);
          await sleep(chunk);
          remainingMs -= chunk;
        }
      }
      if (stopping) break;

      console.log(`[${i + 1}/${queue.length}] ${item.questionId} (${item.engine}, ${item.language}): ${item.query}`);
      const itemScript = `
const { collectBrowserQuestion } = await import(${JSON.stringify(collectorUrl)});
${acquireSpaceFn}
const { task, activePage } = await acquireCollectionSpace(${JSON.stringify(spaceId)}, null);
try {
  await collectBrowserQuestion({ page: () => activePage }, ${JSON.stringify(item)});
} catch (error) {
  const needsHumanAction =
    error?.code === 'NEEDS_HUMAN_HANDOFF' ||
    /人工验证|风控|限流|人工校验|需要先登录/.test(error?.message ?? '');
  if (needsHumanAction) {
    await task.handOff().catch(() => {});
    console.error('[NEEDS_BROWSER_HANDOFF]');
  }
  if (error?.code === 'REVIEW_PENDING') {
    console.error('[REVIEW_PENDING]');
  }
  console.error(error?.message ?? String(error));
  console.error('浏览器页面已保留；可加上 --space ' + task.spaceId + ' 继续余下未采问题（已保存的会自动跳过）。');
  process.exitCode = 1;
}
`;
      // A platform's cooldown counts from when it was asked, not from when our own review finished.
      lastByEngine[item.engine] = Date.now();
      const stepRes = await runEgoScript(itemScript, { forwardOutput: true });

      if (stopping) break;
      if (stepRes.code !== 0) {
        if (stepRes.spawnError) {
          console.error('未检测到 ego-browser（可使用 --driver chrome 切换本机 Chrome 驱动）。');
          process.exitCode = 1;
          return;
        }
        const combined = `${stepRes.errText}\n${stepRes.outText}`;
        if (isBatch && (combined.includes('[REVIEW_PENDING]') || /回答已入库.*(?:审核仍待核实|模型分析失败)/.test(combined))) {
          reviewPendingCount += 1;
          console.log(`[已入库待核实] ${item.questionId} (${item.engine}) — 继续下一题。`);
          continue;
        }
        if (stepRes.sawHandoff && process.platform === 'darwin') {
          try {
            spawn('open', ['-a', 'ego lite'], { stdio: 'ignore', detached: true }).unref();
          } catch {}
        }
        process.exitCode = stepRes.code || 1;
        return;
      }
    }

    if (stopping) {
      process.exitCode = 130;
      return;
    }

    if (ownedByCollector) {
      const finishScript = `
${acquireSpaceFn}
const { task } = await acquireCollectionSpace(${JSON.stringify(spaceId)}, null);
await task.finish({ keep: [] });
`;
      await runEgoScript(finishScript, { forwardOutput: false });
    }
    await finalizeRetestIfNeeded();
    console.log(`本轮批量采集全部完成（待人工核实条数: ${reviewPendingCount}）！请刷新 OpenGEO 概览查看最新表现。`);
  } finally {
    process.off('SIGTERM', stopEgoDriver);
    process.off('SIGINT', stopEgoDriver);
    lineReader.close();
  }
}

if (driver === 'chrome') {
  await runChromeDriver();
} else {
  await runEgoDriver();
}

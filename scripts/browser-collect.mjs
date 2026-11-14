#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { submitBrowserCapture } from './browser-collector.mjs';

// The browser remains the collection surface. This command never reads cookies
// or subscription credentials and never substitutes an API answer for a web answer.
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[i + 1]]);
  return pairs;
}, []));
const base = 'http://127.0.0.1:4327';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  console.error('  整批连采（推荐）: npm run collect -- --project PROJECT [--engine chatgpt|google|all] [--language en|zh] [--force true] [--space ID]');
  console.error('  单题采集:         node scripts/browser-collect.mjs --project PROJECT --question QUESTION --engine chatgpt|google [--language en|zh] [--space ID]');
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
const humanPace = args.pace !== 'false';
const minDelayMs = Number(args['min-delay-ms'] ?? 10000);
const maxDelayMs = Number(args['max-delay-ms'] ?? 18000);
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
  if (args.resume === 'true' && (!args.space || !args.capture)) {
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
  });
} else {
  const engineArg = args.engine ?? 'all';
  if (!['chatgpt', 'google', 'all'].includes(engineArg)) {
    throw new Error('--engine 只支持 chatgpt、google 或 all。');
  }
  const engines = engineArg === 'all' ? ['chatgpt', 'google'] : [engineArg];
  const activeQuestions = batch.questions.filter(q => q.decision === 'search_now' && q[language]);
  // Run each engine sequentially with per-engine cooldowns so a CAPTCHA on one platform
  // never blocks saving unaffected platforms.
  for (const engine of engines) {
    for (const q of activeQuestions) {
      const alreadyDone = !force && q.observations?.some(o => o.engine === engine && o.language === language);
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
      });
    }
  }
  if (!queue.length) {
    console.log(`当前批次全部问题已完成 ${engines.join(' / ')} (${language}) 采集，无需重复运行（如需重采请加 --force true）。`);
    process.exit(0);
  }
  console.log(`准备连采项目 ${state.project?.name || args.project}（语言: ${language}，共 ${queue.length} 项，降频=${humanPace ? '开启' : '关闭'}）…`);
}

const script = `
const { collectBrowserQuestion } = await import(${JSON.stringify(new URL('./browser-collector.mjs', import.meta.url).href)});
const queue = ${JSON.stringify(queue)};
const isBatch = ${JSON.stringify(!args.question)};
const humanPace = ${JSON.stringify(humanPace)};
const minDelayMs = ${JSON.stringify(minDelayMs)};
const maxDelayMs = ${JSON.stringify(maxDelayMs)};
const engineCooldowns = { chatgpt: [38000, 52000], google: [28000, 42000] };
const randomBetween = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min + 1));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lastByEngine = {};
async function openCollectionSpace() {
  const requestedId = ${args.space ? Number(args.space) : 'null'};
  if (!requestedId) return taskSpace(${JSON.stringify(`OpenGEO 批量采集 ${args.project}`)});
  const spaces = await listTaskSpaces();
  const found = spaces.find((s) => s.id === requestedId);
  if (!found) return taskSpace(${JSON.stringify(`OpenGEO 批量采集 ${args.project}`)});
  const t = found.ownership === 'agentDelegatedToUser'
    ? await takeOverTaskSpace(requestedId)
    : found.ownership === 'user'
      ? await claimTaskSpace(requestedId)
      : await taskSpace(requestedId);
  const pages = await t.pages();
  if (!pages.some((p) => p.label === 'p1')) {
    const up = t.userPage();
    if (up) await t.adopt(up, { as: 'p1' });
    else await t.newPage();
  }
  return t;
}
const task = await openCollectionSpace();
console.log({ spaceId: task.spaceId, total: queue.length, language: ${JSON.stringify(language)}, humanPace });
try {
  let reviewPendingCount = 0;
  for (let i = 0; i < queue.length; i += 1) {
    const item = queue[i];
    if (humanPace && i > 0) {
      const stepWait = randomBetween(minDelayMs, maxDelayMs);
      const lastAt = lastByEngine[item.engine] ?? 0;
      const [coolMin, coolMax] = engineCooldowns[item.engine] ?? [28000, 40000];
      const targetCooldown = lastAt ? randomBetween(coolMin, coolMax) : 0;
      const engineRemaining = lastAt ? Math.max(0, targetCooldown - (Date.now() - lastAt)) : 0;
      const waitMs = Math.max(stepWait, engineRemaining);
      if (waitMs > 0) {
        console.log(\`[防封停等待] 间隔 \${Math.round(waitMs / 1000)}s 后采集 \${item.engine} (\${item.questionId})…\`);
        await sleep(waitMs);
      }
    }
    console.log(\`[\${i + 1}/\${queue.length}] \${item.questionId} (\${item.engine}, \${item.language}): \${item.query}\`);
    try {
      await collectBrowserQuestion(task, item);
    } catch (stepError) {
      if (isBatch && /回答已入库.*(?:审核仍待核实|模型分析失败)/.test(stepError?.message ?? '')) {
        reviewPendingCount += 1;
        console.log(\`[已入库待核实] \${item.questionId} (\${item.engine})：\${stepError.message} — 继续下一题。\`);
      } else {
        throw stepError;
      }
    } finally {
      lastByEngine[item.engine] = Date.now();
    }
  }
  ${args.space ? '// The caller owns this existing browser workspace and finishes it after verification.' : 'await task.finish({keep:[]});'}
  console.log(\`本轮批量采集全部完成（待人工核实条数: \${reviewPendingCount}）！请刷新 OpenGEO 概览查看最新表现。\`);
} catch (error) {
  const needsHumanAction = /人工验证|风控|限流|人工校验/.test(error?.message ?? '');
  if (needsHumanAction) {
    await task.handOff().catch(() => {});
    console.error('[NEEDS_BROWSER_HANDOFF]');
  }
  console.error(error.message);
  console.error('浏览器页面已保留在 ego lite 应用中；可加上 --space ' + task.spaceId + ' 继续余下未采问题（已保存的会自动跳过）。');
  process.exitCode = 1;
}
`;

const child = spawn('ego-browser', ['nodejs', '-e', script], { stdio: ['inherit', 'inherit', 'pipe'] });
let sawHandoff = false;
child.stderr.on('data', chunk => {
  const text = chunk.toString();
  if (text.includes('[NEEDS_BROWSER_HANDOFF]')) sawHandoff = true;
  process.stderr.write(chunk);
});
child.on('error', () => { console.error('请先安装并打开 ego-browser。'); process.exitCode = 1; });
child.on('exit', code => {
  if (sawHandoff && process.platform === 'darwin') {
    try {
      spawn('open', ['-a', 'ego lite'], { stdio: 'ignore', detached: true }).unref();
    } catch {}
  }
  process.exitCode = code ?? 1;
});

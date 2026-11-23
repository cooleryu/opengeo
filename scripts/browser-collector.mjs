import fs from 'node:fs/promises';
import path from 'node:path';

// The browser only does what a person would: open the site, type the question,
// wait for the page to settle and copy what is on screen. Deciding what the page
// shows, where the answer is and which links it cites is the AI page reader's job
// (src/lib/geo/page-reader.ts), so nothing here depends on one site's layout.

function taggedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const ENGINES = {
  chatgpt: { label: 'ChatGPT', start: () => 'https://chatgpt.com/?temporary-chat=true', requireSignIn: true },
  google: { label: 'Google', start: (language) => (language === 'en' ? 'https://www.google.com/?hl=en' : 'https://www.google.com/') },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (minMs, maxMs) => sleep(minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs + 1)));

/** Runs in the page. Copies the main content with a [Ln] mark after each link. */
export function capturePage() {
  const visible = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);
  const secretKey = /^(?:authorization|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;
  // Only the main content: a sidebar can hold the person's own chat titles.
  const root = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
  const links = [];
  const marks = [];
  for (const anchor of root.querySelectorAll('a[href]')) {
    if (links.length >= 400) break;
    if (!visible(anchor)) continue;
    let url;
    try { url = new URL(anchor.href); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 16000 ||
      /\s/.test(url.href) || [...url.searchParams.keys()].some((key) => secretKey.test(key))) continue;
    const n = links.length + 1;
    const text = (anchor.getAttribute('aria-label') || anchor.innerText || anchor.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    links.push({ n, text, url: url.href });
    const mark = document.createElement('span');
    mark.textContent = ` [L${n}]`;
    anchor.after(mark);
    marks.push(mark);
  }
  let pageText = '';
  try { pageText = root.innerText || root.textContent || ''; } finally { for (const mark of marks) mark.remove(); }
  const headerText = [...document.querySelectorAll('header')].filter(visible)
    .map((header) => header.innerText || '').join('\n').replace(/[ \t]+/g, ' ').trim().slice(0, 600);
  const signInVisible = [...document.querySelectorAll('a, button, [role="button"]')].some((el) =>
    visible(el) && /^(log in|sign in|登录)$/i.test((el.innerText || el.textContent || '').trim()));
  return { pageUrl: document.location.href, title: (document.title || '').slice(0, 300), headerText,
    pageText: pageText.slice(0, 300000), links, signInVisible };
}

/** Runs in the page. Tags the largest visible text box so the driver can click it. */
export function markInputBox() {
  const visible = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);
  for (const el of document.querySelectorAll('[data-opengeo-input]')) el.removeAttribute('data-opengeo-input');
  const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="search"], input[type="text"], input:not([type])')]
    .filter((el) => visible(el) && !el.disabled && !el.readOnly && el.getAttribute('aria-hidden') !== 'true');
  const area = (el) => { const rect = el.getBoundingClientRect(); return rect.width * rect.height; };
  const box = boxes.sort((a, b) => area(b) - area(a))[0];
  if (!box) return false;
  box.setAttribute('data-opengeo-input', '1');
  return true;
}

/** Runs in the page. Whether a visible "Log in" / "Sign in" button is showing. */
export function signInShown() {
  const visible = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);
  return [...document.querySelectorAll('a, button, [role="button"]')].some((el) =>
    visible(el) && /^(log in|sign in|登录)$/i.test((el.innerText || el.textContent || '').trim()));
}

/** Runs in the page. How much main text there is, and whether a Stop/Generating control is showing. */
export function pageActivity() {
  const visible = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);
  const root = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
  const busy = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label], [role="progressbar"][aria-label]')]
    .some((el) => visible(el) && /\bstop\b|停止|generating|生成中/i.test(el.getAttribute('aria-label') || ''));
  return { length: (root.innerText || root.textContent || '').length, busy };
}

/** Wait until the page has stopped changing for a while. The AI reader still has the final say. */
export async function waitForQuietPage(page, { minMs = 8000, quietMs = 6000, maxMs = 180000, pollMs = 2000 } = {}) {
  const started = Date.now();
  let last = -1;
  let quietSince = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(pollMs);
    const { length, busy } = await page.evaluate(pageActivity);
    if (busy || length !== last) {
      last = length;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - started >= minMs && Date.now() - quietSince >= quietMs) return true;
  }
  return false;
}

async function askQuestion(page, query, humanPause, { maxAttempts = 3, retryMs = 1200 } = {}) {
  let clicked = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await page.evaluate(markInputBox)) {
      try {
        await page.click('[data-opengeo-input="1"]', { timeout: 5000 });
        clicked = true;
        break;
      } catch {
        // SPA hydration (e.g. React/ProseMirror) can replace the node or drop the temporary attribute; re-mark and retry.
      }
    }
    if (attempt < maxAttempts && retryMs > 0) await sleep(retryMs);
  }
  if (!clicked) return false;
  if (humanPause) await jitter(500, 1100);
  await page.keyboard.insertText(query);
  if (humanPause) await jitter(600, 1300);
  await page.keyboard.press('Enter');
  return true;
}

async function fetchLocal(url, init, retries = 1) {
  let lastError;
  for (let i = 0; i <= retries; i += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (i < retries) await sleep(1500);
    }
  }
  const cause = lastError?.cause?.code || lastError?.cause?.message || '';
  const detail = cause ? ` (${cause})` : '';
  throw new Error(`${lastError?.message ?? 'fetch failed'}${detail}`);
}

async function readPage(input, snapshot, attempt) {
  const response = await fetchLocal(`${input.base}/api/geo/browser-pages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: input.base },
    body: JSON.stringify({ projectId: input.projectId, batchId: input.batchId, questionId: input.questionId,
      captureId: input.captureId, attempt, query: input.query, language: input.language, engine: input.engine, ...snapshot }),
    signal: AbortSignal.timeout(240000),
  });
  const reading = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`AI 读取页面未完成：${reading.error ?? response.status}`);
  return reading;
}

export async function collectBrowserQuestion(task, input, { maxReads = 5, quiet = {} } = {}) {
  const directory = path.join(input.root, 'data', 'browser-captures');
  const captureFile = path.join(directory, `${input.captureId}.json`);
  try {
    const prior = JSON.parse(await fs.readFile(captureFile, 'utf8'));
    if (prior.projectId !== input.projectId || prior.batchId !== input.batchId || prior.questionId !== input.questionId ||
      prior.query !== input.query || prior.engine !== input.engine || prior.language !== input.language) throw new Error('采集编号已对应其他问题。');
    const replayPayload = input.optimizationRunId ? { ...prior, optimizationRunId: input.optimizationRunId } : prior;
    return submitBrowserCapture(input, replayPayload);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const engine = ENGINES[input.engine];
  if (!engine) throw new Error(`不支持的平台：${input.engine}`);
  const page = typeof task.page === 'function' ? task.page('p1') : task;
  console.log('正在浏览器采集这一题…');
  if (!input.resume) {
    await page.goto(engine.start(input.language));
    await sleep(quiet.settleMs ?? (input.humanPause ? 2500 : 1500));
    if (engine.requireSignIn && (await page.evaluate(signInShown))) {
      throw taggedError(`${engine.label} 需要先登录账号，请在打开的浏览器窗口登录后点击继续。`, 'NEEDS_HUMAN_HANDOFF');
    }
    if (!(await askQuestion(page, input.query, input.humanPause, { retryMs: quiet.inputRetryMs ?? quiet.retryMs ?? 1200 }))) {
      console.log('页面上没有可点击的输入框，交给 AI 判断页面状态…');
    }
  }

  let lastNote = '';
  for (let attempt = 1; attempt <= maxReads; attempt += 1) {
    await waitForQuietPage(page, { ...(attempt === 1 ? { minMs: 8000, maxMs: 180000 } : { minMs: 2000, maxMs: 45000 }), ...quiet });
    const snapshot = await page.evaluate(capturePage);
    const reading = await readPage(input, snapshot, attempt);
    if (reading.state === 'not_finished') {
      lastNote = reading.message ?? '';
      console.log('AI 判断回答还没生成完，稍等后再读…');
      await sleep(quiet.retryMs ?? 8000);
      continue;
    }
    if (reading.state === 'robot_check') {
      throw taggedError(`${engine.label} 需要人工验证：请在浏览器窗口里完成“我不是机器人”检查后点击继续。未把这次搜索记为零。`, 'NEEDS_HUMAN_HANDOFF');
    }
    if (reading.state === 'login_required') {
      throw taggedError(`${engine.label} 需要先登录，请在打开的浏览器窗口登录后点击继续。`, 'NEEDS_HUMAN_HANDOFF');
    }
    if (reading.state !== 'answer' && reading.state !== 'no_ai_answer') {
      throw new Error(`没有取得可用回答：${reading.message ?? reading.error ?? '页面状态未知'}`);
    }
    const payload = {
      projectId: input.projectId, batchId: input.batchId, questionId: input.questionId,
      ...(input.optimizationRunId ? { optimizationRunId: input.optimizationRunId } : {}),
      query: input.query, language: input.language, engine: input.engine, captureId: input.captureId,
      recordedAt: new Date().toISOString(), pageUrl: snapshot.pageUrl,
      ...reading.observation,
      raw: { collector: 'ai-page-reader', attempt, reader: reading.reader, resolvedLinks: reading.resolvedLinks ?? [] },
    };
    if (payload.entryType === 'web_answer' && !payload.answerText?.trim()) throw new Error('没有取得完整的可读回答，未提交空结果。');
    // Recoverable local copy first; the app then stores it as immutable evidence.
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(captureFile, JSON.stringify(payload, null, 2), { mode: 0o600, flag: 'wx' });
    return submitBrowserCapture(input, payload);
  }
  throw new Error(`回答一直没有生成完，已停止等待：${lastNote || '页面没有稳定下来。'}`);
}

export async function submitBrowserCapture(input, payload) {
  const directory=path.join(input.root,'data','browser-captures');
  const captureFile=path.join(directory,`${payload.captureId}.json`);
  console.log('回答已采集，正在自动分析并保存…');
  const response=await fetchLocal(`${input.base}/api/geo/browser-observations`,{
    method:'POST',headers:{'Content-Type':'application/json',Origin:input.base},body:JSON.stringify(payload),
    signal:AbortSignal.timeout(300000),
  });
  const saved=await response.json();
  if (!response.ok) throw new Error(`入库未完成：${saved.error ?? response.status}。原文已保存在 ${captureFile}，可直接重试入库，无需重搜。`);
  await fs.writeFile(path.join(directory,`${payload.captureId}.result.json`),JSON.stringify(saved,null,2),{mode:0o600});
  console.log(JSON.stringify({captureId:payload.captureId,status:saved.status,analysis:saved.audit?.analysisStatus,
    model:saved.audit?.analysisModel,reasoning:saved.audit?.reasoningEffort,
    mention:saved.audit?.mention,citation:saved.audit?.citation,
    overview:saved.batch?.overviewMetrics?.[`${payload.language}:${payload.engine}`]},null,2));
  if (saved.audit?.analysisStatus === 'failed') throw taggedError('回答已入库，但模型分析失败；判断保留待核实，可重试分析。', 'REVIEW_PENDING');
  if (saved.status === 'needs_review' || saved.audit?.analysisStatus === 'needs_review') throw taggedError('回答已入库，但审核仍待核实；请核对证据后再结束采集。', 'REVIEW_PENDING');
  return saved;
}

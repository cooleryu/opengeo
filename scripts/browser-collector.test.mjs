import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { collectBrowserQuestion, extractChatGPT, extractGoogle, readChatGPTConditions, waitForChatGPTAnswer } from './browser-collector.mjs';

const query = '哪些工具可以核对编码 Agent 的工作记录？';
const answer = 'SampleProject 可以保存工作记录，供用户逐项核对。';
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = globalThis.fetch;
const temporaryRoots = [];
let dom;

function escapeHTML(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function mount({ state = 'complete', user = query, assistant = answer, extra = '' } = {}) {
  dom = new JSDOM(`<!doctype html><html><body>
    <main>
      <section data-talvt-turn-state="${state}">
        <div data-user-message-bubble>${escapeHTML(user)}</div>
        ${assistant === null ? '' : `<div data-markdown-text-style="assistant-message">${assistant}</div>`}
        ${extra}
      </section>
    </main>
    <button aria-label="复制用户消息">复制</button>
  </body></html>`, { url: 'https://chatgpt.com/c/synthetic-browser-capture' });
  // jsdom has no rendered layout. These shims supply only the DOM APIs used by
  // extraction; they do not simulate completion or classify an answer as valid.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return this.textContent; },
  });
  Object.defineProperty(dom.window.Element.prototype, 'checkVisibility', {
    configurable: true,
    value() { return !this.closest('[hidden]'); },
  });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
}

afterEach(async () => {
  dom?.window.close();
  dom = undefined;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else delete globalThis.document;
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

test('extracts only the completed assistant answer from the new ChatGPT turn DOM', () => {
  mount();
  const result = extractChatGPT({ query });
  assert.equal(result.entryType, 'web_answer');
  assert.equal(result.answerText, answer);
  assert.equal(result.answerComplete, true);
  assert.equal(result.answerText.includes(query), false);
});

test('rejects a failed-render marker even when a plausible partial answer is present', () => {
  mount({ extra: '<div data-dil-render-failed="true"></div>' });
  assert.throws(() => extractChatGPT({ query }));
});

for (const errorText of ['无法加载此回复', '无法加载此回复。请重试。']) {
  test(`rejects the cannot-load-response error text: ${errorText}`, () => {
    mount({ assistant: errorText });
    assert.throws(() => extractChatGPT({ query }));
  });
}

for (const state of ['streaming', 'pending', '']) {
  test(`rejects a turn that is not complete (${state || 'missing state value'}) despite a copy button`, () => {
    mount({ state });
    assert.throws(() => extractChatGPT({ query }));
  });
}

test('rejects an answer whose user question does not match the requested query', () => {
  mount({ user: '如何安装另一个产品？' });
  assert.throws(() => extractChatGPT({ query }));
});

test('never falls back to the user question when the assistant answer is missing', () => {
  mount({ assistant: null });
  assert.throws(() => extractChatGPT({ query }));
});

test('ordinary links in the answer body do not establish native citation evidence', () => {
  mount({ assistant: `${answer} <a href="https://github.com/example/sample-project">项目仓库</a>` });
  const result = extractChatGPT({ query });
  assert.equal(result.answerComplete, true);
  assert.ok(result.answerText.includes(answer));
  assert.notEqual(result.citationSource, 'native');
  assert.equal(result.citationsComplete, false);
});

const nativeSources=[1,2,3].map(index=>({title:`来源 ${index}`,url:`https://research.example/source-${index}`}));
function citationBadge(label,role='button') {
  return `<span data-d-component="popover-trigger" role="${role}"><span data-d-component="badge">${label}</span></span>`;
}
function mountNativeCitations() {
  mount({assistant:`${answer}${citationBadge('Sample+1')}${citationBadge('Sample+2')}${citationBadge('Sample+2')}
    ${citationBadge('普通正文链接','presentation')}<a href="https://body.example/page">正文链接</a>`});
}
function nativeEvidence() {
  return {pageUrl:document.location.href,query,groups:[2,3,3].map((count,markerIndex)=>({
    markerIndex,label:`Sample+${count-1}`,expectedCount:count,sources:nativeSources.slice(0,count),
  }))};
}

test('verified native groups retain provenance, deduplicate across groups, and exclude ordinary body links', () => {
  mountNativeCitations();
  const result=extractChatGPT({query,turnIndex:0,nativeCitationEvidence:nativeEvidence()});
  assert.equal(result.citationSource,'native');
  assert.equal(result.citationsComplete,true);
  assert.deepEqual(result.citations,nativeSources);
  assert.deepEqual(result.sources,[{title:'正文链接',url:'https://body.example/page'}]);
  assert.deepEqual(result.nativeCitationEvidence.groups.map(group=>group.sources.length),[2,3,3]);
  assert.equal(result.nativeCitationEvidence.markers.length,3,'presentation wrappers are not native markers');
});

test('native badges alone cannot establish verified citations', () => {
  mountNativeCitations();
  const result=extractChatGPT({query});
  assert.equal(result.citationSource,'unknown');
  assert.equal(result.citationsComplete,false);
  assert.deepEqual(result.citations,[]);
});

test('missing groups preserve verified sources without claiming a complete citation list', () => {
  mountNativeCitations();
  const evidence=nativeEvidence();
  evidence.groups=evidence.groups.slice(0,1);
  const result=extractChatGPT({query,nativeCitationEvidence:evidence});
  assert.equal(result.citationSource,'native');
  assert.equal(result.citationsComplete,false);
  assert.deepEqual(result.citations,nativeSources.slice(0,2));
});

for (const [name,change] of [
  ['duplicate marker indexes',groups=>{groups[2].markerIndex=1;}],
  ['out-of-order groups',groups=>{[groups[1],groups[2]]=[groups[2],groups[1]];}],
  ['wrong label',groups=>{groups[2].label='Other+2';}],
  ['incorrect expected count',groups=>{groups[2].expectedCount=2;}],
  ['missing source',groups=>{groups[2].sources=groups[2].sources.slice(0,2);}],
  ['duplicated source within a group',groups=>{groups[2].sources=[nativeSources[0],nativeSources[0],nativeSources[2]];}],
]) {
  test(`native citations remain incomplete for ${name}`,()=>{
    mountNativeCitations();
    const evidence=nativeEvidence();
    change(evidence.groups);
    const result=extractChatGPT({query,nativeCitationEvidence:evidence});
    assert.equal(result.citationsComplete,false);
    assert.ok(result.citations.length>0,'independently verified groups remain available');
  });
}

test('unsafe source URLs are omitted from citations, ordinary sources, and retained citation evidence',()=>{
  const unsafe=['javascript:alert(1)','https://name:password@research.example/page',
    'https://research.example/page?access_token=secret','https://research.example/has space','https://chatgpt.com/internal'];
  mount({assistant:`${answer}${citationBadge('Sample+4')}${unsafe.map(url=>`<a href="${url}">unsafe</a>`).join('')}`});
  const evidence={pageUrl:document.location.href,query,groups:[{
    markerIndex:0,label:'Sample+4',expectedCount:5,sources:unsafe.map(url=>({title:'unsafe',url})),
  }]};
  const result=extractChatGPT({query,nativeCitationEvidence:evidence});
  assert.equal(result.citationSource,'unknown');
  assert.equal(result.citationsComplete,false);
  assert.deepEqual(result.citations,[]);
  assert.deepEqual(result.sources,[]);
  assert.deepEqual(result.nativeCitationEvidence.groups[0].sources,[]);
});

for (const [name,change] of [
  ['another page',evidence=>{evidence.pageUrl='https://chatgpt.com/c/other';}],
  ['another question',evidence=>{evidence.query='另一个问题';}],
  ['missing page identity',evidence=>{delete evidence.pageUrl;}],
]) {
  test(`rejects citation evidence for ${name}`,()=>{
    mountNativeCitations();
    const evidence=nativeEvidence();
    change(evidence);
    assert.throws(()=>extractChatGPT({query,nativeCitationEvidence:evidence}),/原生引用证据与当前页面或问题不匹配/);
  });
}

function pageForWait(onPending = () => {}) {
  const waits = [];
  return {
    waits,
    async waitForFunction(predicate, argument, options) {
      waits.push({ readyInitially: Boolean(predicate(argument)), timeout: options.timeout });
      if (waits.at(-1).readyInitially) return;
      onPending(waits.length);
      if (predicate(argument)) return;
      const error = new Error('Simulated DOM wait timeout');
      error.name = 'TimeoutError';
      throw error;
    },
    async evaluate(callback, argument) { return callback(argument); },
  };
}

test('a complete but empty answer immediately leaves generation waiting and bounds render waiting', async () => {
  mount({ assistant: '' });
  const page = pageForWait();
  await assert.rejects(waitForChatGPTAnswer(page, { query }), /回复已完成.*10 秒/);
  assert.equal(page.waits.length, 2);
  assert.equal(page.waits[0].readyInitially, true, 'an empty completed turn must not wait for the generation timeout');
  assert.equal(page.waits[1].readyInitially, false);
  assert.ok(page.waits[1].timeout > 0 && page.waits[1].timeout <= 10000);
});

test('allows the completed answer to render within the brief second wait', async () => {
  mount({ assistant: '' });
  const page = pageForWait(() => {
    document.querySelector('[data-markdown-text-style="assistant-message"]').textContent = answer;
  });
  await waitForChatGPTAnswer(page, { query });
  assert.equal(page.waits.length, 2);
  assert.equal(extractChatGPT({ query }).answerText, answer);
});

test('detects a render failure before generation completion without waiting for text', async () => {
  mount({ state: 'streaming', assistant: '', extra: '<div data-dil-render-failed="true"></div>' });
  const page = pageForWait();
  await assert.rejects(waitForChatGPTAnswer(page, { query }), /未能显示这条回复/);
  assert.deepEqual(page.waits.map(wait => wait.readyInitially), [true]);
});

test('detects a load error appearing during the brief render wait', async () => {
  mount({ assistant: '' });
  const page = pageForWait(() => {
    document.querySelector('[data-markdown-text-style="assistant-message"]').textContent = '无法加载此回复。请重试。';
  });
  await assert.rejects(waitForChatGPTAnswer(page, { query }), /未能显示这条回复/);
  assert.equal(page.waits.length, 2);
});

function appendChatGPTTurn({ user = query, assistant = answer, state = 'complete', extra = '' } = {}) {
  document.querySelector('main').insertAdjacentHTML('beforeend', `<section data-talvt-turn-state="${state}">
    <div data-user-message-bubble>${escapeHTML(user)}</div>
    <div data-markdown-text-style="assistant-message">${assistant}</div>${extra}</section>`);
}

test('waits for the new matching question instead of accepting a previous answer or unrelated failure', async () => {
  mount({ assistant: '同题的旧回答。' });
  appendChatGPTTurn({ user: '其他问题', assistant: '无法加载此回复', extra: '<div data-dil-render-failed></div>' });
  const page = pageForWait(() => appendChatGPTTurn());
  const selected = await waitForChatGPTAnswer(page, { query, turnIndex: 1 });
  assert.equal(page.waits[0].readyInitially, false);
  assert.deepEqual(selected, { query, turnIndex: 1 });
  assert.equal(extractChatGPT(selected).answerText, answer);
});

test('keeps the selected matching turn through rendering and extraction when another turn appears', async () => {
  mount({ assistant: '' });
  const page = pageForWait(() => {
    document.querySelector('[data-markdown-text-style="assistant-message"]').textContent = answer;
    appendChatGPTTurn({ assistant: '后来相同问题的另一个回答。' });
    appendChatGPTTurn({ user: '其他问题', assistant: '无法加载此回复' });
  });
  const selected = await waitForChatGPTAnswer(page, { query });
  assert.deepEqual(selected, { query, turnIndex: 0 });
  assert.equal(extractChatGPT(selected).answerText, answer);
});

test('resume stops immediately when the page has no matching question', async () => {
  mount({ user: '其他问题', assistant: '无法加载此回复' });
  const page = pageForWait();
  await assert.rejects(waitForChatGPTAnswer(page, { query }), /没有与原问题匹配/);
  assert.equal(page.waits.length, 0);
});

test('resume does not infer temporary chat, personalization, or login from answer text or inactive controls', () => {
  mount({ assistant: '<button aria-pressed="true">临时聊天</button><button>不个性化</button><button>登录</button>' });
  document.body.insertAdjacentHTML('beforeend', '<button aria-pressed="false">临时聊天</button><button hidden>不个性化</button>');
  const conditions = readChatGPTConditions({ language: 'zh', resume: true });
  assert.equal(conditions.mode, 'unknown');
  assert.equal(conditions.loginState, 'unknown');
  assert.match(conditions.notes, /发送时条件未核实/);
  assert.match(conditions.notes, /是否不个性化未核实/);
});

test('resume records explicit visible state while keeping the original send conditions unverified', () => {
  mount();
  document.body.insertAdjacentHTML('beforeend', '<button aria-pressed="true">临时聊天</button><button>不个性化</button><button>登录</button>');
  const conditions = readChatGPTConditions({ language: 'zh', resume: true });
  assert.equal(conditions.mode, 'temporary_chat');
  assert.equal(conditions.loginState, 'signed_out');
  assert.match(conditions.notes, /发送时条件未核实/);
  assert.match(conditions.notes, /页面显示不个性化/);
});

test('textarea collection uses the ready composer and retains the page when the saved audit needs review', async () => {
  mount();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opengeo-browser-collector-'));
  temporaryRoots.push(root);
  let sent = 0;
  let submitted;
  const page = {
    ...pageForWait(),
    async goto(url) {
      dom.reconfigure({ url });
      document.body.innerHTML = '<header>临时聊天</header><main></main><button>不个性化</button><textarea placeholder="询问 ChatGPT"></textarea><button aria-label="发送">发送</button>';
    },
    async url() { return document.location.href; },
    async waitForSelector(selector) { assert.ok(document.querySelector(selector), 'the supported textarea must be ready'); },
    async fill(selector, value) {
      const composer = document.querySelector(selector);
      assert.equal(composer?.tagName, 'TEXTAREA', 'fill must use the same supported composer');
      composer.value = value;
    },
    async click(selector) {
      assert.ok(selector.includes('button[aria-label="发送"]'));
      assert.equal(document.querySelector('textarea').value, query);
      sent += 1;
      appendChatGPTTurn();
    },
  };
  globalThis.fetch = async (_url, options) => {
    submitted = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'needs_review', audit: { analysisStatus: 'needs_review' } }), { status: 200 });
  };
  const input = { root, base: 'http://127.0.0.1:4327', projectId: 'synthetic-project', batchId: 'synthetic-batch',
    questionId: 'synthetic-question', captureId: 'synthetic-textarea', query, language: 'zh', engine: 'chatgpt' };
  await assert.rejects(collectBrowserQuestion({ page: () => page }, input), /回答已入库.*审核仍待核实/);
  assert.equal(sent, 1);
  assert.equal(submitted.answerText, answer);
  assert.equal(submitted.conditions.mode, 'temporary_chat');
  assert.equal(submitted.conditions.loginState, 'unknown');
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/browser-captures/synthetic-textarea.result.json'))).status, 'needs_review');
  assert.ok(document.querySelector('[data-markdown-text-style="assistant-message"]'), 'the answer remains available for citation inspection');
});

const googleBody = `${answer} <a href="https://github.com/example/sample-project">查看仓库</a>`;
const googleSources = `侧栏来源说明不能作为答案。
  <a href="https://research.example/source">侧栏来源</a>
  <a href="javascript:void(0)">操作按钮</a>
  <a href="mailto:source@example.test">联系来源</a>`;
function mountGoogle({ aio = true, heading = 'h2', complete = 'true', main = googleBody,
  rhs = googleSources,
  currentQuery = query, progress = '', pageUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}` } = {}) {
  mount();
  dom.reconfigure({ url: pageUrl });
  document.body.innerHTML = `
    <textarea name="q">${escapeHTML(currentQuery)}</textarea>
    ${aio ? `<section data-scope-id="turn" ${complete === null ? '' : `data-complete="${complete}"`}>
      ${heading === 'h2' ? '<h2>AI Overview</h2>' : '<div role="heading">AI Overview</div>'}
      ${main === null ? '' : `<div data-container-id="main-col">${main}</div>`}
      ${rhs === null ? '' : `<aside data-container-id="rhs-col">${rhs}</aside>`}
      ${progress}
    </section>` : progress}
    <div id="search">
      <a href="https://organic.example/result"><h3>普通网页结果</h3></a>
      普通搜索摘要不能混入 AI 回答。
    </div>`;
}

for (const heading of ['h2', 'role']) {
  test(`Google AI Overview extracts only the completed main column (${heading} heading)`, () => {
    mountGoogle({ heading });
    const result = extractGoogle({ query });
    assert.equal(result.entryType, 'web_answer');
    assert.equal(result.answerComplete, true);
    assert.equal(result.answerText, `${answer} 查看仓库`);
    assert.equal(result.citationSource, 'native');
    assert.equal(result.citationsComplete, false);
    assert.deepEqual(result.citations, [{ title: '侧栏来源', url: 'https://research.example/source' }]);
    assert.deepEqual(result.sources.map(source => source.url).sort(), [
      'https://github.com/example/sample-project', 'https://research.example/source',
    ]);
  });
}

test('Google body links remain sources when no native source panel is available', () => {
  mountGoogle({ rhs: null });
  const result = extractGoogle({ query });
  assert.deepEqual(result.sources, [{ title: '查看仓库', url: 'https://github.com/example/sample-project' }]);
  assert.deepEqual(result.citations, []);
  assert.equal(result.citationSource, 'unknown');
  assert.equal(result.citationsComplete, false);
});

test('Google native direct links remain partial while goto URLs retain their unresolved originals', () => {
  const hop = 'https://www.google.com/goto?url=https%3A%2F%2Fgithub.com%2Fexample%2Fsample-project';
  mountGoogle({ main: `${googleBody} <a href="${hop}">正文引用跳转</a>`,
    rhs: `${googleSources}<a href="${hop}">侧栏引用跳转</a>` });
  const result = extractGoogle({ query });
  assert.equal(result.citationSource, 'native');
  assert.equal(result.citationsComplete, false);
  assert.deepEqual(result.citations, [{ title: '侧栏来源', url: 'https://research.example/source' }]);
  assert.ok(result.sources.some(source => source.url === hop));
  assert.equal(result.unresolvedCitations.length, 1);
  assert.equal(result.unresolvedCitations[0].url, hop);
  assert.equal(result.unresolvedCitations[0].resolution, 'unresolved');
  assert.equal(result.unresolvedCitations[0].reason, 'google_redirect');
});

test('Google redirects and other internal links never count as verified final citation URLs', () => {
  const hops = [
    'https://www.google.com/goto?url=https%3A%2F%2Fresearch.example%2Fsource',
    'https://www.google.com/url?q=https%3A%2F%2Fresearch.example%2Fsource',
    'https://www.google.com/search?kgmid=synthetic',
    'https://www.google.co.uk/unknown-link?target=https%3A%2F%2Fresearch.example%2Fsource',
  ];
  mountGoogle({ rhs: hops.map((href, index) => `<a href="${href}">来源 ${index}</a>`).join('') });
  const result = extractGoogle({ query });
  assert.deepEqual(result.citations, []);
  assert.equal(result.citationSource, 'unknown');
  assert.equal(result.citationsComplete, false);
  assert.deepEqual(result.unresolvedCitations.map(source => source.url), hops);
  assert.ok(result.unresolvedCitations.every(source => source.resolution === 'unresolved'));
  assert.equal(result.sources.some(source => source.url === 'https://research.example/source'), false,
    'a URL embedded in Google query parameters is not a verified final destination');
});

test('hidden Google source-panel links do not establish observed native citations', () => {
  mountGoogle({ rhs: '<a hidden href="https://research.example/source">未展示来源</a>' });
  const result = extractGoogle({ query });
  assert.ok(result.sources.some(source => source.url === 'https://research.example/source'));
  assert.deepEqual(result.citations, []);
  assert.equal(result.citationSource, 'unknown');
  assert.equal(result.citationsComplete, false);
});

test('Google rejects a textarea query that differs from the requested question', () => {
  mountGoogle({ currentQuery: '如何安装另一个产品？' });
  assert.throws(() => extractGoogle({ query }));
});

for (const complete of ['false', null]) {
  test(`Google rejects an AI turn without confirmed completion (${complete})`, () => {
    mountGoogle({ complete });
    assert.throws(() => extractGoogle({ query }));
  });
}

test('Google accepts an attribute-less AI turn when visible post-answer footer buttons are present', () => {
  mountGoogle({
    complete: null,
    progress: '<button aria-label="Good response"></button><button aria-label="Copy text"></button>',
  });
  const result = extractGoogle({ query });
  assert.equal(result.entryType, 'web_answer');
  assert.equal(result.answerComplete, true);
  assert.equal(result.answerText, `${answer} 查看仓库`);
});

test('Google rejects an attribute-less AI turn with hidden footer buttons or explicit data-complete=false', () => {
  mountGoogle({
    complete: null,
    progress: '<button hidden aria-label="Good response"></button><button hidden aria-label="Copy text"></button>',
  });
  assert.throws(() => extractGoogle({ query }));
  mountGoogle({
    complete: 'false',
    progress: '<button aria-label="Good response"></button><button aria-label="Copy text"></button>',
  });
  assert.throws(() => extractGoogle({ query }));
});

for (const main of ['', null]) {
  test(`Google refuses missing AI main-column content (${main === null ? 'missing element' : 'empty element'})`, () => {
    mountGoogle({ main });
    assert.throws(() => extractGoogle({ query }), 'RHS and ordinary results must not substitute for missing AI prose');
  });
}

test('Google AI Mode cannot be captured as a default-search AI Overview', () => {
  mountGoogle({ pageUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50` });
  assert.throws(() => extractGoogle({ query }));
});

for (const aio of [true, false]) {
  test(`Google refuses visible Generating progress before saving results (AI heading ${aio})`, () => {
    mountGoogle({ aio, progress: '<div role="progressbar" aria-label="Generating"></div>' });
    assert.throws(() => extractGoogle({ query }));
  });
}

test('hidden Copy and Sharing progress does not block a completed Google AI Overview', () => {
  mountGoogle({ progress: '<div hidden role="progressbar" aria-label="Copy"></div><div hidden role="progressbar" aria-label="Sharing"></div>' });
  const result = extractGoogle({ query });
  assert.equal(result.entryType, 'web_answer');
  assert.equal(result.answerText, `${answer} 查看仓库`);
});

test('Google without AI Overview stays a web search rather than an AI answer', () => {
  mountGoogle({ aio: false });
  const result = extractGoogle({ query });
  assert.equal(result.entryType, 'web_search');
  assert.equal(result.answerComplete, false);
  assert.equal(result.citationsComplete, false);
  assert.notEqual(result.citationSource, 'native');
  assert.deepEqual(result.sources, [{ title: '普通网页结果', url: 'https://organic.example/result' }]);
});

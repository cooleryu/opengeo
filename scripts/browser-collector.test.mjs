import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { capturePage, collectBrowserQuestion, markInputBox } from './browser-collector.mjs';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalFetch = globalThis.fetch;
const temporaryRoots = [];
let dom;
// The collector narrates progress for the person watching; keep test output to test results.
console.log = () => {};

function mount(body, url = 'https://www.google.com/search?q=test') {
  dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, { url });
  // jsdom has no layout: innerText falls back to textContent and [hidden] stands in for invisibility.
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { configurable: true, get() { return this.textContent; } });
  Object.defineProperty(dom.window.Element.prototype, 'checkVisibility', { configurable: true, value() { return !this.closest('[hidden]'); } });
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

test('capturePage copies only the main content, marks links and leaves the page unchanged', () => {
  mount(`
    <nav>My private chat about finances</nav>
    <header>ChatGPT 5.5 <button>Sign in</button></header>
    <main>
      <p>Answer text <a href="https://docs.example.com/a">docs</a> continues.</p>
      <a href="https://example.com/?access_token=secret">leaky</a>
      <div hidden><a href="https://hidden.example.com/">hidden</a></div>
      <a href="javascript:void(0)">script</a>
    </main>`);
  const before = document.querySelector('main').innerHTML;
  const page = capturePage();
  assert.match(page.pageText, /Answer text docs \[L1\] continues\./);
  assert.doesNotMatch(page.pageText, /finances/);
  assert.deepEqual(page.links, [{ n: 1, text: 'docs', url: 'https://docs.example.com/a' }]);
  assert.equal(page.signInVisible, true);
  assert.match(page.headerText, /ChatGPT 5\.5/);
  assert.equal(document.querySelector('main').innerHTML, before);
});

test('markInputBox tags a visible text box and skips hidden ones', () => {
  mount('<main><textarea hidden></textarea><div contenteditable="true">ask</div></main>');
  assert.equal(markInputBox(), true);
  assert.equal(document.querySelectorAll('[data-opengeo-input="1"]').length, 1);
  assert.equal(document.querySelector('[data-opengeo-input="1"]').tagName, 'DIV');
  mount('<main><p>No box here</p></main>');
  assert.equal(markInputBox(), false);
});

function fakePage() {
  const calls = [];
  return {
    calls,
    goto: async (url) => { calls.push(['goto', url]); },
    click: async (selector) => { calls.push(['click', selector]); },
    evaluate: async (fn, arg) => fn(arg),
    keyboard: {
      insertText: async (text) => { calls.push(['type', text]); },
      press: async (key) => { calls.push(['press', key]); },
    },
  };
}

async function setup(readings) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opengeo-collector-'));
  temporaryRoots.push(root);
  const submitted = [];
  const pageReads = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/api/geo/browser-pages')) {
      pageReads.push(body);
      return new Response(JSON.stringify(readings.shift()), { status: 200 });
    }
    submitted.push(body);
    return new Response(JSON.stringify({ status: 'complete', audit: { analysisStatus: 'complete' } }), { status: 200 });
  };
  const input = { base: 'http://127.0.0.1:4327', root, projectId: 'p', batchId: 'b', questionId: 'q',
    query: 'What is SampleProject?', language: 'en', engine: 'google', captureId: 'browser-test', humanPause: false };
  return { root, input, submitted, pageReads };
}
const fast = { quiet: { settleMs: 0, minMs: 0, quietMs: 0, maxMs: 50, pollMs: 1, retryMs: 0 } };
const observation = { entryType: 'web_answer', answerText: 'SampleProject is a local tool.', sources: [], citations: [],
  citationSource: 'unknown', answerComplete: true, citationsComplete: false,
  conditions: { mode: 'ai_overview', region: 'unknown', loginState: 'signed_out', searchMode: 'Google default search page', resultLanguage: 'en', notes: 'n' } };

test('asks like a person, waits for the AI reader to see a finished answer, then submits it', async () => {
  mount('<main><textarea name="q"></textarea><p>SampleProject is a local tool.</p></main>');
  const { input, submitted, pageReads } = await setup([
    { state: 'not_finished', message: 'Still generating', reader: null },
    { state: 'answer', observation, reader: { pageState: 'answer' }, resolvedLinks: [] },
  ]);
  const page = fakePage();
  await collectBrowserQuestion(page, input, fast);
  assert.deepEqual(page.calls.map(call => call[0]), ['goto', 'click', 'type', 'press']);
  assert.equal(page.calls[2][1], input.query);
  assert.deepEqual(pageReads.map(read => read.attempt), [1, 2]);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].answerText, observation.answerText);
  assert.equal(submitted[0].raw.collector, 'ai-page-reader');
  assert.equal(submitted[0].raw.attempt, 2);
});

test('a robot check hands the browser to the person and saves nothing', async () => {
  mount('<main><p>Our systems have detected unusual traffic</p></main>');
  const { input, submitted } = await setup([{ state: 'robot_check', message: 'unusual traffic', reader: null }]);
  await assert.rejects(collectBrowserQuestion(fakePage(), input, fast), error => error.code === 'NEEDS_HUMAN_HANDOFF');
  assert.equal(submitted.length, 0);
});

test('ChatGPT asks the person to sign in before typing anything', async () => {
  mount('<header><button>Log in</button></header><main><div contenteditable="true"></div></main>', 'https://chatgpt.com/');
  const { input, pageReads } = await setup([]);
  const page = fakePage();
  await assert.rejects(collectBrowserQuestion(page, { ...input, engine: 'chatgpt' }, fast), error => error.code === 'NEEDS_HUMAN_HANDOFF');
  assert.deepEqual(page.calls.map(call => call[0]), ['goto']);
  assert.equal(pageReads.length, 0);
});

test('a saved capture is resubmitted without searching again', async () => {
  const { root, input, submitted } = await setup([]);
  const directory = path.join(root, 'data', 'browser-captures');
  await fs.mkdir(directory, { recursive: true });
  const prior = { projectId: 'p', batchId: 'b', questionId: 'q', query: input.query, language: 'en', engine: 'google', captureId: 'browser-test', ...observation };
  await fs.writeFile(path.join(directory, 'browser-test.json'), JSON.stringify(prior));
  const page = fakePage();
  await collectBrowserQuestion(page, input, fast);
  assert.equal(page.calls.length, 0);
  assert.equal(submitted[0].answerText, observation.answerText);
});

test('retries input marking and click when SPA hydration drops the temporary attribute', async () => {
  mount('<main><div contenteditable="true"></div><p>SampleProject is a local tool.</p></main>');
  const { input, submitted } = await setup([
    { state: 'answer', observation, reader: { pageState: 'answer' }, resolvedLinks: [] },
  ]);
  const page = fakePage();
  let clickAttempts = 0;
  page.click = async (selector) => {
    clickAttempts += 1;
    page.calls.push(['click', selector]);
    if (clickAttempts === 1) throw new Error('Selector [data-opengeo-input="1"] matched 0 elements');
  };
  await collectBrowserQuestion(page, input, fast);
  assert.equal(clickAttempts, 2);
  assert.deepEqual(page.calls.map(call => call[0]), ['goto', 'click', 'click', 'type', 'press']);
  assert.equal(submitted.length, 1);
});

test('hands unclickable input pages to the AI page reader instead of failing with a raw click timeout', async () => {
  mount('<main><div contenteditable="true"></div><p>Please verify you are human</p></main>');
  const { input, submitted, pageReads } = await setup([
    { state: 'robot_check', message: 'human verification overlay', reader: null },
  ]);
  const page = fakePage();
  let clickAttempts = 0;
  page.click = async (selector) => {
    clickAttempts += 1;
    page.calls.push(['click', selector]);
    throw new Error('Selector [data-opengeo-input="1"] matched 0 elements');
  };
  await assert.rejects(
    collectBrowserQuestion(page, input, fast),
    error => error.code === 'NEEDS_HUMAN_HANDOFF',
  );
  assert.equal(clickAttempts, 3);
  assert.equal(pageReads.length, 1);
  assert.equal(submitted.length, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanPageText, findSnippet, interpretReading, type PageCapture, type ReaderResult } from './page-reader';

const reader = (overrides: Partial<ReaderResult> = {}): ReaderResult => ({
  pageState: 'answer', answerStart: '', answerEnd: '', sourceLinks: [], model: '', temporaryChat: 'unknown', note: '', ...overrides,
});

const googlePage = (overrides: Partial<PageCapture> = {}): PageCapture => ({
  projectId: 'p', batchId: 'b', questionId: 'q', captureId: 'browser-test', attempt: 1,
  query: 'What is SampleProject?', language: 'en', engine: 'google',
  pageUrl: 'https://www.google.com/search?q=What+is+SampleProject%3F', title: 'Search', headerText: 'Sign in',
  pageText: [
    'AI Overview',
    'SampleProject is a local tool [L1] that checks AI answers.',
    'It runs in your own browser.',
    'Sources: Sample repo [L2] Other guide [L3]',
    'Show more',
    'People also ask',
    'Unrelated organic result [L4]',
  ].join('\n'),
  links: [
    { n: 1, text: 'docs', url: 'https://docs.sample.dev/intro' },
    { n: 2, text: 'Sample repo', url: 'https://www.google.com/goto?url=CAES-token-1' },
    { n: 3, text: 'Other guide', url: 'https://www.google.com/goto?url=CAES-token-2' },
    { n: 4, text: 'Unrelated organic result', url: 'https://organic.example.com/' },
  ],
  signInVisible: true,
  ...overrides,
});

const redirects: Record<string, string> = {
  'https://www.google.com/goto?url=CAES-token-1': 'https://github.com/owner/sample',
  'https://www.google.com/goto?url=CAES-token-2': 'https://www.google.com/search?q=more',
};
const fakeFetch = (async (url: string | URL | Request) => {
  const target = redirects[String(url)];
  return new Response(null, target ? { status: 302, headers: { location: target } } : { status: 200 });
}) as typeof fetch;

test('page marks are removed and their positions kept', () => {
  const { text, marks } = cleanPageText('Alpha [L1] beta.\nGamma [L2]');
  assert.equal(text, 'Alpha beta.\nGamma');
  assert.deepEqual(marks, [{ n: 1, at: 5 }, { n: 2, at: 17 }]);
});

test('snippets match across line breaks, link marks and typographic quotes', () => {
  const text = 'Intro\nIt’s a  local\ntool that checks.';
  const found = findSnippet(text, "It's a local tool [L3] that");
  assert.ok(found);
  assert.equal(text.slice(found.start, found.end), 'It’s a  local\ntool that');
  assert.equal(findSnippet(text, 'not on the page at all'), null);
  assert.equal(findSnippet(text, 'It'), null, 'too short to locate reliably');
});

test('the answer is sliced verbatim and Google redirect links resolve to real pages', async () => {
  const outcome = await interpretReading(googlePage(), reader({
    answerStart: 'SampleProject is a local tool', answerEnd: 'runs in your own browser.', sourceLinks: [2, 3],
  }), fakeFetch);
  assert.equal(outcome.state, 'answer');
  if (outcome.state !== 'answer') return;
  const observation = outcome.observation;
  assert.equal(observation.entryType, 'web_answer');
  assert.equal(observation.answerText, 'SampleProject is a local tool that checks AI answers.\nIt runs in your own browser.');
  // Inline link by position, panel link by the reader; the internal Google search link is dropped.
  assert.deepEqual(observation.sources.map(source => source.url), ['https://docs.sample.dev/intro', 'https://github.com/owner/sample']);
  assert.deepEqual(observation.citations, observation.sources);
  assert.equal(observation.citationSource, 'unknown');
  assert.equal(observation.citationsComplete, false);
  assert.equal(observation.conditions.mode, 'ai_overview');
  assert.equal(observation.conditions.loginState, 'signed_out');
  assert.deepEqual(outcome.resolvedLinks.map(link => link.to).sort(), ['https://github.com/owner/sample', 'https://www.google.com/search?q=more']);
});

test('organic results never become sources unless the reader picks them', async () => {
  const outcome = await interpretReading(googlePage(), reader({
    answerStart: 'SampleProject is a local tool', answerEnd: 'checks AI answers.', sourceLinks: [],
  }), fakeFetch);
  assert.equal(outcome.state, 'answer');
  if (outcome.state === 'answer') assert.deepEqual(outcome.observation.sources.map(source => source.url), ['https://docs.sample.dev/intro']);
});

test('answer text the reader invents is refused instead of saved', async () => {
  const outcome = await interpretReading(googlePage(), reader({
    answerStart: 'SampleProject is the best tool ever made', answerEnd: 'runs in your own browser.',
  }), fakeFetch);
  assert.equal(outcome.state, 'error');
});

test('robot checks, sign-in walls and unfinished pages are reported without an observation', async () => {
  for (const pageState of ['robot_check', 'login_required', 'not_finished'] as const) {
    const outcome = await interpretReading(googlePage(), reader({ pageState }), fakeFetch);
    assert.equal(outcome.state, pageState);
    assert.ok(!('observation' in outcome));
  }
});

test('a Google page without an AI Overview is kept as ordinary results', async () => {
  const outcome = await interpretReading(googlePage(), reader({ pageState: 'no_ai_answer' }), fakeFetch);
  assert.equal(outcome.state, 'no_ai_answer');
  if (outcome.state !== 'no_ai_answer') return;
  assert.equal(outcome.observation.entryType, 'web_search');
  assert.equal(outcome.observation.answerComplete, false);
  assert.ok(outcome.observation.sources.every(source => !source.url.includes('google.com')));
});

test('ChatGPT records the visible model, temporary chat and sign-in state', async () => {
  const page = googlePage({
    engine: 'chatgpt', pageUrl: 'https://chatgpt.com/?temporary-chat=true', headerText: 'ChatGPT 5.5 Temporary Chat',
    pageText: 'What is SampleProject?\nSampleProject is a local tool [L1] that checks AI answers.', signInVisible: false,
    links: [{ n: 1, text: 'docs', url: 'https://docs.sample.dev/intro?utm_source=chatgpt.com' }],
  });
  const outcome = await interpretReading(page, reader({
    answerStart: 'SampleProject is a local tool', answerEnd: 'that checks AI answers.', model: 'ChatGPT 5.5', temporaryChat: 'yes',
  }), fakeFetch);
  assert.equal(outcome.state, 'answer');
  if (outcome.state !== 'answer') return;
  assert.equal(outcome.observation.conditions.mode, 'temporary_chat');
  assert.equal(outcome.observation.conditions.model, 'ChatGPT 5.5');
  assert.equal(outcome.observation.conditions.loginState, 'signed_in');
  assert.equal(outcome.observation.answerText, 'SampleProject is a local tool that checks AI answers.');
  assert.deepEqual(outcome.observation.sources.map(source => source.url), ['https://docs.sample.dev/intro?utm_source=chatgpt.com']);
});

test('ChatGPT cannot report a Google-only "no AI answer" state', async () => {
  const outcome = await interpretReading(googlePage({ engine: 'chatgpt' }), reader({ pageState: 'no_ai_answer' }), fakeFetch);
  assert.equal(outcome.state, 'error');
});

test('an ending quoted without its closing bracket still keeps it', async () => {
  const page = googlePage({ pageText: 'AI Overview\nTell me your goal (setting up checks, or comparing tools)\nSponsored' });
  const outcome = await interpretReading(page, reader({ answerStart: 'Tell me your goal', answerEnd: 'or comparing tools' }), fakeFetch);
  assert.equal(outcome.state, 'answer');
  if (outcome.state === 'answer') assert.equal(outcome.observation.answerText, 'Tell me your goal (setting up checks, or comparing tools)');
});

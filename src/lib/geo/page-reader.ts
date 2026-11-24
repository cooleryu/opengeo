import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel from './chatgpt-model';
import { requireGeoModelConnection, shouldUseChatGPTSubscription, type GeoStructuredModel } from './connection-settings';
import { singleRequestModel } from './connection-test';
import { withFailureReason } from './model-failure';
import { evidenceLocation, withGeoProject } from './projects';
import { getResearchBatch } from './research-store';

/**
 * The browser only opens the page, asks, waits and copies what it sees.
 * The AI page reader decides what the page shows and where the answer is;
 * the answer text itself is always sliced verbatim from the captured page.
 */
export class PageReadingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const secretKey = /^(?:authorization|cookie|set-cookie|password|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret)$/i;
function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/\s/.test(value) &&
      ![...url.searchParams.keys()].some(key => secretKey.test(key)) ? url : null;
  } catch { return null; }
}
const httpUrl = z.string().max(16000).refine(value => Boolean(webUrl(value)), 'Needs a web address without credentials.');

export const pageCaptureSchema = z.object({
  projectId: z.string().min(1).max(200),
  batchId: z.string().min(1).max(400),
  questionId: z.string().min(1).max(200),
  captureId: identifier,
  attempt: z.number().int().min(1).max(20),
  query: z.string().min(1).max(16000),
  language: z.enum(['zh', 'en']),
  engine: z.enum(['chatgpt', 'google']),
  pageUrl: httpUrl,
  title: z.string().max(1000),
  headerText: z.string().max(2000),
  pageText: z.string().max(400000),
  links: z.array(z.object({ n: z.number().int().positive(), text: z.string().max(1000), url: httpUrl }).strict()).max(500),
  signInVisible: z.boolean(),
}).strict();
export type PageCapture = z.infer<typeof pageCaptureSchema>;

export const readerResultSchema = z.object({
  pageState: z.enum(['answer', 'no_ai_answer', 'not_finished', 'robot_check', 'login_required', 'error']),
  answerStart: z.string().max(600),
  answerEnd: z.string().max(600),
  sourceLinks: z.array(z.number().int().positive()).max(80),
  model: z.string().max(120),
  temporaryChat: z.enum(['yes', 'no', 'unknown']),
  note: z.string().max(800),
}).strict();
export type ReaderResult = z.infer<typeof readerResultSchema>;

// Providers sometimes send null for "nothing here"; read it as empty rather than failing the page.
export function normalizeReaderReply(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const reply = { ...(raw as Record<string, unknown>) };
  for (const key of ['answerStart', 'answerEnd', 'model', 'note']) if (reply[key] === null) reply[key] = '';
  if (reply.sourceLinks === null) reply.sourceLinks = [];
  if (reply.temporaryChat === null) reply.temporaryChat = 'unknown';
  return reply;
}

const parameterSchema = z.object({
  inputLimitBytes: z.number().int().positive(),
  apiTimeoutMs: z.number().int().positive(),
  subscriptionTimeoutMs: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
}).strict();

type Link = { title: string; url: string };
export type ObservationFields = {
  entryType: 'web_answer' | 'web_search';
  answerText: string;
  sources: Link[];
  citations?: Link[];
  citationSource: 'unknown' | 'none';
  answerComplete: boolean;
  citationsComplete: boolean;
  conditions: { mode: string; region: string; loginState: 'signed_in' | 'signed_out'; model?: string;
    searchMode: string; resultLanguage: string; notes: string };
};
export type ReadingOutcome =
  | { state: 'answer' | 'no_ai_answer'; observation: ObservationFields; reader: ReaderResult; resolvedLinks: Array<{ from: string; to: string }> }
  | { state: 'not_finished' | 'robot_check' | 'login_required' | 'error'; message: string; reader: ReaderResult | null };

// The engine's own search host. Its links are redirects or internal pages, never a cited source;
// sub-sites such as developers.google.com stay ordinary sources.
const ENGINE_HOST: Record<PageCapture['engine'], RegExp> = {
  chatgpt: /^(?:www\.)?chatgpt\.com$/i,
  google: /^(?:www\.)?google\.(?:com|[a-z]{2,3}|com?\.[a-z]{2})$/i,
};
const SEARCH_MODE: Record<PageCapture['engine'], string> = { chatgpt: 'ChatGPT web answer', google: 'Google default search page' };

const MARK = /[ \t]?\[L(\d+)\]/g;
const A11Y_MARKER = /[ \t]*\[Highlight (?:start|end)\][ \t]*/gi;
const TOKEN_OR_NOISE = /[ \t]?\[L(\d+)\]|[ \t]*\[Highlight (?:start|end)\][ \t]*/gi;

/** Remove link marks (remembering their positions) and Google AI Overview a11y highlight markers. */
export function cleanPageText(pageText: string): { text: string; marks: Array<{ n: number; at: number }> } {
  const marks: Array<{ n: number; at: number }> = [];
  let text = '';
  let last = 0;
  for (const match of pageText.matchAll(TOKEN_OR_NOISE)) {
    text += pageText.slice(last, match.index);
    if (match[1] !== undefined) {
      marks.push({ n: Number(match[1]), at: text.length });
    } else {
      const prev = text[text.length - 1] ?? '';
      const next = pageText[match.index! + match[0].length] ?? '';
      if (prev && next && !/\s/.test(prev) && !/\s/.test(next)) text += ' ';
    }
    last = match.index! + match[0].length;
  }
  text += pageText.slice(last);
  return { text, marks };
}

const fold = (value: string) =>
  value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-');

/** Find a quoted snippet in the page while tolerating whitespace, link marks, a11y highlight markers and typographic quotes. */
export function findSnippet(text: string, snippet: string, from = 0): { start: number; end: number } | null {
  const tokens = fold(snippet.replace(MARK, ' ').replace(A11Y_MARKER, ' ')).split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.join(' ').length < 6) return null;
  const pattern = new RegExp(tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gu');
  pattern.lastIndex = from;
  const match = pattern.exec(fold(text));
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

async function resolveEngineLink(url: string, engine: PageCapture['engine'], fetcher: typeof fetch): Promise<string> {
  let current = url;
  for (let hop = 0; hop < 3; hop += 1) {
    const parsed = webUrl(current);
    if (!parsed || !ENGINE_HOST[engine].test(parsed.hostname)) return current;
    try {
      const response = await fetcher(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000) });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return current;
      current = new URL(location, current).href;
    } catch { return current; }
  }
  return current;
}

function uniqueLinks(items: Link[]): Link[] {
  return [...new Map(items.map(item => [item.url, item])).values()];
}

/** Turn the reader's judgment into an observation. Pure apart from following engine redirect links. */
export async function interpretReading(page: PageCapture, reader: ReaderResult, fetcher: typeof fetch = fetch): Promise<ReadingOutcome> {
  const fail = (state: 'not_finished' | 'robot_check' | 'login_required' | 'error', message: string): ReadingOutcome =>
    ({ state, message, reader });
  if (reader.pageState === 'not_finished') return fail('not_finished', reader.note || 'The answer is still loading.');
  if (reader.pageState === 'robot_check') return fail('robot_check', reader.note || 'The page asks to confirm you are not a robot.');
  if (reader.pageState === 'login_required') return fail('login_required', reader.note || 'The page asks you to sign in.');
  if (reader.pageState === 'error') return fail('error', reader.note || 'The page does not show an answer to this question.');
  if (reader.pageState === 'no_ai_answer' && page.engine !== 'google') return fail('error', 'ChatGPT showed no answer to this question.');

  const { text, marks } = cleanPageText(page.pageText);
  const byNumber = new Map(page.links.map(link => [link.n, link]));
  const loginState = page.signInVisible ? 'signed_out' as const : 'signed_in' as const;
  const engineHost = ENGINE_HOST[page.engine];
  const baseConditions = { region: 'unknown', loginState, searchMode: SEARCH_MODE[page.engine], resultLanguage: page.language };

  if (reader.pageState === 'no_ai_answer') {
    const sources = uniqueLinks(page.links.filter(link => !engineHost.test(new URL(link.url).hostname))
      .map(link => ({ title: link.text || new URL(link.url).hostname, url: link.url }))).slice(0, 50);
    return { state: 'no_ai_answer', reader, resolvedLinks: [], observation: {
      entryType: 'web_search', answerText: text.trim().slice(0, 200000), sources, citationSource: 'none',
      answerComplete: false, citationsComplete: false,
      conditions: { ...baseConditions, mode: 'web_search',
        notes: 'No AI Overview on this search page; saved as ordinary results and not counted in AI mention rates.' } } };
  }

  const start = findSnippet(text, reader.answerStart);
  const end = start ? findSnippet(text, reader.answerEnd, start.start) : null;
  if (!start || !end || end.end <= start.start) {
    return fail('error', 'The AI page reader pointed at answer text that is not on the page.');
  }
  // A quoted ending often stops just before closing brackets or quotes; keep them with the answer.
  let answerEnd = end.end;
  while (answerEnd < text.length && /[)\]}"'”’».!?:;]/u.test(text[answerEnd])) answerEnd += 1;
  const answerText = text.slice(start.start, answerEnd).trim();
  // Links inside the answer are known from their position; cards and panels come from the reader.
  const inside = marks.filter(mark => mark.at >= start.start && mark.at <= answerEnd).map(mark => mark.n);
  const chosen = [...new Set([...inside, ...reader.sourceLinks])].map(n => byNumber.get(n)).filter(Boolean) as PageCapture['links'];
  const resolvedLinks: Array<{ from: string; to: string }> = [];
  const resolved = await Promise.all(chosen.map(async link => {
    const to = await resolveEngineLink(link.url, page.engine, fetcher);
    if (to !== link.url) resolvedLinks.push({ from: link.url, to });
    return { title: link.text || new URL(to).hostname, url: to };
  }));
  const sources = uniqueLinks(resolved.filter(link => {
    const parsed = webUrl(link.url);
    return parsed && !engineHost.test(parsed.hostname);
  })).slice(0, 60);
  const model = reader.model.trim();
  return { state: 'answer', reader, resolvedLinks, observation: {
    entryType: 'web_answer', answerText, sources, citations: sources, citationSource: 'unknown',
    answerComplete: true, citationsComplete: false,
    conditions: page.engine === 'chatgpt'
      ? { ...baseConditions, mode: reader.temporaryChat === 'yes' ? 'temporary_chat' : 'unknown', model: model || 'Not shown',
        notes: `AI page reader located the answer; text copied verbatim from the page. Temporary chat: ${reader.temporaryChat}.` }
      : { ...baseConditions, mode: 'ai_overview',
        notes: 'AI page reader located the AI Overview; text copied verbatim from the page. Source links followed to their real addresses.' },
  } };
}

async function askReader(page: PageCapture, injected?: GeoStructuredModel): Promise<ReaderResult> {
  const parameters = readAgentParameters('page-reading', parameterSchema);
  const links = page.links.map(link => {
    const url = new URL(link.url);
    return { n: link.n, text: link.text.slice(0, 200), site: url.hostname, path: url.pathname.slice(0, 80) };
  });
  const build = (pageText: string) => [
    { role: 'system' as const, content: readAgentText('page-reading') },
    { role: 'user' as const, content: JSON.stringify({ engine: page.engine, question: page.query, pageUrl: page.pageUrl,
      title: page.title, headerText: page.headerText, pageText, links }) },
  ];
  let messages = build(page.pageText);
  const overflow = Buffer.byteLength(JSON.stringify(messages), 'utf8') - parameters.inputLimitBytes;
  // Answers sit near the top of both pages; trim the tail rather than refuse to read.
  if (overflow > 0) messages = build(page.pageText.slice(0, Math.max(0, page.pageText.length - overflow - 1000)));
  const controller = new AbortController();
  let model = injected;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!model) {
    const subscription = shouldUseChatGPTSubscription(getChatGPTStatus());
    const timeoutMs = subscription ? parameters.subscriptionTimeoutMs : parameters.apiTimeoutMs;
    model = subscription
      ? new ChatGPTModel({ signal: controller.signal, timeoutMs })
      : singleRequestModel(requireGeoModelConnection(), fetch, controller.signal);
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  try {
    const raw = await model.generateObject({ schema: readerResultSchema, messages, prepare: normalizeReaderReply,
      options: { temperature: parameters.temperature, maxTokens: parameters.maxTokens } });
    const parsed = readerResultSchema.safeParse(normalizeReaderReply(raw));
    if (!parsed.success) throw new PageReadingError('The AI page reader returned an unusable result.', 502);
    return parsed.data;
  } catch (error) {
    if (error instanceof PageReadingError) throw error;
    // Provider errors may carry credentials or request details; report only the outcome.
    throw new PageReadingError(controller.signal.aborted ? 'The AI page reader timed out.'
      : withFailureReason('The AI page reader failed.', error), 502);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read one captured page. Saves what was read next to the capture's evidence; never creates an observation. */
export async function readSearchPage(value: unknown, options: { model?: GeoStructuredModel; fetcher?: typeof fetch } = {}): Promise<ReadingOutcome> {
  const parsed = pageCaptureSchema.safeParse(value);
  if (!parsed.success) throw new PageReadingError(`Invalid page capture: ${parsed.error.issues[0]?.path.join('.') || 'request'}.`);
  const page = parsed.data;
  return withGeoProject(page.projectId, async () => {
    const batch = getResearchBatch(page.projectId, page.batchId);
    const question = batch?.questions.find(item => item.id === page.questionId && item.decision === 'search_now');
    if (!batch || !question || question[page.language] !== page.query) {
      throw new PageReadingError('The page must belong to a confirmed question of this project.', 409);
    }
    const reader = await askReader(page, options.model);
    const outcome = await interpretReading(page, reader, options.fetcher);
    const directory = path.dirname(evidenceLocation(`data/geo-evidence/browser-${page.captureId}/capture.json`).target);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `page-${page.attempt}-${Date.now()}.json`),
      JSON.stringify({ version: 1, storedAt: new Date().toISOString(), page, outcome }, null, 2), { flag: 'wx', mode: 0o600 });
    return outcome;
  });
}

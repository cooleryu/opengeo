import { PublicSourceError, readPublicSource, type PublicSourceRuntime } from '../project-public-source';
import { readThreadsWithBrowser } from './action-board-browser-fetch';
import type { ThreadFetchReason, ThreadSource } from './action-board-catalog';

/**
 * Reads the real thread behind a cited community URL so replies are grounded in what the poster
 * and top commenters actually said. One plain request with a tight timeout; no login, no
 * CAPTCHA handling. When the site refuses, the card says so and the reply uses the title only.
 */

const TIMEOUT_MS = 6_000;
const MAX_BODY = 900;

const REDDIT_RE = /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)/i;

export function communityLabel(url: string): { platform: string; community: string } {
  const reddit = url.match(REDDIT_RE);
  if (reddit) return { platform: 'Reddit', community: `r/${reddit[1]}` };
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = url;
  }
  const platform = /quora\.com$/.test(host)
    ? 'Quora'
    : /news\.ycombinator\.com$/.test(host)
      ? 'Hacker News'
      : /stackoverflow\.com$/.test(host)
        ? 'Stack Overflow'
        : host;
  return { platform, community: host };
}

function clip(text: string, max = MAX_BODY): string {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function reasonOf(error: unknown): ThreadFetchReason {
  if (error instanceof PublicSourceError) {
    const reason = String(error.params?.reason ?? '');
    if (reason === 'timeout') return 'timeout';
    if (reason === 'not_found') return 'not_found';
    if (reason === 'login_or_blocked' || reason === 'http_status') return 'blocked';
  }
  return 'error';
}

interface RedditListing {
  data?: { children?: Array<{ kind?: string; data?: Record<string, unknown> }> };
}

export function parseRedditThread(json: unknown, fetchedAt: string): ThreadSource {
  const listings = Array.isArray(json) ? (json as RedditListing[]) : [];
  const post = listings[0]?.data?.children?.[0]?.data ?? {};
  const replies = (listings[1]?.data?.children ?? [])
    .filter((c) => c.kind === 't1' && typeof c.data?.body === 'string')
    .map((c) => ({
      author: String(c.data?.author ?? ''),
      body: clip(String(c.data?.body ?? ''), 500),
      score: Number(c.data?.score ?? 0),
    }))
    .filter((r) => r.body && r.body !== '[deleted]' && r.body !== '[removed]')
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return {
    status: 'fetched',
    fetchedAt,
    op: {
      author: String(post.author ?? ''),
      body: clip(String(post.selftext ?? '')),
      score: Number(post.score ?? 0),
    },
    replies,
    commentCount: Number(post.num_comments ?? replies.length),
    locked: Boolean(post.locked || post.archived),
  };
}

export function parseMetaDescription(html: string): string {
  const match =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match ? clip(decodeEntities(match[1]), 600) : '';
}

export async function fetchThreadSource(url: string, runtime?: PublicSourceRuntime): Promise<ThreadSource> {
  const fetchedAt = new Date().toISOString();
  const reddit = url.match(REDDIT_RE);
  try {
    if (reddit) {
      const jsonUrl = `https://www.reddit.com/r/${reddit[1]}/comments/${reddit[2]}.json?limit=8&depth=1&sort=top&raw_json=1`;
      const source = await readPublicSource(
        jsonUrl,
        { maxBytes: 900_000, timeoutMs: TIMEOUT_MS, maxRedirects: 2, accept: 'application/json' },
        runtime,
      );
      return parseRedditThread(JSON.parse(source.text), fetchedAt);
    }
    const source = await readPublicSource(
      url,
      { maxBytes: 1_500_000, timeoutMs: TIMEOUT_MS, maxRedirects: 2, accept: 'text/html' },
      runtime,
    );
    const description = parseMetaDescription(source.text);
    if (!description) return { status: 'title_only', reason: 'unsupported', fetchedAt };
    return { status: 'fetched', fetchedAt, op: { body: description } };
  } catch (error) {
    return { status: 'title_only', reason: reasonOf(error), fetchedAt };
  }
}

/**
 * Batch thread reader: fast HTTP first, then one shared headless browser pass for any
 * threads that returned `title_only` (e.g., Reddit/Quora rejecting bare HTTP clients).
 */
export async function fetchThreadSources(
  urls: string[],
  options: { allowBrowser?: boolean; runtime?: PublicSourceRuntime } = {},
): Promise<Array<{ source: ThreadSource; resolvedTitle?: string }>> {
  const initial = await Promise.all(urls.map((url) => fetchThreadSource(url, options.runtime)));
  if (options.allowBrowser === false || options.runtime) {
    return initial.map((source) => ({ source }));
  }
  const blockedUrls = urls.filter((_, i) => initial[i].status !== 'fetched');
  if (!blockedUrls.length) return initial.map((source) => ({ source }));
  const browserMap = await readThreadsWithBrowser(blockedUrls);
  const fetchedAt = new Date().toISOString();
  return urls.map((url, i) => {
    if (initial[i].status === 'fetched') return { source: initial[i] };
    const hit = browserMap.get(url);
    if (hit?.ok) {
      return {
        resolvedTitle: hit.title,
        source: {
          status: 'fetched',
          fetchedAt,
          ...(hit.opBody ? { op: { author: hit.opAuthor, body: clip(hit.opBody) } } : {}),
          ...(hit.replies?.length ? { replies: hit.replies } : {}),
          ...(typeof hit.commentCount === 'number' ? { commentCount: hit.commentCount } : {}),
          ...(hit.locked ? { locked: true } : {}),
        },
      };
    }
    return {
      source: {
        status: 'title_only',
        reason: hit?.reason ?? initial[i].reason ?? 'blocked',
        fetchedAt,
      },
    };
  });
}

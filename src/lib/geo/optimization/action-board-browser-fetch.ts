import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { isPublicProjectAddress, normalizeProjectEntryUrl } from '../project-onboarding-store';
import { lookupPublicProjectHost } from '../project-public-network';
import { readPublicSource } from '../project-public-source';

/**
 * Safe local browser reader for external pages (competitor sites, JS-rendered roundups,
 * and community threads that reject bare HTTP requests).
 *
 * Strictly public hosts only (DNS-validated), blocks heavy assets, short timeout, and
 * NEVER attempts to solve or bypass CAPTCHAs / login walls — when gated, reports `blocked`.
 */

export interface RenderedPageSnapshot {
  ok: boolean;
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  headings: string[];
  bodyText: string;
  contactHints: string[];
  reason?: 'blocked' | 'timeout' | 'private_address' | 'not_found' | 'error';
}

const BOT_WALL_RE =
  /\b(?:verify you are human|prove your humanity|complete the challenge|just a moment|attention required|checking your browser|enable javascript and cookies|access denied|whoa there, pardner|you've been blocked|log in to continue|sign in to continue|complete the captcha|please prove you are human|blocked by network security)\b/i;

const PERSISTENT_PROFILE_DIR = () => path.resolve(process.cwd(), 'data', 'browser-profile');

const CACHE_TTL_MS = 30 * 60_000;
const pageCache = new Map<string, { at: number; value: RenderedPageSnapshot }>();

async function assertPublicHttpUrl(rawUrl: string): Promise<URL | null> {
  try {
    const normalized = normalizeProjectEntryUrl(rawUrl);
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupPublicProjectHost(host);
    if (!addrs.length || addrs.some((a) => !isPublicProjectAddress(a.address))) return null;
    return parsed;
  } catch {
    return null;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export function extractHtmlSnapshot(html: string, url: string): RenderedPageSnapshot {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  const title = decodeHtmlEntities((titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const description = decodeHtmlEntities((descMatch?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const headingMatches = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => decodeHtmlEntities(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()))
    .filter((h) => h.length >= 3 && h.length <= 120)
    .slice(0, 12);
  const stripped = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<(?:nav|footer|aside)[^>]*>[\s\S]*?<\/(?:nav|footer|aside)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  const mailtos = [...html.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)]
    .map((m) => m[1].toLowerCase());
  const contactLinks = [...html.matchAll(/href=["']([^"']*\/(?:contact|about|editorial|advertise|submit|write-for-us)[^"']*)["']/gi)]
    .map((m) => {
      try {
        return new URL(m[1], url).href;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  const contactHints = [...new Set([...mailtos, ...contactLinks])].slice(0, 4);
  if (BOT_WALL_RE.test(`${title} ${stripped.slice(0, 600)}`)) {
    return { ok: false, url, finalUrl: url, title, description: '', headings: [], bodyText: '', contactHints: [], reason: 'blocked' };
  }
  return {
    ok: stripped.length >= 160 || description.length >= 40,
    url,
    finalUrl: url,
    title,
    description,
    headings: headingMatches,
    bodyText: stripped.slice(0, 3200),
    contactHints,
  };
}

export async function launchHeadlessChromium() {
  const pw = await import('playwright');
  for (const opts of [{ headless: true }, { headless: true, channel: 'chrome' as const }, { headless: true, channel: 'msedge' as const }]) {
    try {
      return await pw.chromium.launch(opts);
    } catch {
      // Try next installed Chromium channel.
    }
  }
  return null;
}

async function readPageInBrowser(
  browser: Awaited<ReturnType<typeof launchHeadlessChromium>>,
  rawUrl: string,
  timeoutMs = 11_000,
): Promise<RenderedPageSnapshot> {
  const safeUrl = await assertPublicHttpUrl(rawUrl);
  if (!safeUrl) {
    return { ok: false, url: rawUrl, finalUrl: rawUrl, title: '', description: '', headings: [], bodyText: '', contactHints: [], reason: 'private_address' };
  }
  if (!browser) {
    return { ok: false, url: rawUrl, finalUrl: rawUrl, title: '', description: '', headings: [], bodyText: '', contactHints: [], reason: 'error' };
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font' || type === 'stylesheet') return route.abort();
      return route.continue();
    });
    const response = await page.goto(safeUrl.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = response?.status() ?? 0;
    if (status === 404) {
      return { ok: false, url: rawUrl, finalUrl: page.url(), title: '', description: '', headings: [], bodyText: '', contactHints: [], reason: 'not_found' };
    }
    if (status === 401 || status === 403 || status === 429) {
      return { ok: false, url: rawUrl, finalUrl: page.url(), title: '', description: '', headings: [], bodyText: '', contactHints: [], reason: 'blocked' };
    }
    await page.waitForTimeout(900);
    const data = await page.evaluate(() => {
      const title = (document.title || '').replace(/\s+/g, ' ').trim();
      const desc =
        document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
        document.querySelector('meta[name="description"]')?.getAttribute('content') ||
        '';
      const headings = [...document.querySelectorAll('h1, h2, h3')]
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((h) => h.length >= 3 && h.length <= 120)
        .slice(0, 12);
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      const bodyText = ((main as HTMLElement)?.innerText || document.body?.innerText || '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
      const links = [...document.querySelectorAll('a[href]')]
        .map((a) => a.getAttribute('href') || '')
        .filter((href) => /^mailto:/i.test(href) || /\/(?:contact|about|editorial|write-for-us|pricing)\b/i.test(href))
        .slice(0, 8);
      return { title, desc: desc.trim(), headings, bodyText: bodyText.slice(0, 3600), links };
    });
    const finalUrl = page.url() || safeUrl.href;
    const contactHints = [
      ...new Set(
        data.links
          .filter((href) => /^mailto:/i.test(href) || /\/(?:contact|about|editorial|write-for-us)\b/i.test(href))
          .map((href) => {
            if (/^mailto:/i.test(href)) return href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
            try {
              return new URL(href, finalUrl).href;
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      ),
    ].slice(0, 4);
    if (BOT_WALL_RE.test(`${data.title} ${data.bodyText.slice(0, 600)}`)) {
      return { ok: false, url: rawUrl, finalUrl, title: data.title, description: '', headings: [], bodyText: '', contactHints: [], reason: 'blocked' };
    }
    const ok = data.bodyText.length >= 120 || data.desc.length >= 40;
    return {
      ok,
      url: rawUrl,
      finalUrl,
      title: data.title,
      description: data.desc,
      headings: data.headings,
      bodyText: data.bodyText,
      contactHints,
      ...(ok ? {} : { reason: 'error' as const }),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    const reason = /timeout/i.test(msg) ? 'timeout' : 'error';
    return { ok: false, url: rawUrl, finalUrl: rawUrl, title: '', description: '', headings: [], bodyText: '', contactHints: [], reason };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Reads a batch of external public URLs: fast HTTP first, local Chromium browser fallback
 * when a site is JS-rendered or returns a bare-HTTP 403. Reuses one browser across the batch.
 */
export async function fetchExternalPages(
  urls: string[],
  options: { timeoutMs?: number; skipBrowser?: boolean } = {},
): Promise<Map<string, RenderedPageSnapshot>> {
  const unique = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  const results = new Map<string, RenderedPageSnapshot>();
  const needBrowser: string[] = [];
  const now = Date.now();

  await Promise.all(
    unique.map(async (url) => {
      const cached = pageCache.get(url);
      if (cached && now - cached.at < CACHE_TTL_MS) {
        results.set(url, cached.value);
        return;
      }
      try {
        const res = await readPublicSource(url, { maxBytes: 1_200_000, timeoutMs: 5_500, maxRedirects: 3, accept: 'text/html' });
        const snap = extractHtmlSnapshot(res.text, res.url);
        if (snap.ok && snap.bodyText.length >= 350) {
          pageCache.set(url, { at: now, value: snap });
          results.set(url, snap);
          return;
        }
      } catch {
        // Fall through to browser reader.
      }
      needBrowser.push(url);
    }),
  );

  if (needBrowser.length && !options.skipBrowser) {
    const browser = await launchHeadlessChromium();
    try {
      for (const url of needBrowser) {
        const snap = await readPageInBrowser(browser, url, options.timeoutMs ?? 11_000);
        pageCache.set(url, { at: Date.now(), value: snap });
        results.set(url, snap);
      }
    } finally {
      await browser?.close().catch(() => {});
    }
  } else {
    for (const url of needBrowser) {
      results.set(url, {
        ok: false,
        url,
        finalUrl: url,
        title: '',
        description: '',
        headings: [],
        bodyText: '',
        contactHints: [],
        reason: 'blocked',
      });
    }
  }
  return results;
}

export interface BrowserThreadExtract {
  ok: boolean;
  title?: string;
  opAuthor?: string;
  opBody?: string;
  replies?: Array<{ author?: string; body: string; score?: number }>;
  commentCount?: number;
  locked?: boolean;
  reason?: 'blocked' | 'timeout' | 'not_found' | 'error';
}

const REDDIT_COMMENT_RE = /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)/i;

async function extractThreadFromPage(page: import('playwright').Page, isReddit: boolean) {
  return page.evaluate((redditMode: boolean) => {
    const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);
    const bodyAll = (document.body?.innerText || '').slice(0, 1400);
    if (redditMode) {
      const shredditPost = document.querySelector('shreddit-post');
      const title = clean(
        shredditPost?.getAttribute('post-title') ||
          document.querySelector('h1, a.title')?.textContent ||
          document.title ||
          '',
        220,
      );
      const opAuthor = clean(
        shredditPost?.getAttribute('author') ||
          document.querySelector('.thing.link .author')?.textContent ||
          '',
        60,
      );
      const opBody = clean(
        document.querySelector('[slot="text-body"], [data-test-id="post-content"], .thing.link .expando .usertext-body')
          ?.textContent || '',
        900,
      );
      const replies: Array<{ author?: string; body: string; score?: number }> = [];
      const modernComments = [...document.querySelectorAll('shreddit-comment')].slice(0, 6);
      if (modernComments.length) {
        for (const node of modernComments) {
          const txt = clean(node.querySelector('[slot="comment"], p')?.textContent || '', 500);
          if (!txt || txt === '[deleted]' || txt === '[removed]') continue;
          const author = clean(node.getAttribute('author') || '', 60);
          const score = Number.parseInt(node.getAttribute('score') || '', 10);
          replies.push({ author: author || undefined, body: txt, score: Number.isFinite(score) ? score : undefined });
          if (replies.length >= 3) break;
        }
      } else {
        for (const entry of [...document.querySelectorAll('.commentarea .thing.comment > .entry')].slice(0, 6)) {
          const txt = clean(entry.querySelector('.usertext-body')?.textContent || '', 500);
          if (!txt || txt === '[deleted]' || txt === '[removed]') continue;
          const author = clean(entry.querySelector('.author')?.textContent || '', 60);
          const scoreText = entry.querySelector('.score.unvoted')?.textContent || '';
          const score = Number.parseInt(scoreText.replace(/[^\d-]/g, ''), 10);
          replies.push({ author: author || undefined, body: txt, score: Number.isFinite(score) ? score : undefined });
          if (replies.length >= 3) break;
        }
      }
      const commentAttr = shredditPost?.getAttribute('comment-count') || document.querySelector('.thing.link .comments')?.textContent || '';
      const countNum = Number.parseInt(commentAttr.replace(/[^\d]/g, ''), 10);
      const locked = Boolean(shredditPost?.hasAttribute('is-locked') || document.querySelector('.locked-tagline, [locked]'));
      return { bodyAll, title, opAuthor, opBody, replies, commentCount: Number.isFinite(countNum) ? countNum : undefined, locked };
    }
    const title = clean(document.querySelector('h1')?.textContent || document.title || '', 220);
    const desc =
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      '';
    const mainText = clean(document.querySelector('main, article')?.textContent || desc || '', 900);
    return { bodyAll, title, opAuthor: '', opBody: mainText, replies: [], commentCount: undefined, locked: false };
  }, isReddit);
}

async function openThreadBrowserContext(interactive: boolean) {
  const pw = await import('playwright');
  const profileDir = PERSISTENT_PROFILE_DIR();
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const channels: Array<'chrome' | 'msedge' | undefined> = ['chrome', 'msedge', undefined];
  for (const channel of channels) {
    try {
      const context = await pw.chromium.launchPersistentContext(profileDir, {
        ...(channel ? { channel } : {}),
        headless: !interactive,
        viewport: interactive ? null : { width: 1280, height: 900 },
      });
      return { context, close: () => context.close().catch(() => {}) };
    } catch {
      // Profile may be locked by another Chrome window or channel missing; try fallback.
    }
  }
  if (interactive) return null;
  const browser = await launchHeadlessChromium();
  if (!browser) return null;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  return {
    context,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Reads community threads using OpenGEO's persistent local Chrome profile (`data/browser-profile`).
 * - Background mode (`interactive: false`): fast read; stops immediately if gated by login/CAPTCHA.
 * - Interactive mode (`interactive: true`): opens a visible Chrome window so the user themselves
 *   can sign in or complete a check, then extracts the thread once loaded.
 */
export async function readThreadsWithBrowser(
  urls: string[],
  options: { timeoutMs?: number; interactive?: boolean } = {},
): Promise<Map<string, BrowserThreadExtract>> {
  const out = new Map<string, BrowserThreadExtract>();
  const unique = [...new Set(urls.filter(Boolean))];
  if (!unique.length) return out;
  const interactive = Boolean(options.interactive);
  const handle = await openThreadBrowserContext(interactive);
  if (!handle) {
    for (const u of unique) out.set(u, { ok: false, reason: 'error' });
    return out;
  }
  try {
    for (const rawUrl of unique) {
      const reddit = rawUrl.match(REDDIT_COMMENT_RE);
      const targetUrl = reddit
        ? `https://www.reddit.com/r/${reddit[1]}/comments/${reddit[2]}/`
        : rawUrl;
      const safe = await assertPublicHttpUrl(targetUrl);
      if (!safe) {
        out.set(rawUrl, { ok: false, reason: 'blocked' });
        continue;
      }
      const page = await handle.context.newPage();
      try {
        if (!interactive) {
          await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            if (t === 'image' || t === 'media' || t === 'font') return route.abort();
            return route.continue();
          });
        }
        const response = await page.goto(safe.href, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs ?? 15_000 });
        const status = response?.status() ?? 0;
        if (status === 404) {
          out.set(rawUrl, { ok: false, reason: 'not_found' });
          continue;
        }
        if (!interactive && (status === 401 || status === 403 || status === 429)) {
          out.set(rawUrl, { ok: false, reason: 'blocked' });
          continue;
        }

        const deadline = Date.now() + (interactive ? 90_000 : 2_000);
        let extracted = await extractThreadFromPage(page, Boolean(reddit));
        while (Date.now() < deadline) {
          const isWall = BOT_WALL_RE.test(`${extracted.title} ${extracted.bodyAll}`);
          const ready = !isWall && Boolean(extracted.opBody || (extracted.replies && extracted.replies.length > 0));
          if (ready) break;
          if (!interactive && isWall) break;
          await page.waitForTimeout(interactive ? 1200 : 700);
          if (page.isClosed()) break;
          extracted = await extractThreadFromPage(page, Boolean(reddit));
        }

        if (BOT_WALL_RE.test(`${extracted.title} ${extracted.bodyAll}`)) {
          out.set(rawUrl, { ok: false, reason: 'blocked' });
          continue;
        }
        const hasSignal = Boolean(extracted.opBody || (extracted.replies && extracted.replies.length > 0));
        out.set(
          rawUrl,
          hasSignal
            ? {
                ok: true,
                title: extracted.title || undefined,
                opAuthor: extracted.opAuthor || undefined,
                opBody: extracted.opBody || undefined,
                replies: extracted.replies,
                commentCount: extracted.commentCount,
                locked: extracted.locked,
              }
            : { ok: false, reason: 'blocked' },
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        out.set(rawUrl, { ok: false, reason: /timeout/i.test(msg) ? 'timeout' : 'error' });
      } finally {
        if (!page.isClosed()) await page.close().catch(() => {});
      }
    }
  } finally {
    await handle.close();
  }
  return out;
}

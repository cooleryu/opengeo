import fs from 'node:fs';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { isProjectOwnedUrl } from '../asset-ownership';
import { ensureProjectRelationalData, parseSourcesJson, withProjectDb } from '../db';
import { loadProjectSeed } from '../project-data';
import { readPublicSource, type PublicSourceRuntime } from '../project-public-source';
import { evidenceLocation, withGeoProject } from '../projects';
import type { ResearchEngine } from '../research-types';
import type { ReferenceWinner } from './types';

export interface WinnerStructure {
  title: string;
  headings: string[];
  openingParagraphs: string[];
}

const ANTI_BOT_RE =
  /\b(just a moment|attention required|access denied|verify you are human|security check|captcha|enable javascript and cookies|cf-browser-verification)\b/i;

const TRACKING_PARAM_PREFIXES = ['utm_', 'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source'];

const GENERIC_CONSOLE_HOSTS = new Set([
  'search.google.com',
  'www.bing.com',
  'bing.com',
  'console.cloud.google.com',
]);

function normalizeCandidateUrl(rawUrl: string): { normalized: string; domain: string; isDeepPath: boolean } | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix))) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    parsed.pathname = pathname;
    const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (
      domain === 'support.google.com' ||
      domain === 'policies.google.com' ||
      domain === 'accounts.google.com'
    ) {
      return null;
    }
    if (/^google\.[a-z.]+$/i.test(domain) && /^\/(goto|url|search)(\/|$)/i.test(pathname)) {
      return null;
    }
    return {
      normalized: parsed.href,
      domain,
      isDeepPath: pathname !== '/' && pathname.split('/').filter(Boolean).length >= 1,
    };
  } catch {
    return null;
  }
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateExcerpt(text: string, maxChars: number): string {
  const cleaned = cleanText(text);
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars).replace(/[,.;:，。；：\s]+$/, '')}…`;
}

function readLocalAnswerText(projectId: string, answerPath: string | null, evidencePath: string): string {
  const relPath = answerPath ?? evidencePath;
  if (!relPath) return '';
  try {
    const fullPath = withGeoProject(projectId, () => evidenceLocation(relPath).target);
    if (!fs.existsSync(fullPath)) return '';
    const raw = fs.readFileSync(fullPath, 'utf8');
    if (!fullPath.endsWith('.json')) return raw;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.answer_text === 'string') return parsed.answer_text;
    if (parsed.input && typeof (parsed.input as { answerText?: unknown }).answerText === 'string') {
      return (parsed.input as { answerText: string }).answerText;
    }
    if (parsed.answer && typeof (parsed.answer as { text?: unknown }).text === 'string') {
      return (parsed.answer as { text: string }).text;
    }
    return raw;
  } catch {
    return '';
  }
}

function buildLocalSnippet(
  sourceTitle: string,
  sourceSnippet: string | undefined,
  answerText: string,
  rowSummary: string,
  domain: string,
): string {
  if (sourceSnippet && cleanText(sourceSnippet).length >= 24) {
    return truncateExcerpt(sourceSnippet, 260);
  }
  const cleanAnswer = cleanText(answerText);
  if (cleanAnswer) {
    const sentences = cleanAnswer.split(/(?<=[.!?。！？])\s+/);
    const domainStem = domain.split('.')[0] ?? '';
    const match =
      sentences.find((s) => domain && s.toLowerCase().includes(domain)) ||
      sentences.find((s) => domainStem.length >= 3 && s.toLowerCase().includes(domainStem)) ||
      sentences.find((s) => sourceTitle.length >= 4 && s.toLowerCase().includes(sourceTitle.toLowerCase()));
    if (match && match.length >= 24) {
      return truncateExcerpt(match, 260);
    }
  }
  if (rowSummary && cleanText(rowSummary).length >= 20) {
    return truncateExcerpt(rowSummary, 260);
  }
  return sourceTitle ? truncateExcerpt(sourceTitle, 200) : domain;
}

export function extractWinnerStructureFromMarkdown(markdown: string, fallbackTitle = ''): WinnerStructure | null {
  const lines = markdown.split(/\r?\n/);
  let title = fallbackTitle;
  const headings: string[] = [];
  const paragraphs: string[] = [];
  let buffer: string[] = [];

  const flushBuffer = () => {
    if (!buffer.length) return;
    const joined = cleanText(buffer.join(' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'));
    buffer = [];
    if (joined.length >= 35 && !joined.startsWith('|') && !joined.startsWith('```')) {
      paragraphs.push(truncateExcerpt(joined, 300));
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushBuffer();
      continue;
    }
    if (/^#\s+/.test(line) && !title) {
      flushBuffer();
      title = cleanText(line.replace(/^#\s+/, ''));
      continue;
    }
    if (/^##\s+/.test(line)) {
      flushBuffer();
      const heading = cleanText(line.replace(/^##\s+/, ''));
      if (heading.length >= 3 && heading.length <= 120 && headings.length < 6) {
        headings.push(heading);
      }
      continue;
    }
    if (/^(?:#|!\[|```|>|[-*]\s|\d+\.\s)/.test(line)) {
      flushBuffer();
      continue;
    }
    if (paragraphs.length < 3) {
      buffer.push(line);
    }
  }
  flushBuffer();

  if (!headings.length && !paragraphs.length) return null;
  return {
    title: cleanText(title),
    headings: headings.slice(0, 6),
    openingParagraphs: paragraphs.slice(0, 3),
  };
}

/**
 * Extracts only the structural skeleton (title, up to 6 H2 headings, opening 3 short paragraphs)
 * from an external HTML page. Returns null on empty/anti-bot challenge shells.
 */
export function extractWinnerStructureFromHtml(html: string, pageUrl: string): WinnerStructure | null {
  const trimmed = html.trim();
  if (!trimmed) return null;

  let dom: JSDOM | null = null;
  try {
    dom = new JSDOM(trimmed, { url: pageUrl });
    const doc = dom.window.document;
    const rawTitle = cleanText(doc.title || doc.querySelector('h1')?.textContent || '');
    const bodyText = cleanText(doc.body?.textContent || '');

    if (
      (ANTI_BOT_RE.test(rawTitle) || ANTI_BOT_RE.test(bodyText.slice(0, 600))) &&
      bodyText.length < 1500
    ) {
      return null;
    }

    const reader = new Readability(doc.cloneNode(true) as Document);
    const article = reader.parse();
    const title = cleanText(article?.title || rawTitle);

    let rootDoc = doc;
    let articleDom: JSDOM | null = null;
    if (article?.content) {
      articleDom = new JSDOM(article.content, { url: pageUrl });
      rootDoc = articleDom.window.document;
    }

    const headings: string[] = [];
    for (const el of rootDoc.querySelectorAll('h2, h3')) {
      if (el.tagName === 'H3' && headings.length >= 3) continue;
      const text = cleanText(el.textContent || '');
      if (text.length >= 3 && text.length <= 120 && !headings.includes(text)) {
        headings.push(text);
        if (headings.length >= 6) break;
      }
    }

    const openingParagraphs: string[] = [];
    for (const p of rootDoc.querySelectorAll('p')) {
      const text = cleanText(p.textContent || '');
      if (text.length >= 35 && !ANTI_BOT_RE.test(text)) {
        openingParagraphs.push(truncateExcerpt(text, 300));
        if (openingParagraphs.length >= 3) break;
      }
    }

    articleDom?.window.close();

    if (!headings.length && !openingParagraphs.length) return null;
    return { title, headings, openingParagraphs };
  } catch {
    return null;
  } finally {
    dom?.window.close();
  }
}

async function tryOptionalFirecrawl(
  url: string,
  timeoutMs: number,
  fallbackTitle: string,
): Promise<WinnerStructure | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        timeout: timeoutMs,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { markdown?: string; metadata?: { title?: string } };
    };
    const markdown = payload.data?.markdown ?? '';
    if (!markdown.trim()) return null;
    return extractWinnerStructureFromMarkdown(
      markdown,
      payload.data?.metadata?.title || fallbackTitle,
    );
  } catch {
    return null;
  }
}

interface CandidateBucket {
  url: string;
  domain: string;
  title: string;
  isDeepPath: boolean;
  questionIds: Set<string>;
  engines: Set<ResearchEngine>;
  matchesTargetLanguage: boolean;
  localSnippet: string;
  score: number;
}

/**
 * Selects 2~3 high-signal external pages cited by AI answers and runs a strictly bounded
 * two-layer zero-fight probe (4s hard timeout, 0 retries, <0.1s local snippet fallback).
 */
export async function selectAndProbeReferenceWinners(
  projectId: string,
  options?: {
    targetQuestionIds?: string[];
    targetLanguage?: 'en' | 'zh';
    maxWinners?: number;
    timeoutMs?: number;
    runtime?: PublicSourceRuntime;
  },
): Promise<ReferenceWinner[]> {
  const maxWinners = options?.maxWinners ?? 3;
  const timeoutMs = options?.timeoutMs ?? 4000;
  const targetLang = options?.targetLanguage ?? 'en';
  const targetQuestionSet = new Set(options?.targetQuestionIds ?? []);

  const seed = loadProjectSeed(projectId);
  const candidates = withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const rows = db
      .prepare(
        `SELECT o.question_id, q.category AS question_category, o.engine, o.language, o.summary, o.answer_path, o.evidence_path, o.sources_json
         FROM opengeo_observations o
         LEFT JOIN opengeo_questions q ON q.project_id = o.project_id AND q.id = o.question_id
         WHERE o.project_id = ?
         ORDER BY o.seq DESC`,
      )
      .all(id) as Array<{
      question_id: string;
      question_category: string | null;
      engine: ResearchEngine;
      language: 'en' | 'zh';
      summary: string;
      answer_path: string | null;
      evidence_path: string;
      sources_json: string;
    }>;

    const parsedRows = rows.map((row) => ({
      row,
      sources: parseSourcesJson(row.sources_json),
    }));
    const hasNonBrandSources = parsedRows.some(
      ({ row, sources }) => row.question_category !== 'brand' && sources.length > 0,
    );
    const hasTargetLangSources = parsedRows.some(
      ({ row, sources }) => row.language === targetLang && sources.length > 0,
    );

    const buckets = new Map<string, CandidateBucket>();
    for (const { row, sources } of parsedRows) {
      if (!sources.length) continue;
      if (hasTargetLangSources && row.language !== targetLang) continue;
      if (hasNonBrandSources && row.question_category === 'brand') continue;
      let answerTextCache: string | null = null;

      for (const src of sources) {
        if (!src.url || isProjectOwnedUrl(src.url, seed.project)) continue;
        const norm = normalizeCandidateUrl(src.url);
        if (!norm) continue;
        if (answerTextCache === null) {
          answerTextCache = readLocalAnswerText(id, row.answer_path, row.evidence_path);
        }
        const existing = buckets.get(norm.normalized);
        const rawSnippet =
          typeof (src as { snippet?: unknown }).snippet === 'string'
            ? ((src as { snippet?: string }).snippet ?? undefined)
            : undefined;
        const snippet = buildLocalSnippet(
          src.title || '',
          rawSnippet,
          answerTextCache,
          row.summary,
          norm.domain,
        );

        if (existing) {
          existing.questionIds.add(row.question_id);
          existing.engines.add(row.engine);
          if (row.language === targetLang) existing.matchesTargetLanguage = true;
          if (!existing.title && src.title) existing.title = cleanText(src.title);
          if (snippet.length > existing.localSnippet.length) existing.localSnippet = snippet;
        } else {
          buckets.set(norm.normalized, {
            url: norm.normalized,
            domain: norm.domain,
            title: cleanText(src.title || norm.domain),
            isDeepPath: norm.isDeepPath,
            questionIds: new Set([row.question_id]),
            engines: new Set([row.engine]),
            matchesTargetLanguage: row.language === targetLang,
            localSnippet: snippet,
            score: 0,
          });
        }
      }
    }

    for (const bucket of buckets.values()) {
      const targetOverlap = [...bucket.questionIds].filter((q) => targetQuestionSet.has(q)).length;
      bucket.score =
        targetOverlap * 4 +
        bucket.questionIds.size * 3 +
        bucket.engines.size * 2 +
        (bucket.matchesTargetLanguage ? 2 : 0) +
        (bucket.isDeepPath ? 2 : 0) -
        (GENERIC_CONSOLE_HOSTS.has(bucket.domain) ? 4 : 0);
    }

    return [...buckets.values()].sort((a, b) => b.score - a.score);
  });

  if (!candidates.length) return [];

  const topCandidates = candidates.slice(0, Math.min(candidates.length, maxWinners + 2));
  const probed = await Promise.all(
    topCandidates.map(async (candidate): Promise<ReferenceWinner> => {
      const now = new Date().toISOString();
      const baseWinner: Omit<ReferenceWinner, 'probeStatus' | 'headings' | 'openingParagraphs'> = {
        url: candidate.url,
        domain: candidate.domain,
        title: candidate.title || candidate.domain,
        citedEngines: [...candidate.engines],
        citedQuestionCount: candidate.questionIds.size,
        localSnippet: candidate.localSnippet,
        probedAt: now,
      };

      let extracted: WinnerStructure | null = null;
      let status: ReferenceWinner['probeStatus'] = 'local_fallback';

      try {
        const source = await readPublicSource(
          candidate.url,
          {
            maxBytes: 256 * 1024,
            timeoutMs,
            maxRedirects: 3,
            accept: 'text/html, text/markdown, text/plain;q=0.9',
          },
          options?.runtime,
        );
        if (/markdown|plain/i.test(source.contentType)) {
          extracted = extractWinnerStructureFromMarkdown(source.text, baseWinner.title);
        } else {
          extracted = extractWinnerStructureFromHtml(source.text, source.url);
        }
        if (extracted) {
          status = 'full_read';
        }
      } catch {
        extracted = null;
      }

      if (!extracted && !options?.runtime) {
        extracted = await tryOptionalFirecrawl(candidate.url, timeoutMs, baseWinner.title);
        if (extracted) {
          status = 'firecrawl_read';
        }
      }

      if (extracted) {
        return {
          ...baseWinner,
          title: extracted.title || baseWinner.title,
          probeStatus: status,
          headings: extracted.headings,
          openingParagraphs: extracted.openingParagraphs,
        };
      }
      return {
        ...baseWinner,
        probeStatus: 'local_fallback',
        headings: [],
        openingParagraphs: [],
      };
    }),
  );

  const fullReads = probed.filter((w) => w.probeStatus !== 'local_fallback');
  const fallbacks = probed.filter((w) => w.probeStatus === 'local_fallback');
  return [...fullReads, ...fallbacks].slice(0, maxWinners);
}

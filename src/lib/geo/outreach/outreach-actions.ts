import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getChatGPTStatus } from '../chatgpt-auth';
import ChatGPTModel from '../chatgpt-model';
import { requireGeoModelConnection, shouldUseChatGPTSubscription } from '../connection-settings';
import { singleRequestModel } from '../connection-test';
import type { GeoLanguage } from '../i18n';
import { OptimizationStateError, parseGitHubRepoSlug } from '../optimization';
import { loadProjectSeed } from '../project-data';
import { getProjectOnboarding } from '../project-onboarding-store';
import { withGeoProject } from '../projects';
import type { ResearchBatch, ResearchEngine } from '../research-types';
import { extractOutreachCitedPages } from '../research-view';
import { parseGitHubRepoUrl, SAFE_GH_SEGMENT_RE } from '../source-identity';
import { getGeoState } from '../store';
import type { GeoProject } from '../types';
import {
  getOutreachRecord,
  readOutreachRecords,
  upsertOutreachRecord,
  type AwesomePrDraft,
  type CommunityPostDraft,
  type DirectoryListingDraft,
  type OutreachActionRecord,
  type RepoMetaDraft,
} from './outreach-store';

const COMMUNITY_FORUM_HOST_RE =
  /(?:^|\.)(?:reddit\.com|news\.ycombinator\.com|quora\.com|stackoverflow\.com|stackexchange\.com|indiehackers\.com|v2ex\.com|zhihu\.com|dev\.to|medium\.com|substack\.com|youtube\.com|x\.com|twitter\.com|linkedin\.com)$/i;

const KNOWN_DIRECTORY_HOST_RE =
  /(?:^|\.)(?:g2\.com|capterra\.com|getapp\.com|trustradius\.com|producthunt\.com|alternativeto\.net|sourceforge\.net|saasworthy\.com|softwaresuggest\.com|glama\.ai|smithery\.ai|mcp\.so|pulsemcp\.com|marketmcp\.vercel\.app|theresanaiforthat\.com|futurepedia\.io|toolify\.ai|aitoolsdirectory\.com|openalternative\.co|selfh\.st|libhunt\.com|stackshare\.io|slant\.co|crozdesk\.com|softwareadvice\.com|betalist\.com)$/i;

const DIRECTORY_URL_OR_TITLE_RE =
  /(?:\/(?:best|top|alternatives|directory|catalog|marketplace|mcp\/best|tools|compare)\b|\b(?:best|top\s+\d+|alternatives\s+to|directory|catalog|marketplace|open[- ]source\s+\w+\s+list)\b)/i;

/**
 * Project-agnostic classifier distinguishing high-leverage external directories / tool lists
 * (which belong in Main Pack 2 alongside GitHub Awesome PRs) from community threads / posts
 * (which belong in the quiet optional strip).
 */
export function classifyCitedExternalPage(page: {
  url: string;
  title: string;
  host?: string;
}): 'directory_listing' | 'community_post' {
  let host = (page.host || '').trim().toLowerCase().replace(/^www\./, '');
  if (!host) {
    try {
      host = new URL(page.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      host = '';
    }
  }
  if (COMMUNITY_FORUM_HOST_RE.test(host)) return 'community_post';
  if (/\breddit\b|(?:^|[\s·/])r\/[a-z0-9_]+|hacker news/i.test(page.title)) {
    return 'community_post';
  }
  if (KNOWN_DIRECTORY_HOST_RE.test(host)) return 'directory_listing';
  if (DIRECTORY_URL_OR_TITLE_RE.test(`${page.url} ${page.title}`)) {
    return 'directory_listing';
  }
  return 'community_post';
}

export function buildDefaultDirectoryListingDraft(
  project: Pick<GeoProject, 'name' | 'description' | 'repositoryUrl' | 'siteUrl'>,
  page: { title: string; url: string; host?: string },
): DirectoryListingDraft {
  const productUrl = (project.siteUrl || project.repositoryUrl || '').trim();
  const rawSummary = (project.description || '').replace(/\s+/g, ' ').trim();
  const oneLiner = rawSummary
    ? rawSummary.slice(0, 140)
    : `${project.name} (${productUrl || 'official site'})`;
  const directoryName = page.host || page.title;
  return {
    directoryName,
    submitUrl: page.url,
    productUrl,
    oneLiner,
    submissionPitch: [
      `Product: ${project.name}`,
      ...(productUrl ? [`URL: ${productUrl}`] : []),
      `Summary: ${oneLiner}`,
      `Note: Submitting ${project.name} for listing consideration on ${directoryName}. Happy to provide any additional screenshots or verification details.`,
    ].join('\n'),
  };
}

const HAS_CJK_RE = /[\u3400-\u9fff]/;
const NOISE_THREAD_PAGE_RE =
  /(?:^|\/)(?:login|signin|sign-in|signup|sign-up|privacy(?:-policy)?|terms(?:-of-service)?|cookie-policy)(?:\/|$|\?)/i;
const TOPIC_STOPWORDS = new Set([
  'about', 'across', 'after', 'already', 'also', 'and', 'another', 'answers', 'any',
  'app', 'are', 'based', 'best', 'build', 'built', 'can', 'check', 'code', 'compare',
  'docs', 'does', 'for', 'from', 'good', 'guide', 'help', 'how', 'into', 'just',
  'like', 'list', 'make', 'more', 'most', 'need', 'new', 'not', 'open', 'our',
  'other', 'over', 'page', 'pages', 'project', 'projects', 'real', 'repo', 'repository',
  'should', 'show', 'some', 'source', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'this', 'those', 'tool', 'tools', 'use', 'used', 'user', 'users', 'using',
  'want', 'way', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'work', 'works', 'would', 'your',
]);
const LIST_HEADING_PRIORITY_RE =
  /tools|open[- ]source|monitoring|analytics|tracking|visibility|platforms|software|projects|resources|trackers|utilities/i;
const SKIP_HEADING_RE = /table of contents|contents|contributing|license|acknowledg/i;
const LIST_ITEM_RE = /^\s*([-*])\s+(.*)$/;

const execFileAsync = promisify(execFile);

interface RepoMetaSnapshot {
  ok: boolean;
  description: string;
  homepage: string;
  topics: string[];
  fetchedAt: number;
}

const repoMetaCache = new Map<string, RepoMetaSnapshot>();
const inFlightRepoMeta = new Map<
  string,
  Promise<{ description: string; homepage: string; topics: string[] } | null>
>();
const REPO_META_CACHE_TTL_MS = 5 * 60_000;
const REPO_META_FAILURE_TTL_MS = 60_000;

function assertSafeGitHubSlug(owner: string, repo: string): { owner: string; repo: string } {
  const cleanOwner = owner.trim();
  const cleanRepo = repo.trim();
  if (!SAFE_GH_SEGMENT_RE.test(cleanOwner) || !SAFE_GH_SEGMENT_RE.test(cleanRepo)) {
    throw new OptimizationStateError('GitHub 仓库标识格式无效。', 400);
  }
  return { owner: cleanOwner, repo: cleanRepo };
}

function resolveEgoBrowserBin(): string | null {
  const pathDirs = (process.env.PATH || '')
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === 'win32' ? 'ego-browser.exe' : 'ego-browser'));
  const candidates = [
    process.env.EGO_BROWSER_BIN?.trim(),
    path.join(os.homedir(), '.local', 'bin', 'ego-browser'),
    '/opt/homebrew/bin/ego-browser',
    '/usr/local/bin/ego-browser',
    ...pathDirs,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try next binary location
    }
  }
  return null;
}

function openUrlInSystemBrowser(url: string): void {
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}

function runGh(args: string[], timeout = 15_000, stdinInput?: string): string {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    timeout,
    ...(stdinInput !== undefined ? { input: stdinInput } : {}),
    stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  }).trim();
}

function runGit(args: string[], cwd?: string, timeout = 30_000): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function parseRepoMetaPayload(raw: string): RepoMetaSnapshot {
  const parsed = JSON.parse(raw) as {
    description?: unknown;
    homepage?: unknown;
    topics?: unknown;
  };
  return {
    ok: true,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    homepage: typeof parsed.homepage === 'string' ? parsed.homepage : '',
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === 'string')
      : [],
    fetchedAt: Date.now(),
  };
}

function readRepoMetaCache(key: string): {
  hit: boolean;
  value: { description: string; homepage: string; topics: string[] } | null;
} {
  const cached = repoMetaCache.get(key);
  if (!cached) return { hit: false, value: null };
  const ttl = cached.ok ? REPO_META_CACHE_TTL_MS : REPO_META_FAILURE_TTL_MS;
  if (Date.now() - cached.fetchedAt >= ttl) return { hit: false, value: null };
  return {
    hit: true,
    value: cached.ok
      ? {
          description: cached.description,
          homepage: cached.homepage,
          topics: cached.topics,
        }
      : null,
  };
}

function storeRepoMetaFailure(key: string): void {
  repoMetaCache.set(key, {
    ok: false,
    description: '',
    homepage: '',
    topics: [],
    fetchedAt: Date.now(),
  });
}

function fetchLiveRepoMeta(owner: string, repo: string): {
  description: string;
  homepage: string;
  topics: string[];
} | null {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = readRepoMetaCache(key);
  if (cached.hit) return cached.value;

  try {
    const raw = runGh(
      ['api', `repos/${owner}/${repo}`, '--jq', '{description, homepage, topics}'],
      4_500,
    );
    const snapshot = parseRepoMetaPayload(raw);
    repoMetaCache.set(key, snapshot);
    return {
      description: snapshot.description,
      homepage: snapshot.homepage,
      topics: snapshot.topics,
    };
  } catch {
    storeRepoMetaFailure(key);
    return null;
  }
}

async function fetchLiveRepoMetaAsync(owner: string, repo: string): Promise<{
  description: string;
  homepage: string;
  topics: string[];
} | null> {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = readRepoMetaCache(key);
  if (cached.hit) return cached.value;

  const existingFlight = inFlightRepoMeta.get(key);
  if (existingFlight) return existingFlight;

  const promise = (async () => {
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['api', `repos/${owner}/${repo}`, '--jq', '{description, homepage, topics}'],
        { encoding: 'utf8', timeout: 3_500 },
      );
      const snapshot = parseRepoMetaPayload(stdout.trim());
      repoMetaCache.set(key, snapshot);
      return {
        description: snapshot.description,
        homepage: snapshot.homepage,
        topics: snapshot.topics,
      };
    } catch {
      storeRepoMetaFailure(key);
      return null;
    } finally {
      inFlightRepoMeta.delete(key);
    }
  })();

  inFlightRepoMeta.set(key, promise);
  return promise;
}

async function generateStructuredJson<T>(
  schema: z.ZodType<T>,
  systemPrompt: string,
  userPayload: unknown,
): Promise<T | null> {
  const controller = new AbortController();
  const timeoutMs = 25_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const subscription = shouldUseChatGPTSubscription(getChatGPTStatus());
    const model = subscription
      ? new ChatGPTModel({ signal: controller.signal, timeoutMs })
      : singleRequestModel(requireGeoModelConnection(), fetch, controller.signal);

    const raw = await model.generateObject({
      schema,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      options: { temperature: 0.3, maxTokens: 1400 },
    });
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrlMatchToken(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

export interface AwesomeInsertionResult {
  updatedReadme: string;
  sectionHeading: string;
  insertedLine: string;
  contextSnippet: string;
}

export function parseAwesomeInsertion(
  readmeContent: string,
  project: Pick<GeoProject, 'name' | 'repositoryUrl' | 'siteUrl' | 'description'>,
  modelSuggestion?: {
    sectionHeading?: string;
    description?: string;
    insertedLine?: string;
    stars?: number;
    language?: string;
  },
): AwesomeInsertionResult {
  const normalized = readmeContent.replace(/\r\n/g, '\n');
  const primaryUrl = (project.repositoryUrl || project.siteUrl || '').trim();
  if (!primaryUrl) {
    throw new OptimizationStateError('当前项目缺少公开仓库或官网地址，无法生成榜单插入行。', 400);
  }

  const slug = parseGitHubRepoSlug(primaryUrl);
  const urlTokens = [project.repositoryUrl, project.siteUrl]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeUrlMatchToken);
  const loweredReadme = normalized.toLowerCase();
  if (
    (slug && loweredReadme.includes(`${slug.owner.toLowerCase()}/${slug.repo.toLowerCase()}`)) ||
    urlTokens.some((tok) => tok && loweredReadme.includes(tok))
  ) {
    throw new OptimizationStateError('该榜单仓库中已经包含你的项目链接，无需重复提交 PR。', 409);
  }

  if (modelSuggestion?.insertedLine?.trim()) {
    const customLine = modelSuggestion.insertedLine.trim();
    if (!customLine.includes(primaryUrl) && (!slug || !customLine.toLowerCase().includes(slug.repo.toLowerCase()))) {
      throw new OptimizationStateError('提交行必须包含你的项目仓库或官网链接。', 400);
    }
  }

  const lines = normalized.split('\n');
  interface MarkdownSection {
    heading: string;
    headingLineIdx: number;
    endLineIdx: number;
    bulletLineIndexes: number[];
    tableLineIndexes: number[];
    tableHeaderLineIdx: number | null;
    score: number;
  }

  const sections: MarkdownSection[] = [];
  let current: MarkdownSection = {
    heading: 'Overview',
    headingLineIdx: -1,
    endLineIdx: lines.length - 1,
    bulletLineIndexes: [],
    tableLineIndexes: [],
    tableHeaderLineIdx: null,
    score: 0,
  };

  for (let i = 0; i < lines.length; i += 1) {
    const headingMatch = lines[i].match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      current.endLineIdx = i - 1;
      sections.push(current);
      const heading = headingMatch[1].replace(/[#`*]/g, '').trim();
      let score = LIST_HEADING_PRIORITY_RE.test(heading) ? 20 : 1;
      if (SKIP_HEADING_RE.test(heading)) score = -20;
      if (/^#{2,3}\s/.test(lines[i])) score += 3;
      current = {
        heading,
        headingLineIdx: i,
        endLineIdx: lines.length - 1,
        bulletLineIndexes: [],
        tableLineIndexes: [],
        tableHeaderLineIdx: null,
        score,
      };
      continue;
    }

    if (LIST_ITEM_RE.test(lines[i]) && /\[[^\]]+\]\(https?:\/\//.test(lines[i])) {
      current.bulletLineIndexes.push(i);
    } else if (/^\s*\|.+\|\s*$/.test(lines[i])) {
      if (
        current.tableHeaderLineIdx === null &&
        i + 1 < lines.length &&
        /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
      ) {
        current.tableHeaderLineIdx = i;
      } else if (/\[[^\]]+\]\(https?:\/\//.test(lines[i])) {
        current.tableLineIndexes.push(i);
      }
    }
  }
  current.endLineIdx = lines.length - 1;
  sections.push(current);

  const listSections = sections.filter(
    (s) => (s.bulletLineIndexes.length > 0 || s.tableLineIndexes.length > 0) && s.score >= 0,
  );
  const requestedHeading = modelSuggestion?.sectionHeading?.trim().toLowerCase();

  let targetSection: MarkdownSection | undefined;
  if (requestedHeading) {
    targetSection =
      listSections.find((s) => s.heading.toLowerCase() === requestedHeading) ??
      listSections.find((s) => s.heading.toLowerCase().includes(requestedHeading)) ??
      sections.find((s) => s.heading.toLowerCase().includes(requestedHeading));
  }
  if (!targetSection && listSections.length > 0) {
    targetSection = [...listSections].sort(
      (a, b) =>
        b.score - a.score ||
        b.bulletLineIndexes.length + b.tableLineIndexes.length - (a.bulletLineIndexes.length + a.tableLineIndexes.length),
    )[0];
  }

  let insertAtLineIdx = lines.length;
  let bulletPrefix = '- ';
  let useBoldName = false;
  let separator = ' - ';
  let trailingPeriod = true;
  let sectionHeading = 'Open-Source Tools';
  let tableFormattedLine: string | null = null;

  const cleanProjectDesc =
    project.description && !HAS_CJK_RE.test(project.description) ? project.description : '';
  const rawDesc = (
    modelSuggestion?.description ||
    cleanProjectDesc ||
    'Open-source software project.'
  )
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '/')
    .trim()
    .replace(/\.+$/, '');
  const shortDesc = rawDesc.length > 140 ? `${rawDesc.slice(0, 136).trimEnd()}...` : rawDesc;

  if (targetSection && targetSection.tableLineIndexes.length > 0 && targetSection.bulletLineIndexes.length === 0) {
    sectionHeading = targetSection.heading;
    const headerCells =
      targetSection.tableHeaderLineIdx !== null
        ? lines[targetSection.tableHeaderLineIdx]
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim())
        : ['Repository', 'Description'];
    const sampleRow = lines[targetSection.tableLineIndexes[0]];
    const sampleCells = sampleRow.split('|').slice(1, -1).map((c) => c.trim());
    const starsVal = typeof modelSuggestion?.stars === 'number' ? modelSuggestion.stars : 0;
    const langVal = modelSuggestion?.language?.trim() || 'TypeScript';

    const rowCells = headerCells.map((header, idx) => {
      const h = header.toLowerCase();
      const sample = sampleCells[idx] || '';
      if (idx === 0 || /repo|name|tool|project/i.test(h)) {
        return `[${project.name}](${primaryUrl})`;
      }
      if (/star/i.test(h)) {
        if (starsVal <= 0) return '-';
        return sample.includes('⭐') ? `⭐ ${starsVal}` : `${starsVal}`;
      }
      if (/type|kind|category/i.test(h)) {
        return sample.includes('🔧') ? '🔧 Tool' : 'Tool';
      }
      if (/lang/i.test(h)) {
        return langVal;
      }
      if (/desc|summary|about|what/i.test(h) || idx === headerCells.length - 1) {
        return `${shortDesc}.`;
      }
      if (/licen/i.test(h)) {
        return 'MIT';
      }
      return '-';
    });
    tableFormattedLine = `| ${rowCells.join(' | ')} |`;
    insertAtLineIdx = targetSection.tableLineIndexes.at(-1)! + 1;
  } else if (targetSection && targetSection.bulletLineIndexes.length > 0) {
    sectionHeading = targetSection.heading;
    const sampleLines = targetSection.bulletLineIndexes.map((idx) => lines[idx]);
    const asteriskCount = sampleLines.filter((l) => /^\s*\*/.test(l)).length;
    if (asteriskCount > sampleLines.length / 2) bulletPrefix = '* ';
    const boldCount = sampleLines.filter((l) => /^\s*[-*]\s+\*\*\[/.test(l)).length;
    useBoldName = boldCount > sampleLines.length / 2;
    if (sampleLines.some((l) => /\]\([^)]+\)(?:\*\*)?\s+—\s+/.test(l))) separator = ' — ';
    else if (sampleLines.some((l) => /\]\([^)]+\)(?:\*\*)?\s+–\s+/.test(l))) separator = ' – ';
    else if (sampleLines.some((l) => /\]\([^)]+\)(?:\*\*)?:\s+/.test(l))) separator = ': ';

    const periodCount = sampleLines.filter((l) => /\.\s*$/.test(l)).length;
    trailingPeriod = periodCount >= sampleLines.length / 2;

    const lastBulletIdx = targetSection.bulletLineIndexes.at(-1)!;
    insertAtLineIdx = lastBulletIdx + 1;
    // Skip indented continuation lines belonging to the last bullet
    while (
      insertAtLineIdx <= targetSection.endLineIdx &&
      /^\s{2,}\S/.test(lines[insertAtLineIdx] ?? '')
    ) {
      insertAtLineIdx += 1;
    }
  } else if (targetSection) {
    sectionHeading = targetSection.heading;
    insertAtLineIdx = targetSection.headingLineIdx + 1;
  }

  const formattedDesc = trailingPeriod ? `${shortDesc}.` : shortDesc;
  const linkedName = useBoldName
    ? `**[${project.name}](${primaryUrl})**`
    : `[${project.name}](${primaryUrl})`;

  const insertedLine =
    modelSuggestion?.insertedLine?.trim() ||
    tableFormattedLine ||
    `${bulletPrefix}${linkedName}${separator}${formattedDesc}`;

  const nextLines = [...lines];
  if (targetSection) {
    nextLines.splice(insertAtLineIdx, 0, insertedLine);
  } else {
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
      nextLines.pop();
    }
    insertAtLineIdx = nextLines.length + 2;
    nextLines.push('', `## ${sectionHeading}`, '', insertedLine);
  }

  const contextStart = Math.max(0, insertAtLineIdx - 2);
  const contextEnd = Math.min(nextLines.length - 1, insertAtLineIdx + 1);
  const contextLines: string[] = [];
  for (let i = contextStart; i <= contextEnd; i += 1) {
    contextLines.push(i === insertAtLineIdx ? `+ ${nextLines[i]}` : `  ${nextLines[i]}`);
  }

  return {
    updatedReadme: `${nextLines.join('\n').replace(/\n+$/, '')}\n`,
    sectionHeading,
    insertedLine,
    contextSnippet: contextLines.join('\n'),
  };
}

function discoverCitedAwesomeRepos(
  batch: ResearchBatch | null,
  ownSlug: { owner: string; repo: string } | null,
): Array<{
  owner: string;
  repo: string;
  url: string;
  citedCount: number;
  citedEngines: ResearchEngine[];
}> {
  if (!batch) return [];
  const byRepo = new Map<
    string,
    {
      owner: string;
      repo: string;
      url: string;
      questionIds: Set<string>;
      engines: Set<ResearchEngine>;
    }
  >();

  for (const question of batch.questions ?? []) {
    for (const obs of question.observations ?? []) {
      for (const source of obs.sources ?? []) {
        const gh = parseGitHubRepoUrl(source.url || '', { allowSubpaths: true });
        if (!gh) continue;
        if (
          ownSlug &&
          gh.owner.toLowerCase() === ownSlug.owner.toLowerCase() &&
          gh.repo.toLowerCase() === ownSlug.repo.toLowerCase()
        ) {
          continue;
        }
        const combinedLabel = `${gh.repo} ${source.title || ''}`;
        if (!/awesome|list|directory|curated|resources|collection/i.test(combinedLabel)) {
          continue;
        }
        const key = gh.key;
        const existing = byRepo.get(key);
        if (!existing) {
          byRepo.set(key, {
            owner: gh.owner,
            repo: gh.repo,
            url: gh.url,
            questionIds: new Set([question.id]),
            engines: new Set([obs.engine]),
          });
        } else {
          existing.questionIds.add(question.id);
          existing.engines.add(obs.engine);
        }
      }
    }
  }

  return [...byRepo.values()]
    .sort((a, b) => b.questionIds.size - a.questionIds.size || a.repo.localeCompare(b.repo))
    .slice(0, 4)
    .map((entry) => ({
      owner: entry.owner,
      repo: entry.repo,
      url: entry.url,
      citedCount: entry.questionIds.size,
      citedEngines: [...entry.engines],
    }));
}

export function sanitizeAwesomePrDraft(draft: AwesomePrDraft): AwesomePrDraft {
  return {
    ...draft,
    insertedLine: draft.insertedLine.replace(/\|\s*⭐\s*0\s*\|/g, '| - |'),
    contextSnippet: draft.contextSnippet.replace(/\|\s*⭐\s*0\s*\|/g, '| - |'),
  };
}

export function buildDefaultShowHnDraft(
  project: Pick<GeoProject, 'name' | 'description' | 'repositoryUrl' | 'siteUrl' | 'targetLanguage'>,
  latestBatch: ResearchBatch | null = null,
): CommunityPostDraft {
  const repoSlug = parseGitHubRepoSlug(project.repositoryUrl);
  const repoLabel = repoSlug ? `${repoSlug.owner}/${repoSlug.repo}` : project.name;
  const rawSummary = (project.description || '').replace(/\s+/g, ' ').trim();
  const cleanSummary =
    rawSummary && !HAS_CJK_RE.test(rawSummary) ? rawSummary.replace(/\.+$/, '') : '';
  const shortAngle = cleanSummary || 'Open-source tool';

  const questionCount = latestBatch?.questions?.length ?? 0;
  const preferredScopeKey = project.targetLanguage === 'en' ? 'en:all' : 'zh:all';
  const fallbackScopeKey = preferredScopeKey === 'en:all' ? 'zh:all' : 'en:all';
  const scope =
    latestBatch?.overviewMetrics?.[preferredScopeKey] ??
    latestBatch?.overviewMetrics?.[fallbackScopeKey];
  const audits = latestBatch?.answerAudits ?? [];
  const observedEngines = new Set<ResearchEngine>();
  let totalObservations = 0;
  for (const q of latestBatch?.questions ?? []) {
    for (const obs of q.observations ?? []) {
      observedEngines.add(obs.engine);
      totalObservations += 1;
    }
  }
  const completedAnswers =
    scope?.mention?.completed ?? (audits.length > 0 ? audits.length : totalObservations);
  const mentionYes =
    scope?.mention?.yes ?? audits.filter((a) => a.mention === 'yes').length;

  const awesomeRepos = discoverCitedAwesomeRepos(latestBatch, repoSlug);
  const citedPages = latestBatch
    ? extractOutreachCitedPages(
        latestBatch,
        { repositoryUrl: project.repositoryUrl ?? '', siteUrl: project.siteUrl ?? '' },
        { limit: 10 },
      )
    : [];

  const engineLabels: string[] = [];
  if (observedEngines.has('chatgpt')) engineLabels.push('ChatGPT');
  if (observedEngines.has('google')) engineLabels.push('Google AI');
  const enginePhrase =
    engineLabels.length > 0 ? ` across ${engineLabels.join(' & ')}` : '';

  const citationTail =
    awesomeRepos.length > 0
      ? `, while answers cited ${
          awesomeRepos.length === 1
            ? `GitHub list ${awesomeRepos[0].owner}/${awesomeRepos[0].repo}`
            : `${awesomeRepos.length} curated GitHub lists (including ${awesomeRepos[0].owner}/${awesomeRepos[0].repo})`
        }`
      : citedPages.length > 0
        ? `, while citing ${citedPages.length} external pages`
        : '';

  const introParagraph = cleanSummary
    ? `Hey HN — we built ${project.name} (${repoLabel}): ${cleanSummary}.`
    : `Hey HN — sharing ${project.name} (${repoLabel}).`;

  const measuredParagraph =
    questionCount > 0 && completedAnswers > 0
      ? `Running ${questionCount} buyer prompts${enginePhrase} (${completedAnswers} answers) surfaced ${project.name} in ${mentionYes}/${completedAnswers} answers${citationTail}.`
      : '';

  const projectLink = project.repositoryUrl || project.siteUrl || '';
  const bodySections = [
    introParagraph,
    ...(measuredParagraph ? ['', measuredParagraph] : []),
    '',
    ...(projectLink ? [`Code and docs: ${projectLink}`, ''] : []),
    'Would love candid feedback on what works and what is missing.',
  ];

  return {
    channelLabel: 'Hacker News · Show HN',
    submitUrl: 'https://news.ycombinator.com/submit',
    draftUrl: projectLink,
    draftTitle: `Show HN: ${project.name} – ${shortAngle.slice(0, 62)}`,
    draftBody: bodySections.join('\n'),
  };
}

function extractAsciiTokens(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9-]{1,34}/g) ?? [];
  return matches.filter((tok) => tok.length >= 2 && !TOPIC_STOPWORDS.has(tok));
}

function collectProjectKeywords(
  project: Pick<GeoProject, 'name' | 'description'>,
  batch: ResearchBatch | null,
  onboardingSummary = '',
): Set<string> {
  const sources = [
    project.name || '',
    project.description || '',
    onboardingSummary,
    ...(batch?.questions ?? []).map((q) => q.en || ''),
  ];
  const tokens = new Set<string>();
  for (const src of sources) {
    for (const tok of extractAsciiTokens(src)) {
      if (tok.length >= 3) tokens.add(tok);
      for (const part of tok.split('-')) {
        if (part.length >= 3 && !TOPIC_STOPWORDS.has(part)) tokens.add(part);
      }
    }
  }
  return tokens;
}

export function deriveRecommendedTopics(
  project: Pick<GeoProject, 'name' | 'description'>,
  currentTopics: string[],
  batch: ResearchBatch | null = null,
  onboardingSummary = '',
): string[] {
  const cleanCurrent = currentTopics
    .map((t) => t.trim().toLowerCase())
    .filter((t) => /^[a-z0-9][a-z0-9-]{0,34}$/.test(t));
  const out = new Set<string>(cleanCurrent);
  const combinedSource = [project.name || '', project.description || '', onboardingSummary].join(' ');
  const isGeoDomain = /\b(geo|aeo|ai[- ]search|generative[- ]engine|ai[- ]visibility|citation)\b/i.test(
    combinedSource,
  );
  if (isGeoDomain) {
    for (const tag of ['generative-engine-optimization', 'ai-search-visibility', 'local-first', 'geo']) {
      out.add(tag);
    }
  }
  const candidateTokens = extractAsciiTokens(
    [
      project.description || '',
      onboardingSummary,
      ...(batch?.questions ?? []).slice(0, 6).map((q) => q.en || ''),
    ].join(' '),
  );
  for (const tok of candidateTokens) {
    if (out.size >= Math.max(5, cleanCurrent.length + 3)) break;
    const normalized = tok.replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
    if (normalized.length >= 2 && normalized.length <= 35 && !TOPIC_STOPWORDS.has(normalized)) {
      out.add(normalized);
    }
  }
  return [...out].slice(0, 8);
}

const THREAD_NON_TOPICAL_TOKENS = new Set([
  'ai', 'chatgpt', 'com', 'google', 'goto', 'http', 'https', 'net', 'org', 'reddit', 'www',
]);

export function isRelevantCitedThread(
  page: { title: string; url: string; questionCount?: number },
  project: Pick<GeoProject, 'name' | 'description'>,
  batch: ResearchBatch | null = null,
  onboardingSummary = '',
): boolean {
  if (NOISE_THREAD_PAGE_RE.test(page.url)) return false;
  if ((page.questionCount ?? 0) >= 2) return true;
  const projectKeywords = collectProjectKeywords(project, batch, onboardingSummary);
  for (const noise of THREAD_NON_TOPICAL_TOKENS) projectKeywords.delete(noise);
  if (projectKeywords.size === 0) return false;
  // Never match redirect wrapper URLs (e.g. google.com/goto?...) as topical text.
  const urlForMatching = /google\.[a-z.]+\/goto/i.test(page.url) ? '' : page.url;
  const pageTokens = extractAsciiTokens(`${page.title} ${urlForMatching}`).filter(
    (tok) => !THREAD_NON_TOPICAL_TOKENS.has(tok),
  );
  for (const tok of pageTokens) {
    if (projectKeywords.has(tok)) return true;
    for (const part of tok.split('-')) {
      if (part.length >= 3 && !THREAD_NON_TOPICAL_TOKENS.has(part) && projectKeywords.has(part)) {
        return true;
      }
    }
  }
  const cleanName = (project.name || '').trim().toLowerCase();
  if (cleanName.length >= 2 && page.title.toLowerCase().includes(cleanName)) {
    return true;
  }
  return false;
}

export function listOutreachActions(
  projectId: string,
  lang: GeoLanguage = 'zh',
): OutreachActionRecord[] {
  const isEn = lang === 'en';
  const seed = loadProjectSeed(projectId);
  const project = seed.project;
  const latestBatch = withGeoProject(projectId, () => getGeoState().latestResearch) ?? null;
  let onboardingSummary = '';
  try {
    const onboarding = getProjectOnboarding(projectId);
    if (onboarding?.analysis) {
      onboardingSummary = [
        onboarding.analysis.summary || '',
        ...(onboarding.analysis.capabilities ?? []),
      ]
        .filter(Boolean)
        .join(' ');
    }
  } catch {
    // Non-onboarding projects rely on seed project description & batch questions
  }
  const persistedList = readOutreachRecords(projectId);
  const persistedMap = new Map(persistedList.map((r) => [r.id, r]));
  const now = new Date().toISOString();

  const records: OutreachActionRecord[] = [];
  const ownSlug = parseGitHubRepoSlug(project.repositoryUrl);

  // 1. GitHub Repo Facade / Metadata Card (only surfaced when repo metadata actually needs syncing)
  if (ownSlug) {
    const saved = persistedMap.get('repo-meta');
    const liveMeta = fetchLiveRepoMeta(ownSlug.owner, ownSlug.repo);
    const currentDescription = liveMeta?.description ?? project.description ?? '';
    const currentHomepage = liveMeta?.homepage ?? project.siteUrl ?? '';
    const currentTopics = liveMeta?.topics ?? [];

    const ownRepoStem = `github.com/${ownSlug.owner.toLowerCase()}/${ownSlug.repo.toLowerCase()}`;
    const rawSiteUrl = (project.siteUrl || '').trim();
    const externalSiteUrl =
      rawSiteUrl && !rawSiteUrl.toLowerCase().includes(ownRepoStem) ? rawSiteUrl : '';

    const recommendedTopics = deriveRecommendedTopics(
      project,
      currentTopics,
      latestBatch,
      onboardingSummary,
    );
    const suggestedHomepage = currentHomepage.trim() || externalSiteUrl || '';
    const savedSuggestedHome = saved?.repoMetaDraft?.suggestedHomepage?.trim() || '';
    const cleanSavedHome =
      savedSuggestedHome && !/github\.com\/[^/]+\/[^/]+#readme$/i.test(savedSuggestedHome)
        ? savedSuggestedHome
        : suggestedHomepage;

    const cleanSavedDesc =
      saved?.repoMetaDraft?.suggestedDescription &&
      !HAS_CJK_RE.test(saved.repoMetaDraft.suggestedDescription)
        ? saved.repoMetaDraft.suggestedDescription
        : '';
    const cleanCurrentDesc =
      currentDescription.trim().length >= 20 && !HAS_CJK_RE.test(currentDescription)
        ? currentDescription.trim()
        : '';
    const cleanSeedDesc =
      project.description?.trim().length >= 20 && !HAS_CJK_RE.test(project.description)
        ? project.description.trim()
        : '';
    const cleanOnboardingDesc =
      onboardingSummary.trim().length >= 20 && !HAS_CJK_RE.test(onboardingSummary)
        ? onboardingSummary.trim().slice(0, 220)
        : '';
    const suggestedDescription =
      cleanSavedDesc ||
      cleanCurrentDesc ||
      cleanSeedDesc ||
      cleanOnboardingDesc ||
      currentDescription.trim() ||
      `${project.name} (${ownSlug.owner}/${ownSlug.repo})`;

    const needsSync =
      liveMeta !== null &&
      ((Boolean(externalSiteUrl) && !currentHomepage.trim()) ||
        currentTopics.length < 3 ||
        currentDescription.trim().length < 20 ||
        HAS_CJK_RE.test(currentDescription));

    if (needsSync || saved?.status === 'completed' || saved?.status === 'skipped') {
      const draft: RepoMetaDraft = {
        owner: ownSlug.owner,
        repo: ownSlug.repo,
        currentDescription,
        currentHomepage,
        currentTopics,
        suggestedDescription: saved?.repoMetaDraft?.suggestedDescription ?? suggestedDescription,
        suggestedHomepage: cleanSavedHome,
        suggestedTopics: saved?.repoMetaDraft?.suggestedTopics ?? recommendedTopics,
      };

      records.push({
        id: 'repo-meta',
        kind: 'repo_meta',
        title: isEn
          ? `GitHub About & Topics (${ownSlug.owner}/${ownSlug.repo})`
          : `GitHub 仓库简介与 Topics（${ownSlug.owner}/${ownSlug.repo}）`,
        subtitle: isEn
          ? 'Keep repo About description and repository topics up to date so GitHub search and topic pages match your project.'
          : '检测到仓库简介或 Topics 标签尚未补齐，补充后有助于搜索索引与榜单核验。',
        targetUrl: `https://github.com/${ownSlug.owner}/${ownSlug.repo}`,
        status: saved?.status ?? (needsSync ? 'prepared' : 'suggested'),
        repoMetaDraft: draft,
        ...(saved?.resultUrl ? { resultUrl: saved.resultUrl } : {}),
        ...(saved?.completedAt ? { completedAt: saved.completedAt } : {}),
        updatedAt: saved?.updatedAt ?? now,
      });
    }
  }

  // 2. Discovered AI-cited Awesome GitHub Repositories (Highest-leverage external citations)
  const awesomeRepos = discoverCitedAwesomeRepos(latestBatch, ownSlug);
  for (const repo of awesomeRepos) {
    const id = `awesome:${repo.owner}/${repo.repo}`;
    const saved = persistedMap.get(id);
    const sanitizedDraft = saved?.awesomePrDraft
      ? sanitizeAwesomePrDraft(saved.awesomePrDraft)
      : undefined;
    records.push({
      id,
      kind: 'awesome_pr',
      title: `${repo.owner}/${repo.repo}`,
      subtitle: isEn
        ? 'Already cited in AI answers — adding your repo places it inside a source ChatGPT & Google read directly.'
        : 'AI 回答已直接引用这份榜单——收录后可借助这个高权重列表进入搜索回答来源。',
      targetUrl: repo.url,
      citedCount: repo.citedCount,
      citedEngines: repo.citedEngines,
      status: saved?.status ?? 'suggested',
      ...(sanitizedDraft ? { awesomePrDraft: sanitizedDraft } : {}),
      ...(saved?.resultUrl ? { resultUrl: saved.resultUrl } : {}),
      ...(saved?.note ? { note: saved.note } : {}),
      ...(saved?.completedAt ? { completedAt: saved.completedAt } : {}),
      updatedAt: saved?.updatedAt ?? now,
    });
  }

  // 3. Founder Show HN Post (+ preserve legacy completed devto-angle only if already logged)
  const showHnSaved = persistedMap.get('post:show-hn');
  records.push({
    id: 'post:show-hn',
    kind: 'community_post',
    title: isEn ? 'Hacker News · Show HN Post' : 'Hacker News · Show HN 发布帖',
    subtitle: isEn
      ? 'Share a factual launch note anchored in your measured results.'
      : '克制不夸大的技术发布口吻，基于真实实测数据生成发布稿并在浏览器中打开。',
    targetUrl: 'https://news.ycombinator.com/submit',
    status: showHnSaved?.status ?? 'prepared',
    postDraft: showHnSaved?.postDraft ?? buildDefaultShowHnDraft(project, latestBatch),
    ...(showHnSaved?.resultUrl ? { resultUrl: showHnSaved.resultUrl } : {}),
    ...(showHnSaved?.note ? { note: showHnSaved.note } : {}),
    ...(showHnSaved?.completedAt ? { completedAt: showHnSaved.completedAt } : {}),
    updatedAt: showHnSaved?.updatedAt ?? now,
  });

  const devtoSaved = persistedMap.get('post:devto-angle');
  if (devtoSaved?.status === 'completed') {
    records.push(devtoSaved);
  }

  // 4. Cited External Directories / Tool Lists (universal Main Pack 2 for SaaS & repos) + Community Threads
  const citedPages = extractOutreachCitedPages(
    latestBatch,
    { repositoryUrl: project.repositoryUrl ?? '', siteUrl: project.siteUrl ?? '' },
    { limit: 10 },
  ).filter(
    (page) =>
      !/github\.com\/[^/]+\/[^/]+/i.test(page.url) &&
      !/github topics/i.test(page.title) &&
      isRelevantCitedThread(page, project, latestBatch, onboardingSummary),
  );

  let directoryCount = 0;
  let threadCount = 0;
  for (const page of citedPages) {
    const pageKind = classifyCitedExternalPage(page);
    const safeKey = createHash('sha256').update(page.url).digest('base64url').slice(0, 16);
    const hostLabel =
      page.host ||
      (/\breddit\b|(?:^|[\s·/])r\/[a-z0-9_]+/i.test(page.title)
        ? 'reddit.com'
        : isEn
          ? 'External'
          : '该外部');

    if (pageKind === 'directory_listing') {
      if (directoryCount >= 4) continue;
      directoryCount += 1;
      const id = `directory:${safeKey}`;
      const saved = persistedMap.get(id) ?? persistedMap.get(`post:thread:${safeKey}`);
      records.push({
        id,
        kind: 'directory_listing',
        title: page.title || hostLabel,
        subtitle: isEn
          ? `${hostLabel} directory/list already cited by AI — submit your product details to get listed.`
          : `${hostLabel} 外部目录/榜单已被 AI 直接引用 — 备好客观提交材料申请收录。`,
        targetUrl: page.url,
        citedCount: page.questionCount,
        citedEngines: page.engines,
        status: saved?.status ?? 'prepared',
        listingDraft: saved?.listingDraft ?? buildDefaultDirectoryListingDraft(project, page),
        ...(saved?.resultUrl ? { resultUrl: saved.resultUrl } : {}),
        ...(saved?.note ? { note: saved.note } : {}),
        ...(saved?.completedAt ? { completedAt: saved.completedAt } : {}),
        updatedAt: saved?.updatedAt ?? now,
      });
      continue;
    }

    if (threadCount >= 3) continue;
    threadCount += 1;
    const id = `post:thread:${safeKey}`;
    const saved = persistedMap.get(id);
    records.push({
      id,
      kind: 'community_post',
      title: page.title,
      subtitle: isEn
        ? `${hostLabel} discussion already cited by AI — draft a concise factual reply.`
        : `${hostLabel} 社区讨论已被 AI 直接引用 — 可备一段克制的真实经验补充。`,
      targetUrl: page.url,
      citedCount: page.questionCount,
      citedEngines: page.engines,
      status: saved?.status ?? 'suggested',
      ...(saved?.postDraft ? { postDraft: saved.postDraft } : {}),
      ...(saved?.resultUrl ? { resultUrl: saved.resultUrl } : {}),
      ...(saved?.note ? { note: saved.note } : {}),
      ...(saved?.completedAt ? { completedAt: saved.completedAt } : {}),
      updatedAt: saved?.updatedAt ?? now,
    });
  }

  // Rank strictly by leverage: AI-cited Awesome PRs & Directories first, then repo metadata, then threads, then Show HN
  const priorityWeight = (item: OutreachActionRecord) => {
    if (item.kind === 'awesome_pr') return 0;
    if (item.kind === 'directory_listing') return 1;
    if (item.kind === 'repo_meta') return 2;
    if (item.id.startsWith('post:thread:')) return 3;
    return 4;
  };
  return records.sort(
    (a, b) =>
      priorityWeight(a) - priorityWeight(b) ||
      (b.citedCount ?? 0) - (a.citedCount ?? 0),
  );
}

/**
 * Non-blocking variant of `listOutreachActions` for API GET routes:
 * warms the in-memory `gh` metadata cache via async `execFile` before composing cards.
 */
export async function listOutreachActionsAsync(
  projectId: string,
  lang: GeoLanguage = 'zh',
): Promise<OutreachActionRecord[]> {
  const seed = loadProjectSeed(projectId);
  const ownSlug = parseGitHubRepoSlug(seed.project.repositoryUrl);
  if (ownSlug) {
    await fetchLiveRepoMetaAsync(ownSlug.owner, ownSlug.repo);
  }
  return listOutreachActions(projectId, lang);
}

const awesomeAiSuggestionSchema = z.object({
  sectionHeading: z.string().min(1).max(120),
  description: z.string().min(8).max(160),
});

export async function prepareAwesomePrAction(
  projectId: string,
  actionId: string,
  lang: GeoLanguage = 'zh',
): Promise<OutreachActionRecord> {
  const currentList = listOutreachActions(projectId, lang);
  const existing = currentList.find((item) => item.id === actionId && item.kind === 'awesome_pr');
  if (!existing) {
    throw new OptimizationStateError('未找到该 Awesome 榜单条目。', 404);
  }

  const rawSlug = existing.id.slice('awesome:'.length);
  const [rawOwner = '', rawRepo = ''] = rawSlug.split('/');
  const { owner, repo } = assertSafeGitHubSlug(rawOwner, rawRepo);
  const seed = loadProjectSeed(projectId);

  let defaultBranch = 'main';
  let readmeText = '';
  try {
    const repoRaw = runGh(['api', `repos/${owner}/${repo}`, '--jq', '{default_branch}']);
    defaultBranch = (JSON.parse(repoRaw) as { default_branch?: string }).default_branch || 'main';
    const readmeRaw = runGh(['api', `repos/${owner}/${repo}/readme`, '--jq', '{content}']);
    const contentB64 = (JSON.parse(readmeRaw) as { content?: string }).content || '';
    readmeText = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new OptimizationStateError(`读取 ${owner}/${repo} README 失败：${msg}`, 502);
  }

  const headings = readmeText
    .split(/\r?\n/)
    .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.trim())
    .filter((h): h is string => Boolean(h))
    .slice(0, 30);

  const aiSuggestion = await generateStructuredJson(
    awesomeAiSuggestionSchema,
    'You prepare clean 1-line entries for GitHub awesome lists. Pick the best existing heading from headings[] and write one concise, factual, hype-free English description (< 120 chars).',
    {
      targetRepo: `${owner}/${repo}`,
      headings,
      readmePreview: readmeText.slice(0, 4500),
      project: {
        name: seed.project.name,
        url: seed.project.repositoryUrl || seed.project.siteUrl,
        description: seed.project.description,
      },
    },
  );

  let ownStars = 0;
  let ownLanguage = 'TypeScript';
  const ownSlug = parseGitHubRepoSlug(seed.project.repositoryUrl);
  if (ownSlug) {
    try {
      const ownRaw = runGh(
        ['api', `repos/${ownSlug.owner}/${ownSlug.repo}`, '--jq', '{stargazers_count, language}'],
        4000,
      );
      const ownParsed = JSON.parse(ownRaw) as { stargazers_count?: unknown; language?: unknown };
      if (typeof ownParsed.stargazers_count === 'number') ownStars = ownParsed.stargazers_count;
      if (typeof ownParsed.language === 'string' && ownParsed.language.trim()) {
        ownLanguage = ownParsed.language.trim();
      }
    } catch {
      // Fallback cleanly to defaults
    }
  }

  const insertion = parseAwesomeInsertion(readmeText, seed.project, {
    ...(aiSuggestion ?? {}),
    stars: ownStars,
    language: ownLanguage,
  });
  const rawSummary = (seed.project.description || '').replace(/\s+/g, ' ').trim();
  const cleanSummary = rawSummary && !HAS_CJK_RE.test(rawSummary) ? rawSummary.replace(/\.+$/, '') : '';
  const draft: AwesomePrDraft = {
    upstreamOwner: owner,
    upstreamRepo: repo,
    defaultBranch,
    sectionHeading: insertion.sectionHeading,
    insertedLine: insertion.insertedLine,
    contextSnippet: insertion.contextSnippet,
    prTitle: `Add ${seed.project.name} under ${insertion.sectionHeading}`,
    prBody: [
      `Hi! Adding [${seed.project.name}](${seed.project.repositoryUrl || seed.project.siteUrl}) under **${insertion.sectionHeading}**.`,
      ``,
      cleanSummary
        ? `${cleanSummary}.`
        : `Open-source project maintained at ${seed.project.repositoryUrl || seed.project.siteUrl}.`,
      ``,
      `Happy to adjust the wording or section placement if needed!`,
    ].join('\n'),
  };

  return upsertOutreachRecord(projectId, {
    ...existing,
    status: 'prepared',
    awesomePrDraft: draft,
  });
}

export async function submitAwesomePrAction(
  projectId: string,
  actionId: string,
  overrides?: { insertedLine?: string; prTitle?: string; prBody?: string },
): Promise<OutreachActionRecord> {
  const existing =
    getOutreachRecord(projectId, actionId) ??
    listOutreachActions(projectId, 'en').find((item) => item.id === actionId);
  if (!existing || existing.kind !== 'awesome_pr') {
    throw new OptimizationStateError('未找到该 Awesome 榜单 PR 任务。', 404);
  }
  const draft = existing.awesomePrDraft
    ? sanitizeAwesomePrDraft(existing.awesomePrDraft)
    : undefined;
  if (!draft) {
    throw new OptimizationStateError('请先生成推荐行 Diff 预览，确认无误后再提交 PR。', 400);
  }

  const { owner, repo } = assertSafeGitHubSlug(draft.upstreamOwner, draft.upstreamRepo);
  const seed = loadProjectSeed(projectId);

  let viewerLogin = '';
  try {
    viewerLogin = runGh(['api', 'user', '--jq', '.login']);
  } catch {
    throw new OptimizationStateError('请先在本机执行 `gh auth login` 登录 GitHub 后再提交 PR。', 422);
  }
  if (!SAFE_GH_SEGMENT_RE.test(viewerLogin)) {
    throw new OptimizationStateError('无法识别当前 GitHub 登录账号。', 422);
  }

  let readmePath = 'README.md';
  let defaultBranch = draft.defaultBranch || 'main';
  let freshReadme = '';
  try {
    const repoRaw = runGh(['api', `repos/${owner}/${repo}`, '--jq', '{default_branch}']);
    defaultBranch = (JSON.parse(repoRaw) as { default_branch?: string }).default_branch || defaultBranch;
    const readmeRaw = runGh(['api', `repos/${owner}/${repo}/readme`, '--jq', '{path, content}']);
    const parsed = JSON.parse(readmeRaw) as { path?: string; content?: string };
    readmePath = parsed.path || 'README.md';
    freshReadme = Buffer.from((parsed.content || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch (err) {
    throw new OptimizationStateError(
      `拉取 ${owner}/${repo} 最新 README 失败：${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  const cleanOverrideLine = overrides?.insertedLine
    ?.trim()
    .replace(/\|\s*⭐\s*0\s*\|/g, '| - |');
  const insertion = parseAwesomeInsertion(freshReadme, seed.project, {
    sectionHeading: draft.sectionHeading,
    insertedLine: cleanOverrideLine || draft.insertedLine,
  });

  const cleanPrTitle = (overrides?.prTitle?.trim() || draft.prTitle).slice(0, 180);
  const cleanPrBody = (overrides?.prBody?.trim() || draft.prBody).slice(0, 4000);
  const sameOwner = viewerLogin.toLowerCase() === owner.toLowerCase();

  if (!sameOwner) {
    runGh(['repo', 'fork', `${owner}/${repo}`, '--clone=false'], 30_000);
  }

  const forkTarget = sameOwner ? `${owner}/${repo}` : `${viewerLogin}/${repo}`;
  // GitHub fork provisioning can lag slightly; poll briefly until reachable.
  let forkReady = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      runGh(['api', `repos/${forkTarget}`, '--jq', '.full_name'], 6_000);
      forkReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
  if (!forkReady) {
    throw new OptimizationStateError(`已触发 Fork ${owner}/${repo}，但仓库尚未就绪，请几秒后重试。`, 502);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-awesome-pr-'));
  const cloneDir = path.join(tempRoot, 'repo');
  const ownSlug = parseGitHubRepoSlug(seed.project.repositoryUrl);
  const branchSlug = (ownSlug?.repo || seed.project.name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';
  const branchName = `add-${branchSlug}-${Date.now().toString(36).slice(-4)}`;

  try {
    runGh(['repo', 'clone', forkTarget, cloneDir, '--', '--depth', '1'], 30_000);
    if (!sameOwner) {
      runGit(
        ['fetch', `https://github.com/${owner}/${repo}.git`, defaultBranch, '--depth=1'],
        cloneDir,
        30_000,
      );
      runGit(['checkout', '-B', branchName, 'FETCH_HEAD'], cloneDir);
    } else {
      runGit(['checkout', '-b', branchName], cloneDir);
    }

    const absReadme = path.resolve(cloneDir, readmePath);
    if (!absReadme.startsWith(`${path.resolve(cloneDir)}${path.sep}`)) {
      throw new OptimizationStateError('上游 README 路径不安全。', 400);
    }
    fs.writeFileSync(absReadme, insertion.updatedReadme, 'utf8');

    try {
      runGit(['config', '--get', 'user.name'], cloneDir);
    } catch {
      runGit(['config', 'user.name', viewerLogin], cloneDir);
    }
    try {
      runGit(['config', '--get', 'user.email'], cloneDir);
    } catch {
      runGit(['config', 'user.email', `${viewerLogin}@users.noreply.github.com`], cloneDir);
    }

    runGit(['add', readmePath], cloneDir);
    runGit(['commit', '-m', cleanPrTitle], cloneDir);
    runGit(['push', '-u', 'origin', branchName], cloneDir, 30_000);

    const headRef = sameOwner ? branchName : `${viewerLogin}:${branchName}`;
    const prOutput = runGh(
      [
        'pr',
        'create',
        '--repo',
        `${owner}/${repo}`,
        '--head',
        headRef,
        '--base',
        defaultBranch,
        '--title',
        cleanPrTitle,
        '--body',
        cleanPrBody,
      ],
      30_000,
    );
    const prUrl = prOutput.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0] || prOutput;

    return upsertOutreachRecord(projectId, {
      ...existing,
      status: 'completed',
      awesomePrDraft: {
        ...draft,
        insertedLine: insertion.insertedLine,
        contextSnippet: insertion.contextSnippet,
        prTitle: cleanPrTitle,
        prBody: cleanPrBody,
      },
      resultUrl: prUrl,
      note: `PR 已提交至 ${owner}/${repo} (${defaultBranch})`,
      completedAt: new Date().toISOString(),
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const communityAiSchema = z.object({
  draftTitle: z.string().min(4).max(160),
  draftBody: z.string().min(20).max(2500),
});

export async function prepareCommunityPostAction(
  projectId: string,
  actionId: string,
  lang: GeoLanguage = 'zh',
): Promise<OutreachActionRecord> {
  const existing = listOutreachActions(projectId, lang).find(
    (item) => item.id === actionId && item.kind === 'community_post',
  );
  if (!existing) {
    throw new OptimizationStateError('未找到该社区发声任务。', 404);
  }
  const seed = loadProjectSeed(projectId);
  const project = seed.project;
  const repoUrl = project.repositoryUrl || project.siteUrl || '';

  const aiDraft = await generateStructuredJson(
    communityAiSchema,
    'Write an authentic, non-salesy developer community post/comment in English (unless target page is Chinese). Never use hype, exclamation marks, or marketing cliches. Mention the open-source repo naturally once.',
    {
      channel: existing.postDraft?.channelLabel ?? existing.title,
      targetUrl: existing.targetUrl,
      project: {
        name: project.name,
        repoUrl,
        description: project.description,
      },
    },
  );

  const cleanSummary =
    project.description && !HAS_CJK_RE.test(project.description)
      ? project.description.replace(/\s+/g, ' ').trim()
      : '';
  const fallbackDraft: CommunityPostDraft = existing.postDraft ?? {
    channelLabel: existing.title,
    submitUrl: existing.targetUrl,
    draftUrl: repoUrl,
    draftTitle: cleanSummary
      ? `Notes from building ${project.name}: ${cleanSummary.slice(0, 80)}`
      : `Sharing ${project.name} (${repoUrl})`,
    draftBody: [
      cleanSummary
        ? `Sharing a practical update from building ${project.name}: ${cleanSummary}`
        : `Sharing ${project.name} (${repoUrl}) for folks exploring related workflows.`,
      ``,
      ...(repoUrl ? [`Repo & docs: ${repoUrl}`, ``] : []),
      `Curious how others here handle this in practice and what edge cases you've run into?`,
    ].join('\n'),
  };

  const nextPostDraft: CommunityPostDraft = aiDraft
    ? {
        ...fallbackDraft,
        draftTitle: aiDraft.draftTitle,
        draftBody: aiDraft.draftBody,
      }
    : fallbackDraft;

  return upsertOutreachRecord(projectId, {
    ...existing,
    status: 'prepared',
    postDraft: nextPostDraft,
  });
}

export async function openDraftInEgoLiteAction(input: {
  targetUrl: string;
  draftTitle?: string;
  draftBody?: string;
  draftUrl?: string;
}): Promise<{ openedUrl: string }> {
  const targetUrl = input.targetUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    throw new OptimizationStateError('只能打开 http:// 或 https:// 网页。', 400);
  }

  const egoBin = resolveEgoBrowserBin();
  if (!egoBin) {
    openUrlInSystemBrowser(targetUrl);
    return { openedUrl: targetUrl };
  }

  const script = `
const targetUrl = ${JSON.stringify(targetUrl)};
const draftTitle = ${JSON.stringify(input.draftTitle || '')};
const draftBody = ${JSON.stringify(input.draftBody || '')};
const draftUrl = ${JSON.stringify(input.draftUrl || '')};
const task = await taskSpace("外发发布工作台");
const pages = await task.pages();
const page = pages.length === 0 ? task.page("p1") : await task.newPage();
await page.goto(targetUrl);
if (/news\\.ycombinator\\.com\\/submit/i.test(targetUrl)) {
  try {
    await page.waitForSelector('input[name="title"]', { state: 'visible', timeout: 8000 });
    if (draftTitle) await page.fill('input[name="title"]', draftTitle);
    if (draftUrl) await page.fill('input[name="url"]', draftUrl);
    if (draftBody) {
      await page.evaluate((text) => {
        const box = document.querySelector('textarea[name="text"]');
        if (box) box.value = text;
      }, draftBody);
    }
  } catch {
    // User might need to sign in on HN first; keep tab open for manual post
  }
}
const allPages = await task.pages();
await task.finish({ keep: allPages.map((p) => p.label) });
`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(egoBin || 'ego-browser', ['nodejs', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errText = '';
    child.stderr?.on('data', (chunk) => {
      errText += chunk.toString();
    });
    child.on('error', (err) => {
      reject(new OptimizationStateError(`无法打开 Ego Lite：${err.message}`, 500));
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new OptimizationStateError(
            `Ego Lite 打开页面失败：${errText.trim().split('\n').pop() || `exit ${code}`}`,
            500,
          ),
        );
      }
    });
  });

  if (process.platform === 'darwin') {
    try {
      spawn('open', ['-a', 'ego lite'], { stdio: 'ignore', detached: true }).unref();
    } catch {
      // Non-fatal if OS focus command fails
    }
  }

  return { openedUrl: targetUrl };
}

export function updateRepoMetaAction(
  projectId: string,
  input: {
    description: string;
    homepage: string;
    topics: string[];
  },
): OutreachActionRecord {
  const existing = listOutreachActions(projectId, 'zh').find((item) => item.id === 'repo-meta');
  if (!existing?.repoMetaDraft) {
    throw new OptimizationStateError('当前项目未配置 GitHub 仓库，无法更新仓库门面信息。', 400);
  }
  const { owner, repo } = assertSafeGitHubSlug(
    existing.repoMetaDraft.owner,
    existing.repoMetaDraft.repo,
  );
  const description = input.description.trim().slice(0, 350);
  const homepage = input.homepage.trim().slice(0, 300);
  if (homepage && !/^https?:\/\//i.test(homepage)) {
    throw new OptimizationStateError('Homepage 链接必须以 http:// 或 https:// 开头。', 400);
  }
  const cleanTopics = Array.from(
    new Set(
      input.topics
        .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, ''))
        .filter((t) => t.length >= 1 && t.length <= 50),
    ),
  ).slice(0, 20);

  try {
    runGh([
      'api',
      '-X',
      'PATCH',
      `repos/${owner}/${repo}`,
      '-f',
      `description=${description}`,
      '-f',
      `homepage=${homepage}`,
    ]);
    if (cleanTopics.length > 0) {
      runGh(
        [
          'api',
          '-X',
          'PUT',
          `repos/${owner}/${repo}/topics`,
          '-H',
          'Accept: application/vnd.github+json',
          '--input',
          '-',
        ],
        15_000,
        JSON.stringify({ names: cleanTopics }),
      );
    }
  } catch (err) {
    throw new OptimizationStateError(
      `更新 GitHub 仓库信息失败：${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  repoMetaCache.set(`${owner.toLowerCase()}/${repo.toLowerCase()}`, {
    ok: true,
    description,
    homepage,
    topics: cleanTopics,
    fetchedAt: Date.now(),
  });

  return upsertOutreachRecord(projectId, {
    ...existing,
    status: 'completed',
    repoMetaDraft: {
      ...existing.repoMetaDraft,
      currentDescription: description,
      currentHomepage: homepage,
      currentTopics: cleanTopics,
      suggestedDescription: description,
      suggestedHomepage: homepage,
      suggestedTopics: cleanTopics,
    },
    resultUrl: `https://github.com/${owner}/${repo}`,
    note: `已更新 ${owner}/${repo} 的 About 简介、Homepage 与 ${cleanTopics.length} 个 Topics`,
    completedAt: new Date().toISOString(),
  });
}

export function markOutreachStatusAction(
  projectId: string,
  actionId: string,
  status: 'completed' | 'skipped',
  options?: { resultUrl?: string; note?: string },
): OutreachActionRecord {
  const existing = listOutreachActions(projectId, 'zh').find((item) => item.id === actionId);
  if (!existing) {
    throw new OptimizationStateError('未找到对应的行动卡片。', 404);
  }
  const cleanResultUrl = options?.resultUrl?.trim();
  if (cleanResultUrl && !/^https?:\/\//i.test(cleanResultUrl)) {
    throw new OptimizationStateError('公开链接必须以 http:// 或 https:// 开头。', 400);
  }
  if (status === 'completed') {
    const resolvedProofUrl = cleanResultUrl || existing.resultUrl?.trim() || '';
    if (!resolvedProofUrl || !/^https?:\/\//i.test(resolvedProofUrl)) {
      throw new OptimizationStateError(
        '请粘贴已提交或已发布后的真实公开链接（以 http:// 或 https:// 开头），以便记入已上线记录并用于后续复测核对。',
        400,
      );
    }
  }

  return upsertOutreachRecord(projectId, {
    ...existing,
    status,
    ...(cleanResultUrl ? { resultUrl: cleanResultUrl } : {}),
    ...(options?.note?.trim() ? { note: options.note.trim() } : {}),
    ...(status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
  });
}

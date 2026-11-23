import fs from 'node:fs';
import path from 'node:path';
import { findPublicProjectScreenshotUrl } from '../outreach/external-page-meta';
import { readProjectContext } from '../project-context';
import { loadProjectSeed } from '../project-data';
import { getProjectOnboarding } from '../project-onboarding-store';
import type { ActionCardSkeleton, CardSeedPage } from './action-board-catalog';
import {
  isWorkspaceRepoForProject,
  type OptimizationStrategicBrief,
} from './citation-landscape';

export function normalizeEvidenceUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export interface ProjectFacts {
  name: string;
  owner: string;
  repositoryUrl: string;
  siteUrl: string;
  description: string;
  englishSummary: string;
  screenshotUrl: string;
  factsExcerpt: string;
  ownsWorkspaceRepo: boolean;
}

function readWorkspaceReadme(): string {
  try {
    const abs = path.resolve(process.cwd(), 'README.md');
    if (!fs.existsSync(abs)) return '';
    return fs
      .readFileSync(abs, 'utf8')
      .replace(/<[^>]+>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch {
    return '';
  }
}

function resolveCanonicalBrandName(fallbackName: string, readme: string): string {
  const h1 = readme.match(/^#\s+([^\n#]+)/m)?.[1]?.trim();
  return h1 && h1.toLowerCase() === fallbackName.trim().toLowerCase() ? h1 : fallbackName.trim();
}

function extractEnglishOneLiner(readme: string, brandName: string): string {
  const lines = readme
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 40 && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('http'));
  const isLatin = (l: string) => !/[㐀-鿿]/.test(l);
  const pick = lines.find((l) => l.toLowerCase().includes(brandName.toLowerCase()) && isLatin(l)) ?? lines.find(isLatin);
  return pick ? pick.replace(/\*\*/g, '').slice(0, 220) : '';
}

/**
 * Screenshot for drafts. A raw.githubusercontent.com link is built only when this checkout is the
 * project's own repository and the image exists in it; otherwise only images the project's own
 * README already links to are used.
 */
function resolveScreenshotUrl(
  repositoryUrl: string,
  ownsWorkspaceRepo: boolean,
  assets: Array<{ sourcePath?: string; markdown?: string }>,
): string {
  const gh = repositoryUrl.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  const candidates = ['docs/images/improvement-tracking-en.png', 'docs/images/overview-en.png'];
  const localShot = candidates.find((p) => fs.existsSync(path.resolve(process.cwd(), p)));
  if (gh && ownsWorkspaceRepo && localShot) {
    return `https://raw.githubusercontent.com/${gh[1]}/${gh[2].replace(/\.git$/i, '')}/main/${localShot}`;
  }
  return findPublicProjectScreenshotUrl(repositoryUrl, assets);
}

export function buildProjectIdentityFacts(projectId: string, factsMaxChars = 2600): ProjectFacts {
  const seed = loadProjectSeed(projectId);
  const repositoryUrl = seed.project.repositoryUrl || '';
  const ownsWorkspaceRepo = isWorkspaceRepoForProject({ repositoryUrl });
  const readme = ownsWorkspaceRepo ? readWorkspaceReadme() : '';
  const name = resolveCanonicalBrandName(seed.project.name, readme);
  const facts = readme
    ? `${readme.slice(0, factsMaxChars)}\n${readme.slice(-360)}`
    : readProjectContext(projectId).markdown.slice(0, factsMaxChars);
  const onboardingSummary = (getProjectOnboarding(projectId)?.analysis?.summary || '').slice(0, 280);
  return {
    name,
    owner: seed.project.owner || '',
    repositoryUrl,
    siteUrl: seed.project.siteUrl || '',
    description: (seed.project.description || '').slice(0, 260),
    englishSummary: extractEnglishOneLiner(readme, name) || onboardingSummary,
    screenshotUrl: resolveScreenshotUrl(
      repositoryUrl,
      ownsWorkspaceRepo,
      seed.assets.map((a) => ({ sourcePath: a.sourcePath, markdown: a.markdown })),
    ),
    factsExcerpt: facts.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    ownsWorkspaceRepo,
  };
}

export interface WorkerContext {
  project: ProjectFacts;
  prompts: Array<{ id: string; query: string; recommendedBrands: string[] }>;
  pages: CardSeedPage[];
  competitors: string[];
  existingRepoDocs: string[];
  homonymClues: string[];
}

/** Everything a worker may ground on: the card's own evidence, never the whole landscape. */
export function buildWorkerContext(
  projectId: string,
  card: ActionCardSkeleton,
  brief: OptimizationStrategicBrief,
  facts: ProjectFacts = buildProjectIdentityFacts(projectId),
): WorkerContext {
  const wanted = new Set(card.evidence.questionIds);
  const rows = brief.questionMatrix.filter((row) => wanted.has(row.questionId));
  return {
    project: facts,
    prompts: (rows.length ? rows : brief.questionMatrix).slice(0, 5).map((row) => ({
      id: row.questionId,
      query: row.query,
      recommendedBrands: [
        ...new Set([...(row.chatgpt?.recommendedBrands ?? []), ...(row.google?.recommendedBrands ?? [])]),
      ].slice(0, 6),
    })),
    pages: (card.seeds.pages ?? []).slice(0, 6),
    competitors: card.seeds.competitors ?? [],
    existingRepoDocs: brief.alreadyShipped.existingRepoDocs,
    homonymClues: card.kind === 'page_diff' ? (brief.coverage.brand.homonymClues ?? []).slice(0, 3) : [],
  };
}

export function allowedUrlSet(pages: CardSeedPage[]): Set<string> {
  return new Set(pages.map((p) => normalizeEvidenceUrl(p.url)));
}

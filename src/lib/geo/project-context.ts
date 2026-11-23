import fs from 'node:fs';
import path from 'node:path';
import { resolveAssetOwnership } from './asset-ownership';
import { projectDatabasePath, readRelationalResearchBatch } from './db';
import {
  buildOptimizationStrategicBrief,
  formatCitationLandscapeForContext,
  listWorkspaceRepoDocs,
} from './optimization/citation-landscape';
import { loadProjectSeed, readRuntimeProjects } from './project-data';
import { projectDataDirectory, withGeoProject } from './projects';
import { extractTopExternalCitedSources } from './research-view';
import type { GeoProject } from './types';

export const PROJECT_CONTEXT_FILENAME = 'project-context.md';

type ProjectWithExclusion = GeoProject & {
  identityExclusion?: {
    url?: string;
    authors?: string[];
    reason?: string;
  };
};

export function getProjectContextPath(projectId: string): string {
  return withGeoProject(projectId, () => path.join(projectDataDirectory(), PROJECT_CONTEXT_FILENAME));
}

export function projectContextExists(projectId: string): boolean {
  try {
    const filePath = getProjectContextPath(projectId);
    return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export function synthesizeProjectContextMarkdown(projectId: string): string {
  const seed = loadProjectSeed(projectId);
  const project = seed.project as ProjectWithExclusion;
  const runtimeEntry = readRuntimeProjects().find((entry) => entry.seed.project.id === projectId);
  const onboarding = runtimeEntry?.onboarding ?? null;

  const lines: string[] = [`# ${project.name} — Project Fact Sheet`, ''];

  lines.push('## Core Identity & Entry');
  lines.push(`- Name: ${project.name}`);
  if (project.owner?.trim()) lines.push(`- Owner / Maintainer: ${project.owner.trim()}`);
  if (project.siteUrl?.trim()) lines.push(`- Website: ${project.siteUrl.trim()}`);
  if (project.repositoryUrl?.trim()) lines.push(`- Repository: ${project.repositoryUrl.trim()}`);
  if (project.targetLanguage) lines.push(`- Target Language: ${project.targetLanguage}`);
  if (project.uiLanguage) lines.push(`- UI Language: ${project.uiLanguage}`);
  if (project.description?.trim()) lines.push(`- Summary: ${project.description.trim()}`);
  lines.push('');

  const liveWorkspaceDocs = listWorkspaceRepoDocs(project);
  let liveReadmeExcerpt = '';
  if (liveWorkspaceDocs.includes('README.md')) {
    try {
      const readmeAbs = path.resolve(process.cwd(), 'README.md');
      if (fs.existsSync(readmeAbs)) {
        const rawReadme = fs
          .readFileSync(readmeAbs, 'utf8')
          .replace(/<[^>]+>/g, ' ')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
        if (rawReadme.length >= 200) {
          liveReadmeExcerpt = rawReadme.slice(0, 3200);
        }
      }
    } catch {
      // Non-fatal if workspace README cannot be read
    }
  }

  if (liveReadmeExcerpt) {
    lines.push('## Current Live README (Authoritative Product Facts)');
    lines.push(liveReadmeExcerpt);
    lines.push('');
  }

  if (onboarding) {
    const capturedAt =
      (onboarding as { updatedAt?: string; createdAt?: string }).updatedAt ??
      (onboarding as { createdAt?: string }).createdAt;
    lines.push(
      capturedAt
        ? `## Onboarding Understanding (captured ${capturedAt.slice(0, 10)})`
        : '## Onboarding Understanding',
    );
    lines.push(`- Entry Kind: ${onboarding.kind}`);
    if (onboarding.notes?.trim()) {
      lines.push(`- Maintainer Notes: ${onboarding.notes.trim()}`);
    }
    if (onboarding.analysis) {
      if (onboarding.analysis.summary?.trim()) {
        lines.push(`- Positioning Summary: ${onboarding.analysis.summary.trim()}`);
      }
      if (onboarding.analysis.audience?.trim()) {
        lines.push(`- Target Audience: ${onboarding.analysis.audience.trim()}`);
      }
      if (!liveReadmeExcerpt && onboarding.analysis.capabilities?.length) {
        lines.push('- Verified Capabilities:');
        for (const cap of onboarding.analysis.capabilities) {
          if (cap?.trim()) lines.push(`  - ${cap.trim()}`);
        }
      }
      if (!liveReadmeExcerpt && onboarding.analysis.unknowns?.length) {
        lines.push('- Unverified / Scope Boundaries (do NOT fabricate or overclaim):');
        for (const item of onboarding.analysis.unknowns) {
          if (item?.trim()) lines.push(`  - ${item.trim()}`);
        }
      }
    }
    if (onboarding.revision?.feedback?.trim()) {
      lines.push(`- Latest Maintainer Correction: ${onboarding.revision.feedback.trim()}`);
    }
    lines.push('');
  }

  if (project.identityExclusion) {
    lines.push('## Identity & Disambiguation');
    if (project.identityExclusion.url) {
      lines.push(`- Distinct Unrelated Homonym URL: ${project.identityExclusion.url}`);
    }
    if (project.identityExclusion.authors?.length) {
      lines.push(`- Distinct Homonym Authors / Orgs: ${project.identityExclusion.authors.join(', ')}`);
    }
    if (project.identityExclusion.reason) {
      lines.push(`- Note: ${project.identityExclusion.reason}`);
    }
    lines.push('');
  }

  const ownedAssets = seed.assets.filter(
    (asset) => resolveAssetOwnership(asset, seed).ownership === 'owned',
  );
  if (ownedAssets.length > 0 || liveWorkspaceDocs.length > 0) {
    lines.push('## Owned Content Assets');
    for (const asset of ownedAssets.slice(0, 12)) {
      const linkPart = asset.publicUrl ? ` (${asset.publicUrl})` : '';
      const summaryPart = asset.summary?.trim() ? ` — ${asset.summary.trim()}` : '';
      lines.push(`- ${asset.title} [${asset.type}]${linkPart}${summaryPart}`);
    }
    for (const relDoc of liveWorkspaceDocs) {
      if (!ownedAssets.some((a) => (a.publicUrl ?? '').endsWith(`/${relDoc}`))) {
        lines.push(`- ${relDoc} [workspace-doc] — present in current local repository`);
      }
    }
    lines.push('');
  }

  let landscapeLines: string[] = [];
  let topCited: ReturnType<typeof extractTopExternalCitedSources> = [];
  try {
    const dbPath = projectDatabasePath(projectId);
    if (fs.existsSync(dbPath)) {
      const brief = buildOptimizationStrategicBrief(projectId, {
        targetLanguage: project.targetLanguage ?? 'en',
      });
      landscapeLines = formatCitationLandscapeForContext(brief);
      if (landscapeLines.length === 0) {
        const batch = readRelationalResearchBatch(projectId);
        if (batch) {
          topCited = extractTopExternalCitedSources(
            batch,
            project,
            project.targetLanguage ?? 'en',
            6,
          );
        }
      }
    }
  } catch {
    // Non-fatal if DB or relational batch is absent
  }

  if (landscapeLines.length > 0) {
    lines.push('## Observed AI-Cited Competitors & External Sources');
    lines.push(...landscapeLines);
  } else if (topCited.length > 0) {
    lines.push('## Observed AI-Cited Competitors & External Sources');
    for (const src of topCited) {
      lines.push(`- ${src.label} (${src.url}) — cited across ${src.questionCount} prompt(s)`);
    }
    lines.push('');
  }

  lines.push(
    '> Note: This open Markdown file is editable by the project maintainer at any time to refine product positioning, audience technical level, installation instructions, excluded homonyms, or key competitors.',
  );

  return `${lines.join('\n').trimEnd()}\n`;
}

export function readProjectContext(projectId: string): {
  path: string;
  source: 'file' | 'synthesized';
  markdown: string;
} {
  const filePath = getProjectContextPath(projectId);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim()) {
        return { path: filePath, source: 'file', markdown: raw };
      }
    }
  } catch {
    // Fall back to synthesized view
  }
  return {
    path: filePath,
    source: 'synthesized',
    markdown: synthesizeProjectContextMarkdown(projectId),
  };
}

export function writeProjectContext(projectId: string, markdown: string): string {
  const filePath = getProjectContextPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const normalized = `${markdown.trimEnd()}\n`;
  fs.writeFileSync(filePath, normalized, 'utf8');
  return filePath;
}

import { createHash } from 'node:crypto';
import type { GeoQuestion, GeoSeed } from './types';
import type { WorkflowQuestion } from './workflow-types';

export const DEEPSEEK_SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
export const WORKFLOW_SEARCH_PARAMETERS = { count: 50, need_content: true } as const;
export const LEGACY_SEARCH_PARAMETERS = { count: 50, need_content: false } as const;

/** A protocol identifies the actual query, target, and request parameters, not a display label. */
export function buildSearchProtocolKey(questions: WorkflowQuestion[]): string {
  const normalized = questions.map(question => ({
    id: question.id, query: question.query, language: question.language,
    target: question.target, assetIds: [...question.assetIds].sort(),
    exploratory: question.exploratory,
  })).sort((left, right) => left.id.localeCompare(right.id));
  return `deepseek-search-v2:${createHash('sha256').update(JSON.stringify({
    endpoint: DEEPSEEK_SEARCH_ENDPOINT, parameters: WORKFLOW_SEARCH_PARAMETERS,
    matching: 'project-descendant-or-exact-article-v1', questions: normalized,
  })).digest('hex')}`;
}

function normalizedURL(value: string): { host: string; pathname: string } | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return { host: url.hostname.toLowerCase().replace(/^www\./, ''), pathname: decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/' };
  } catch { return null; }
}

export function matchesProjectURL(value: string, seed: GeoSeed): boolean {
  const candidate = normalizedURL(value);
  if (!candidate) return false;
  return [seed.project.siteUrl, seed.project.repositoryUrl].some(value => {
    const root = normalizedURL(value);
    return root !== null && candidate.host === root.host &&
      (candidate.pathname === root.pathname || candidate.pathname.startsWith(root.pathname === '/' ? '/' : `${root.pathname}/`));
  });
}

export function matchesQuestionTarget(value: string, question: WorkflowQuestion | undefined, seed: GeoSeed): boolean {
  if (!question || question.target === 'project') return matchesProjectURL(value, seed);
  const candidate = normalizedURL(value);
  if (!candidate) return false;
  return seed.assets.some(asset => question.assetIds.includes(asset.id) && asset.publicUrl && (() => {
    const target = normalizedURL(asset.publicUrl!);
    return target !== null && target.host === candidate.host && target.pathname === candidate.pathname;
  })());
}

export function frozenQuestion(question: WorkflowQuestion): GeoQuestion {
  return {
    id: question.id, query: question.query, language: question.language,
    tier: question.category, matchingAssetIds: [...question.assetIds],
    measurementAt: '', provider: 'DeepSeek Search API', resultCount: 0,
    projectHit: false, rank: null, aiCited: null, topSources: [], evidencePath: '',
  };
}

/** Missing/reworded questions must never acquire a historical result by position or topic. */
export function matchHistoricalQuestions(questions: GeoQuestion[], historical: GeoQuestion[]): GeoQuestion[] {
  return questions.flatMap(question => {
    const match = historical.find(item => item.id === question.id && item.query === question.query);
    return match ? [{ ...structuredClone(match), matchingAssetIds: question.matchingAssetIds, tier: question.tier }] : [];
  });
}

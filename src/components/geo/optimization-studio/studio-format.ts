import type { OptimizationDeliverable, OptimizationRun } from '@/lib/geo/optimization/types';
import { getDeliverableRoleLabel } from '../DeliverableArticleView';

export const REPO_DOC_PATH_RE =
  /^(?:README(?:\.[a-zA-Z0-9_-]+)?\.md|(?:docs|public)\/[a-zA-Z0-9._/-]+\.(?:md|html))$/i;

export type AngleOptionKey = 'comparison' | 'collision' | 'workflow' | 'custom';

/** Project-agnostic preset article angles (parameterized by projectName — zero domain overfitting). */
export function buildPresetAngleBrief(key: Exclude<AngleOptionKey, 'custom'>, projectName: string): string {
  const name = projectName.trim() || 'this product';
  switch (key) {
    case 'comparison':
      return `Write a balanced, factual buyer comparison showing how ${name} differs from the top alternatives cited in real AI answers, covering pricing model, setup trade-offs, and best-fit scenarios.`;
    case 'collision':
      return `Write a clear, authoritative explainer defining what ${name} is, who it is built for, and how it differs from similarly named or adjacent tools, grounded strictly in verified product facts.`;
    case 'workflow':
      return `Write a hands-on getting-started and workflow guide showing real users how to adopt ${name} step by step to solve the core buyer questions surfaced in monitoring.`;
  }
}

export function isRepoDocDestinationPath(destination?: string | null): boolean {
  const trimmed = (destination || '').trim();
  if (!trimmed) return false;
  const blobMatch = trimmed.match(
    /^https?:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/i,
  );
  const candidate = blobMatch ? decodeURIComponent(blobMatch[1]) : trimmed.replace(/^\/+/, '');
  return REPO_DOC_PATH_RE.test(candidate);
}

export function isExternalArticleDeliverable(d: OptimizationDeliverable): boolean {
  return (
    d.kind === 'new_content' &&
    getDeliverableRoleLabel(d, 'zh') === '公开获客文章'
  );
}

export function formatShortDate(iso: string | undefined, isEn: boolean): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(isEn ? 'en-US' : 'zh-CN', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatElapsedWindow(hours: number, isEn: boolean): string {
  if (hours < 1) return isEn ? '<1h ago' : '不到 1 小时';
  if (hours < 24) return isEn ? `${hours}h ago` : `第 ${hours} 小时`;
  const days = Math.floor(hours / 24);
  return isEn ? `Day ${days}` : `第 ${days} 天`;
}

export interface ShippedHistoryEntry {
  key: string;
  at: string;
  title: string;
  sourceKind:
    | 'doc'
    | 'article'
    | 'page_audit'
    | 'repo_meta'
    | 'awesome_pr'
    | 'directory_listing'
    | 'community_post';
  subtitle: string;
  liveUrl?: string;
  run?: OptimizationRun;
  deliverable?: OptimizationDeliverable;
}

/** Which outreach review the pop-up shows: the whole outside-site pack or one item. */
export type OutreachModalState =
  | null
  | { mode: 'external_pack' }
  | { mode: 'external_item'; actionId: string }
  | { mode: 'community_item'; actionId: string };

/** The draft open in the reader side panel. */
export type ReaderState = { runId: string; deliverable: OptimizationDeliverable } | null;

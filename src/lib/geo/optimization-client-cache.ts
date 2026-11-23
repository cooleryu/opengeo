import type { GeoLanguage } from './i18n';
import type { ActionBoardRecord } from './optimization/action-board-catalog';
import type { PageAuditRecord, PageAuditTargetOption } from './optimization/page-audit';
import type { OptimizationRun, OptimizationRunViewModel } from './optimization/types';
import type { OutreachActionRecord } from './outreach/outreach-store';
import type { ExternalListingType } from './outreach/external-page-meta';

export interface OptimizationApiSnapshot {
  projectId: string;
  viewModel?: OptimizationRunViewModel;
  runs?: OptimizationRun[];
  outreachActions?: OutreachActionRecord[];
  topNextOutreach?: {
    id: string;
    kind: 'awesome_pr' | 'repo_meta' | 'directory_listing' | 'community_post';
    title: string;
    citedCount: number;
    targetUrl: string;
    listingType?: ExternalListingType;
  } | null;
  latestShippedAt?: string | null;
  pageAudit?: PageAuditRecord | null;
  auditTargets?: PageAuditTargetOption[];
  actionBoard?: ActionBoardRecord | null;
}

const snapshotCache = new Map<string, OptimizationApiSnapshot>();
const inFlightRequests = new Map<string, Promise<OptimizationApiSnapshot | null>>();

function cacheKey(projectId: string, lang: GeoLanguage, runId?: string): string {
  return `${projectId}::${lang}::${runId ?? ''}`;
}

export function readCachedOptimizationSnapshot(
  projectId: string,
  lang: GeoLanguage,
  runId?: string,
): OptimizationApiSnapshot | null {
  if (!projectId) return null;
  return (
    snapshotCache.get(cacheKey(projectId, lang, runId)) ??
    (runId ? snapshotCache.get(cacheKey(projectId, lang)) : undefined) ??
    null
  );
}

export function writeCachedOptimizationSnapshot(
  projectId: string,
  lang: GeoLanguage,
  patch: Partial<OptimizationApiSnapshot>,
  runId?: string,
): void {
  if (!projectId) return;
  const key = cacheKey(projectId, lang, runId);
  const existing = snapshotCache.get(key) ?? { projectId };
  const merged: OptimizationApiSnapshot = { ...existing, ...patch, projectId };
  snapshotCache.set(key, merged);
  if (runId) {
    const baseKey = cacheKey(projectId, lang);
    const baseExisting = snapshotCache.get(baseKey) ?? { projectId };
    snapshotCache.set(baseKey, { ...baseExisting, ...patch, projectId });
  }
}

/**
 * Deduplicated client fetch for `/api/geo/optimization` so OpenGeoApp,
 * OptimizationHeroCard, and OptimizationStudio share one in-flight request
 * and switch tabs instantaneously without a blocking loading spinner.
 */
export function fetchOptimizationSnapshot(
  projectId: string,
  lang: GeoLanguage,
  options?: { runId?: string; force?: boolean },
): Promise<OptimizationApiSnapshot | null> {
  const key = cacheKey(projectId, lang, options?.runId);
  if (!options?.force) {
    const existingFlight = inFlightRequests.get(key);
    if (existingFlight) return existingFlight;
  }

  const params = new URLSearchParams({ project: projectId, lang });
  if (options?.runId) params.set('runId', options.runId);

  const req = fetch(`/api/geo/optimization?${params.toString()}`, {
    cache: 'no-store',
  })
    .then(async (res) => {
      if (!res.ok) return null;
      const payload = (await res.json()) as OptimizationApiSnapshot;
      snapshotCache.set(key, payload);
      if (options?.runId) {
        snapshotCache.set(cacheKey(projectId, lang), payload);
      }
      return payload;
    })
    .catch(() => null)
    .finally(() => {
      if (inFlightRequests.get(key) === req) {
        inFlightRequests.delete(key);
      }
    });

  inFlightRequests.set(key, req);
  return req;
}

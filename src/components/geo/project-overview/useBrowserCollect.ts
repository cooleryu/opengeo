import { useEffect, useRef, useState } from 'react';
import type { BrowserCollectJobSnapshot } from '@/lib/geo/browser-collect-types';
import { useUiLanguage } from '../UiLanguageContext';

export type StartCollectOptions = {
  engine?: 'all' | 'chatgpt' | 'google';
  spaceId?: number;
  force?: boolean;
  since?: string;
  optimizationRunId?: string;
};

/** The project's local browser collection job: status, polling while it runs, start / stop / resume. */
export function useBrowserCollect({
  projectId,
  previewOnly,
  activeOptimizationRunId,
  onRefresh,
}: {
  projectId: string;
  previewOnly: boolean;
  activeOptimizationRunId?: string | null;
  onRefresh?: () => void;
}) {
  const { uiLanguage } = useUiLanguage();
  const isEn = uiLanguage === 'en';
  const [collectJob, setCollectJob] = useState<BrowserCollectJobSnapshot | null>(null);
  const [startingCollect, setStartingCollect] = useState(false);
  const [collectActionError, setCollectActionError] = useState('');
  const prevCompletedRef = useRef<number>(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (previewOnly) return;
    let active = true;
    const syncCollectJob = () => {
      fetch(`/api/geo/browser-collect?project=${encodeURIComponent(projectId)}`, {
        cache: 'no-store',
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((payload: { job?: BrowserCollectJobSnapshot } | null) => {
          if (!active || !payload?.job) return;
          prevCompletedRef.current = payload.job.completedCount;
          setCollectJob(payload.job);
        })
        .catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncCollectJob();
    };
    syncCollectJob();
    window.addEventListener('focus', syncCollectJob);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      window.removeEventListener('focus', syncCollectJob);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [projectId, previewOnly]);

  useEffect(() => {
    if (previewOnly || collectJob?.status !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/geo/browser-collect?project=${encodeURIComponent(projectId)}`,
          { cache: 'no-store' },
        );
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as { job?: BrowserCollectJobSnapshot };
        if (!payload.job || cancelled) return;
        const prevDone = prevCompletedRef.current;
        prevCompletedRef.current = payload.job.completedCount;
        setCollectJob(payload.job);
        if (
          payload.job.completedCount > prevDone ||
          payload.job.status === 'completed'
        ) {
          onRefreshRef.current?.();
        }
      } catch {
        // Keep last state on transient polling errors
      }
    };
    const timer = setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, collectJob?.status, previewOnly]);

  const startCollect = async (opts?: StartCollectOptions) => {
    if (previewOnly || startingCollect) return;
    setStartingCollect(true);
    setCollectActionError('');
    const effectiveRunId = opts?.optimizationRunId ?? activeOptimizationRunId ?? undefined;
    try {
      const res = await fetch('/api/geo/browser-collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          projectId: projectId,
          engine: opts?.engine ?? 'all',
          ...(opts?.force ? { force: true } : {}),
          ...(opts?.since ? { since: opts.since } : {}),
          ...(opts?.spaceId ? { spaceId: opts.spaceId } : {}),
          ...(effectiveRunId ? { optimizationRunId: effectiveRunId } : {}),
        }),
      });
      const payload = (await res.json()) as {
        error?: string;
        job?: BrowserCollectJobSnapshot;
      };
      if (!res.ok) {
        throw new Error(
          payload.error ||
            (isEn
              ? 'Could not start local browser collection.'
              : '未能启动本地浏览器采集。'),
        );
      }
      if (payload.job) {
        prevCompletedRef.current = payload.job.completedCount;
        setCollectJob(payload.job);
      }
    } catch (err) {
      setCollectActionError(
        err instanceof Error
          ? err.message
          : isEn
            ? 'Failed to start local browser collection.'
            : '启动本地浏览器采集失败。',
      );
    } finally {
      setStartingCollect(false);
    }
  };

  const stopCollect = async () => {
    if (previewOnly) return;
    try {
      const res = await fetch('/api/geo/browser-collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'stop',
          projectId: projectId,
        }),
      });
      const payload = (await res.json()) as { job?: BrowserCollectJobSnapshot };
      if (res.ok && payload.job) setCollectJob(payload.job);
    } catch {
      // Ignore transient stop errors
    }
  };

  const resumeCollect = (job: BrowserCollectJobSnapshot) => {
    void startCollect({
      engine: job.engine,
      spaceId: job.spaceId ?? undefined,
      force: job.force,
      since: job.force
        ? (job.batchStartedAt ?? job.startedAt ?? undefined)
        : undefined,
      optimizationRunId: job.optimizationRunId ?? undefined,
    });
  };

  return {
    collectJob,
    startingCollect,
    collectActionError,
    startCollect,
    stopCollect,
    resumeCollect,
  };
}

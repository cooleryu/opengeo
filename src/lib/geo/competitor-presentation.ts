import type { CompetitorPerformanceData } from './competitor-types';
import type { ResearchEngine } from './research-types';
import { RESEARCH_ENGINES } from './research-engines';

/** Pick a complete, shared measurement scope; never silently drop unknown rows. */
export function comparableCompetitorMention(
  performance: CompetitorPerformanceData | undefined,
  language: 'zh' | 'en',
  requestedEngine: ResearchEngine | 'all',
) {
  const engines = requestedEngine === 'all'
    ? ['all', ...RESEARCH_ENGINES] as const
    : [requestedEngine];
  for (const engine of engines) {
    const scope = performance?.scopes[`${language}:${engine}`];
    const metric = scope?.metrics.find((item) => item.id === 'mention');
    if (!scope || !metric || metric.own.rate === null || metric.target.rate === null ||
      metric.own.unknown || metric.target.unknown || !metric.own.completed ||
      metric.own.completed !== metric.target.completed || metric.own.questions !== metric.target.questions ||
      metric.own.unmeasured !== metric.target.unmeasured) continue;
    return { engine, scope, metric };
  }
  return null;
}

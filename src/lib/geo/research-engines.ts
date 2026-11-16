import type { ResearchBatch, ResearchEngine } from './research-types';

export const CONSUMER_RESEARCH_ENGINES = ['chatgpt', 'google'] as const;

export const RESEARCH_ENGINES = ['chatgpt', 'google'] as const;

export const RESEARCH_ENGINE_NAMES: Record<ResearchEngine, string> = {
  chatgpt: 'ChatGPT',
  google: 'Google',
};

export const RESEARCH_ENGINE_COLORS: Record<ResearchEngine, string> = {
  chatgpt: '#4f8b78',
  google: '#5075cf',
};

export function isResearchEngine(value: unknown): value is ResearchEngine {
  return RESEARCH_ENGINES.some((engine) => engine === value);
}

export function isConsumerResearchEngine(
  value: unknown,
): value is 'chatgpt' | 'google' {
  return value === 'chatgpt' || value === 'google';
}

/** Return the active consumer research engines. */
export function getBatchResearchEngines(
  _batch?: ResearchBatch | null,
): ResearchEngine[] {
  return [...RESEARCH_ENGINES];
}

import type { ResearchBatch, ResearchEngine } from './research-types';

export const RESEARCH_ENGINES = [
  'chatgpt',
  'google',
  'deepseek',
  'qwen',
  'doubao',
] as const;

export const RESEARCH_ENGINE_NAMES: Record<ResearchEngine, string> = {
  chatgpt: 'ChatGPT',
  google: 'Google',
  deepseek: 'DeepSeek 搜索 API',
  qwen: '通义千问 API',
  doubao: '豆包 API',
};

export const RESEARCH_ENGINE_COLORS: Record<ResearchEngine, string> = {
  chatgpt: '#4f8b78',
  google: '#5075cf',
  deepseek: '#8562ba',
  qwen: '#b47c38',
  doubao: '#b85f74',
};

export function isResearchEngine(value: unknown): value is ResearchEngine {
  return RESEARCH_ENGINES.some((engine) => engine === value);
}

export function isConsumerResearchEngine(
  value: unknown,
): value is 'chatgpt' | 'google' {
  return value === 'chatgpt' || value === 'google';
}

/** Keep existing consumer entries visible; add API entries only when observed. */
export function getBatchResearchEngines(
  batch: ResearchBatch,
): ResearchEngine[] {
  return RESEARCH_ENGINES.filter(
    (engine) =>
      isConsumerResearchEngine(engine) ||
      batch.questions.some((question) =>
        question.observations.some(
          (observation) => observation.engine === engine,
        ),
      ),
  );
}

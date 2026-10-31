export type CollectionProvider = 'deepseek' | 'doubao' | 'qwen';

/** Frozen with a task. Never contains credentials. */
export interface CollectionConfig {
  provider: CollectionProvider;
  label: string;
  endpoint: string;
  model?: string;
  parameters: Record<string, unknown>;
  metric: 'web_target_hit' | 'answer_target_citation';
}

export interface AnswerSource { url: string; title: string; summary?: string; snippet?: string; content?: string }
export interface AnswerCitation { url: string; title: string; startIndex?: number; endIndex?: number }
export interface CollectedAnswer {
  text: string;
  /** Acquisition evidence, never a model assertion. Missing means unverified. */
  evidence?: { answerComplete: boolean; citationsComplete: boolean; citationSource: 'native' };
  citations: AnswerCitation[];
  sources: AnswerSource[];
  searchPerformed: boolean;
  usage: { inputTokens?: number; outputTokens?: number; searchCalls?: number };
  responseId?: string;
  model?: string;
}

export interface AnswerRequest { url: string; headers: Record<string, string>; body: Record<string, unknown> }

export interface CollectionProviderStatus {
  id: CollectionProvider;
  label: string;
  configured: boolean;
  missing: string[];
  model: string | null;
  costNote: string;
}

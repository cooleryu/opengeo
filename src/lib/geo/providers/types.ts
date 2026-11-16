export interface AnswerSource { url: string; title: string; summary?: string; snippet?: string; content?: string }
export interface AnswerCitation { url: string; title: string; startIndex?: number; endIndex?: number }
export interface CollectedAnswer {
  text: string;
  /** Acquisition evidence, never a model assertion. Missing means unverified. */
  evidence?: { answerComplete: boolean; citationsComplete: boolean; citationSource: 'native' | 'unknown' | 'none' };
  citations: AnswerCitation[];
  sources: AnswerSource[];
  searchPerformed: boolean;
  usage: { inputTokens?: number; outputTokens?: number; searchCalls?: number };
  responseId?: string;
  model?: string;
}

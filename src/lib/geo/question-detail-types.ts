import type { ResearchEngine, ResearchSource } from './research-types';

export interface QuestionDetailFilters {
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
  includeHistory: boolean;
}

export interface QuestionDetailPlatform {
  recordKey: string;
  observationIndex: number | null;
  engine: ResearchEngine;
  label: string;
  entryLabel: string;
  recordedAt: string | null;
  /** Google status follows the ordinary web-result counts, excluding attached citations. */
  status: 'found' | 'not_observed' | 'unmeasured';
  /** Google counts only normal web results with a saved positive position. */
  officialCount: number | null;
  otherCount: number | null;
  totalSources: number | null;
  /** Google sources without a positive position, kept outside web-result counts. */
  otherSourcesCount: number | null;
  sources: ResearchSource[];
  summary: string;
  query: string;
  conditions: string;
  answerPath?: string;
  evidencePath?: string;
}

export interface QuestionDetail {
  version: 1;
  projectId: string;
  batchId: string;
  questionId: string;
  language: 'zh' | 'en';
  title: string;
  mode: 'latest' | 'history';
  platforms: QuestionDetailPlatform[];
}

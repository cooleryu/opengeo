import type { ResearchEngine, ResearchObservation, ResearchSource } from './research-types';

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
  entryType?: ResearchObservation['entryType'];
  entryLabel: string;
  recordedAt: string | null;
  /** Google web-search status follows ordinary result counts; AI answers use their saved status. */
  status: 'found' | 'not_observed' | 'unmeasured';
  /** Audited AI brand mention verdict when the row is an AI answer and batch audits are loaded. */
  mention?: 'yes' | 'no' | 'unknown';
  /** Google web searches count only normal results with a saved positive position. */
  officialCount: number | null;
  otherCount: number | null;
  totalSources: number | null;
  /** Google web-search sources without a positive position, outside web-result counts. */
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

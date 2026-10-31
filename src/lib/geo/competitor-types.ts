import type {
  ResearchEngine,
  ResearchObservation,
  ResearchSource,
} from './research-types';
import type { MetricSummary } from './overview-metrics';

/** Derived from the current overview scope; never an AI assessment score. */
export interface CompetitorPerformanceData {
  ownName: string;
  targetName: string;
  scopes: Record<string, {
    metrics: { id: string; label: string; own: MetricSummary; target: MetricSummary; targetLimitations?: string[] }[];
    measuredAt?: string;
  }>;
}

export interface CompetitorTarget {
  name: string;
  aliases: string[];
  officialUrls: string[];
  updatedAt: string;
}

export interface CompetitorMatch {
  status: 'matched' | 'not_seen' | 'unknown';
  names: string[];
  excerpts: string[];
}

export interface CompetitorRow {
  id: string;
  questionId: string;
  question: string;
  query: string;
  observationIndex: number;
  engine: ResearchEngine;
  entryType?: ResearchObservation['entryType'];
  language: ResearchObservation['language'];
  recordedAt: string;
  collectedAt?: string;
  conditions: string;
  evidencePath: string;
  answerPath?: string;
  answerAvailable: boolean;
  sourcesAvailable: boolean;
  ownMention: CompetitorMatch;
  targetMention: CompetitorMatch;
  sources: (ResearchSource & { own: boolean; target: boolean })[];
}

export interface CompetitorComparison {
  projectId: string;
  own: { name: string; aliases: string[]; officialUrls: string[] };
  target: CompetitorTarget | null;
  batch: { id: string; date: string } | null;
  rows: CompetitorRow[];
  performance?: CompetitorPerformanceData;
  selection?: CompetitorSelection | null;
}

/** A snapshot captured only when the user changes the primary target. */
export interface CompetitorSelection {
  id: string;
  projectId: string;
  batchId: string | null;
  candidateId: string;
  selectedAt: string;
  /** Matching identity at selection time. Optional for pre-snapshot records. */
  target?: CompetitorTarget;
  baseline: { batch: { id: string; date: string } | null; rows: CompetitorRow[] };
}

export interface CompetitorAnalysis {
  status: 'ready' | 'pending' | 'failed';
  /** A prior validated result; not an assessment of the current evidence. */
  stale?: boolean;
  description: string;
  reason: string;
  /** Legacy assessment only. Never used for eligibility, ordering or recommendation. */
  scores?: { relevance: number; evidence: number; learning: number; visibility: number; total: number };
  strengths: string[];
  opportunities: { questionId: string; title: string; observed: string; hypothesis: string; action: string; evidenceIds: string[] }[];
  limitations: string[];
  evidenceIds: string[];
  quotes?: { evidenceId: string; quote: string }[];
  generatedAt?: string;
  model?: string;
  version: string;
  recommended?: boolean;
}

export interface CompetitorAnalysisState {
  status: 'pending' | 'running' | 'ready' | 'failed';
  summary: string;
  stale?: boolean;
  generatedAt?: string;
  startedAt?: string;
  phase?: 'preparing' | 'generating' | 'validating' | 'saving';
  candidateCount?: number;
  evidenceCount?: number;
  error?: string;
}

export interface CandidateQuestion {
  evidenceId?: string;
  batchId: string;
  questionId: string;
  question: string;
  language: 'zh' | 'en';
  engine: ResearchEngine;
  recordedAt: string;
  collectedAt?: string;
  evidencePath: string;
  answerPath?: string;
  observationIndex: number;
  sourceUrl: string;
  excerpt: string;
}

export interface CompetitorCandidate {
  id: string;
  name: string;
  aliases: string[];
  officialUrls: string[];
  description: string;
  reason: string;
  saved: boolean;
  questions: CandidateQuestion[];
  analysis?: CompetitorAnalysis;
  performance?: CompetitorPerformanceData;
  recommendation?: CompetitorRecommendation;
}

export interface CompetitorRankingScope {
  language: 'zh' | 'en';
  engine: ResearchEngine | 'all';
}

export interface CompetitorRecommendation {
  status: 'ranked' | 'candidate';
  /** A confirmed current-scope answer, never the legacy AI rationale. */
  reason: string;
  evidence?: CompetitorRecommendationEvidence;
  /** Equal observed results share a rank. Missing/incomparable samples have no rank. */
  rank?: number;
  isLeader: boolean;
}

export interface CompetitorRecommendationEvidence {
  batchId: string;
  questionId: string;
  question: string;
  engine: ResearchEngine;
  language: 'zh' | 'en';
  observationIndex: number;
}

export interface CompetitorRanking {
  status: 'ranked' | 'candidate';
  scope: CompetitorRankingScope;
  reason: string;
  eligibleCount: number;
  /** Present only when complete comparable observations establish one leader. */
  leaderId?: string;
}

export interface CompetitorCandidates {
  projectId: string;
  batch: { id: string; date: string } | null;
  target: CompetitorTarget | null;
  candidates: CompetitorCandidate[];
  analysis: CompetitorAnalysisState;
  ranking?: CompetitorRanking;
  selectedCandidate?: CompetitorCandidate | null;
  previewCandidate?: CompetitorCandidate;
  selection?: CompetitorSelection | null;
  comparison?: CompetitorComparison;
}

import type { GeoAsset, GeoProject } from './types';
import type { ResearchEngine, ResearchQuestion } from './research-types';

export type ProjectOptimizationMode = 'focus' | 'deep';
export type ProjectOptimizationPhase = 'initializing' | 'planning' | 'reviewing' | 'revising' | 'awaiting_review' | 'blocked' | 'failed' | 'closed';
export interface ProjectOptimizationEvidence {
  id: string;
  questionId: string;
  engine: ResearchEngine;
  language: 'zh' | 'en';
  query: string;
  recordedAt: string;
  conditions: string;
  evidencePath: string;
  text: string;
  boundary: string;
}
export interface ProjectOptimizationSnapshot {
  project: GeoProject;
  batchDate: string;
  questions: ResearchQuestion[];
  assets: GeoAsset[];
  evidence: ProjectOptimizationEvidence[];
  limitations: string[];
}
export interface ProjectOptimizationAction {
  id: string;
  title: string;
  priority: number;
  questionIds: string[];
  assetIds: string[];
  observed: string;
  hypothesis: string;
  change: string;
  rationale: string;
  evidence: { evidenceId: string; quote: string }[];
  verification: string;
  limitations: string[];
  status: 'ready' | 'blocked';
}
export interface ProjectOptimizationActionReview {
  actionId: string;
  scores: { evidence: number; relevance: number; actionability: number; verifiability: number };
  preservesGoal: 'pass' | 'fail' | 'unknown';
  evidenceGrounded: 'pass' | 'fail' | 'unknown';
  passed: boolean;
  issues: string[];
}
export interface ProjectOptimizationReview {
  passed: boolean;
  reviewedAt: string;
  issues: string[];
  actions: ProjectOptimizationActionReview[];
}
export interface ProjectOptimizationRound {
  attempt: number;
  round: number;
  candidateSavedAt: string;
  summary: string;
  actions: ProjectOptimizationAction[];
  limitations: string[];
  review: ProjectOptimizationReview | null;
}
export interface ProjectOptimization {
  mode: ProjectOptimizationMode;
  batchId: string;
  questionIds: string[];
  questionCount: number;
  frozenAt: string;
  phase: ProjectOptimizationPhase;
  progress?: { message: string; round: number; maxRounds: number; updatedAt: string };
  attempt?: number;
  maxRounds?: number;
  history?: ProjectOptimizationRound[];
  stopReason?: 'no_evidence' | 'no_progress' | 'round_limit';
  summary: string;
  actions: ProjectOptimizationAction[];
  limitations: string[];
  review: ProjectOptimizationReview | null;
  snapshot: ProjectOptimizationSnapshot;
}

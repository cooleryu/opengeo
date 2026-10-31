import type { GeoProposal, GeoRun } from './types';
import type { QuestionCategory } from './question-types';
import type { CollectionConfig } from './providers/types';
import type { ResearchObservation } from './research-types';

export interface WorkflowQuestion {
  id: string;
  query: string;
  language: string;
  category: QuestionCategory;
  target: 'project' | 'article';
  assetIds: string[];
  exploratory: boolean;
  intent: string;
  expectedResult: string;
}

export interface GeoDiagnosis {
  summary: string;
  findings: { id: string; observation: string; hypothesis: string; evidencePaths: string[]; uncertainty: string }[];
  comparisons: { questionId: string; sourceUrl: string; observedDifference: string; evidencePath: string }[];
  recommendedAction: string;
  limitations: string[];
  source: 'model' | 'local';
  createdAt: string;
}

export type GeoAcceptanceReview = Record<'implementation' | 'ownBrandMention' | 'ownTargetCitation' | 'comparableConditions' | 'unknownBaseline', {
  met: boolean;
  criterionQuote: string;
  reason: string;
}>;

export interface QualityReview {
  criteriaVersion: string;
  proposalDigest: string;
  reviewedAt: string;
  source: 'model' | 'local';
  scores: { evidence: number; relevance: number; actionability: number; verifiability: number };
  total: number;
  passed: boolean;
  issues: { dimension: string; severity: 'blocking' | 'improvement'; detail: string; suggestion: string }[];
  summary: string;
  /** Required for saved-research plan reviews under the GEO goal-preservation criteria. */
  geoAcceptanceRequired?: boolean;
  geoAcceptance?: GeoAcceptanceReview;
}

export interface QualityLoop {
  maxRounds: number;
  targetScore: number;
  minimumDimensionScore: number;
  stopReason: 'target_reached' | 'no_progress' | 'round_limit' | 'needs_configuration' | 'needs_evidence';
  rounds: { round: number; candidate: GeoProposal; review: QualityReview }[];
  bestRound: number;
}

export interface GeoOutcome {
  classification: 'improved' | 'unchanged' | 'worse' | 'inconclusive';
  summary: string;
  evaluatedAt: string;
  baselineRunId: string | null;
  followupRunIds: string[];
  beforeRate: number | null;
  afterRate: number | null;
  evidencePaths: string[];
  limitations: string[];
}

export type StrategyStatus = 'candidate' | 'validated' | 'active' | 'reverted';

export interface StrategyValidation {
  at: string;
  classification: GeoOutcome['classification'];
  beforeRate: number | null;
  afterRate: number | null;
  runIds: string[];
  evidencePaths: string[];
  passed: boolean;
  summary: string;
}

export interface StrategyHistoryEntry {
  version: number;
  action: 'created' | 'validated' | 'validation_failed' | 'activated' | 'reverted';
  at: string;
  reason: string;
  runIds: string[];
  evidencePaths: string[];
}

export interface StrategyMemory {
  id: string;
  taskId: string;
  projectId: string;
  createdAt: string;
  status: StrategyStatus;
  originalCreatedAt?: string;
  version: number;
  history: StrategyHistoryEntry[];
  validation?: StrategyValidation;
  targetAssetId: string;
  categories: QuestionCategory[];
  protocolKey: string;
  outcome: Exclude<GeoOutcome['classification'], 'inconclusive'>;
  recommendation: string;
  action: string;
  beforeRate: number;
  afterRate: number;
  baselineRunId: string;
  followupRunIds: string[];
  evidencePaths: string[];
  implementationRevision: number;
  confidence: 'observational';
}

export interface GeoWorkflow {
  version: 1;
  collection?: CollectionConfig;
  maxQualityRounds?: number;
  questionPlanId: string;
  questionPlanRevision: number;
  frozenAt: string;
  questions: WorkflowQuestion[];
  protocolKey: string;
  stage: 'search' | 'diagnosis' | 'quality' | 'implementation' | 'monitoring' | 'reflection';
  baseline?: GeoRun;
  /** One server-saved observation used for planning; never a newly collected API baseline. */
  savedResearch?: ResearchObservation;
  diagnosis?: GeoDiagnosis;
  quality?: QualityLoop;
  qualityHistory?: { proposalRevision: number; quality: QualityLoop }[];
  proposalRevision: number;
  appliedStrategyIds: string[];
  outcome?: GeoOutcome;
}

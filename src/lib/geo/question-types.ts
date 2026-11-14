export type QuestionCategory = 'brand' | 'positioning' | 'problem' | 'content' | 'comparison' | 'boundary';
export type QuestionDecision = 'include' | 'explore' | 'exclude';
export type QuestionPriority = 'high' | 'medium' | 'low';

export interface QuestionNeed {
  id: string; title: string; audience: string; trigger: string;
  importance: QuestionPriority; assetIds: string[];
}
export interface QuestionCoverageReview {
  needs: QuestionNeed[];
  selectionAdvantages: { description: string; assetIds: string[] }[];
  selectedIds: string[];
  coverage: { needId: string; candidateIds: string[]; status: 'covered' | 'missing' | 'deferred'; reason: string }[];
  duplicates: { candidateIds: string[]; reason: string }[];
  reason: string;
  status: 'complete' | 'incomplete';
  refinementRounds: 0 | 1;
}

export type QuestionGenerationCheckpoint = {
  key: string;
  title: string;
  items: string[];
  completedAt: string;
  /** Full stage output stays in the local job record, not in page responses. */
  payload?: unknown;
};

export type QuestionGenerationProgress = {
  stage: 'preparing' | 'planning' | 'generating' | 'checking' | 'repairing' | 'reviewing' | 'saving';
  message: string;
  workflowStep?: 'planning' | 'generating' | 'reviewing' | 'saving';
  checkpoint?: Omit<QuestionGenerationCheckpoint, 'completedAt'>;
  request?: import('./chatgpt-model').ChatGPTRequestActivity;
};

export interface QuestionGenerationJob extends QuestionGenerationProgress {
  id: string;
  projectId: string;
  positioning: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'superseded';
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  planRevision?: number;
  checkpoints?: QuestionGenerationCheckpoint[];
}

export interface QuestionAssessment {
  worthPursuing: {
    verdict: 'yes' | 'uncertain' | 'no';
    reason: string;
    demandBasis: 'user-provided' | 'public-observation' | 'inferred' | 'unknown';
    basis: string;
  };
  currentSupport: { level: 'supported' | 'partial' | 'unverified' | 'missing'; reason: string };
  evidence: { assetId: string; quote: string }[];
  gaps: { kind: 'content' | 'evidence' | 'capability' | 'investigation'; description: string }[];
}

export const QUESTION_CATEGORY_LABELS: Record<QuestionCategory, string> = {
  brand: '品牌识别', positioning: '定位匹配', problem: '需求找方案',
  content: '已有内容发现', comparison: '比较选择', boundary: '操作与边界',
};

export interface QuestionCandidate {
  id: string;
  query: string;
  queryEn?: string;
  category: QuestionCategory;
  origin: 'existing' | 'curated' | 'model' | 'manual';
  originalQuestionId?: string;
  /** Source lineage only; revised questions never reuse a measured question ID. */
  sourceQuestionId?: string;
  sourceResearchBatchId?: string;
  supersedesCandidateId?: string;
  supersededByCandidateId?: string;
  intent: string;
  target: 'project' | 'article';
  assetIds: string[];
  evidence: { assetId: string; quote: string }[];
  rationale: string;
  expectedResult: string;
  demandStatus: 'unverified';
  review: {
    decision: QuestionDecision; reason: string; concerns: string[];
    /** AI recommendation priority. Absent on legacy records; fresh reviews must provide it. */
    priority?: QuestionPriority;
    source?: 'manual' | 'model' | 'curated';
    status?: 'pending' | 'reviewed';
    reviewedAt?: string;
    /** Absent on legacy records; never infer a completed dual assessment from a decision alone. */
    assessment?: QuestionAssessment;
  };
  selected: boolean;
}

export interface GeoQuestionPlan {
  id: string;
  projectId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  source: 'curated' | 'model';
  status: 'draft' | 'ready';
  positioning: string;
  candidates: QuestionCandidate[];
  notes: string[];
  /** Set-level recommendation at generation time; later manual selections may differ. */
  coverageReview?: QuestionCoverageReview;
}

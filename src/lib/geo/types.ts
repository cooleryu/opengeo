import type { CollectedAnswer, CollectionProvider, CollectionProviderStatus } from './providers/types';
import type { WidgetBlock } from '@/lib/types';
import type { GeoVisibility } from './visibility-types';
import type { GeoQuestionPlan } from './question-types';
import type { GeoDiagnosis, GeoWorkflow, StrategyMemory } from './workflow-types';
import type { ResearchBatch, ResearchQuestion, ResearchObservation, ResearchEngine } from './research-types';
import type { CompetitorCandidate, CompetitorSelection } from './competitor-types';

export interface ResearchCompetitorReference {
  selectionId: string;
  candidateId: string;
  name: string;
  aliases: string[];
  officialUrls: string[];
  selectedAt: string;
  baseline: CompetitorSelection['baseline'];
  opportunities: NonNullable<CompetitorCandidate['analysis']>['opportunities'];
  evidence: CompetitorCandidate['questions'];
  quotes: NonNullable<CompetitorCandidate['analysis']>['quotes'];
}

/** Resolve question text and evidence from this server-owned research batch. */
export interface ResearchTaskContext {
  projectId?: string;
  batchId: string;
  questionId: string;
  language: 'zh' | 'en';
  engine: ResearchEngine;
  purpose?: 'improve_answer' | 'investigate_gap';
  sourceUrl?: string;
  gapId?: string;
  gap?: string;
  targetAssetId?: string;
  targetUrl?: string;
  candidateId?: string;
  snapshot?: {
    projectId: string;
    batchDate: string;
    question: ResearchQuestion;
    observations: ResearchObservation[];
    reportPath: string;
    sourceAuditPath: string;
    reviewPath: string;
    capturedAt: string;
    candidateAssetIds: string[];
    targetAsset?: GeoAsset;
    competitorReference?: ResearchCompetitorReference;
  };
}

export interface AssetGovernanceRecord {
  id: string;
  projectId: string;
  batchId: string;
  questionId: string;
  gapId: string;
  gap: string;
  status: 'open' | 'investigating' | 'resolved';
  taskIds: string[];
  evidence: { id: string; note: string; url?: string; at: string }[];
  resolution?: string;
  updatedAt: string;
  history: { at: string; status: 'open' | 'investigating' | 'resolved'; resolution?: string }[];
}
export interface AssetGovernanceInput {
  batchId: string;
  questionId: string;
  gapId: string;
  status?: AssetGovernanceRecord['status'];
  taskIds?: string[];
  evidence?: { note: string; url?: string };
  resolution?: string;
}

export interface ClaimReviewRecord {
  id: string;
  projectId: string;
  batchId: string;
  questionId: string;
  observationIndex: number;
  language: 'zh' | 'en';
  engine: ResearchEngine;
  quote: string;
  fact: string;
  evidenceUrl: string;
  conclusion: 'supported' | 'contradicted' | 'uncertain';
  scope: string;
  reviewedAt: string;
  reviewer: 'user';
}

export interface GeoProject { id: string; name: string; description: string; siteUrl: string; repositoryUrl: string; owner: string; asOf: string }
export interface GeoAsset { id: string; title: string; type: string; language: string; status: string; publishedAt: string | null; publicUrl: string | null; sourcePath: string; summary: string; markdown: string; markdownIsExcerpt?: boolean; evidencePaths: string[] }
export interface GeoQuestion { providerId?:CollectionProvider; answer?:CollectedAnswer; matchingAssetIds?: string[]; id: string; tier: string; language: string; query: string; resultCount: number; projectHit: boolean; rank: number | null; aiCited: boolean | null; measurementAt: string; provider: string; topSources: {position:number;title:string;url:string;domain:string;isHomonym:boolean}[]; evidencePath:string }
export interface GeoObservation { id:string; measurementAt:string; provider:string; comparableGroup:string; queryCount:number; hitCount:number; resultCount:number; rank:number|null; aiCited:boolean|null; sourcePath:string; comparabilityNote:string }
export interface GeoFinding { id:string; title:string; detail:string; evidencePaths:string[]; kind:string }
export interface GeoProposal { id:string; title:string; status:string; rationale:string; targetAssetId:string; targetUrl:string; before:string; after:string; changes:string[]; evidencePaths:string[]; successCriteria:string[]; limitations:string[] }
export interface GeoSeed { project:GeoProject; assets:GeoAsset[]; questions:GeoQuestion[]; observations:GeoObservation[]; findings:GeoFinding[]; gaps:any[]; proposal:GeoProposal; monitoringPlan:any; boundaries:any }

export type GeoStatus = 'queued' | 'investigating' | 'proposal_ready' | 'awaiting_implementation' | 'monitoring' | 'paused' | 'completed' | 'failed';
export interface GeoEvent { id:string; at:string; title:string; detail:string; kind:'info'|'success'|'attention'|'error' }
export interface GeoRun { costEstimated?:boolean; id:string; at:string; completedAt?:string; measurementAt:string; mode:'replay'|'live'; status:'completed'|'partial'|'failed'; queryCount:number; completedCount:number; hitCount:number|null; resultCount:number; cost:number; summary:string; questions:GeoQuestion[]; error?:string; phase?:'baseline'|'followup'; protocolKey?:string; implementationRevision?:number }
export interface GeoMonitor { enabled:boolean; mode:'replay'|'live'; timeOfDay:string; days:number; remaining:number; nextRunAt:string|null; budgetLimit:number; spent:number; queryIds:string[]; lastRunAt:string|null }
export interface GeoTask { reviewContextUpdatedAt?:string; assetGovernance?:AssetGovernanceRecord; researchGapReview?:GeoDiagnosis; researchContext?:ResearchTaskContext; projectId?:string; canContinueRevision?:boolean; collectionProvider?:CollectionProvider; id:string; title:string; goal:string; status:GeoStatus; createdAt:string; updatedAt:string; blocks:WidgetBlock[]; events:GeoEvent[]; proposal:GeoProposal|null; implementation:{kind:'rehearsal'|'user_confirmed';note:string;url:string;at:string;occurredAt?:string;proposalRevision?:number;proposalDigest?:string}|null; monitor:GeoMonitor; runs:GeoRun[]; source:'evidence'|'model'; error?:string; workflow?:GeoWorkflow; workflowHistory?:GeoWorkflow[] }
export interface GeoState extends GeoSeed { governanceRecords?:AssetGovernanceRecord[]; claimReviews?:ClaimReviewRecord[]; latestResearch?:ResearchBatch|null; projects:GeoProject[]; visibility:GeoVisibility; questionPlan:GeoQuestionPlan; tasks:GeoTask[]; strategies?:StrategyMemory[]; settings:{collectionProviders:CollectionProviderStatus[];liveSearchConfigured:boolean;modelConfigured:boolean;modelName:string|null;mode:'demo';schedulerRunning:boolean} }

import type { WidgetBlock } from '@/lib/types';
import type { GeoVisibility } from './visibility-types';
import type { GeoQuestionPlan } from './question-types';
import type { GeoWorkflow, StrategyMemory } from './workflow-types';

export interface GeoProject { id: string; name: string; description: string; siteUrl: string; repositoryUrl: string; owner: string; asOf: string }
export interface GeoAsset { id: string; title: string; type: string; language: string; status: string; publishedAt: string | null; publicUrl: string | null; sourcePath: string; summary: string; markdown: string; markdownIsExcerpt?: boolean; evidencePaths: string[] }
export interface GeoQuestion { matchingAssetIds?: string[]; id: string; tier: string; language: string; query: string; resultCount: number; projectHit: boolean; rank: number | null; aiCited: boolean | null; measurementAt: string; provider: string; topSources: {position:number;title:string;url:string;domain:string;isHomonym:boolean}[]; evidencePath:string }
export interface GeoObservation { id:string; measurementAt:string; provider:string; comparableGroup:string; queryCount:number; hitCount:number; resultCount:number; rank:number|null; aiCited:boolean|null; sourcePath:string; comparabilityNote:string }
export interface GeoFinding { id:string; title:string; detail:string; evidencePaths:string[]; kind:string }
export interface GeoProposal { id:string; title:string; status:string; rationale:string; targetAssetId:string; targetUrl:string; before:string; after:string; changes:string[]; evidencePaths:string[]; successCriteria:string[]; limitations:string[] }
export interface GeoSeed { project:GeoProject; assets:GeoAsset[]; questions:GeoQuestion[]; observations:GeoObservation[]; findings:GeoFinding[]; gaps:any[]; proposal:GeoProposal; monitoringPlan:any; boundaries:any }

export type GeoStatus = 'queued' | 'investigating' | 'proposal_ready' | 'awaiting_implementation' | 'monitoring' | 'paused' | 'completed' | 'failed';
export interface GeoEvent { id:string; at:string; title:string; detail:string; kind:'info'|'success'|'attention'|'error' }
export interface GeoRun { id:string; at:string; completedAt?:string; measurementAt:string; mode:'replay'|'live'; status:'completed'|'partial'|'failed'; queryCount:number; completedCount:number; hitCount:number|null; resultCount:number; cost:number; summary:string; questions:GeoQuestion[]; error?:string; phase?:'baseline'|'followup'; protocolKey?:string; implementationRevision?:number }
export interface GeoMonitor { enabled:boolean; mode:'replay'|'live'; timeOfDay:string; days:number; remaining:number; nextRunAt:string|null; budgetLimit:number; spent:number; queryIds:string[]; lastRunAt:string|null }
export interface GeoTask { id:string; title:string; goal:string; status:GeoStatus; createdAt:string; updatedAt:string; blocks:WidgetBlock[]; events:GeoEvent[]; proposal:GeoProposal|null; implementation:{kind:'rehearsal'|'user_confirmed';note:string;url:string;at:string;proposalRevision?:number;proposalDigest?:string}|null; monitor:GeoMonitor; runs:GeoRun[]; source:'evidence'|'model'; error?:string; workflow?:GeoWorkflow; workflowHistory?:GeoWorkflow[] }
export interface GeoState extends GeoSeed { visibility:GeoVisibility; questionPlan:GeoQuestionPlan; tasks:GeoTask[]; strategies?:StrategyMemory[]; settings:{liveSearchConfigured:boolean;modelConfigured:boolean;modelName:string|null;mode:'demo';schedulerRunning:boolean} }

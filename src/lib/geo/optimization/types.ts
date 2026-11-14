import type { HumanProgressStep } from '../../agent-hub';
import type {
  DeliverableFormat,
  DeliverableKind,
  DeliverableStatus,
  OptimizationRunMode,
  OptimizationRunStatus,
} from '../db/schema';
import type { ResearchEngine } from '../research-types';

export interface ReferenceWinner {
  url: string;
  domain: string;
  title: string;
  citedEngines: ResearchEngine[];
  citedQuestionCount: number;
  probeStatus: 'full_read' | 'firecrawl_read' | 'local_fallback';
  headings: string[];
  openingParagraphs: string[];
  localSnippet: string;
  probedAt: string;
}

export interface DeliverableMediaItem {
  type: 'screenshot' | 'mermaid' | 'table';
  pathOrTitle: string;
  caption: string;
}

export interface RedLineCheck {
  passed: boolean;
  note: string;
}

export interface DeliverableReviewResult {
  verdict: 'pass' | 'veto';
  summary: string;
  checks: {
    authenticity: RedLineCheck;
    compliance: RedLineCheck;
    readability: RedLineCheck;
  };
  revisionRound: number;
  revisionInstructions: string[];
  reviewedAt: string;
  reviewerModel?: string;
}

export interface DeliverableCompanionFile {
  /** 相对仓库根目录的路径，如 README.zh-CN.md 或 docs/getting-started.zh-CN.md */
  path: string;
  /** 界面切换标签，如 "简体中文" */
  label: string;
  /** 语言代码，如 "zh-CN" */
  lang: string;
  /** 文件完整内容 */
  content: string;
  /** 推送到 GitHub 时要顺手清理的旧路径（如 ["README.en.md"]） */
  deletePaths?: string[];
  /** 仅用于工作台对照阅读或手动另发（如知乎/掘金/公众号），不写入本地仓库、不推送 GitHub */
  reviewOnly?: boolean;
}

export interface DeliverableAppliedRecord {
  appliedAt: string;
  mode: 'local_file' | 'external_published' | 'github_pushed';
  destination: string;
  publishedUrl?: string;
  commitHash?: string;
  branch?: string;
  pushedPaths?: string[];
  note?: string;
}

export interface OptimizationDeliverable {
  id: string;
  projectId: string;
  runId: string;
  priority: number;
  kind: DeliverableKind;
  format: DeliverableFormat;
  status: DeliverableStatus;
  title: string;
  targetAssetId: string | null;
  destination: string;
  audienceAndGoal: string;
  questionIds: string[];
  beforeContent: string;
  afterContent: string;
  mediaManifest: DeliverableMediaItem[];
  companionFiles: DeliverableCompanionFile[];
  referenceWinners?: ReferenceWinner[];
  review: DeliverableReviewResult | null;
  appliedRecord: DeliverableAppliedRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface OptimizationRun {
  id: string;
  projectId: string;
  mode: OptimizationRunMode;
  status: OptimizationRunStatus;
  statusMessage: string;
  summary: string;
  progress: HumanProgressStep[];
  baselineObservationIds: string[];
  followupObservationIds: string[];
  errorMessage: string | null;
  deliverables: OptimizationDeliverable[];
  createdAt: string;
  updatedAt: string;
}

export interface RetestQuestionComparison {
  questionId: string;
  query: string;
  engine: ResearchEngine;
  beforeMention: 'yes' | 'no' | 'unknown' | 'unmeasured';
  afterMention: 'yes' | 'no' | 'unknown' | 'unmeasured';
  beforeCitation: 'yes' | 'no' | 'unknown' | 'unmeasured';
  afterCitation: 'yes' | 'no' | 'unknown' | 'unmeasured';
  afterEvidence: string;
}

export interface RetestComparisonSummary {
  comparedCount: number;
  beforeMentionYes: number;
  afterMentionYes: number;
  beforeCitationYes: number;
  afterCitationYes: number;
  items: RetestQuestionComparison[];
}

export interface OptimizationRunViewModel {
  run: OptimizationRun | null;
  stageLabel: string;
  primaryAction: {
    kind: 'start_focus' | 'wait_working' | 'review_and_confirm' | 'run_retest' | 'retry' | 'view_result';
    label: string;
    description: string;
  };
  retestComparison: RetestComparisonSummary | null;
}

export const RUN_STATUS_LABELS: Record<OptimizationRunStatus, string> = {
  planning: '正在找突破口',
  drafting: '正在图文精写',
  reviewing: '正在三红线把关',
  awaiting_approval: '等你审阅拍板',
  implementing: '正在执行落地',
  awaiting_retest: '等待原题复测',
  remeasuring: '正在复测判卷',
  completed: '已完成前后对比',
  failed: '未能完成（可重试）',
};

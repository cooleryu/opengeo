export type BrowserCollectJobStatus =
  | 'idle'
  | 'running'
  | 'needs_handoff'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface BrowserCollectJobSnapshot {
  jobId: string | null;
  status: BrowserCollectJobStatus;
  projectId: string | null;
  engine: 'all' | 'chatgpt' | 'google';
  force?: boolean;
  batchStartedAt?: string | null;
  optimizationRunId: string | null;
  spaceId: number | null;
  completedCount: number;
  totalCount: number;
  currentIndex: number;
  currentQuestionId: string | null;
  currentEngine: 'chatgpt' | 'google' | null;
  currentQuery: string | null;
  waitSeconds: number | null;
  message: string;
  messageCode?: string;
  messageParams?: Record<string, string | number>;
  error: string | null;
  errorCode?: string | null;
  errorParams?: Record<string, string | number>;
  errorDetail?: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  busyOtherProjectId?: string | null;
}

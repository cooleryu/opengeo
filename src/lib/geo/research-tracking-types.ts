import type { MoneyBudget } from './research-budget';

export type ResearchScheduleStatus = 'active' | 'paused' | 'stopped' | 'budget_exhausted' | 'failed';

export interface ResearchSchedule {
  id: string;
  requestId: string;
  projectId: string;
  batchId: string;
  questionIds: string[];
  questions: { questionId: string; query: string }[];
  language: 'zh' | 'en';
  provider: 'deepseek';
  timeOfDay: string;
  timeZone: 'Asia/Shanghai';
  budget: MoneyBudget;
  limitCny: number;
  spentCny: number;
  reservedCny: number;
  status: ResearchScheduleStatus;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** A durable claim, retained until the associated run is reconciled. */
  activeRunId: string | null;
  activeRunReservationCny: number;
  activeRunConfirmedCny: number;
  ownerPid?: number;
}

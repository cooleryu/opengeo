export type ProjectEntryKind = 'repository' | 'store' | 'company' | 'creator';

export interface OnboardingAnalysis {
  summary: string;
  audience: string;
  capabilities: string[];
  unknowns: string[];
  sources?: { title: string; url: string }[];
}

export interface OnboardingRevision {
  id: string;
  feedback: string;
  createdAt: string;
  completedAt?: string;
  previousAnalysis: OnboardingAnalysis;
}

export interface OnboardingRecord {
  projectId: string;
  kind: ProjectEntryKind;
  url: string;
  notes: string;
  targetLanguage?: 'en' | 'zh';
  uiLanguage?: 'en' | 'zh';
  status: 'queued' | 'reading' | 'analyzing' | 'ready' | 'failed';
  message: string;
  createdAt: string;
  updatedAt: string;
  analysis?: OnboardingAnalysis;
  readLimitations?: string[];
  sourceReads?: { title: string; url: string; readAt: string }[];
  revision?: OnboardingRevision;
  revisionHistory?: OnboardingRevision[];
  error?: string;
}

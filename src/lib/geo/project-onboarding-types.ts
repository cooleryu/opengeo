import { parseGitHubRepoUrl } from './source-identity';

export type ProjectEntryKind = 'repository' | 'store' | 'company' | 'creator';

/** Infers open-source repository vs company/product site directly from the pasted entry URL. */
export function inferProjectEntryKind(rawUrl: string): 'repository' | 'company' {
  const parsed = parseGitHubRepoUrl(rawUrl, { allowSubpaths: true, allowSchemeless: true });
  return parsed ? 'repository' : 'company';
}

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
  messageCode?: string;
  messageParams?: Record<string, string | number>;
  createdAt: string;
  updatedAt: string;
  analysis?: OnboardingAnalysis;
  readLimitations?: string[];
  sourceReads?: { title: string; url: string; readAt: string }[];
  revision?: OnboardingRevision;
  revisionHistory?: OnboardingRevision[];
  error?: string;
  errorCode?: string;
  errorParams?: Record<string, string | number>;
  outputLanguage?: 'en' | 'zh';
}

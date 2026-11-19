export type ProjectEntryKind = 'repository' | 'store' | 'company' | 'creator';

const NON_REPO_GH_OWNERS = new Set([
  'topics',
  'orgs',
  'users',
  'features',
  'about',
  'collections',
  'sponsors',
  'marketplace',
  'explore',
  'settings',
  'search',
]);

/** Infers open-source repository vs company/product site directly from the pasted entry URL. */
export function inferProjectEntryKind(rawUrl: string): 'repository' | 'company' {
  const trimmed = rawUrl.trim();
  const match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/i);
  if (match && !NON_REPO_GH_OWNERS.has(match[1].toLowerCase())) {
    return 'repository';
  }
  return 'company';
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
  createdAt: string;
  updatedAt: string;
  analysis?: OnboardingAnalysis;
  readLimitations?: string[];
  sourceReads?: { title: string; url: string; readAt: string }[];
  revision?: OnboardingRevision;
  revisionHistory?: OnboardingRevision[];
  error?: string;
}

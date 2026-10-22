export type QuestionCategory = 'brand' | 'positioning' | 'problem' | 'content' | 'comparison' | 'boundary';
export type QuestionDecision = 'include' | 'explore' | 'exclude';

export const QUESTION_CATEGORY_LABELS: Record<QuestionCategory, string> = {
  brand: '品牌识别', positioning: '定位匹配', problem: '需求找方案',
  content: '已有内容发现', comparison: '比较选择', boundary: '操作与边界',
};

export interface QuestionCandidate {
  id: string;
  query: string;
  category: QuestionCategory;
  origin: 'existing' | 'curated' | 'model';
  originalQuestionId?: string;
  intent: string;
  target: 'project' | 'article';
  assetIds: string[];
  evidence: { assetId: string; quote: string }[];
  rationale: string;
  expectedResult: string;
  demandStatus: 'unverified';
  review: { decision: QuestionDecision; reason: string; concerns: string[] };
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
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateQuestionPlan } from './question-planner';
import type { GeoQuestionPlan, QuestionCandidate } from './question-types';
import type { ResearchBatch } from './research-types';
import type { GeoSeed } from './types';

const saveSchema = z.object({
  candidateId: z.string().min(1).max(180).optional(),
  sourceQuestionId: z.string().min(1).max(160).optional(),
  query: z.string().trim().min(3, '问题至少需要 3 个字。').max(300, '问题请控制在 300 字以内。'),
  queryEn: z.string().trim().max(300).optional(),
  category: z.enum(['brand', 'positioning', 'problem', 'content', 'comparison', 'boundary']),
  intent: z.string().trim().min(5, '请简要说明谁在什么情况下会问这个问题。').max(600),
  rationale: z.string().trim().min(5, '请简要说明为什么值得争取这个问题。').max(800),
  expectedResult: z.string().trim().min(5, '请简要说明希望找到什么帮助。').max(600),
  assetIds: z.array(z.string().min(1).max(160)).max(8),
});
const reviewInputSchema = z.object({
  candidateId: z.string().min(1).max(180),
  decision: z.enum(['include', 'explore', 'exclude']),
  reason: z.string().trim().min(5, '请写下人工审阅的判断依据，至少 5 个字。').max(900),
});

export type SaveQuestionInput = z.infer<typeof saveSchema>;
export type ReviewQuestionInput = z.infer<typeof reviewInputSchema>;

function editableCandidate(plan: GeoQuestionPlan, id: string): QuestionCandidate {
  const candidate = plan.candidates.find(item => item.id === id);
  if (!candidate) throw new Error('没有找到这道候选题。');
  if (candidate.supersededByCandidateId) throw new Error('这道问题已有新版本，请操作最新版本。');
  return candidate;
}

/** Saves a human draft without invoking a model or changing measured source questions. */
export function saveManualQuestion(plan: GeoQuestionPlan, seed: GeoSeed, input: unknown, research?: ResearchBatch | null): GeoQuestionPlan {
  const values = saveSchema.parse(input);
  const previous = values.candidateId ? editableCandidate(plan, values.candidateId) : undefined;
  const queryEn = values.queryEn === undefined ? previous?.queryEn : values.queryEn || undefined;
  if (queryEn && queryEn.length < 3) throw new Error('英文问法至少需要 3 个字符；未准备好可以留空。');
  if (new Set(values.assetIds).size !== values.assetIds.length) throw new Error('题目引用了重复的材料。');
  const assets = values.assetIds.map(id => {
    const asset = seed.assets.find(item => item.id === id);
    if (!asset) throw new Error('题目关联的材料不属于当前项目。');
    return asset;
  });
  const priorSourceId = previous?.sourceQuestionId || previous?.originalQuestionId;
  if (previous && values.sourceQuestionId && values.sourceQuestionId !== priorSourceId) throw new Error('编辑问题时不能更换原始来源。');
  const sourceQuestionId = priorSourceId || values.sourceQuestionId;
  let sourceResearchBatchId = previous?.sourceResearchBatchId;
  if (!previous && sourceQuestionId) {
    const researchSource = research?.projectId === seed.project.id && [...research.questions, ...research.deferredQuestions].some(item => item.id === sourceQuestionId);
    if (researchSource) sourceResearchBatchId = research!.id;
    else if (!seed.questions.some(item => item.id === sourceQuestionId)) throw new Error('来源问题不属于当前项目。');
  }
  const unchanged = previous && previous.query === values.query && previous.queryEn === queryEn &&
    previous.category === values.category && previous.intent === values.intent && previous.rationale === values.rationale &&
    previous.expectedResult === values.expectedResult && previous.assetIds.length === values.assetIds.length &&
    previous.assetIds.every(id => values.assetIds.includes(id));
  if (unchanged) return plan;

  const candidate: QuestionCandidate = {
    id: `manual-${randomUUID()}`, query: values.query, ...(queryEn ? { queryEn } : {}),
    category: values.category, origin: 'manual',
    ...(sourceQuestionId ? { sourceQuestionId } : {}), ...(sourceResearchBatchId ? { sourceResearchBatchId } : {}),
    ...(previous ? { supersedesCandidateId: previous.id } : {}),
    intent: values.intent, rationale: values.rationale, expectedResult: values.expectedResult,
    target: values.category === 'brand' || values.category === 'positioning' ? 'project' : 'article',
    assetIds: [...values.assetIds],
    evidence: assets.flatMap(asset => {
      const text = asset.summary.trim().length >= 12 ? asset.summary.trim() : asset.markdown.trim();
      return text.length >= 12 ? [{ assetId: asset.id, quote: text.slice(0, 700) }] : [];
    }),
    demandStatus: 'unverified', selected: false,
    review: {
      decision: 'explore', reason: '人工保存的候选问题，等待人工审阅；尚未经过 AI 审核。',
      concerns: ['关联材料仅说明已有内容，不能证明真实搜索需求或完整承接能力。'], source: 'manual', status: 'pending',
    },
  };
  return validateQuestionPlan({
    ...plan, status: 'draft',
    candidates: [...plan.candidates.map(item => item.id === previous?.id ? { ...item, selected: false, supersededByCandidateId: candidate.id } : item), candidate],
  }, seed);
}

/** A review records the user's decision; it does not silently select a new question. */
export function reviewManualQuestion(plan: GeoQuestionPlan, seed: GeoSeed, input: unknown, reviewedAt = new Date().toISOString()): GeoQuestionPlan {
  const values = reviewInputSchema.parse(input);
  const candidate = editableCandidate(plan, values.candidateId);
  return validateQuestionPlan({
    ...plan, status: 'draft', candidates: plan.candidates.map(item => item.id !== candidate.id ? item : {
      ...item, selected: values.decision === 'exclude' ? false : item.selected,
      review: { decision: values.decision, reason: values.reason, concerns: [...item.review.concerns], source: 'manual', status: 'reviewed', reviewedAt },
    }),
  }, seed);
}

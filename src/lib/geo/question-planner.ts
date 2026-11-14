import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { readAgentParameters, readAgentText } from './agent-files';
import { getProjectOnboardingPlanningContext } from './project-onboarding-store';
import { projectResearchContext } from './project-research-context';
import type { GeoAsset, GeoSeed } from './types';
import { resolveAssetOwnership } from './asset-ownership';
import type { GeoQuestionPlan, QuestionCandidate, QuestionCategory, QuestionGenerationCheckpoint, QuestionGenerationProgress } from './question-types';
import type { GeoStructuredModel } from './connection-settings';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel from './chatgpt-model';

const callOptionsSchema = z.object({
  temperature: z.number().min(0).max(2), maxTokens: z.number().int().positive(),
}).strict();
const parametersSchema = z.object({
  maxNewCandidates: z.number().int().positive().max(100),
  maxInputBytes: z.number().int().positive().max(48 * 1024),
  subscriptionTimeoutMs: z.number().int().positive(),
  maxConcurrency: z.number().int().positive().max(3).default(3),
  materials: z.object({
    maxTotalCharacters: z.number().int().positive(),
    maxCharactersPerAsset: z.number().int().positive(),
  }).strict(),
  planning: callOptionsSchema, propose: callOptionsSchema, review: callOptionsSchema,
}).strict();

const categorySchema = z.enum(['brand', 'positioning', 'problem', 'content', 'comparison', 'boundary']);
const decisionSchema = z.enum(['include', 'explore', 'exclude']);
const evidenceSchema = z.object({ assetId: z.string().min(1).max(160), quote: z.string().min(12).max(700) }).strict();
const draftSchema = z.object({
  query: z.string().trim().min(3).max(300), category: categorySchema,
  intent: z.string().min(5).max(600), target: z.enum(['project', 'article']),
  assetIds: z.array(z.string().min(1).max(160)).max(8),
  evidence: z.array(evidenceSchema).max(8),
  rationale: z.string().min(5).max(800), expectedResult: z.string().min(5).max(600),
}).strict();
const prioritySchema = z.enum(['high', 'medium', 'low']);
const reviewSchema = z.object({ decision: decisionSchema, priority: prioritySchema.optional(), reason: z.string().min(5).max(900), concerns: z.array(z.string().min(1).max(400)).max(8) }).strict();
const assessmentSchema = z.object({
  worthPursuing: z.object({
    verdict: z.enum(['yes', 'uncertain', 'no']), reason: z.string().min(5).max(800),
    demandBasis: z.enum(['user-provided', 'public-observation', 'inferred', 'unknown']),
    basis: z.string().min(5).max(800),
  }).strict(),
  currentSupport: z.object({ level: z.enum(['supported', 'partial', 'unverified', 'missing']), reason: z.string().min(5).max(800) }).strict()
    .describe('只能包含 level 和 reason。引用放在 assessment.evidence，缺口放在 assessment.gaps，不能嵌套到 currentSupport。'),
  evidence: z.array(evidenceSchema).max(8).describe('assessment 顶层的共享原文依据，与 worthPursuing、currentSupport、gaps 平级。'),
  gaps: z.array(z.object({ kind: z.enum(['content', 'evidence', 'capability', 'investigation']), description: z.string().min(5).max(400) }).strict()).max(8),
}).strict();
const modelReviewSchema = reviewSchema.extend({ priority: prioritySchema, assessment: assessmentSchema });
// Providers parse this schema before returning. Keep both wire shapes JSON-Schema
// representable; only the observed evidence relocation is accepted, never extra keys.
const nestedEvidenceAssessmentSchema = assessmentSchema.omit({ evidence: true }).extend({
  currentSupport: assessmentSchema.shape.currentSupport.extend({ evidence: assessmentSchema.shape.evidence })
    .describe('兼容结构：仅当 assessment 没有 evidence 时，可将同一证据数组放在这里；程序会无损移到 assessment.evidence 后再次校验。'),
}).strict();
const wireModelReviewSchema = reviewSchema.extend({
  priority: prioritySchema,
  assessment: z.union([assessmentSchema, nestedEvidenceAssessmentSchema]),
});

function normalizeModelReview(input: z.infer<typeof wireModelReviewSchema>) {
  const assessment = input.assessment;
  if ('evidence' in assessment) return modelReviewSchema.parse(input);
  const { evidence, ...currentSupport } = assessment.currentSupport;
  return modelReviewSchema.parse({ ...input, assessment: { ...assessment, currentSupport, evidence } });
}
const candidateSchema = draftSchema.extend({
  id: z.string().min(1).max(180), origin: z.enum(['existing', 'curated', 'model', 'manual']),
  queryEn: z.string().trim().min(3).max(300).optional(),
  originalQuestionId: z.string().max(160).optional(),
  sourceQuestionId: z.string().min(1).max(160).optional(),
  sourceResearchBatchId: z.string().min(1).max(180).optional(),
  supersedesCandidateId: z.string().min(1).max(180).optional(),
  supersededByCandidateId: z.string().min(1).max(180).optional(),
  demandStatus: z.literal('unverified'), review: reviewSchema.extend({
    source: z.enum(['manual', 'model', 'curated']).optional(),
    status: z.enum(['pending', 'reviewed']).optional(), reviewedAt: z.string().datetime().optional(),
    assessment: assessmentSchema.optional(),
  }), selected: z.boolean(),
}).strict();
const needSchema = z.object({
  id: z.string().min(1).max(80), title: z.string().min(2).max(120), audience: z.string().min(2).max(200),
  trigger: z.string().min(5).max(300), importance: prioritySchema, assetIds: z.array(z.string().min(1).max(160)).max(8),
}).strict();
const advantageSchema = z.object({ description: z.string().min(5).max(400), assetIds: z.array(z.string().min(1).max(160)).max(8) }).strict();
const setReviewSchema = z.object({
  selectedIds: z.array(z.string().min(1).max(180)).max(8),
  coverage: z.array(z.object({ needId: z.string().min(1).max(80), candidateIds: z.array(z.string().min(1).max(180)).max(8),
    status: z.enum(['covered', 'missing', 'deferred']), reason: z.string().min(5).max(500),
  }).strict()).max(22),
  missingAdditionalNeeds: z.array(needSchema).max(3),
  duplicates: z.array(z.object({ candidateIds: z.array(z.string().min(1).max(180)).min(2).max(100), reason: z.string().min(5).max(400) }).strict()).max(30),
  reason: z.string().min(5).max(1000),
}).strict();
const coverageReviewSchema = setReviewSchema.omit({ missingAdditionalNeeds: true }).extend({
  needs: z.array(needSchema).max(22), selectionAdvantages: z.array(advantageSchema).max(8),
  status: z.enum(['complete', 'incomplete']), refinementRounds: z.union([z.literal(0), z.literal(1)]),
}).strict();
const planSchema = z.object({
  id: z.string().min(1).max(180), projectId: z.string().min(1).max(160),
  revision: z.number().int().positive(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  source: z.enum(['curated', 'model']), status: z.enum(['draft', 'ready']),
  positioning: z.string().trim().min(5).max(1000),
  candidates: z.array(candidateSchema).max(100), notes: z.array(z.string().max(1000)).max(15),
  coverageReview: coverageReviewSchema.optional(),
}).strict();

const compact = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const queryKey = (value: string) => compact(value);

class EvidenceQuoteError extends Error {
  constructor(message: string, candidateId: string, evidence: z.infer<typeof evidenceSchema>) {
    super(`${message}（问题 ${candidateId}，材料 ${evidence.assetId}，摘录：${JSON.stringify(evidence.quote)}）`);
  }
}

function publicAsset(asset: GeoAsset, seed: GeoSeed) {
  try {
    const url = new URL(asset.publicUrl || '');
    return resolveAssetOwnership(asset, seed).ownership === 'owned' &&
      asset.status === 'published' && ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}

function identityTerms(seed: GeoSeed) {
  const terms = [seed.project.name, seed.project.id, seed.project.owner];
  for (const value of [seed.project.siteUrl, seed.project.repositoryUrl,
    ...seed.assets.filter(asset => resolveAssetOwnership(asset, seed).ownership === 'owned').map(asset => asset.publicUrl)]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      terms.push(url.hostname + url.pathname);
      if (['x.com', 'twitter.com', 'github.com'].includes(url.hostname)) terms.push(url.pathname.split('/')[1]);
    } catch { /* Malformed source URLs cannot support a public result. */ }
  }
  return terms.map(compact).filter(term => term.length >= 3);
}

function copiesPositioning(query: string, positioning: string) {
  const words = positioning.toLowerCase().match(/[a-z0-9]+/g) || [];
  const queryWords = (query.toLowerCase().match(/[a-z0-9]+/g) || []).join(' ');
  for (let i = 0; i + 8 <= words.length; i++) {
    if (queryWords.includes(words.slice(i, i + 8).join(' '))) return true;
  }
  const queryCompact = compact(query);
  for (const phrase of positioning.match(/[\p{Script=Han}]{20,}/gu) || []) {
    for (let i = 0; i + 20 <= phrase.length; i++) {
      if (queryCompact.includes(phrase.slice(i, i + 20))) return true;
    }
  }
  return false;
}

/** Hard guards are independent of the model review. This returns a copy; seed/history are never changed. */
export function validateQuestionPlan(input: unknown, seed: GeoSeed): GeoQuestionPlan {
  const { maxNewCandidates } = readAgentParameters('question-planning', parametersSchema);
  const plan = planSchema.parse(input);
  if (plan.projectId !== seed.project.id) throw new Error('题单与当前项目不匹配。');
  if ((plan.positioning.match(/\S+/g) || []).length > 100) throw new Error('定位请控制在 100 个词以内。');
  const assets = new Map(seed.assets.map(asset => [asset.id, asset]));
  const history = new Map(seed.questions.map(question => [question.id, question]));
  const seen = new Set<string>();
  const seenQueries = new Set<string>();
  const historyIds = new Set<string>();
  const identities = identityTerms(seed);
  let newCount = 0;

  for (const candidate of plan.candidates) {
    if (seen.has(candidate.id)) throw new Error('题目 ID 重复。');
    seen.add(candidate.id);
    if (candidate.origin === 'existing') {
      const original = history.get(candidate.originalQuestionId || '');
      if (!original || original.query !== candidate.query || historyIds.has(original.id)) throw new Error('历史题目关联或原文不正确。');
      historyIds.add(original.id);
    } else {
      if (candidate.origin !== 'manual' && !candidate.supersededByCandidateId) newCount++;
      if (candidate.originalQuestionId) throw new Error('新问题不能冒充历史题目。');
    }
    if (newCount > maxNewCandidates) throw new Error(`每份题单最多增加 ${maxNewCandidates} 道新问题。`);
    const key = queryKey(candidate.query);
    if (!candidate.supersededByCandidateId) {
      if (seenQueries.has(key)) throw new Error('题目内容重复。');
      seenQueries.add(key);
    }
    if (new Set(candidate.assetIds).size !== candidate.assetIds.length) throw new Error('题目引用了重复的材料。');
    for (const assetId of candidate.assetIds) {
      if (!assets.has(assetId)) throw new Error(`题目引用了不存在的材料：${assetId}`);
    }
    for (const evidence of candidate.evidence) {
      const asset = assets.get(evidence.assetId);
      if (!asset || !candidate.assetIds.includes(evidence.assetId)) throw new Error('证据未关联到题目材料。');
      if (!asset.markdown.includes(evidence.quote) && !asset.summary.includes(evidence.quote)) throw new EvidenceQuoteError('证据摘录必须是材料正文或摘要的原文，不能编造。', candidate.id, evidence);
    }
    for (const evidence of candidate.review.assessment?.evidence ?? []) {
      const asset = assets.get(evidence.assetId);
      if (!asset || (!asset.markdown.includes(evidence.quote) && !asset.summary.includes(evidence.quote))) throw new EvidenceQuoteError('复评证据摘录必须来自当前项目材料原文，不能编造。', candidate.id, evidence);
    }
    const problems: string[] = [];
    for (const query of [candidate.query, candidate.queryEn].filter((value): value is string => Boolean(value))) {
      if (candidate.category === 'brand') {
        if (!identities.some(term => queryKey(query).includes(term))) problems.push('品牌识别题必须明确包含本项目身份。');
      } else {
        if (identities.some(term => queryKey(query).includes(term))) problems.push('无品牌问题包含项目名、作者或官方地址，不能作为独立发现题。');
        if (copiesPositioning(query, plan.positioning)) problems.push('问题直接复制了定位长句，需要改成自然的用户问法。');
      }
    }
    const gaps: string[] = [];
    const supportEvidence = [...candidate.evidence, ...(candidate.review.assessment?.evidence ?? [])];
    const supportIds = [...new Set([...candidate.assetIds, ...supportEvidence.map(item => item.assetId)])];
    if (!supportIds.length || !supportIds.every(id => supportEvidence.some(item => item.assetId === id))) {
      gaps.push('尚无逐项对应的材料证据。');
    }
    if (!supportIds.some(id => publicAsset(assets.get(id)!, seed))) gaps.push('尚无记载为已发布的公开内容承接这道问题。');
    const manuallyManaged = candidate.review.source === 'manual' || (candidate.origin === 'manual' && candidate.review.source !== 'model');
    if (manuallyManaged) {
      if (problems.length && candidate.review.status !== 'pending' && candidate.review.decision !== 'exclude') throw new Error(`请先修改问题：${problems.join(' ')}`);
      candidate.review.concerns = [...new Set([...candidate.review.concerns, ...problems, ...gaps, ...(gaps.length ? ['材料缺口与需求价值分别判断；尚未关联内容不代表问题不值得争取。'] : [])])].slice(0, 8);
    } else {
      candidate.review.concerns = [...new Set([...candidate.review.concerns, ...problems, ...gaps, ...(gaps.length ? ['材料缺口与需求价值分别判断；尚未关联内容不代表问题不值得争取。'] : [])])].slice(0, 8);
      if (problems.length) candidate.review = { ...candidate.review, decision: 'exclude', reason: [...new Set(problems)].join(' ') };
    }
    // Exploration starts unselected, but an explicit user selection may retain it for separate measurement.
    if (candidate.review.decision === 'exclude' || candidate.review.status === 'pending' || candidate.supersededByCandidateId) candidate.selected = false;
  }
  for (const [index, candidate] of plan.candidates.entries()) {
    if (candidate.supersedesCandidateId) {
      const previousIndex = plan.candidates.findIndex(item => item.id === candidate.supersedesCandidateId);
      if (previousIndex < 0 || previousIndex >= index || plan.candidates[previousIndex].supersededByCandidateId !== candidate.id) throw new Error('问题版本来源关联不正确。');
    }
    if (candidate.supersededByCandidateId && !plan.candidates.some(item => item.id === candidate.supersededByCandidateId && item.supersedesCandidateId === candidate.id)) throw new Error('问题后续版本关联不正确。');
  }
  if (historyIds.size !== history.size) throw new Error('题单必须保留全部历史题目及来源关联。');
  if (plan.coverageReview) {
    const audit = plan.coverageReview;
    if (new Set(audit.needs.map(need => need.id)).size !== audit.needs.length) throw new Error('整组审核保存的需求 ID 重复。');
    for (const item of [...audit.needs, ...audit.selectionAdvantages]) {
      if (new Set(item.assetIds).size !== item.assetIds.length || item.assetIds.some(id => !assets.has(id))) throw new Error('整组审核保存的材料关联不正确。');
    }
    validateSetReview({ ...audit, missingAdditionalNeeds: [] }, audit.needs, plan.candidates);
    const expectedStatus = audit.needs.some(need => need.importance === 'high' && audit.coverage.some(item => item.needId === need.id && item.status === 'missing')) ? 'incomplete' : 'complete';
    if (audit.status !== expectedStatus) throw new Error('整组审核的完成状态与重要需求遗漏不一致。');
    const selected = plan.candidates.filter(candidate => candidate.selected).map(candidate => candidate.id).sort();
    if (!isDeepStrictEqual(selected, [...audit.selectedIds].sort())) throw new Error('问题选择已经改变，需要移除过期的整组审核结论。');
  }
  return plan;
}

function cited(seed: GeoSeed, assetIds: string[]) {
  const available = assetIds.flatMap(id => {
    const asset = seed.assets.find(item => item.id === id);
    return asset ? [asset] : [];
  });
  return { assetIds: available.map(asset => asset.id), evidence: available.map(asset => ({ assetId: asset.id, quote: asset.summary || asset.markdown.slice(0, 300) })) };
}

/** Deterministic, manually curated starting point. It does not call an AI or a search provider. */
export function buildInitialQuestionPlan(seed: GeoSeed): GeoQuestionPlan {
  const positioning = seed.project.description;
  const localPlan = (seed as GeoSeed & { initialQuestionPlan?: {
    additions?: Array<{ id: string; query: string; category: QuestionCategory; target: 'project' | 'article'; ids: string[]; intent: string }>;
    reviews?: Record<string, { category: QuestionCategory; selected: boolean; decision: QuestionCandidate['review']['decision']; reason: string }>;
  } }).initialQuestionPlan;

  const candidates: QuestionCandidate[] = seed.questions.map(question => {
    const brand = question.tier === 'L1' || identityTerms(seed).some(term => queryKey(question.query).includes(term));
    const savedReview = localPlan?.reviews?.[question.id];
    const category: QuestionCategory = savedReview?.category || (brand ? 'brand' : 'content');
    return {
      id: question.id, originalQuestionId: question.id, origin: 'existing', query: question.query, category,
      intent: brand ? '已知品牌后，查找正确的项目入口并区分同名对象。' : '寻找能够回答当前技术问题的文章或研究材料。',
      target: brand ? 'project' : 'article', ...cited(seed, question.matchingAssetIds || []),
      rationale: brand ? '品牌识别是基础检查，命中仍需实际测量。' : '保留旧题和历史来源；评估文章发现，不把文章主题当成产品已经具备的能力。',
      expectedResult: brand ? '出现本项目的官方入口或正确介绍；同名论文不算本项目。' : '相关公开文章被返回或引用；不要求一定推荐本项目作为产品方案。',
      demandStatus: 'unverified', selected: savedReview?.selected ?? true,
      review: {
        decision: savedReview?.decision || 'include',
        reason: savedReview?.reason || (brand ? '有明确身份与公开入口，可作为品牌基础检查；不承诺命中。' : '有对应公开文章，适合检查内容发现；仍未验证真实用户需求。'),
        concerns: ['题目需求尚未经外部搜索行为或用户反馈验证。'],
      },
    };
  });
  for (const addition of localPlan?.additions || []) candidates.push({
      id: addition.id, query: addition.query, category: addition.category, target: addition.target, intent: addition.intent,
      origin: 'curated', ...cited(seed, addition.ids),
      rationale: '由现有公开材料人工整理的候选问法，与历史命中情况无关；材料支持相关性，不证明存在搜索需求。',
      expectedResult: addition.target === 'project' ? '发现定位相关的研究项目；不宣称已有普适有效的商用解决方案。' : '返回或引用对应文章中的解释、方法和有边界的实验证据。',
      demandStatus: 'unverified', selected: true,
      review: { decision: 'include', reason: '材料覆盖问题的主要意图，且没有带入品牌身份；可纳入待测题单。', concerns: ['问法为人工假设，尚未取得真实需求证据。', '是否能被发现尚未测量。'] },
    });
  const at = `${seed.project.asOf.slice(0, 10)}T00:00:00.000Z`;
  return validateQuestionPlan({
    id: `${seed.project.id}-question-plan`, projectId: seed.project.id, revision: 1, createdAt: at, updatedAt: at,
    source: 'curated', status: 'draft', positioning, candidates,
    notes: ['人工整理的初始题单，未调用 AI、未发起新搜索。', '旧题完整保留；题单选择不会改变历史测量。', '全部需求状态仍未验证；公开状态来自导入材料，未重新检查页面。', '文章发现与项目发现分开解释；品牌和定位都不保证命中。'],
  }, seed);
}

type PlanningParameters = z.infer<typeof parametersSchema>;
export type QuestionPlanningProgress = QuestionGenerationProgress;
type PlanningRuntime = {
  model?: GeoStructuredModel; onProgress?: (progress: QuestionPlanningProgress) => void;
  /** Server-only checkpoints. The caller must verify the source job's input fingerprint and base plan. */
  resume?: readonly QuestionGenerationCheckpoint[];
};
type TrackedPlanningRuntime = PlanningRuntime & { onActivity?: (activity: NonNullable<QuestionPlanningProgress['request']>) => void };

function trackPlanningRuntime(runtime: PlanningRuntime, initial: Pick<QuestionPlanningProgress, 'stage' | 'message'> & { stage: 'planning' | 'generating' | 'reviewing' | 'saving' }): TrackedPlanningRuntime {
  let current: Pick<QuestionPlanningProgress, 'stage' | 'message' | 'workflowStep'> = { ...initial, workflowStep: initial.stage };
  return { ...runtime,
    onProgress(progress) {
      const workflowStep = progress.workflowStep ?? (['planning', 'generating', 'reviewing', 'saving'].includes(progress.stage)
        ? progress.stage as NonNullable<QuestionPlanningProgress['workflowStep']> : current.workflowStep);
      // A checkpoint describes one completed batch, not every in-flight request.
      if (!progress.checkpoint) current = { stage: progress.stage, message: progress.message, workflowStep };
      runtime.onProgress?.({ ...progress, workflowStep });
    },
    onActivity(request) { runtime.onProgress?.({ ...current, request }); },
  };
}

async function planningModel(runtime: TrackedPlanningRuntime, parameters: PlanningParameters): Promise<GeoStructuredModel> {
  if (runtime.model) return runtime.model;
  const { loadGeoModel, shouldUseChatGPTSubscription } = await import('./connection-settings');
  return shouldUseChatGPTSubscription(getChatGPTStatus()) ? new ChatGPTModel({ timeoutMs: parameters.subscriptionTimeoutMs, onActivity: runtime.onActivity }) : loadGeoModel();
}

function projectContext(seed: GeoSeed, positioning: string) {
  const { id, name, owner, description, siteUrl, repositoryUrl, targetLanguage } = seed.project;
  const understanding = getProjectOnboardingPlanningContext(id);
  const research = projectResearchContext(id);
  return {
    project: {
      id,
      name,
      owner,
      description,
      siteUrl,
      repositoryUrl,
      ...(targetLanguage ? { targetLanguage } : {}),
    },
    positioning,
    ...(understanding ? { projectUnderstanding: understanding } : {}),
    ...(research ? { projectResearch: research } : {}),
  };
}

function reviewCandidateInput(candidate: QuestionCandidate) {
  const { id, query, queryEn, category, intent, target, assetIds, evidence, expectedResult } = candidate;
  // Generation reasoning, previous verdicts and selection stay out of independent review.
  return { id, query, queryEn, category, intent, target, assetIds, evidence, expectedResult };
}

/** Bound the full business prompt in UTF-8 bytes, including metadata and role rules. */
function boundedContext(seed: GeoSeed, base: Record<string, unknown>, system: string, parameters: PlanningParameters, preferredIds: string[] = []) {
  let remaining = parameters.materials.maxTotalCharacters;
  const ordered = [...seed.assets].sort((a, b) => Number(preferredIds.includes(b.id)) - Number(preferredIds.includes(a.id)));
  const materials = ordered.map(asset => ({
    id: asset.id, title: asset.title, status: asset.status, publicUrl: asset.publicUrl,
    ...resolveAssetOwnership(asset, seed),
    summary: asset.summary, markdown: '',
    markdownIsExcerpt: Boolean((asset as GeoAsset & { markdownIsExcerpt?: boolean }).markdownIsExcerpt),
    originalCharacters: asset.markdown.length, providedCharacters: 0, truncated: asset.markdown.length > 0,
  }));
  const context = { ...base, materials };
  const fits = () => Buffer.byteLength(system, 'utf8') + Buffer.byteLength(JSON.stringify(context), 'utf8') <= parameters.maxInputBytes;
  if (!fits()) throw new Error('问题审核的必要信息超过输入预算；本次未调用模型，请缩小材料或候选范围。');
  for (const [index, asset] of ordered.entries()) {
    const material = materials[index];
    const limit = Math.min(asset.markdown.length, parameters.materials.maxCharactersPerAsset, remaining);
    const setLength = (length: number) => {
      material.markdown = asset.markdown.slice(0, length);
      material.providedCharacters = length;
      material.truncated = length !== asset.markdown.length;
    };
    let low = 0;
    let high = limit;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      setLength(mid);
      if (fits()) low = mid;
      else high = mid - 1;
    }
    // Avoid splitting a surrogate pair when truncating non-BMP text.
    if (low < asset.markdown.length && low > 0 && /[\uD800-\uDBFF]/.test(asset.markdown[low - 1])) low--;
    setLength(low);
    remaining -= low;
  }
  return context;
}

function providedEvidence(evidence: z.infer<typeof evidenceSchema>, context: ReturnType<typeof boundedContext>, candidates: ReturnType<typeof reviewCandidateInput>[] = []) {
  const asset = context.materials.find(item => item.id === evidence.assetId);
  const providedQuote = candidates.some(candidate => candidate.evidence.some(item => item.assetId === evidence.assetId && item.quote.includes(evidence.quote)));
  return Boolean(asset && (asset.markdown.includes(evidence.quote) || asset.summary.includes(evidence.quote) || providedQuote));
}

function validateModelReview(review: z.infer<typeof reviewSchema> & { assessment: z.infer<typeof assessmentSchema> }, context: ReturnType<typeof boundedContext>, candidates: ReturnType<typeof reviewCandidateInput>[], candidateId: string) {
  const assessment = review.assessment;
  if ((review.decision === 'exclude') !== (assessment.worthPursuing.verdict === 'no')) throw new Error('复评结论与争取价值不一致；不能仅因承接不足排除问题。');
  for (const evidence of assessment.evidence) {
    if (!providedEvidence(evidence, context, candidates)) throw new EvidenceQuoteError('复评引用了未提供的材料原文，不能保存。', candidateId, evidence);
  }
  if (assessment.worthPursuing.demandBasis === 'public-observation' && !assessment.evidence.length) throw new Error('公开观测的需求依据必须附材料原文；推导不能冒充公开观测。');
  if (assessment.currentSupport.level !== 'unverified' && !assessment.evidence.length) throw new Error('确认承接程度必须附材料原文；没有依据时应保留为尚未核实。');
  if (assessment.currentSupport.level !== 'supported' && !assessment.gaps.length) throw new Error('承接不足或尚未核实的复评必须说明具体缺口。');
}

/** Repair only invalid quote slots, once. Questions, judgments, evidence count and source IDs stay intact. */
async function validateWithEvidenceRepair(
  candidates: QuestionCandidate[], validate: (items: QuestionCandidate[]) => QuestionCandidate[],
  scope: 'draft' | 'review', context: ReturnType<typeof boundedContext>,
  seed: GeoSeed, model: GeoStructuredModel, parameters: PlanningParameters, runtime: PlanningRuntime,
): Promise<QuestionCandidate[]> {
  let originalError: EvidenceQuoteError;
  try { return validate(candidates); } catch (error) {
    if (!(error instanceof EvidenceQuoteError)) throw error;
    originalError = error;
  }
  const providedCandidates = scope === 'review' ? candidates.map(reviewCandidateInput) : [];
  const failures = candidates.flatMap(candidate => {
    const evidence = scope === 'draft' ? candidate.evidence : candidate.review.assessment?.evidence ?? [];
    return evidence.flatMap((item, evidenceIndex) => providedEvidence(item, context, providedCandidates) ? [] : [{
      candidateId: candidate.id, query: candidate.query, intent: candidate.intent,
      evidenceIndex, assetId: item.assetId, quote: item.quote,
    }]);
  });
  if (!failures.length || failures.some(failure => !context.materials.some(asset => asset.id === failure.assetId))) throw originalError;
  const ids = new Set(failures.map(failure => failure.assetId));
  // Reuse only the excerpts already supplied to this stage, never fetch or expose omitted text.
  const repairSeed = { ...seed, assets: seed.assets.filter(asset => ids.has(asset.id)).map(asset => {
    const supplied = context.materials.find(item => item.id === asset.id)!;
    return { ...asset, markdown: supplied.markdown, summary: supplied.summary, markdownIsExcerpt: supplied.markdownIsExcerpt || supplied.truncated };
  }) };
  const providedCandidateEvidence = providedCandidates.flatMap(candidate => candidate.evidence.filter(item => ids.has(item.assetId)));
  const system = readAgentText('question-planning', 'repair-evidence.md');
  const repairContext = boundedContext(repairSeed, { failures, providedCandidateEvidence }, system, parameters);
  const correctionSchema = z.object({ corrections: z.array(z.object({
    candidateId: z.string().min(1).max(180), evidenceIndex: z.number().int().nonnegative(),
    assetId: evidenceSchema.shape.assetId, quote: evidenceSchema.shape.quote.nullable(),
  }).strict()).length(failures.length) }).strict();
  runtime.onProgress?.({ stage: 'repairing', message: scope === 'draft' ? '正在核对并修正问题依据中的原文摘录。' : '正在核对并修正审核依据中的原文摘录。' });
  let result: z.infer<typeof correctionSchema>;
  try {
    result = correctionSchema.parse(await model.generateObject({
      schema: correctionSchema, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(repairContext) }],
      options: parameters.review,
    }));
  } catch (error) {
    throw new Error(`${originalError.message} 原文修正未完成，题单未保存。`, { cause: error });
  }
  const repaired = structuredClone(candidates);
  const applied = new Set<string>();
  for (const correction of result.corrections) {
    const failure = failures.find(item => item.candidateId === correction.candidateId && item.evidenceIndex === correction.evidenceIndex);
    const key = `${correction.candidateId}:${correction.evidenceIndex}`;
    if (!failure || applied.has(key) || correction.assetId !== failure.assetId) throw new Error('原文修正未逐项对应失败摘录，题单未保存。');
    if (!correction.quote) throw new EvidenceQuoteError('未找到能够替换失败摘录的原文，题单未保存。', failure.candidateId, failure);
    const evidence = { assetId: correction.assetId, quote: correction.quote };
    if (!providedEvidence(evidence, repairContext, providedCandidates)) throw new EvidenceQuoteError('修正后的摘录仍不是所提供材料的原文，题单未保存。', failure.candidateId, evidence);
    const candidate = repaired.find(item => item.id === correction.candidateId)!;
    (scope === 'draft' ? candidate.evidence : candidate.review.assessment!.evidence)[correction.evidenceIndex] = evidence;
    applied.add(key);
  }
  runtime.onProgress?.({ stage: 'checking', message: '正在重新核对原文依据和问题规则。' });
  return validate(repaired);
}

function planningRules(seed: GeoSeed): string {
  const base = readAgentText('question-planning', 'common.md');
  if (seed.project.targetLanguage !== 'en') return base;
  let explainInEn = true;
  try {
    const understanding = getProjectOnboardingPlanningContext(seed.project.id);
    if (understanding?.outputLanguage === 'zh') explainInEn = false;
  } catch { /* Onboarding context may be absent or incomplete. */ }
  return `${base}\n\nMANDATORY LANGUAGE RULE: project.targetLanguage is "en". Every candidate "query" MUST be a natural, idiomatic English question that an overseas developer or buyer would type into ChatGPT or Google (zero Chinese characters in "query").${explainInEn ? ' Write all needs, selectionAdvantages, directions, intent, rationale, expectedResult, reason, concerns, and assessment text fields in concise English.' : ''} Keep every evidence.quote as an exact verbatim substring copied character-for-character from the provided source markdown or summary (never translate or paraphrase quotes). In review outputs, currentSupport MUST ONLY contain keys "level" and "reason" (NEVER include "evidence" or "gaps" inside currentSupport; put shared evidence ONLY in assessment.evidence and gaps ONLY in assessment.gaps).`;
}

/** One explicit review, with at most one quote repair; no generation/search/persistence. */
export async function reviewQuestionCandidate(seed: GeoSeed, plan: GeoQuestionPlan, candidateId: string, runtime: PlanningRuntime = {}): Promise<GeoQuestionPlan> {
  runtime = trackPlanningRuntime(runtime, { stage: 'reviewing', message: '正在独立审核这道问题的价值和现有依据。' });
  const candidate = plan.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new Error('没有找到这道候选题。');
  if (candidate.supersededByCandidateId) throw new Error('这道问题已有新版本，请操作最新版本。');
  // Validate source identity/evidence before a paid call, without adopting normalization of other questions.
  validateQuestionPlan(plan, seed);
  const { coverageReview: _coverageReview, ...withoutSetReview } = plan;
  const parameters = readAgentParameters('question-planning', parametersSchema);
  const system = readAgentText('question-planning', 'review.md').replace('{{common}}', planningRules(seed));
  const candidates = [reviewCandidateInput(candidate)];
  const context = boundedContext(seed, { ...projectContext(seed, plan.positioning), candidates }, system, parameters, candidate.assetIds);
  const schema = z.object({ reviews: z.array(wireModelReviewSchema.extend({ id: z.string().min(1).max(180) })).length(1) }).strict();
  const model = await planningModel(runtime, parameters);
  runtime.onProgress?.({ stage: 'reviewing', message: '正在独立审核这道问题的价值和现有依据。' });
  const result = schema.parse(await model.generateObject({ schema, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }], options: parameters.review }));
  const { id, ...wireReview } = result.reviews[0];
  if (id !== candidateId) throw new Error('复评返回的问题 ID 不匹配，题单未保存。');
  const review = normalizeModelReview(wireReview);
  runtime.onProgress?.({ stage: 'checking', message: '正在核对审核结论和原文依据。' });
  const [checked] = await validateWithEvidenceRepair([{
    ...candidate, review: { ...review, source: 'model', status: 'reviewed', reviewedAt: new Date().toISOString() },
    selected: review.decision === 'exclude' ? false : candidate.selected,
  }], items => {
    validateModelReview(items[0].review as z.infer<typeof modelReviewSchema>, context, candidates, candidateId);
    return [validateQuestionPlan({ ...withoutSetReview, candidates: plan.candidates.map(item => item.id === candidateId ? items[0] : item) }, seed).candidates.find(item => item.id === candidateId)!];
  }, 'review', context, seed, model, parameters, runtime);
  return { ...withoutSetReview, candidates: plan.candidates.map(item => item.id !== candidateId ? item : { ...item, review: checked.review, selected: checked.review.decision === 'exclude' ? false : item.selected }) };
}

const directionSchema = z.object({
  title: z.string().trim().min(2).max(100), audience: z.string().trim().min(2).max(200),
  trigger: z.string().trim().min(5).max(300), assetIds: z.array(z.string().min(1).max(160)).max(8),
  needIds: z.array(z.string().min(1).max(80)).min(1).max(16).optional(),
}).strict();
const maxDirections = 3;
const batchSize = 4;
const funnelPlanningSchema = z.object({
  needs: z.array(needSchema).max(16), selectionAdvantages: z.array(advantageSchema).max(8),
  directions: z.array(directionSchema.extend({ needIds: directionSchema.shape.needIds.unwrap() })).max(maxDirections),
}).strict();
const reviewDecisionLabels = { include: '纳入', explore: '暂缓', exclude: '排除' };
const resumeCheckpointSchema = z.object({
  key: z.string().min(1), title: z.string(), items: z.array(z.string()),
  completedAt: z.string().datetime(), payload: z.unknown(),
}).strict();
const savedDraftSchema = candidateSchema.omit({
  queryEn: true, originalQuestionId: true, sourceQuestionId: true, sourceResearchBatchId: true,
  supersedesCandidateId: true, supersededByCandidateId: true,
}).extend({
  origin: z.literal('model'), selected: z.literal(false),
  review: reviewSchema.extend({ status: z.literal('pending') }).strict(),
}).strict();
const savedReviewedSchema = candidateSchema.extend({
  origin: z.literal('model'), review: reviewSchema.extend({ assessment: assessmentSchema,
    source: z.literal('model'), status: z.literal('reviewed'), reviewedAt: z.string().datetime(),
  }).strict(),
}).strict();

function candidateContent(candidate: QuestionCandidate) {
  const { review: _review, selected: _selected, ...content } = candidate;
  return content;
}

/** Settle every scheduled task before propagating a failure; completed checkpoints remain usable. */
async function settledBatches<T, R>(items: readonly T[], concurrency: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await run(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => (result as PromiseFulfilledResult<R>).value);
}

function validateNeedMap(planned: z.infer<typeof funnelPlanningSchema>, seed: GeoSeed) {
  const needIds = new Set(planned.needs.map(need => need.id));
  if (needIds.size !== planned.needs.length) throw new Error('需求地图包含重复 ID。');
  for (const item of [...planned.needs, ...planned.selectionAdvantages, ...planned.directions]) {
    if (new Set(item.assetIds).size !== item.assetIds.length || item.assetIds.some(id => !seed.assets.some(asset => asset.id === id))) throw new Error('需求地图引用了重复或不存在的材料。');
  }
  const assigned = new Set<string>();
  for (const direction of planned.directions) {
    if (new Set(direction.needIds).size !== direction.needIds.length || direction.needIds.some(id => !needIds.has(id))) throw new Error('工作分组引用了重复或不存在的需求。');
    direction.needIds.forEach(id => assigned.add(id));
  }
  if (planned.directions.length && assigned.size !== needIds.size) throw new Error('工作分组没有覆盖完整需求地图。');
}

function validateSetReview(review: z.infer<typeof setReviewSchema>, needs: z.infer<typeof needSchema>[], candidates: QuestionCandidate[]) {
  const selected = new Set(review.selectedIds);
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  if (selected.size !== review.selectedIds.length || review.selectedIds.some(id => {
    const candidate = byId.get(id);
    return !candidate || candidate.review.decision !== 'include' || candidate.review.status !== 'reviewed' || !candidate.review.assessment || candidate.supersededByCandidateId;
  })) throw new Error('整组审核选择了重复、不存在或尚不可纳入的问题。');
  const coveredNeeds = new Set(review.coverage.map(item => item.needId));
  if (coveredNeeds.size !== review.coverage.length || coveredNeeds.size !== needs.length || needs.some(need => !coveredNeeds.has(need.id))) throw new Error('整组审核必须逐项覆盖需求地图。');
  for (const item of review.coverage) {
    if (new Set(item.candidateIds).size !== item.candidateIds.length || item.candidateIds.some(id => !selected.has(id)) ||
      (item.status === 'covered') !== (item.candidateIds.length > 0)) throw new Error('整组审核的需求覆盖与最终选择不一致。');
  }
  const additionalIds = new Set(review.missingAdditionalNeeds.map(need => need.id));
  if (additionalIds.size !== review.missingAdditionalNeeds.length || review.missingAdditionalNeeds.some(need => coveredNeeds.has(need.id) || need.importance !== 'high')) throw new Error('整组审核新增需求的 ID 重复或并非重要遗漏。');
  const duplicateGroups = new Set<string>();
  for (const group of review.duplicates) {
    const ids = new Set(group.candidateIds);
    const key = [...ids].sort().join('\u0000');
    if (ids.size !== group.candidateIds.length || group.candidateIds.some(id => !byId.has(id)) || duplicateGroups.has(key) || group.candidateIds.filter(id => selected.has(id)).length > 1) throw new Error('整组审核的重复判断与最终选择不一致。');
    duplicateGroups.add(key);
  }
  return review;
}

/** A single bounded refinement round; successful stages remain independently resumable. */
async function completeQuestionFunnel(input: {
  seed: GeoSeed; positioning: string; runtime: PlanningRuntime; parameters: PlanningParameters; rules: string;
  historical: QuestionCandidate[]; reviewed: QuestionCandidate[]; planned: z.infer<typeof funnelPlanningSchema>;
  saved: Map<string, z.infer<typeof resumeCheckpointSchema>>;
  validateDrafts: (items: QuestionCandidate[], context: ReturnType<typeof boundedContext>) => QuestionCandidate[];
  makePlan: (items: QuestionCandidate[]) => GeoQuestionPlan;
}) {
  const { seed, positioning, runtime, parameters, rules, historical, planned, saved, validateDrafts, makePlan } = input;
  let reviewed = input.reviewed;
  let needs = [...planned.needs];
  const emit = (key: string, title: string, items: string[], payload: unknown) => runtime.onProgress?.({
    stage: 'checking', workflowStep: key === 'refinement-draft' ? 'generating' : 'reviewing', message: title, checkpoint: { key, title, items, payload },
  });
  const baseSetSystem = readAgentText('question-planning', 'set-review.md').replace('{{common}}', rules);
  const setSystem = seed.project.targetLanguage === 'en'
    ? `${baseSetSystem}\n\nSET-REVIEW JSON INVARIANT: Before writing selectedIds, mentally identify all duplicate candidate groups first so selectedIds NEVER contains 2+ candidates from any duplicates group (pick at most 1 per duplicate group, and only candidates with review.decision="include" and review.status="reviewed"). In coverage (one item per input needId), candidateIds MUST ONLY contain IDs present in selectedIds: if >=1 selectedId answers the need set status="covered" with only those selectedIds, otherwise set candidateIds=[] and status="missing" or "deferred" (NEVER "covered"). In missingAdditionalNeeds every item MUST have importance="high".`
    : baseSetSystem;
  const auditSet = async (round: 0 | 1) => {
    const candidates = [...historical, ...reviewed];
    const checkpoint = saved.get(`set-review-${round}`);
    let result: z.infer<typeof setReviewSchema>;
    if (checkpoint) result = setReviewSchema.parse(checkpoint.payload);
    else {
      const stageRuntime = trackPlanningRuntime(runtime, { stage: 'reviewing', message: round ? '正在复核补题后的需求覆盖和问题取舍。' : '正在审核整组问题的需求覆盖、重复和自然问法。' });
      stageRuntime.onProgress?.({ stage: 'reviewing', message: round ? '正在复核补题后的需求覆盖和问题取舍。' : '正在审核整组问题的需求覆盖、重复和自然问法。' });
      const context = boundedContext(seed, { ...projectContext(seed, positioning), needs,
        selectionAdvantages: planned.selectionAdvantages, maxSelected: 8, refinementRound: round,
        candidates: candidates.map(candidate => ({ id: candidate.id, query: candidate.query, category: candidate.category, intent: candidate.intent,
          review: { decision: candidate.review.decision, priority: candidate.review.priority, status: candidate.review.status, reason: candidate.review.reason,
            ...(candidate.review.assessment ? { assessment: { worthPursuing: candidate.review.assessment.worthPursuing,
              currentSupport: candidate.review.assessment.currentSupport, gaps: candidate.review.assessment.gaps } } : {}),
          },
        })),
      }, setSystem, parameters);
      const model = await planningModel(stageRuntime, parameters);
      result = setReviewSchema.parse(await model.generateObject({ schema: setReviewSchema,
        messages: [{ role: 'system', content: setSystem }, { role: 'user', content: JSON.stringify(context) }], options: parameters.review,
      }));
    }
    validateSetReview(result, needs, candidates);
    for (const need of result.missingAdditionalNeeds) {
      if (new Set(need.assetIds).size !== need.assetIds.length || need.assetIds.some(id => !seed.assets.some(asset => asset.id === id))) throw new Error('整组审核新增需求引用了重复或不存在的材料。');
    }
    emit(`set-review-${round}`, round ? '补题后的整组审核已完成' : '整组审核已完成', result.coverage.map(item => `${needs.find(need => need.id === item.needId)!.title}：${item.reason}`), result);
    needs = [...needs, ...result.missingAdditionalNeeds];
    const { missingAdditionalNeeds, ...review } = result;
    return { ...review, coverage: [...review.coverage, ...missingAdditionalNeeds.map(need => ({ needId: need.id,
      candidateIds: [] as string[], status: 'missing' as const, reason: `整组审核发现需求地图遗漏：${need.trigger}`,
    }))] };
  };
  let result = await auditSet(0);
  const missingNeeds = needs.filter(need => need.importance === 'high' && result.coverage.some(item => item.needId === need.id && item.status === 'missing'));
  const limit = Math.min(batchSize, parameters.maxNewCandidates - reviewed.length);
  let refinementRounds: 0 | 1 = 0;
  if (!missingNeeds.length || limit <= 0) {
    if (['refinement-draft', 'refinement-review', 'set-review-1'].some(key => saved.has(key))) throw new Error('保存的补题与首轮整组审核不匹配。');
  } else {
    refinementRounds = 1;
    const system = readAgentText('question-planning', 'propose.md').replace('{{common}}', rules).replace('{{maxNewCandidates}}', String(limit));
    const context = boundedContext(seed, { ...projectContext(seed, positioning), needs,
      selectionAdvantages: planned.selectionAdvantages, missingNeeds, refinementRound: 1,
      previousQuestions: [...historical, ...reviewed].map(candidate => ({ id: candidate.id, query: candidate.query })),
    }, system, parameters, missingNeeds.flatMap(need => need.assetIds));
    const draftCheckpoint = saved.get('refinement-draft');
    let rawDrafts: QuestionCandidate[];
    if (draftCheckpoint) {
      rawDrafts = z.object({ candidates: z.array(savedDraftSchema).max(limit) }).strict().parse(draftCheckpoint.payload).candidates;
      if (rawDrafts.some((candidate, index) => candidate.id !== `model-${maxDirections * batchSize + index + 1}`)) throw new Error('补题的问题 ID 与保存批次不匹配。');
      rawDrafts = validateDrafts(rawDrafts, context);
    } else {
      const stageRuntime = trackPlanningRuntime(runtime, { stage: 'generating', message: '正在为尚未覆盖的重要需求补充问题。' });
      stageRuntime.onProgress?.({ stage: 'generating', message: '正在为尚未覆盖的重要需求补充问题。' });
      const model = await planningModel(stageRuntime, parameters);
      const schema = z.object({ candidates: z.array(draftSchema).max(limit) }).strict();
      const generated = schema.parse(await model.generateObject({ schema, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }], options: parameters.propose }));
      rawDrafts = await validateWithEvidenceRepair(generated.candidates.map((draft, index) => ({ ...draft,
        id: `model-${maxDirections * batchSize + index + 1}`, origin: 'model', demandStatus: 'unverified', selected: false,
        review: { decision: 'explore', reason: '等待独立审阅，暂不进入正式题单。', concerns: [], status: 'pending' },
      })), items => validateDrafts(items, context), 'draft', context, seed, model, parameters, stageRuntime);
    }
    emit('refinement-draft', '重要需求补题已核对原文', rawDrafts.map(candidate => candidate.query), { candidates: rawDrafts });
    const seen = new Set([...historical, ...reviewed].map(candidate => queryKey(candidate.query)));
    const drafts = rawDrafts.filter(candidate => { const key = queryKey(candidate.query); if (seen.has(key)) return false; seen.add(key); return true; });
    const candidates = drafts.map(reviewCandidateInput);
    const reviewSystem = readAgentText('question-planning', 'review.md').replace('{{common}}', rules);
    // The independent reviewer receives neither the missing-needs instruction nor generation reasoning.
    const reviewContext = boundedContext(seed, { ...projectContext(seed, positioning), candidates }, reviewSystem, parameters, drafts.flatMap(candidate => candidate.assetIds));
    const validate = (items: QuestionCandidate[]) => {
      for (const candidate of items) validateModelReview(candidate.review as z.infer<typeof modelReviewSchema>, reviewContext, candidates, candidate.id);
      const ids = new Set(items.map(candidate => candidate.id));
      return validateQuestionPlan(makePlan([...reviewed, ...items]), seed).candidates.filter(candidate => ids.has(candidate.id));
    };
    const reviewCheckpoint = saved.get('refinement-review');
    let additions: QuestionCandidate[];
    if (reviewCheckpoint) {
      additions = z.object({ candidates: z.array(savedReviewedSchema).length(drafts.length) }).strict().parse(reviewCheckpoint.payload).candidates;
      if (!isDeepStrictEqual(additions.map(candidateContent), drafts.map(candidateContent))) throw new Error('补题审核与已保存补题不匹配。');
      additions = validate(additions);
    } else if (!drafts.length) additions = [];
    else {
      const stageRuntime = trackPlanningRuntime(runtime, { stage: 'reviewing', message: '正在独立审核补充问题的价值和依据。' });
      stageRuntime.onProgress?.({ stage: 'reviewing', message: '正在独立审核补充问题的价值和依据。' });
      const model = await planningModel(stageRuntime, parameters);
      const schema = z.object({ reviews: z.array(wireModelReviewSchema.extend({ id: z.string().min(1).max(180) })).length(drafts.length) }).strict();
      const audit = schema.parse(await model.generateObject({ schema, messages: [{ role: 'system', content: reviewSystem }, { role: 'user', content: JSON.stringify(reviewContext) }], options: parameters.review }));
      const reviews = new Map(audit.reviews.map(review => [review.id, review]));
      if (reviews.size !== drafts.length || drafts.some(candidate => !reviews.has(candidate.id))) throw new Error('补题独立审核未逐项覆盖候选。');
      additions = await validateWithEvidenceRepair(drafts.map(candidate => {
        const { id: _id, ...wireReview } = reviews.get(candidate.id)!;
        return { ...candidate, review: { ...normalizeModelReview(wireReview), source: 'model', status: 'reviewed', reviewedAt: new Date().toISOString() }, selected: false };
      }), validate, 'review', reviewContext, seed, model, parameters, stageRuntime);
    }
    emit('refinement-review', '补充问题已完成独立审核', additions.map(candidate => `${reviewDecisionLabels[candidate.review.decision]}：${candidate.query}`), { candidates: additions });
    reviewed = [...reviewed, ...additions];
    result = await auditSet(1);
  }
  const status = needs.some(need => need.importance === 'high' && result.coverage.some(item => item.needId === need.id && item.status === 'missing')) ? 'incomplete' as const : 'complete' as const;
  return { reviewed, coverageReview: { ...result, needs, selectionAdvantages: planned.selectionAdvantages, status, refinementRounds } };
}

/** Explicit generation only. Each bounded batch is checked before its checkpoint is exposed. */
export async function generateQuestionPlan(seed: GeoSeed, positioning: string, runtime: PlanningRuntime = {}): Promise<GeoQuestionPlan> {
  const callerRuntime = runtime;
  runtime = trackPlanningRuntime(runtime, { stage: 'planning', message: '正在从项目材料中整理值得关注的需求方向。' });
  const parameters = readAgentParameters('question-planning', parametersSchema);
  const directionsSchema = z.object({ directions: z.array(directionSchema).max(maxDirections) }).strict();
  const savedDirectionsSchema = z.union([directionsSchema.extend({ executionVersion: z.literal(2).optional() }),
    funnelPlanningSchema.extend({ executionVersion: z.literal(3) })]);
  const initial = buildInitialQuestionPlan(seed);
  validateQuestionPlan({ ...initial, positioning }, seed);
  const historical = initial.candidates.filter(candidate => candidate.origin === 'existing');
  const makePlan = (items: QuestionCandidate[]) => ({ ...initial, positioning, source: 'model' as const, candidates: [...historical, ...items] });
  const shared = {
    ...projectContext(seed, positioning),
    existingQuestions: seed.questions.map(question => ({ id: question.id, query: question.query })),
  };
  const rules = planningRules(seed);
  const planningSystem = readAgentText('question-planning', 'directions.md').replace('{{common}}', rules);
  const planningContext = boundedContext(seed, shared, planningSystem, parameters);
  const resume = runtime.resume === undefined ? null : z.array(resumeCheckpointSchema).min(1).max(11).parse(runtime.resume);
  const saved = new Map(resume?.map(checkpoint => [checkpoint.key, checkpoint]));
  if (resume && (saved.size !== resume.length || !saved.has('directions'))) throw new Error('续跑中间成果缺少需求方向或包含重复批次。');
  const savedDirections = saved.has('directions') ? savedDirectionsSchema.parse(saved.get('directions')!.payload) : undefined;
  const legacyResume = Boolean(savedDirections && !savedDirections.executionVersion);
  const llm = await planningModel(runtime, parameters);
  if (!resume) runtime.onProgress?.({ stage: 'planning', message: '正在从项目材料中整理值得关注的需求方向。' });
  const planned = savedDirections ?? funnelPlanningSchema.parse(await llm.generateObject({
    schema: funnelPlanningSchema,
    messages: [{ role: 'system', content: planningSystem }, { role: 'user', content: JSON.stringify(planningContext) }],
    options: parameters.planning,
  }));
  const funnel = 'needs' in planned ? planned : undefined;
  if (funnel) validateNeedMap(funnel, seed);
  for (const direction of planned.directions) {
    if (new Set(direction.assetIds).size !== direction.assetIds.length || direction.assetIds.some(id => !seed.assets.some(asset => asset.id === id))) {
      throw new Error('需求方向引用了重复或不存在的材料，未继续生成问题。');
    }
  }
  // New runs reserve IDs and quotas by direction, so completion order never changes them.
  // Older jobs retain their cumulative IDs and original generation context exactly.
  const draftSpecs = planned.directions.flatMap((direction, index) => {
    const limit = legacyResume ? batchSize : Math.min(batchSize, parameters.maxNewCandidates - index * batchSize);
    return limit > 0 ? [{ direction, index, limit }] : [];
  });
  const allowedKeys = new Set(['directions', ...draftSpecs.map(({ index }) => `draft-${index + 1}`),
    ...Array.from({ length: maxDirections }, (_, index) => `review-${index + 1}`),
    ...(funnel ? ['set-review-0', 'refinement-draft', 'refinement-review', 'set-review-1'] : [])]);
  if ([...saved.keys()].some(key => !allowedKeys.has(key))) throw new Error('续跑包含不属于当前方向的批次。');
  const hasAllDrafts = draftSpecs.every(({ index }) => saved.has(`draft-${index + 1}`));
  if ((legacyResume || [...saved.keys()].some(key => key.startsWith('review-') || key.startsWith('set-review') || key.startsWith('refinement'))) && !hasAllDrafts) {
    throw new Error('已保存审核或旧版续跑必须包含全部候选批次。');
  }
  const preparedDrafts: Array<{ candidates: QuestionCandidate[]; context: ReturnType<typeof boundedContext> } | undefined> = [];
  const priorLegacyDrafts: QuestionCandidate[] = [];
  const draftContext = (direction: z.infer<typeof directionSchema>, limit: number, previous: QuestionCandidate[] = []) => {
    const system = readAgentText('question-planning', 'propose.md').replace('{{common}}', rules).replace('{{maxNewCandidates}}', String(limit));
    const context = boundedContext(seed, { ...shared, direction,
      ...(legacyResume ? { previousQuestions: previous.map(candidate => ({ id: candidate.id, query: candidate.query })) } : { allDirections: planned.directions }),
      ...(funnel ? { needs: funnel.needs, selectionAdvantages: funnel.selectionAdvantages } : {}),
    }, system, parameters, direction.assetIds);
    return { system, context };
  };
  const validateDrafts = (items: QuestionCandidate[], context: ReturnType<typeof boundedContext>) => items.map(candidate => {
    for (const evidence of candidate.evidence) {
      if (!providedEvidence(evidence, context)) throw new EvidenceQuoteError('问题引用了未提供的材料原文，不能保存。', candidate.id, evidence);
    }
    // Validate every raw candidate, even duplicates, before checkpointing. Deduplication
    // happens only when merging batches; the original batch payload is retained.
    return validateQuestionPlan({ ...makePlan([]), candidates: [candidate] }, { ...seed, questions: [] }).candidates[0];
  });
  // Reject corrupt saved drafts before invoking any missing batch.
  for (const spec of draftSpecs) {
    const checkpoint = saved.get(`draft-${spec.index + 1}`);
    if (!checkpoint) continue;
    if (legacyResume) spec.limit = Math.min(batchSize, parameters.maxNewCandidates - priorLegacyDrafts.length);
    if (spec.limit <= 0) throw new Error('续跑候选超出当前上限，不能丢弃已保存批次。');
    const payload = z.object({ direction: directionSchema, candidates: z.array(savedDraftSchema).max(spec.limit) }).strict().parse(checkpoint.payload);
    const offset = legacyResume ? priorLegacyDrafts.length : spec.index * batchSize;
    if (!isDeepStrictEqual(payload.direction, spec.direction) || payload.candidates.some((candidate, index) => candidate.id !== `model-${offset + index + 1}`)) {
      throw new Error('续跑候选的方向或问题 ID 与原批次不匹配。');
    }
    const { context } = draftContext(spec.direction, spec.limit, priorLegacyDrafts);
    const candidates = validateDrafts(payload.candidates, context);
    preparedDrafts[spec.index] = { candidates, context };
    priorLegacyDrafts.push(...candidates);
  }
  runtime.onProgress?.({ stage: 'planning', message: `已整理 ${planned.directions.length} 个需求方向。`, checkpoint: {
    key: 'directions', title: '需求方向', items: planned.directions.map(direction => direction.title),
    payload: funnel ? { ...funnel, executionVersion: 3 } : legacyResume ? { directions: planned.directions } : { directions: planned.directions, executionVersion: 2 },
  } });
  const materials = [...planningContext.materials];
  const draftResults = await settledBatches(draftSpecs, parameters.maxConcurrency, async ({ direction, index, limit }) => {
    const batchRuntime = trackPlanningRuntime(callerRuntime, { stage: 'generating', message: `正在生成第 ${index + 1}/${draftSpecs.length} 个方向的问题：${direction.title}。` });
    const prepared = preparedDrafts[index];
    const { system, context } = prepared ? { system: '', context: prepared.context } : draftContext(direction, limit);
    let validated: QuestionCandidate[];
    if (prepared) validated = prepared.candidates;
    else {
      batchRuntime.onProgress?.({ stage: 'generating', message: `正在生成第 ${index + 1}/${draftSpecs.length} 个方向的问题：${direction.title}。` });
      const model = await planningModel(batchRuntime, parameters);
      const generationSchema = z.object({ candidates: z.array(draftSchema).max(limit) }).strict();
      const generated = generationSchema.parse(await model.generateObject({ schema: generationSchema,
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }], options: parameters.propose,
      }));
      const candidates: QuestionCandidate[] = generated.candidates.map((draft, draftIndex) => ({
        ...draft, id: `model-${index * batchSize + draftIndex + 1}`, origin: 'model', demandStatus: 'unverified', selected: false,
        review: { decision: 'explore', reason: '等待独立审阅，暂不进入正式题单。', concerns: [], status: 'pending' },
      }));
      batchRuntime.onProgress?.({ stage: 'checking', workflowStep: 'generating', message: `正在核对第 ${index + 1} 批问题和材料原文依据。` });
      validated = await validateWithEvidenceRepair(candidates, items => validateDrafts(items, context), 'draft', context, seed, model, parameters, batchRuntime);
    }
    batchRuntime.onProgress?.({ stage: 'checking', workflowStep: 'generating', message: `第 ${index + 1} 批 ${validated.length} 道问题已核对原文，等待独立审核。`, checkpoint: {
      key: `draft-${index + 1}`, title: direction.title, items: validated.map(candidate => candidate.query), payload: { direction, candidates: validated },
    } });
    return { candidates: validated, materials: context.materials };
  });
  const seen = new Set(historical.map(candidate => queryKey(candidate.query)));
  const checked = draftResults.flatMap(result => result.candidates).filter(candidate => {
    const key = queryKey(candidate.query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  materials.push(...draftResults.flatMap(result => result.materials));
  const reviewSystem = readAgentText('question-planning', 'review.md').replace('{{common}}', rules);
  const batches = Array.from({ length: Math.ceil(checked.length / batchSize) }, (_, index) => checked.slice(index * batchSize, (index + 1) * batchSize));
  if (funnel && saved.has('set-review-0') && batches.some((_, index) => !saved.has(`review-${index + 1}`))) throw new Error('整组审核续跑必须保留全部逐题审核。');
  if (funnel && ['refinement-draft', 'refinement-review', 'set-review-1'].some(key => saved.has(key)) && !saved.has('set-review-0')) throw new Error('定向补题续跑缺少首轮整组审核。');
  if (funnel && saved.has('refinement-review') && !saved.has('refinement-draft')) throw new Error('定向补题续跑缺少补题原文。');
  if (funnel && saved.has('set-review-1') && !saved.has('refinement-review')) throw new Error('整组复核续跑缺少补题独立审核。');
  if ([...saved.keys()].some(key => key.startsWith('review-') && !batches[Number(key.slice(7)) - 1])) throw new Error('续跑审核批次超出了已保存候选范围。');
  const reviewSpecs = batches.map((batch, index) => {
    const candidates = batch.map(reviewCandidateInput);
    const context = boundedContext(seed, { ...projectContext(seed, positioning), candidates }, reviewSystem, parameters, batch.flatMap(candidate => candidate.assetIds));
    const validate = (items: QuestionCandidate[]) => {
      for (const item of items) validateModelReview(item.review as z.infer<typeof savedReviewedSchema>['review'], context, candidates, item.id);
      const byId = new Map(items.map(candidate => [candidate.id, candidate]));
      return validateQuestionPlan(makePlan(checked.map(candidate => byId.get(candidate.id) ?? candidate)), seed).candidates.filter(candidate => byId.has(candidate.id));
    };
    const checkpoint = saved.get(`review-${index + 1}`);
    let restored: QuestionCandidate[] | undefined;
    if (checkpoint) {
      const payload = z.object({ candidates: z.array(savedReviewedSchema).length(batch.length) }).strict().parse(checkpoint.payload);
      if (!isDeepStrictEqual(payload.candidates.map(candidateContent), batch.map(candidateContent))) throw new Error('续跑审核的问题 ID、顺序或问法依据与已保存候选不匹配。');
      restored = validate(payload.candidates);
    }
    return { batch, candidates, context, validate, restored };
  });
  // All saved reviews have been revalidated before any remaining review is requested.
  const reviewResults = await settledBatches(reviewSpecs, parameters.maxConcurrency, async ({ batch, candidates, context, validate, restored }, index) => {
    const batchNumber = index + 1;
    const batchRuntime = trackPlanningRuntime(callerRuntime, { stage: 'reviewing', message: `正在独立审核第 ${batchNumber}/${batches.length} 批问题的价值和现有依据。` });
    let validated: QuestionCandidate[];
    if (restored) validated = restored;
    else {
      batchRuntime.onProgress?.({ stage: 'reviewing', message: `正在独立审核第 ${batchNumber}/${batches.length} 批问题的价值和现有依据。` });
      const model = await planningModel(batchRuntime, parameters);
      const auditSchema = z.object({ reviews: z.array(wireModelReviewSchema.extend({ id: z.string().min(1).max(180) })).length(batch.length) }).strict();
      const audit = auditSchema.parse(await model.generateObject({ schema: auditSchema,
        messages: [{ role: 'system', content: reviewSystem }, { role: 'user', content: JSON.stringify(context) }], options: parameters.review,
      }));
      const reviews = new Map(audit.reviews.map(review => [review.id, review]));
      if (reviews.size !== batch.length || batch.some(candidate => !reviews.has(candidate.id))) throw new Error('独立审核未逐项覆盖候选，题单未保存。');
      const audited = batch.map(candidate => {
        const { id: _id, ...wireReview } = reviews.get(candidate.id)!;
        const review = normalizeModelReview(wireReview);
        return { ...candidate, review: { ...review, source: 'model' as const, status: 'reviewed' as const, reviewedAt: new Date().toISOString() }, selected: review.decision === 'include' };
      });
      batchRuntime.onProgress?.({ stage: 'checking', workflowStep: 'reviewing', message: `正在核对第 ${batchNumber} 批审核覆盖范围和原文依据。` });
      validated = await validateWithEvidenceRepair(audited, validate, 'review', context, seed, model, parameters, batchRuntime);
    }
    batchRuntime.onProgress?.({ stage: 'checking', workflowStep: 'reviewing', message: `第 ${batchNumber} 批 ${validated.length} 道问题已完成独立审核。`, checkpoint: {
      key: `review-${batchNumber}`, title: `第 ${batchNumber} 批独立审核`,
      items: validated.map(candidate => `${reviewDecisionLabels[candidate.review.decision]}：${candidate.query}`), payload: { candidates: validated },
    } });
    return { candidates: validated, materials: context.materials };
  });
  let reviewed = reviewResults.flatMap(result => result.candidates);
  materials.push(...reviewResults.flatMap(result => result.materials));
  const funnelResult = funnel ? await completeQuestionFunnel({ seed, positioning, runtime: callerRuntime, parameters, rules,
    historical, reviewed, planned: funnel, saved, validateDrafts, makePlan }) : undefined;
  if (funnelResult) reviewed = funnelResult.reviewed;
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const recommendations = reviewed.filter(candidate => candidate.review.decision === 'include')
    .sort((a, b) => priorityOrder[a.review.priority ?? 'medium'] - priorityOrder[b.review.priority ?? 'medium']);
  // This is a new draft recommendation. Confirmed monitoring data in seed is never changed.
  const selectedIds = new Set(funnelResult?.coverageReview.selectedIds ?? [...recommendations, ...historical.filter(candidate => candidate.selected)].slice(0, 8).map(candidate => candidate.id));
  const now = new Date().toISOString();
  return validateQuestionPlan({
    ...makePlan(reviewed), createdAt: now, updatedAt: now,
    // Do not mutate candidate objects already exposed in an original checkpoint.
    candidates: [...historical, ...reviewed].map(candidate => ({ ...candidate, selected: selectedIds.has(candidate.id) })),
    ...(funnelResult ? { coverageReview: funnelResult.coverageReview } : {}),
    notes: [funnelResult ? 'AI 先展开需求地图，再分组生成、逐题独立审核与整组覆盖审核；同一配置模型，不代表独立的人类评审。' : 'AI 按需求方向并行生成候选，再使用独立上下文并行审核；同一配置模型，不代表独立的人类评审。', '模型只收到项目材料和旧题原文，没有收到历史命中、排名或引擎结果。', '全部需求仍未验证；未执行新搜索。探索题和拒绝题不进入默认测量。',
      ...(funnelResult?.coverageReview.status === 'incomplete' ? ['重要需求仍有遗漏，已保留未完成状态；当前仅为待人工审阅草稿。'] : []),
      ...(draftResults.reduce((count, result) => count + result.candidates.length, 0) > checked.length ? ['合并时去除了与历史或其他方向重复的问题，原始候选仍保留在各批次记录中。'] : []),
      ...(materials.some(asset => asset.markdownIsExcerpt) ? ['部分导入材料本身是原文节选，已标明；节选未见不代表完整页面没有。'] : []),
      ...(materials.some(asset => asset.truncated) ? ['部分材料又因输入预算截断，已标明；只能根据提供部分审阅。'] : []),
      ...(!materials.some(asset => asset.truncated || asset.markdownIsExcerpt) ? ['本次传入全部已有材料正文；完整性以导入材料的标记为准，未重新读取公开页面。'] : []),
    ],
  }, seed);
}

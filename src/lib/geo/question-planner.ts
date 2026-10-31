import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import type { GeoAsset, GeoSeed } from './types';
import type { GeoQuestionPlan, QuestionCandidate, QuestionCategory } from './question-types';
import type { GeoStructuredModel } from './connection-settings';

const callOptionsSchema = z.object({
  temperature: z.number().min(0).max(2), maxTokens: z.number().int().positive(),
}).strict();
const parametersSchema = z.object({
  maxNewCandidates: z.number().int().positive().max(100),
  maxInputBytes: z.number().int().positive().max(48 * 1024),
  materials: z.object({
    maxTotalCharacters: z.number().int().positive(),
    maxCharactersPerAsset: z.number().int().positive(),
  }).strict(),
  propose: callOptionsSchema, review: callOptionsSchema,
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
const reviewSchema = z.object({ decision: decisionSchema, reason: z.string().min(5).max(900), concerns: z.array(z.string().min(1).max(400)).max(8) }).strict();
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
const modelReviewSchema = reviewSchema.extend({ assessment: assessmentSchema });
// Providers parse this schema before returning. Keep both wire shapes JSON-Schema
// representable; only the observed evidence relocation is accepted, never extra keys.
const nestedEvidenceAssessmentSchema = assessmentSchema.omit({ evidence: true }).extend({
  currentSupport: assessmentSchema.shape.currentSupport.extend({ evidence: assessmentSchema.shape.evidence })
    .describe('兼容结构：仅当 assessment 没有 evidence 时，可将同一证据数组放在这里；程序会无损移到 assessment.evidence 后再次校验。'),
}).strict();
const wireModelReviewSchema = reviewSchema.extend({
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
const planSchema = z.object({
  id: z.string().min(1).max(180), projectId: z.string().min(1).max(160),
  revision: z.number().int().positive(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  source: z.enum(['curated', 'model']), status: z.enum(['draft', 'ready']),
  positioning: z.string().trim().min(5).max(1000),
  candidates: z.array(candidateSchema).max(100), notes: z.array(z.string().max(1000)).max(15),
}).strict();

const compact = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const queryKey = (value: string) => compact(value);

function publicAsset(asset: GeoAsset) {
  try {
    const url = new URL(asset.publicUrl || '');
    return asset.status === 'published' && ['http:', 'https:'].includes(url.protocol);
  } catch { return false; }
}

function identityTerms(seed: GeoSeed) {
  const terms = [seed.project.name, seed.project.id, seed.project.owner];
  for (const value of [seed.project.siteUrl, seed.project.repositoryUrl, ...seed.assets.map(a => a.publicUrl)]) {
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
      if (!asset.markdown.includes(evidence.quote) && !asset.summary.includes(evidence.quote)) throw new Error('证据摘录必须是材料正文或摘要的原文，不能编造。');
    }
    for (const evidence of candidate.review.assessment?.evidence ?? []) {
      const asset = assets.get(evidence.assetId);
      if (!asset || (!asset.markdown.includes(evidence.quote) && !asset.summary.includes(evidence.quote))) throw new Error('复评证据摘录必须来自当前项目材料原文，不能编造。');
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
    if (!supportIds.some(id => publicAsset(assets.get(id)!))) gaps.push('尚无记载为已发布的公开内容承接这道问题。');
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
  const candidates: QuestionCandidate[] = seed.questions.map(question => {
    const brand = question.tier === 'L1' || identityTerms(seed).some(term => queryKey(question.query).includes(term));
    const comparison = /500K.*(?:1M|1m)/i.test(question.query);
    const compaction = /(?:减少.*压缩|reduce.*compaction)/i.test(question.query);
    const exploratory = comparison || compaction;
    const category: QuestionCategory = brand ? 'brand' : comparison ? 'comparison' : 'content';
    return {
      id: question.id, originalQuestionId: question.id, origin: 'existing', query: question.query, category,
      intent: brand ? '已知品牌后，查找正确的项目入口并区分同名对象。' : '寻找能够回答当前技术问题的文章或研究材料。',
      target: brand ? 'project' : 'article', ...cited(seed, question.matchingAssetIds || []),
      rationale: brand ? '品牌识别是基础检查，命中仍需实际测量。' : '保留旧题和历史来源；评估文章发现，不把文章主题当成产品已经具备的能力。',
      expectedResult: brand ? '出现本项目的官方入口或正确介绍；同名论文不算本项目。' : '相关公开文章被返回或引用；不要求一定推荐本项目作为产品方案。',
      demandStatus: 'unverified', selected: !exploratory,
      review: {
        decision: exploratory ? 'explore' : 'include',
        reason: comparison ? '现有文章提供选择方法，但没有实测 500K 与 1M 的优劣；仅作探索，不能作为产品主评分。' : compaction ? '这主要询问平台窗口特性；本项目未实测 Codex 500K，不作为产品主评分。' : brand ? '有明确身份与公开入口，可作为品牌基础检查；不承诺命中。' : '有对应公开文章，适合检查内容发现；仍未验证真实用户需求。',
        concerns: ['题目需求尚未经外部搜索行为或用户反馈验证。'],
      },
    };
  });
  const at = `${seed.project.asOf.slice(0, 10)}T00:00:00.000Z`;
  return validateQuestionPlan({
    id: `${seed.project.id}-question-plan`, projectId: seed.project.id, revision: 1, createdAt: at, updatedAt: at,
    source: 'curated', status: 'draft', positioning, candidates,
    notes: ['人工整理的初始题单，未调用 AI、未发起新搜索。', '旧题完整保留；题单选择不会改变历史测量。', '全部需求状态仍未验证；公开状态来自导入材料，未重新检查页面。', '文章发现与项目发现分开解释；品牌和定位都不保证命中。'],
  }, seed);
}

type PlanningParameters = z.infer<typeof parametersSchema>;
type PlanningRuntime = { model?: GeoStructuredModel };

function projectContext(seed: GeoSeed, positioning: string) {
  const { id, name, owner, description, siteUrl, repositoryUrl } = seed.project;
  return { project: { id, name, owner, description, siteUrl, repositoryUrl }, positioning };
}

function reviewCandidateInput(candidate: QuestionCandidate) {
  const { id, query, queryEn, category, intent, target, assetIds, evidence, rationale, expectedResult } = candidate;
  // Previous verdicts and selection are deliberately absent from the independent review.
  return { id, query, queryEn, category, intent, target, assetIds, evidence, rationale, expectedResult };
}

/** Bound the full business prompt in UTF-8 bytes, including metadata and role rules. */
function boundedContext(seed: GeoSeed, base: Record<string, unknown>, system: string, parameters: PlanningParameters, preferredIds: string[] = []) {
  let remaining = parameters.materials.maxTotalCharacters;
  const ordered = [...seed.assets].sort((a, b) => Number(preferredIds.includes(b.id)) - Number(preferredIds.includes(a.id)));
  const materials = ordered.map(asset => ({
    id: asset.id, title: asset.title, status: asset.status, publicUrl: asset.publicUrl,
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

function validateModelReview(review: z.infer<typeof modelReviewSchema>, context: ReturnType<typeof boundedContext>, candidates: ReturnType<typeof reviewCandidateInput>[]) {
  const assessment = review.assessment;
  if ((review.decision === 'exclude') !== (assessment.worthPursuing.verdict === 'no')) throw new Error('复评结论与争取价值不一致；不能仅因承接不足排除问题。');
  for (const evidence of assessment.evidence) {
    const asset = context.materials.find(item => item.id === evidence.assetId);
    const providedQuote = candidates.some(candidate => candidate.evidence.some(item => item.assetId === evidence.assetId && item.quote.includes(evidence.quote)));
    if (!asset || (!asset.markdown.includes(evidence.quote) && !asset.summary.includes(evidence.quote) && !providedQuote)) throw new Error('复评引用了未提供的材料原文，不能保存。');
  }
  if (assessment.worthPursuing.demandBasis === 'public-observation' && !assessment.evidence.length) throw new Error('公开观测的需求依据必须附材料原文；推导不能冒充公开观测。');
  if (assessment.currentSupport.level !== 'unverified' && !assessment.evidence.length) throw new Error('确认承接程度必须附材料原文；没有依据时应保留为尚未核实。');
  if (assessment.currentSupport.level !== 'supported' && !assessment.gaps.length) throw new Error('承接不足或尚未核实的复评必须说明具体缺口。');
}

/** One explicit review, no generation/search/persistence. The caller owns revision and saving. */
export async function reviewQuestionCandidate(seed: GeoSeed, plan: GeoQuestionPlan, candidateId: string, runtime: PlanningRuntime = {}): Promise<GeoQuestionPlan> {
  const candidate = plan.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new Error('没有找到这道候选题。');
  if (candidate.supersededByCandidateId) throw new Error('这道问题已有新版本，请操作最新版本。');
  // Validate source identity/evidence before a paid call, without adopting normalization of other questions.
  validateQuestionPlan(plan, seed);
  const parameters = readAgentParameters('question-planning', parametersSchema);
  const system = readAgentText('question-planning', 'review.md').replace('{{common}}', readAgentText('question-planning', 'common.md'));
  const candidates = [reviewCandidateInput(candidate)];
  const context = boundedContext(seed, { ...projectContext(seed, plan.positioning), candidates }, system, parameters, candidate.assetIds);
  const schema = z.object({ reviews: z.array(wireModelReviewSchema.extend({ id: z.string().min(1).max(180) })).length(1) }).strict();
  const model = runtime.model ?? await (await import('./connection-settings')).loadGeoModel();
  const result = schema.parse(await model.generateObject({ schema, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }], options: parameters.review }));
  const { id, ...wireReview } = result.reviews[0];
  if (id !== candidateId) throw new Error('复评返回的问题 ID 不匹配，题单未保存。');
  const review = normalizeModelReview(wireReview);
  validateModelReview(review, context, candidates);
  const next = {
    ...plan,
    candidates: plan.candidates.map(item => item.id !== candidateId ? item : {
      ...item, review: { ...review, source: 'model' as const, status: 'reviewed' as const, reviewedAt: new Date().toISOString() },
      selected: review.decision === 'exclude' ? false : item.selected,
    }),
  };
  const checked = validateQuestionPlan(next, seed).candidates.find(item => item.id === candidateId)!;
  return { ...plan, candidates: plan.candidates.map(item => item.id !== candidateId ? item : { ...item, review: checked.review, selected: checked.review.decision === 'exclude' ? false : item.selected }) };
}

/** Called only by an explicit UI action. Two isolated model calls; no search results are supplied. */
export async function generateQuestionPlan(seed: GeoSeed, positioning: string, runtime: PlanningRuntime = {}): Promise<GeoQuestionPlan> {
  const parameters = readAgentParameters('question-planning', parametersSchema);
  const generationSchema = z.object({ candidates: z.array(draftSchema).min(1).max(parameters.maxNewCandidates) }).strict();
  const auditSchema = z.object({ reviews: z.array(wireModelReviewSchema.extend({ id: z.string().min(1).max(180) })).min(1).max(parameters.maxNewCandidates) }).strict();
  const initial = buildInitialQuestionPlan(seed);
  // Validate positioning before making a potentially paid request.
  validateQuestionPlan({ ...initial, positioning }, seed);
  const shared = {
    ...projectContext(seed, positioning),
    existingQuestions: seed.questions.map(question => ({ id: question.id, query: question.query })),
  };
  const rules = readAgentText('question-planning', 'common.md');
  const proposeSystem = readAgentText('question-planning', 'propose.md').replace('{{common}}', rules).replace('{{maxNewCandidates}}', String(parameters.maxNewCandidates));
  const generationContext = boundedContext(seed, shared, proposeSystem, parameters);
  const llm = runtime.model ?? await (await import('./connection-settings')).loadGeoModel();
  const generated = generationSchema.parse(await llm.generateObject<z.infer<typeof generationSchema>>({
    schema: generationSchema,
    messages: [
      { role: 'system', content: proposeSystem },
      { role: 'user', content: JSON.stringify(generationContext) },
    ], options: parameters.propose,
  }));
  const candidates: QuestionCandidate[] = generated.candidates.map((draft, index) => ({
    ...draft, id: `model-${index + 1}`, origin: 'model', demandStatus: 'unverified', selected: false,
    review: { decision: 'explore', reason: '等待独立审阅，暂不进入正式题单。', concerns: [], status: 'pending' },
  }));
  const historical = initial.candidates.filter(candidate => candidate.origin === 'existing');
  const makePlan = (items: QuestionCandidate[]) => ({ ...initial, positioning, source: 'model' as const, candidates: [...historical, ...items] });
  const checked = validateQuestionPlan(makePlan(candidates), seed).candidates.filter(candidate => candidate.origin === 'model');
  const reviewSystem = readAgentText('question-planning', 'review.md').replace('{{common}}', rules);
  const reviewCandidates = checked.map(reviewCandidateInput);
  const reviewContext = boundedContext(seed, { ...projectContext(seed, positioning), candidates: reviewCandidates }, reviewSystem, parameters, checked.flatMap(candidate => candidate.assetIds));
  const audit = auditSchema.parse(await llm.generateObject<z.infer<typeof auditSchema>>({
    schema: auditSchema,
    messages: [
      { role: 'system', content: reviewSystem },
      { role: 'user', content: JSON.stringify(reviewContext) },
    ], options: parameters.review,
  }));
  const reviews = new Map(audit.reviews.map(review => [review.id, review]));
  if (reviews.size !== checked.length || reviews.size !== audit.reviews.length || checked.some(candidate => !reviews.has(candidate.id))) throw new Error('独立审核未逐项覆盖候选，题单未保存。');
  const reviewed = checked.map(candidate => {
    const { id: _id, ...wireReview } = reviews.get(candidate.id)!;
    const review = normalizeModelReview(wireReview);
    validateModelReview(review, reviewContext, reviewCandidates);
    return { ...candidate, review: { ...review, source: 'model' as const, status: 'reviewed' as const, reviewedAt: new Date().toISOString() }, selected: review.decision === 'include' };
  });
  const now = new Date().toISOString();
  const materials = [...generationContext.materials, ...reviewContext.materials];
  return validateQuestionPlan({
    ...makePlan(reviewed), createdAt: now, updatedAt: now,
    notes: ['AI 生成候选后，使用独立上下文进行第二次审核；同一配置模型，不代表独立的人类评审。', '模型只收到项目材料和旧题原文，没有收到历史命中、排名或引擎结果。', '全部需求仍未验证；未执行新搜索。探索题和拒绝题不进入默认测量。',
      ...(materials.some(asset => asset.markdownIsExcerpt) ? ['部分导入材料本身是原文节选，已标明；节选未见不代表完整页面没有。'] : []),
      ...(materials.some(asset => asset.truncated) ? ['部分材料又因输入预算截断，已标明；只能根据提供部分审阅。'] : []),
      ...(!materials.some(asset => asset.truncated || asset.markdownIsExcerpt) ? ['本次传入全部已有材料正文；完整性以导入材料的标记为准，未重新读取公开页面。'] : []),
    ],
  }, seed);
}

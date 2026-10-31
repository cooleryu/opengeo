import { randomUUID } from 'node:crypto';
import { getGeoModelConnection, loadGeoModel } from './connection-settings';
import { z } from 'zod';
import SessionManager from '@/lib/session';
import type { WidgetBlock } from '@/lib/types';
import type { GenerateObjectInput } from '@/lib/models/types';
import type { AssetGovernanceRecord, GeoTask, GeoSeed, GeoProposal } from './types';
import type { GeoDiagnosis, GeoWorkflow, QualityLoop, QualityReview, StrategyMemory } from './workflow-types';
import { buildDiagnosisContext, localDiagnosis, validateDiagnosis, validateProposal, readRegisteredEvidence, type DiagnosisContext } from './diagnosis';
import { buildQualityReview, proposalDigest, runQualityLoop, continueQualityLoop, QUALITY_CRITERIA_VERSION, GEO_ACCEPTANCE_CRITERIA_VERSION, QUALITY_MINIMUM, QUALITY_TARGET, type QualityIssue } from './quality';
export { proposalDigest } from './quality';
import { assertResearchTaskSearchEligible, researchTaskQuestion } from './research-task-context';
import { readAgentParameters, readAgentText } from './agent-files';
import { withOneImprovementStructureRetry } from './improvement-structured-output';


type ResearchSnapshot = NonNullable<NonNullable<GeoTask['researchContext']>['snapshot']>;
type ResearchDiagnosisContext = DiagnosisContext & {
  research?: {
    purpose: string;
    originalQuestion: Omit<ResearchSnapshot, 'question' | 'targetAsset' | 'competitorReference'> & {
      question: Omit<ResearchSnapshot['question'], 'diagnosis' | 'observations' | 'zh' | 'en'> & Partial<Pick<ResearchSnapshot['question'], 'zh' | 'en'>>;
      targetAssetId?: string;
    };
    selectedSourceUrl: string | null;
    selectedGap: string | null;
    selectedTargetAssetId: string | null;
    competitorReference: NonNullable<NonNullable<GeoTask['researchContext']>['snapshot']>['competitorReference'] | null;
    acceptanceGoals: string[];
    referenceEvidence: { path: string; text: string; truncated: boolean }[];
    userRegisteredEvidence: { record: AssetGovernanceRecord; verified: false; boundary: string } | null;
    boundary: string;
  };
};

function taskMaterialSeed(task: GeoTask, seed: GeoSeed): GeoSeed {
  const target = task.researchContext?.snapshot?.targetAsset;
  // A selected asset is the content the user reviewed when creating this task.
  let assets = target ? [...seed.assets.filter(asset => asset.id !== target.id), structuredClone(target)] : seed.assets;
  if (task.workflow?.savedResearch) {
    const allowed = new Set(task.workflow.questions.flatMap(question => question.assetIds));
    const language = task.workflow.savedResearch.language;
    assets = assets.filter(asset => allowed.has(asset.id) && (target ? asset.id === target.id : asset.language.startsWith(language)));
  }
  return { ...seed, assets };
}

/** Plan from one saved, exact observation. This does not collect, persist or manufacture a run. */
export function prepareSavedResearchWorkflow(task: GeoTask, seed: GeoSeed): GeoWorkflow {
  const research = task.researchContext;
  if (!research?.snapshot) throw new Error('任务没有保存的研究原题与证据，请从已有问题重新建立任务。');
  if (task.implementation) throw new Error('已有实施记录的任务不能重建方案。');
  if ((task.projectId && task.projectId !== seed.project.id) || (research.projectId && research.projectId !== seed.project.id))
    throw new Error('研究任务不属于当前项目。');
  if (research.purpose && research.purpose !== 'improve_answer') throw new Error('缺口核查任务不能直接生成改稿。');
  assertResearchTaskSearchEligible(research);
  const question = researchTaskQuestion(research, seed.project.id);
  const observation = research.snapshot.observations.filter(item => item.engine === research.engine
    && item.language === research.language && item.query === question.query
    && (!research.sourceUrl || item.sources.some(source => source.url === research.sourceUrl))).at(-1);
  if (!observation) throw new Error('任务没有同题、同语言、同入口的已保存观测。');
  const workflow: GeoWorkflow = {
    version: 1, questionPlanId: research.batchId, questionPlanRevision: research.snapshot.question.questionPlanRevision ?? 1,
    frozenAt: new Date().toISOString(), questions: [question], savedResearch: structuredClone(observation),
    protocolKey: `saved-research:${research.batchId}:${research.questionId}:${research.language}:${research.engine}:${observation.recordedAt}`,
    stage: 'diagnosis', proposalRevision: task.workflow?.proposalRevision ?? 0, appliedStrategyIds: [], maxQualityRounds: 2,
  };
  const context = buildTaskDiagnosisContext({ ...task, workflow }, seed);
  if (!context.evidenceReady) throw new Error(`保存证据尚不能生成方案：${context.limitations.join(' ')}`);
  return workflow;
}

/** Retain research intent for the writer and independent reviewer without turning it into a baseline. */
export function buildTaskDiagnosisContext(task: GeoTask, seed: GeoSeed, strategies: StrategyMemory[] = []): ResearchDiagnosisContext {
  const context: ResearchDiagnosisContext = buildDiagnosisContext(task, taskMaterialSeed(task, seed), strategies);
  const research = task.researchContext;
  if (!research?.snapshot) return context;
  const snapshot = research.snapshot;
  const registered = task.assetGovernance;
  const matchingRegistration = registered && registered.projectId === seed.project.id
    && registered.projectId === snapshot.projectId && registered.batchId === research.batchId
    && registered.questionId === research.questionId && registered.gapId === research.gapId
    && registered.gap === research.gap && registered.taskIds.includes(task.id) ? registered : null;
  const hasUserSupplement = Boolean(matchingRegistration && (matchingRegistration.resolution?.trim()
    || matchingRegistration.evidence.some(item => item.note.trim() || item.url?.trim())));
  const registrationBoundary = '补充证据、人工结论和解决状态是用户登记记录，尚未经联网核实。外部 URL 仅为待核查线索，未读取其正文，不得把登记为已解决当作事实证明、搜索资格或方案审核通过。';
  const primaryPaths = new Set(task.workflow?.savedResearch
    ? [task.workflow.savedResearch.evidencePath, task.workflow.savedResearch.answerPath].filter(Boolean) : []);
  const references = [...new Set([...(context.savedResearch ? [] : [snapshot.reviewPath, snapshot.sourceAuditPath, snapshot.reportPath]),
    ...(snapshot.competitorReference?.evidence.flatMap(item => [item.evidencePath, item.answerPath ?? '']) ?? []),
    ...(context.savedResearch ? [] : snapshot.observations).flatMap(observation => [observation.evidencePath, observation.answerPath ?? ''])].filter(file => Boolean(file) && !primaryPaths.has(file)))];
  let remaining = 30000;
  const referenceEvidence = references.flatMap(file => {
    const raw = readRegisteredEvidence(file);
    if (raw === null || remaining <= 0) return [];
    const excerpt = raw.slice(0, Math.min(6000, remaining));
    remaining -= excerpt.length;
    return [{ path: file, text: excerpt, truncated: excerpt.length !== raw.length }];
  });
  context.goal = `原始需求：${snapshot.question[research.language]}\n争取价值：${snapshot.question.valueReason}\n当前承接：${snapshot.question.answerability}\n用户任务要求：${task.goal}`;
  const { diagnosis: _historicalDiagnosis, observations: _allObservations, ...originalQuestion } = snapshot.question;
  if (context.savedResearch) delete (originalQuestion as Partial<typeof originalQuestion>)[research.language === 'zh' ? 'en' : 'zh'];
  const { targetAsset: _targetAsset, competitorReference: _reference, ...originalSnapshot } = snapshot;
  context.research = { purpose: research.purpose ?? 'improve_answer', originalQuestion: structuredClone({ ...originalSnapshot,
    question: originalQuestion, observations: context.savedResearch ? [] : snapshot.observations,
    ...(snapshot.targetAsset ? { targetAssetId: snapshot.targetAsset.id } : {}) }),
    selectedSourceUrl: research.sourceUrl ?? null, selectedGap: research.gap ?? null,
    selectedTargetAssetId: research.targetAssetId ?? null, referenceEvidence,
    competitorReference: snapshot.competitorReference ? structuredClone(snapshot.competitorReference) : null,
    acceptanceGoals: snapshot.competitorReference ? [
      '自身改善：按同题、同语言、同入口与相同条件，复测自身相对保存基线是否改善，分别保留提及与自有引用口径。',
      `缩小差距：在相同条件下同时复测自身和${snapshot.competitorReference.name}，与保存的双方差距比较。未知不能当作零，没有可比后测时只记待复测。`,
    ] : [],
    userRegisteredEvidence: matchingRegistration && hasUserSupplement ? { record: structuredClone(matchingRegistration), verified: false, boundary: registrationBoundary } : null,
    boundary: context.savedResearch
      ? '本次以已保存的原始回答或搜索片段比较内容并提出改稿；不是新采集基线，不代表已实施或已见效果。引用原文必须说明其原始时间、入口和条件。候选资产不代表已满足需求。'
      : '保存的研究观测和来源只供解释选题、缺口与内容核查，不是本任务采集入口的新基线；引用原文必须说明其原始时间、入口和条件。候选资产只表示可核查材料，不代表已满足需求。' };
  context.allowedEvidencePaths = [...new Set([...context.allowedEvidencePaths, ...referenceEvidence.map(item => item.path)])];
  if (hasUserSupplement) context.limitations.push(registrationBoundary);
  context.limitations.push(context.research.boundary,
    '不得削弱或替换中英原问题来让方案通过；原需求、选中来源、选中缺口与选中目标都需回应。未读来源全文不能推断其具体内容或优势。');
  if (snapshot.competitorReference) {
    context.goal += `\n参照：${snapshot.competitorReference.name}\n双重目标：自身比保存基线改善，并缩小与该参照的差距。`;
    context.limitations.push('参照身份、差距与学习依据以任务保存快照为准，不得跟随当前参照设置变化。机会中的 hypothesis 是待验证推断；需指出具体可学习做法、支持证据和适用边界。successCriteria 必须分别覆盖自身改善与差距缩小；一次方案审核通过不代表任一效果已实现。不同入口的新任务基线不能直接与原参照基线相减。');
  }
  if (snapshot.projectId !== seed.project.id) {
    context.evidenceReady = false;
    context.limitations.push('研究依据不属于当前项目，停止生成改稿。');
  }
  try { assertResearchTaskSearchEligible(research); } catch (error) {
    context.evidenceReady = false;
    context.limitations.push(error instanceof Error ? error.message : '原题尚未取得搜索和改稿资格。');
  }
  if (research.targetAssetId) context.allowedTargetAssetIds = context.allowedTargetAssetIds.filter(id => id === research.targetAssetId);
  return context;
}

/** Free local inspection: it reports available material, never fills a gap by assertion or grants approval. */
export function buildResearchGapReview(task: GeoTask, seed: GeoSeed): GeoDiagnosis {
  const research = task.researchContext;
  if (!research?.snapshot || research.purpose !== 'investigate_gap' || !research.gap)
    throw new Error('这条任务没有已保存的原始缺口。');
  if (research.snapshot.projectId !== seed.project.id) throw new Error('缺口依据不属于当前项目。');
  const context = buildTaskDiagnosisContext(task, seed);
  const readable = context.research!.referenceEvidence.map(item => item.path);
  const target = research.snapshot.targetAsset;
  const registration = context.research!.userRegisteredEvidence;
  const record = registration?.record;
  const statusLabels = { open: '待补充', investigating: '调查中', resolved: '已解决' };
  return {
    summary: `已核对本地保存的 ${readable.length} 份研究材料${target ? `及《${target.title}》的登记正文` : ''}；${record ? `用户已登记为“${statusLabels[record.status]}”，该结论尚未联网核实。` : '原缺口仍待实证核查。'}`,
    findings: [{ id: research.gapId ?? research.questionId,
      observation: `原始缺口：${research.gap}\n当前承接记录：${research.snapshot.question.answerability}`,
      hypothesis: research.snapshot.question.diagnosis.hypothesis,
      evidencePaths: readable,
      uncertainty: '本地检查仅确认材料可读取，不判断缺口已经补齐，也不证明相关产品能力或需求价值。' },
      ...(record ? [{ id: `user-registration-${record.id}`,
        observation: `用户登记状态：${statusLabels[record.status]}（${record.updatedAt}）\n人工结论：${record.resolution || '未填写'}\n补充证据：\n${record.evidence.map(item => `${item.at} · ${item.note}${item.url ? `\n待核查链接：${item.url}` : ''}`).join('\n') || '未登记'}`,
        hypothesis: '这些补充材料可能影响对原缺口的判断，需逐项核查其与原需求的关系及内容真实性。',
        evidencePaths: [], uncertainty: registration!.boundary }] : [])],
    comparisons: [],
    recommendedAction: record ? `先核查用户补充证据与人工结论，再复审原始缺口：${research.snapshot.question.diagnosis.nextStep}` : research.snapshot.question.diagnosis.nextStep,
    limitations: [...context.limitations, '本次未调用模型、搜索或发布；核查结论与补充证据需另行记录，原题资格不因此改变。'],
    source: 'local', createdAt: new Date().toISOString(),
  };
}

function unreviewedResearchProposal(task: GeoTask): GeoProposal {
  const research = task.researchContext!;
  const question = research.snapshot?.question;
  return { id: `${task.id}-proposal`, title: `核查 ${research.questionId} 的承接材料`, status: 'unreviewed',
    rationale: [research.gap, question?.diagnosis.nextStep, question?.answerability].filter(Boolean).join('\n'),
    targetAssetId: research.targetAssetId ?? '', targetUrl: research.targetUrl ?? '', before: '', after: '', changes: [], evidencePaths: [],
    successCriteria: [`保持原问题：${question?.[research.language] ?? task.goal}；核验原始回答或搜索证据后，再提出具体改动并独立审核。`],
    limitations: ['尚未生成候选正文，不能据此实施或认定缺口已解决。'] };
}

export function getGeoModelSettings() {
  const connection = getGeoModelConnection();
  return { modelConfigured: connection.configured, modelName: connection.configured ? connection.model : null };
}

const boundedText = (max = 3000) => z.string().trim().min(1).max(max);
const paths = z.array(boundedText(1000)).min(1).max(30);
const diagnosisSchema = z.object({
  summary: boundedText(),
  findings: z.array(z.object({ id: boundedText(180), observation: boundedText(), hypothesis: boundedText(),
    evidencePaths: paths, uncertainty: boundedText() }).strict()).min(1).max(20),
  comparisons: z.array(z.object({ questionId: boundedText(180), sourceUrl: boundedText(2048),
    observedDifference: boundedText(), evidencePath: boundedText(1000) }).strict()).max(20),
  recommendedAction: boundedText(), limitations: z.array(boundedText()).min(1).max(15),
}).strict();
const proposalSchema = z.object({
  title: boundedText(500), rationale: boundedText(6000), targetAssetId: boundedText(180),
  before: boundedText(20000), after: boundedText(30000),
  changes: z.array(boundedText(2000)).min(1).max(8), evidencePaths: paths,
  successCriteria: z.array(boundedText(2000)).min(1).max(8), limitations: z.array(boundedText(2000)).min(1).max(15),
}).strict();
const dimensions = ['evidence', 'relevance', 'actionability', 'verifiability'] as const;
const reviewSchema = z.object({
  scores: z.object({ evidence: z.number().min(0).max(100), relevance: z.number().min(0).max(100),
    actionability: z.number().min(0).max(100), verifiability: z.number().min(0).max(100) }).strict(),
  reasons: z.object({ evidence: boundedText(), relevance: boundedText(), actionability: boundedText(), verifiability: boundedText() }).strict(),
  issues: z.array(z.object({ dimension: z.enum(dimensions), severity: z.enum(['blocking', 'improvement']),
    detail: boundedText(), suggestion: boundedText() }).strict()).max(30),
  summary: boundedText(),
}).strict();
const geoAcceptanceCheckSchema = z.object({ met: z.boolean(), criterionQuote: z.string().max(2000), reason: boundedText(1600) }).strict();
const geoReviewSchema = reviewSchema.extend({ geoAcceptance: z.object({
  implementation: geoAcceptanceCheckSchema, ownBrandMention: geoAcceptanceCheckSchema,
  ownTargetCitation: geoAcceptanceCheckSchema, comparableConditions: geoAcceptanceCheckSchema,
  unknownBaseline: geoAcceptanceCheckSchema,
}).strict() }).strict();

type StructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };
const loadModel = async () => withOneImprovementStructureRetry(await loadGeoModel());

const modelOptionsSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
}).strict();
const improvementParametersSchema = z.object({
  diagnose: modelOptionsSchema,
  propose: modelOptionsSchema,
  review: modelOptionsSchema,
  repair: modelOptionsSchema,
  defaultMaxQualityRounds: z.number().int().min(1).max(3),
}).strict();

function improvementParameters() {
  return readAgentParameters('improvement-planning', improvementParametersSchema);
}

function improvementPrompt(stage: 'diagnose' | 'propose' | 'review' | 'repair'): string {
  return [readAgentText('improvement-planning', 'common.md'), readAgentText('improvement-planning', `${stage}.md`),
    ...(stage === 'propose' || stage === 'repair' ? [readAgentText('improvement-planning', 'proposal-requirements.md')] : [])].join(' ');
}

function candidateFromModel(draft: z.infer<typeof proposalSchema>, task: GeoTask, seed: GeoSeed): GeoProposal {
  const target = seed.assets.find(asset => asset.id === draft.targetAssetId);
  return { ...draft, id: `${task.id}-proposal`, status: 'draft', targetUrl: target?.publicUrl ?? '' };
}

async function createCandidate(model: StructuredModel, task: GeoTask, seed: GeoSeed, context: DiagnosisContext,
  diagnosis: GeoDiagnosis, previous?: { proposal: GeoProposal; review: QualityReview }): Promise<GeoProposal> {
  const draft = proposalSchema.parse(await model.generateObject<z.infer<typeof proposalSchema>>({
    schema: proposalSchema,
    messages: [
      { role: 'system', content: improvementPrompt(previous ? 'repair' : 'propose') },
      { role: 'user', content: JSON.stringify({ context, diagnosis, ...(previous ? { previousCandidate: previous.proposal, issuesToRepair: previous.review.issues, previousAssessment: previous.review.summary } : {}) }) },
    ], options: improvementParameters()[previous ? 'repair' : 'propose'],
  }));
  const candidate = candidateFromModel(draft, task, seed);
  if (previous && (candidate.targetAssetId !== previous.proposal.targetAssetId || candidate.targetUrl !== previous.proposal.targetUrl || candidate.before !== previous.proposal.before)) {
    throw new Error('修订改变了原定目标或替换范围，已停止并保留原稿。');
  }
  return candidate;
}

function structuralIssues(proposal: GeoProposal, seed: GeoSeed, context: DiagnosisContext, diagnosis: GeoDiagnosis): QualityIssue[] {
  return [...validateDiagnosis(diagnosis, context), ...validateProposal(proposal, seed, context)];
}

/** Rebuild review input from primary material, with no writer history, old diagnosis or earlier scores. */
export function buildIndependentReviewInput(context: ResearchDiagnosisContext, diagnosis: GeoDiagnosis,
  proposal: GeoProposal, structuralProblems: QualityIssue[]) {
  const independent = structuredClone(context);
  independent.strategies = [];
  if (independent.research) {
    // The generated diagnosis is supplied separately as a claim to review. Historical conclusions
    // and report prose must not become the independent reviewer's factual starting point.
    independent.research.originalQuestion.observations = [];
    const rawPaths = new Set(independent.questions.filter(question => question.rawAvailable).map(question => question.evidencePath));
    independent.research.referenceEvidence = independent.research.referenceEvidence.filter(item => rawPaths.has(item.path));
    if (independent.research.competitorReference) {
      // The selected reference and evidence stay; its previous suggested actions are not review guidance.
      independent.research.competitorReference.opportunities = [];
    }
  }
  return { context: independent, diagnosisToReview: diagnosis, fullCandidate: proposal, structuralProblems };
}

async function assessCandidate(model: StructuredModel, proposal: GeoProposal, seed: GeoSeed,
  context: DiagnosisContext, diagnosis: GeoDiagnosis): Promise<QualityReview> {
  // This fresh context excludes earlier scores and the writer's conversation.
  const schema = context.savedResearch ? geoReviewSchema : reviewSchema;
  const assessment = schema.parse(await model.generateObject({
    schema,
    messages: [
      { role: 'system', content: improvementPrompt('review') },
      { role: 'user', content: JSON.stringify(buildIndependentReviewInput(context, diagnosis, proposal,
        structuralIssues(proposal, seed, context, diagnosis))) },
    ], options: improvementParameters().review,
  }));
  const labels = { evidence: '事实与证据', relevance: '问题与措施匹配', actionability: '可执行程度', verifiability: '验证方案' };
  const geoAcceptance = context.savedResearch ? geoReviewSchema.parse(assessment).geoAcceptance : undefined;
  return buildQualityReview(proposal, { ...assessment,
    ...(context.savedResearch ? { geoAcceptanceRequired: true, geoAcceptance } : {}),
    summary: `${assessment.summary}\n${dimensions.map(dimension => `${labels[dimension]}：${assessment.reasons[dimension]}`).join('\n')}${geoAcceptance ? '\nGEO 验收：\n' + Object.values(geoAcceptance).map(check => `${check.met ? '满足' : '不满足'}：${check.reason}`).join('\n') : ''}` },
  structuralIssues(proposal, seed, context, diagnosis));
}

function previewLoop(proposal: GeoProposal, seed: GeoSeed, context: DiagnosisContext, diagnosis: GeoDiagnosis,
  stopReason: 'needs_configuration' | 'needs_evidence'): QualityLoop {
  const review = buildQualityReview(proposal, null, [...structuralIssues(proposal, seed, context, diagnosis),
    { dimension: 'evidence', severity: 'blocking', detail: stopReason === 'needs_configuration' ? '尚未配置模型，未执行诊断与独立质量审核。' : '原始回答、搜索证据或内容比较依据不足，不能交付实施方案。',
      suggestion: stopReason === 'needs_configuration' ? '配置模型后显式执行诊断与质量检查。' : '补齐本轮真实原始证据后重做诊断。' }]);
  return { maxRounds: improvementParameters().defaultMaxQualityRounds, targetScore: QUALITY_TARGET, minimumDimensionScore: QUALITY_MINIMUM,
    stopReason, rounds: [{ round: 1, candidate: proposal, review }], bestRound: 1 };
}

function makeBlocks(proposal: GeoProposal, diagnosis: GeoDiagnosis, quality: QualityLoop,
  context: DiagnosisContext, appliedStrategyIds: string[]): WidgetBlock[] {
  const session = SessionManager.createSession();
  const params: Record<string, Record<string, unknown>> = {
    evidence_summary: { title: '本轮观测与诊断', summary: diagnosis.summary, findings: diagnosis.findings,
      diagnosis, observation: context.savedResearch ?? context.baseline, sourceLabel: diagnosis.source === 'model' ? context.savedResearch ? '基于已保存证据的内容比较' : '基于本轮真实证据诊断' : '本地预览 · 尚未通过审核',
      appliedStrategyIds, strategies: context.strategies.filter(strategy => appliedStrategyIds.includes(strategy.id)) },
    proposal: { ...proposal, proposal, quality },
    implementation: { title: '记录这项改进的实施', targetUrl: proposal.targetUrl, note: '仅通过当前版本质量审核的候选可以确认实施。' },
    monitor: { title: '实施后按固定条件观察', days: 7, timeOfDay: '09:00', queryCount: context.questions.length,
      estimatedCost: context.questions.length * (context.questions.some(question => question.answer) ? 0.1 : 0.005),
      mode: context.questions.some(question => question.answer) ? 'live' : 'replay',
      costNote: '采集费用预留，模型生成与审核另计；不作为供应商账单。' },
  };
  for (const [widgetType, value] of Object.entries(params)) session.emitBlock({ id: randomUUID(), type: 'widget', data: { widgetType, params: value } });
  const blocks = session.getAllBlocks().filter((block): block is WidgetBlock => block.type === 'widget');
  session.emit('end', {}); session.removeAllListeners();
  return blocks;
}

export async function buildTaskPlan(task: GeoTask, seed: GeoSeed, strategies: StrategyMemory[] = []): Promise<{
  proposal: GeoProposal; blocks: WidgetBlock[]; source: 'evidence' | 'model'; diagnosis: GeoDiagnosis;
  quality: QualityLoop; appliedStrategyIds: string[];
}> {
  seed = taskMaterialSeed(task, seed);
  const context = buildTaskDiagnosisContext(task, seed, strategies);
  let diagnosis = localDiagnosis(context);
  let proposal: GeoProposal = { ...structuredClone(task.proposal ?? (task.researchContext ? unreviewedResearchProposal(task) : seed.proposal)), status: 'unreviewed' };
  let quality: QualityLoop;
  let source: 'evidence' | 'model' = 'evidence';
  let appliedStrategyIds: string[] = [];
  if (!getGeoModelSettings().modelConfigured || !context.evidenceReady) {
    quality = previewLoop(proposal, seed, context, diagnosis,
      !getGeoModelSettings().modelConfigured ? 'needs_configuration' : 'needs_evidence');
  } else {
    const model = await loadModel();
    const result = diagnosisSchema.parse(await model.generateObject<z.infer<typeof diagnosisSchema>>({
      schema: diagnosisSchema,
      messages: [
        { role: 'system', content: improvementPrompt('diagnose') },
        { role: 'user', content: JSON.stringify(context) },
      ], options: improvementParameters().diagnose,
    }));
    diagnosis = { ...result, limitations: [...new Set([...result.limitations, ...context.limitations])], source: 'model', createdAt: new Date().toISOString() };
    appliedStrategyIds = context.strategies.map(strategy => strategy.id);
    source = 'model';
    if (validateDiagnosis(diagnosis, context).length) {
      quality = previewLoop(proposal, seed, context, diagnosis, 'needs_evidence');
    } else {
      proposal = await createCandidate(model, task, seed, context, diagnosis);
      quality = await runQualityLoop(proposal,
        candidate => assessCandidate(model, candidate, seed, context, diagnosis),
        (candidate, review) => createCandidate(model, task, seed, context, diagnosis, { proposal: candidate, review }), task.workflow?.maxQualityRounds ?? improvementParameters().defaultMaxQualityRounds);
      proposal = structuredClone(quality.rounds.find(round => round.round === quality.bestRound)!.candidate);
      proposal.status = quality.rounds.find(round => round.round === quality.bestRound)!.review.passed ? 'reviewed' : 'needs_review';
    }
  }
  return { proposal, blocks: makeBlocks(proposal, diagnosis, quality, context, appliedStrategyIds), source, diagnosis, quality, appliedStrategyIds };
}

/** Recheck the exact user-edited candidate once. Editing never silently authorizes an automatic rewrite. */
export async function reviewEditedProposal(task: GeoTask, seed: GeoSeed, proposal: GeoProposal,
  strategies: StrategyMemory[] = []): Promise<QualityLoop> {
  seed = taskMaterialSeed(task, seed);
  const context = buildTaskDiagnosisContext(task, seed, strategies);
  const diagnosis = task.workflow?.diagnosis ?? localDiagnosis(context);
  if (!getGeoModelSettings().modelConfigured || !context.evidenceReady || diagnosis.source !== 'model') {
    return previewLoop(proposal, seed, context, diagnosis,
      !getGeoModelSettings().modelConfigured ? 'needs_configuration' : 'needs_evidence');
  }
  const review = await assessCandidate(await loadModel(), proposal, seed, context, diagnosis);
  return { maxRounds: 1, targetScore: QUALITY_TARGET, minimumDimensionScore: QUALITY_MINIMUM,
    stopReason: review.passed ? 'target_reached' : 'round_limit', rounds: [{ round: 1, candidate: structuredClone(proposal), review }], bestRound: 1 };
}

function currentRevisionReview(task: GeoTask): QualityReview | undefined {
  if (!task.proposal) return;
  const digest = proposalDigest(task.proposal);
  const criteriaVersion = task.workflow?.savedResearch ? GEO_ACCEPTANCE_CRITERIA_VERSION : QUALITY_CRITERIA_VERSION;
  const latest = task.workflow?.quality?.rounds.slice().reverse().find(round => round.review.proposalDigest === digest)?.review;
  return latest?.source === 'model' && latest.criteriaVersion === criteriaVersion ? latest : undefined;
}

export function canContinueTaskRevision(task: GeoTask): boolean {
  const review = currentRevisionReview(task);
  if (task.researchContext) { try { assertResearchTaskSearchEligible(task.researchContext); } catch { return false; } }
  return Boolean(review && !review.passed && !task.implementation
    && ['proposal_ready', 'failed'].includes(task.status) && getGeoModelSettings().modelConfigured
    && (task.workflow?.savedResearch || (task.workflow?.baseline?.mode === 'live' && task.workflow.baseline.status === 'completed'))
    && task.workflow.diagnosis?.source === 'model');
}

/** Continue the exact reviewed draft; neither search nor diagnosis is repeated. */
export async function continueTaskRevision(task: GeoTask, seed: GeoSeed, strategies: StrategyMemory[],
  maxAdditionalRounds: number, assertActive: () => void): Promise<{ proposal: GeoProposal; quality: QualityLoop; blocks: WidgetBlock[] }> {
  if (!canContinueTaskRevision(task)) throw new Error('当前稿没有可继续使用的未通过审核，请先保存并复检当前版本。');
  seed = taskMaterialSeed(task, seed);
  const context = buildTaskDiagnosisContext(task, seed, strategies);
  const diagnosis = task.workflow!.diagnosis!;
  if (!context.evidenceReady || validateDiagnosis(diagnosis, context).length) throw new Error('现有证据不完整或诊断已失效，不能继续自动改稿。');
  const model = await loadModel();
  const quality = await continueQualityLoop(task.proposal!, currentRevisionReview(task)!,
    candidate => { assertActive(); return assessCandidate(model, candidate, seed, context, diagnosis); },
    (candidate, review) => { assertActive(); return createCandidate(model, task, seed, context, diagnosis, { proposal: candidate, review }); },
    maxAdditionalRounds);
  const best = quality.rounds.find(round => round.round === quality.bestRound)!;
  const proposal = { ...structuredClone(best.candidate), status: best.review.passed ? 'reviewed' as const : 'needs_review' as const };
  return { proposal, quality, blocks: makeBlocks(proposal, diagnosis, quality, context, task.workflow!.appliedStrategyIds) };
}

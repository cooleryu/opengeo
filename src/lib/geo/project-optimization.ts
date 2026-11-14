import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import type { GeoStructuredModel } from './connection-settings';
import { loadImprovementModel } from './improvement-model';
import { readRegisteredEvidence } from './diagnosis';
import { readSavedResearchEvidence } from './saved-research-evidence';
import type { ResearchBatch } from './research-types';
import type { GeoSeed } from './types';
import { editableAssetIssue, resolveAssetOwnership } from './asset-ownership';
import type { ProjectOptimization, ProjectOptimizationMode, ProjectOptimizationPhase, ProjectOptimizationReview } from './project-optimization-types';

const optimizationBoundary = '仅使用本次冻结的已有回答、自有内容和外部参考；外部参考不可作为修改目标。未重新搜索、实施、发布或跟测。诊断原因是待验证假设，审核通过也不代表真实效果。';

const modelOptionsSchema = z.object({ temperature: z.number().min(0).max(2), maxTokens: z.number().int().positive() }).strict();
const maxRoundsSchema = z.number().int().min(1).max(2);
const projectParametersSchema = z.object({
  projectOptimization: z.object({
    defaultMaxRounds: maxRoundsSchema,
    focus: modelOptionsSchema,
    deep: modelOptionsSchema,
    review: modelOptionsSchema,
  }).strict(),
});
function projectParameters() {
  return readAgentParameters('improvement-planning', projectParametersSchema).projectOptimization;
}

export function setProjectOptimizationProgress(plan: ProjectOptimization, phase: ProjectOptimizationPhase, message: string,
  round = plan.progress?.round ?? 0): void {
  plan.phase = phase;
  plan.progress = { message, round, maxRounds: plan.maxRounds ?? projectParameters().defaultMaxRounds, updatedAt: new Date().toISOString() };
}

/** Older saved candidates remain inspectable when their task is explicitly retried. */
export function preserveProjectOptimizationHistory(plan: ProjectOptimization): void {
  if (!plan.history?.length && (plan.actions.length || plan.review)) {
    plan.history = [{ attempt: plan.attempt ?? 1, round: plan.progress?.round || 1,
      candidateSavedAt: plan.review?.reviewedAt ?? plan.frozenAt, summary: plan.summary,
      actions: structuredClone(plan.actions), limitations: [...plan.limitations], review: structuredClone(plan.review) }];
  }
}

/** Keep a valid UTF-8 prefix without splitting a multi-byte character. Budgets count bytes, not JS characters. */
function utf8Prefix(value: string, budget: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= budget) return value;
  let end = Math.max(0, Math.floor(budget));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function omission(id: string, supplied: string, original: string, reason: string): string | null {
  const provided = Buffer.byteLength(supplied, 'utf8');
  const total = Buffer.byteLength(original, 'utf8');
  return provided < total ? `${id}：提供原文 ${provided} / ${total} UTF-8 字节；余下 ${total - provided} 字节因${reason}未提供，不作为已核查内容。` : null;
}

export function validateProjectOptimizationMode(value: unknown): ProjectOptimizationMode {
  if (value !== 'focus' && value !== 'deep') throw new Error('请选择重点优化或深度优化模式。');
  return value;
}

/** Freeze all current questions, never a client-side selection or a new measurement. */
export function freezeProjectOptimization(batch: ResearchBatch | null, seed: GeoSeed, mode: ProjectOptimizationMode,
  batchId: unknown, read = readRegisteredEvidence, frozenAt = new Date().toISOString()): ProjectOptimization {
  validateProjectOptimizationMode(mode);
  if (!batch || batch.id !== batchId) throw new Error('当前问题批次已变化，请刷新后再开始。');
  if (batch.projectId !== seed.project.id) throw new Error('问题批次不属于当前项目。');
  if (!batch.questions.length) throw new Error('当前批次还没有问题，请先确认问题。');
  if (new Set(batch.questions.map(question => question.id)).size !== batch.questions.length) throw new Error('问题批次包含重复 ID，无法冻结范围。');
  const snapshot: ProjectOptimization['snapshot'] = { project: structuredClone(seed.project), batchDate: batch.date,
    questions: structuredClone(batch.questions), assets: structuredClone(seed.assets), evidence: [], limitations: [] };
  collectFrozenEvidence(snapshot, read);
  const maxRounds = projectParameters().defaultMaxRounds;
  return { mode, batchId: batch.id, questionIds: snapshot.questions.map(question => question.id),
    questionCount: snapshot.questions.length, frozenAt, phase: 'initializing', attempt: 1, maxRounds, history: [],
    progress: { message: '已保存整批原题、条件与已有材料，正在准备改动。', round: 0, maxRounds, updatedAt: frozenAt },
    summary: '', actions: [], review: null, snapshot,
    limitations: [...snapshot.limitations, optimizationBoundary] };
}

function collectFrozenEvidence(snapshot: ProjectOptimization['snapshot'], read = readRegisteredEvidence): void {
  const questionBudget = Math.floor(512 * 1024 / snapshot.questions.length);
  for (const question of snapshot.questions) {
    const observationBudget = Math.min(32 * 1024, Math.floor(questionBudget / Math.max(1, question.observations.length)));
    if (!question.observations.length) snapshot.limitations.push(`${question.id}：没有已保存的回答记录，相关缺口仍待核实。`);
    question.observations.forEach((observation, index) => {
      const label = `${question.id}:observation:${index} / ${observation.language} / ${observation.engine}`;
      if (observation.query !== question[observation.language]) {
        snapshot.limitations.push(`${label}：记录问法与当前原题不一致，不作为当前题的证据。`); return;
      }
      const saved = readSavedResearchEvidence(observation, read);
      if (!saved.available) { snapshot.limitations.push(`${label}：${saved.error}`); return; }
      const source = saved.answerText ?? saved.results.map(result => JSON.stringify(result)).join('\n');
      const text = utf8Prefix(source, observationBudget);
      const note = omission(label, text, source, '本次按题分配的快照预算');
      if (note) snapshot.limitations.push(note);
      if (!text) return;
      snapshot.evidence.push({ id: `${question.id}:observation:${index}`, questionId: question.id,
        engine: observation.engine, language: observation.language, query: observation.query, recordedAt: observation.recordedAt,
        conditions: observation.conditions, evidencePath: saved.evidencePath, text, boundary: saved.boundary });
    });
  }
}

/** Recover a reader failure using only paths frozen before the model ran. */
export function recoverUnreadProjectEvidence(plan: ProjectOptimization, read = readRegisteredEvidence): boolean {
  if (plan.stopReason !== 'no_evidence' || plan.snapshot.evidence.length || plan.history?.length || plan.actions.length) return false;
  const recovered = structuredClone(plan.snapshot);
  recovered.limitations = [];
  collectFrozenEvidence(recovered, read);
  if (!recovered.evidence.length) return false;
  plan.snapshot = recovered;
  plan.limitations = [...recovered.limitations, optimizationBoundary];
  return true;
}

const text = (max = 6000) => z.string().trim().min(1).max(max);
const strings = (max = 30) => z.array(text()).max(max);
const actionSchema = z.object({ id: text(100), title: text(250), priority: z.number().int().min(1).max(8),
  questionIds: strings(100).min(1), assetIds: strings(100), observed: text(), hypothesis: text(), change: text(16_000),
  rationale: text(), evidence: z.array(z.object({ evidenceId: text(200), quote: text(1000) }).strict()).min(1).max(40),
  verification: text(), limitations: strings(),
}).strict();
const draftSchema = z.object({ summary: text(), actions: z.array(actionSchema).max(8), limitations: strings() }).strict();
const hardCheck = z.enum(['pass', 'fail', 'unknown']);
const score = z.number().min(0).max(100);
const reviewSchema = z.object({ issues: strings(), actions: z.array(z.object({ actionId: text(100),
  scores: z.object({ evidence: score, relevance: score, actionability: score, verifiability: score }).strict(),
  preservesGoal: hardCheck, evidenceGrounded: hardCheck, issues: strings(),
}).strict()).max(8) }).strict();

/** Both roles receive this identical bounded evidence set, with historical conclusions removed. */
function modelContext(plan: ProjectOptimization) {
  const deep = plan.mode === 'deep';
  // Retry uses the same primary record, not limitations or judgments written by an earlier candidate.
  const limitations = [...plan.snapshot.limitations, ...(plan.preparedMaterials?.limitations ?? []), optimizationBoundary];
  // Separate pools prevent plentiful answers from consuming owned-content space.
  // Divide the answer pool by all frozen questions, then each question's saved records.
  const selected = new Set(plan.actions.flatMap(action => action.questionIds));
  const totalBudget = (deep ? 176 : 56) * 1024;
  const selectedRecords = plan.snapshot.evidence.filter(item => selected.has(item.questionId));
  const selectedBudget = Math.min(32 * 1024, selectedRecords.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0));
  const questionBudget = Math.floor((totalBudget - selectedBudget) / Math.max(1, plan.questionCount - selected.size));
  const evidence = plan.questionIds.flatMap(questionId => {
    const records = plan.snapshot.evidence.filter(item => item.questionId === questionId);
    const recordBudget = selected.has(questionId)
      ? Math.floor(selectedBudget / Math.max(1, selectedRecords.length))
      : Math.min((deep ? 16 : 8) * 1024, Math.floor(questionBudget / Math.max(1, records.length)));
    return records.flatMap(item => {
      const excerpt = utf8Prefix(item.text, recordBudget);
      const note = omission(item.id, excerpt, item.text, '本模式的逐题回答预算');
      if (note) limitations.push(note);
      return excerpt ? [{ ...item, text: excerpt }] : [];
    });
  });
  const materials = plan.preparedMaterials?.assets ?? plan.snapshot.assets;
  const assetBudget = Math.floor((deep ? 64 : 32) * 1024 / Math.max(1, materials.length));
  const assets = materials.map(asset => {
    const markdown = utf8Prefix(asset.markdown, assetBudget);
    const note = omission(asset.id, markdown, asset.markdown, '本模式的材料正文预算');
    if (note) limitations.push(note);
    if (asset.markdownIsExcerpt) limitations.push(`${asset.id}：保存的正文原本就是节选，完整来源的未提供字节数未知。`);
    return { id: asset.id, title: asset.title, language: asset.language, publicUrl: asset.publicUrl,
      sourcePath: asset.sourcePath, ...resolveAssetOwnership(asset, plan.snapshot),
      editable: !editableAssetIssue(asset, plan.snapshot), markdown,
      excerpt: markdown.length < asset.markdown.length || Boolean(asset.markdownIsExcerpt) };
  });
  return { mode: plan.mode, maximumActions: deep ? 8 : 3, project: plan.snapshot.project,
    batchId: plan.batchId, frozenAt: plan.frozenAt, questionCount: plan.questionCount,
    questions: plan.snapshot.questions.map(({ observations: _observations, diagnosis: _diagnosis, ...question }) => question),
    assets, allowedTargetAssetIds: assets.filter(asset => asset.editable).map(asset => asset.id), evidence, limitations };
}
type ModelContext = ReturnType<typeof modelContext>;

function actionIssues(action: z.infer<typeof actionSchema>, context: ModelContext): string[] {
  const issues: string[] = [];
  if (new Set(action.questionIds).size !== action.questionIds.length) issues.push('行动重复列出同一问题。');
  for (const id of action.questionIds) {
    if (!context.questions.some(question => question.id === id)) issues.push(`问题 ${id} 不在冻结范围。`);
    if (!action.evidence.some(ref => context.evidence.some(item => item.id === ref.evidenceId && item.questionId === id)))
      issues.push(`问题 ${id} 没有绑定到本行动的可核验原始证据。`);
  }
  for (const id of action.assetIds) {
    const asset = context.assets.find(asset => asset.id === id);
    if (!asset?.editable) issues.push(`材料 ${id} 不是当前项目可修改的自有内容，外部参考只能作为证据。`);
    else if (!asset.markdown.trim()) issues.push(`自有内容 ${id} 没有提供正文。`);
  }
  for (const reference of action.evidence) {
    const asset = context.assets.find(item => item.id === reference.evidenceId);
    if (asset) {
      if (!asset.markdown.includes(reference.quote)) issues.push(`材料 ${asset.id} 的引文不在提供的原文中。`);
      continue;
    }
    const evidence = context.evidence.find(item => item.id === reference.evidenceId);
    if (!evidence || !action.questionIds.includes(evidence.questionId)) issues.push(`证据 ${reference.evidenceId} 未绑定到本行动原题。`);
    else if (!evidence.text.includes(reference.quote)) issues.push(`证据 ${reference.evidenceId} 的引文不在提供的原文中。`);
  }
  return issues;
}

export interface ProjectOptimizationDependencies {
  loadModel?: () => Promise<GeoStructuredModel>;
  onProgress?: (plan: ProjectOptimization) => void | Promise<void>;
  prepareMaterials?: (plan: ProjectOptimization) => Promise<NonNullable<ProjectOptimization['preparedMaterials']>>;
}

function assessCandidate(candidate: z.infer<typeof draftSchema>, assessment: z.infer<typeof reviewSchema>, context: ModelContext): ProjectOptimizationReview {
  const issues = [...assessment.issues];
  if (!candidate.actions.length) issues.push('没有形成可交付的行动。');
  if (candidate.actions.length > context.maximumActions) issues.push(`本模式最多交付 ${context.maximumActions} 项行动。`);
  if (new Set(candidate.actions.map(action => action.id)).size !== candidate.actions.length) issues.push('行动 ID 重复，无法独立绑定审核。');
  const signatures = candidate.actions.map(action => `${[...action.assetIds].sort().join(',')}:${action.change.replace(/\s+/g, '')}`);
  if (new Set(signatures).size !== signatures.length) issues.push('存在重复的目标与改动，请合并共同问题。');
  if (assessment.actions.some(action => !candidate.actions.some(candidateAction => candidateAction.id === action.actionId))) issues.push('审核包含不属于当前方案的行动。');
  const reviews: ProjectOptimizationReview['actions'] = candidate.actions.map(action => {
    const matches = assessment.actions.filter(item => item.actionId === action.id);
    const review = matches[0];
    const blockers = actionIssues(action, context);
    if (matches.length !== 1) blockers.push('缺少唯一、完整的独立审核。');
    if (review?.preservesGoal !== 'pass') blockers.push('原始需求保持不变尚未通过核查。');
    if (review?.evidenceGrounded !== 'pass') blockers.push('真实证据依据尚未通过核查。');
    const scores = review?.scores ?? { evidence: 0, relevance: 0, actionability: 0, verifiability: 0 };
    const values = Object.values(scores);
    if (values.some(value => value < 70) || values.reduce((sum, value) => sum + value, 0) / 4 < 80) blockers.push('每项至少 70 分、平均至少 80 分的统一标准尚未达到。');
    return { actionId: action.id, scores, preservesGoal: review?.preservesGoal ?? 'unknown', evidenceGrounded: review?.evidenceGrounded ?? 'unknown',
      passed: blockers.length === 0 && issues.length === 0 && !review?.issues.length,
      issues: [...new Set([...blockers, ...(review?.issues ?? [])])] };
  });
  return { passed: issues.length === 0 && reviews.length > 0 && reviews.every(item => item.passed),
    reviewedAt: new Date().toISOString(), issues, actions: reviews };
}

function candidateContent(candidate: z.infer<typeof draftSchema>): string {
  // Renaming an action, changing its order or rewriting only the summary is not a repair.
  return JSON.stringify(candidate.actions.map(({ id: _id, title: _title, priority: _priority, ...action }) => ({
    ...action, questionIds: [...action.questionIds].sort(), assetIds: [...action.assetIds].sort(),
  })).map(action => JSON.stringify(action).replace(/\s+/g, '')).sort());
}

/** Bounded writer/reviewer rounds. Every candidate and assessment is saved before another model call. */
export async function buildProjectOptimization(input: ProjectOptimization, dependencies: ProjectOptimizationDependencies = {}): Promise<ProjectOptimization> {
  const plan = structuredClone(input);
  const parameters = projectParameters();
  plan.maxRounds = maxRoundsSchema.parse(plan.maxRounds ?? parameters.defaultMaxRounds);
  plan.attempt ??= 1;
  preserveProjectOptimizationHistory(plan);
  plan.history ??= [];
  delete plan.stopReason;
  if (dependencies.prepareMaterials && !plan.preparedMaterials) plan.preparedMaterials = await dependencies.prepareMaterials(plan);
  let context = modelContext(plan);
  const publish = async (phase: ProjectOptimizationPhase, message: string, round: number) => {
    setProjectOptimizationProgress(plan, phase, message, round);
    await dependencies.onProgress?.(structuredClone(plan));
  };
  if (!context.evidence.length) {
    plan.stopReason = 'no_evidence';
    if (!plan.summary) plan.summary = '当前保存材料不足以制定有证据的项目方案。';
    await publish('blocked', '已停止：冻结材料没有可核验的原始回答；已有成果已保留，需要补齐材料后新建任务。', 0);
    return plan;
  }
  const load = dependencies.loadModel ?? loadImprovementModel;
  let previousCandidate: z.infer<typeof draftSchema> | undefined;
  let previousReview: ProjectOptimizationReview | undefined;
  for (let round = 1; round <= plan.maxRounds; round += 1) {
    await publish(round === 1 ? 'planning' : 'revising', round === 1
      ? '正在根据冻结的原题与证据准备具体改动。'
      : `正在按第 ${round - 1} 轮审核意见修订，保留原始目标与全部问题。`, round);
    const writer = await load();
    const candidate = draftSchema.parse(await writer.generateObject({ schema: draftSchema,
      messages: [{ role: 'system', content: readAgentText('improvement-planning', previousCandidate ? 'project-repair.md' : 'project-propose.md') },
        { role: 'user', content: JSON.stringify(previousCandidate ? { context, previousCandidate, previousReview } : { context }) }],
      options: parameters[plan.mode] }));
    plan.summary = candidate.summary;
    plan.actions = candidate.actions.map(action => ({ ...action, status: 'blocked' }));
    // Spend the same answer budget on the chosen questions before review and repair.
    // The first comparison still sees every frozen question; measurement data is unchanged.
    context = modelContext(plan);
    plan.review = null;
    const covered = new Set(plan.actions.flatMap(action => action.questionIds));
    const uncovered = plan.questionIds.filter(id => !covered.has(id));
    plan.limitations = [...new Set([...context.limitations, ...candidate.limitations,
      ...(uncovered.length ? [`本次优先行动未覆盖 ${uncovered.join('、')}；这些原题仍保留在范围和分母中，不视作排除或已解决。`] : [])])];
    const savedRound = { attempt: plan.attempt, round, candidateSavedAt: new Date().toISOString(), summary: plan.summary,
      actions: structuredClone(plan.actions), limitations: [...plan.limitations], review: null as ProjectOptimizationReview | null };
    plan.history.push(savedRound);
    if (previousCandidate && candidateContent(previousCandidate) === candidateContent(candidate)) {
      plan.stopReason = 'no_progress';
      await publish('blocked', '已停止：修订未形成实质改动，未再次审核；各轮候选与已有审核意见已保存。', round);
      return plan;
    }
    await publish('reviewing', `第 ${round} 轮候选已保存；正在独立核查原题、证据、改动内容与验证方法。`, round);
    // Each reviewer gets only primary material and this candidate, never prior assessments or writer dialogue.
    const reviewer = await load();
    const assessment = reviewSchema.parse(await reviewer.generateObject({ schema: reviewSchema,
      messages: [{ role: 'system', content: readAgentText('improvement-planning', 'project-review.md') },
        { role: 'user', content: JSON.stringify({ context, candidateToReview: candidate }) }], options: parameters.review }));
    plan.review = assessCandidate(candidate, assessment, context);
    plan.actions = candidate.actions.map(action => ({ ...action,
      status: plan.review!.actions.find(item => item.actionId === action.id)?.passed ? 'ready' : 'blocked' }));
    savedRound.actions = structuredClone(plan.actions);
    savedRound.review = structuredClone(plan.review);
    if (plan.review.passed) {
      await publish('awaiting_review', `第 ${round} 轮审核通过，${plan.actions.length} 项改动待你审阅；尚未实施、发布或跟测。`, round);
      return plan;
    }
    if (!candidate.actions.length) {
      plan.stopReason = 'no_evidence';
      await publish('blocked', '已停止：未形成有证据支撑的行动，候选与审核意见已保存。', round);
      return plan;
    }
    if (round === plan.maxRounds) {
      plan.stopReason = 'round_limit';
      await publish('blocked', `已停止：达到 ${plan.maxRounds} 轮上限仍未通过审核；候选、限制与未通过原因已保存。`, round);
      return plan;
    }
    previousCandidate = candidate;
    previousReview = plan.review;
    // Save this assessment before entering the next revision stage.
    await publish('reviewing', `第 ${round} 轮审核未通过，审核意见已保存，将据此修订。`, round);
  }
  return plan;
}

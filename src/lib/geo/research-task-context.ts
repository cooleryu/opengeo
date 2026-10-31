import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
} from './research-types';
import type { GeoAsset, ResearchTaskContext } from './types';
import type { GeoWorkflow, WorkflowQuestion } from './workflow-types';
import type { CollectionConfig } from './providers/types';
import { isBrandQuestion } from './research-view';
import { buildSearchProtocolKey } from './search-protocol';
import { isResearchEngine } from './research-engines';
import type { CompetitorCandidates } from './competitor-types';
import type { ResearchCompetitorReference } from './types';

function workflowQuestion(
  context: ResearchTaskContext,
  original: ResearchQuestion,
): WorkflowQuestion {
  return {
    id: `research-${context.batchId}-${original.id}-${context.language}`,
    query: original[context.language],
    language: context.language === 'zh' ? 'zh-CN' : 'en',
    category: isBrandQuestion(original) ? 'brand' : 'problem',
    target: context.targetAssetId ? 'article' : 'project',
    assetIds: context.targetAssetId
      ? [context.targetAssetId]
      : [...(context.snapshot?.candidateAssetIds ?? [])],
    exploratory: original.decision !== 'search_now',
    intent: original[context.language],
    expectedResult: original.valueReason,
  };
}

/** Resolve all content from server-owned records. Client snapshots are never accepted. */
export function resolveResearchTaskContext(
  value: unknown,
  batch: ResearchBatch | null,
  projectId: string,
  assets: GeoAsset[] = [],
  competitors?: CompetitorCandidates,
): {
  context: ResearchTaskContext;
  question: WorkflowQuestion;
  observations: ResearchObservation[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('研究题来源格式无效。');
  const input = value as Record<string, unknown>;
  if (input.projectId !== undefined && input.projectId !== projectId)
    throw new Error('研究题来源不属于当前项目。');
  if (input.language !== 'zh' && input.language !== 'en')
    throw new Error('请选择中文或英文原题。');
  if (!isResearchEngine(input.engine)) throw new Error('研究题来源入口无效。');
  if (!batch || batch.projectId !== projectId || input.batchId !== batch.id)
    throw new Error('研究批次不属于当前项目或已更新，请刷新后重新选择。');
  const purpose = input.purpose ?? 'improve_answer';
  if (purpose !== 'improve_answer' && purpose !== 'investigate_gap')
    throw new Error('研究任务用途无效。');
  const original = [...batch.questions, ...batch.deferredQuestions].find(
    (item) => item.id === input.questionId,
  );
  if (
    !original ||
    original.decision === 'drop_for_now' ||
    (purpose === 'improve_answer' && original.decision !== 'search_now')
  )
    throw new Error('这道问题尚未通过本批搜索审核，不能启动改进任务。');
  if (!original[input.language]?.trim())
    throw new Error('这道问题缺少对应语言的已审原文。');
  const observations = original.observations.filter(
    (item) => item.language === input.language && item.engine === input.engine,
  );
  if (purpose === 'improve_answer' && !observations.length)
    throw new Error('该语言与引擎尚无可关联的研究观测。');

  let gapIndex = -1;
  if (input.gapId !== undefined) {
    gapIndex = original.gaps.findIndex(
      (_, index) =>
        input.gapId === `${projectId}:${batch.id}:${original.id}:gap:${index}`,
    );
    if (gapIndex < 0) throw new Error('所选缺口不属于这道原题。');
  }
  if (input.gap !== undefined) {
    if (typeof input.gap !== 'string' || !original.gaps.includes(input.gap))
      throw new Error('所选缺口不属于这道原题。');
    if (gapIndex >= 0 && original.gaps[gapIndex] !== input.gap)
      throw new Error('缺口编号与原文不一致。');
    gapIndex = original.gaps.indexOf(input.gap);
  }
  if (purpose === 'investigate_gap' && gapIndex < 0)
    throw new Error('缺口核查任务必须关联一条已记录的原始缺口。');
  if (
    input.sourceUrl !== undefined &&
    (typeof input.sourceUrl !== 'string' ||
      !observations.some((item) =>
        item.sources.some((source) => source.url === input.sourceUrl),
      ))
  )
    throw new Error('所选来源不属于该语言与引擎的原始观测。');
  const targetAsset =
    input.targetAssetId === undefined
      ? undefined
      : assets.find((asset) => asset.id === input.targetAssetId);
  if (input.targetAssetId !== undefined && !targetAsset)
    throw new Error('所选修改材料不属于当前项目。');
  const candidateAssetIds = targetAsset
    ? [targetAsset.id]
    : assets
        .filter((asset) => asset.publicUrl && asset.markdown.trim())
        .map((asset) => asset.id);
  let competitorReference: ResearchCompetitorReference | undefined;
  if (input.candidateId !== undefined) {
    const selection = competitors?.selection;
    const candidate = competitors?.selectedCandidate;
    if (
      typeof input.candidateId !== 'string' ||
      competitors?.projectId !== projectId ||
      competitors.batch?.id !== batch.id ||
      !selection ||
      selection.projectId !== projectId ||
      selection.candidateId !== input.candidateId ||
      !candidate ||
      candidate.id !== input.candidateId
    )
      throw new Error(
        '所选参照已变化或不属于当前项目，请返回竞品页面重新选择。',
      );
    if (candidate.analysis?.status !== 'ready')
      throw new Error('所选参照分析尚未完成，请先完成参照分析。');
    const scopedEvidence = candidate.questions.filter(
      (item) =>
        item.batchId === batch.id &&
        item.questionId === original.id &&
        item.language === input.language &&
        item.engine === input.engine &&
        item.evidenceId,
    );
    const scopedEvidenceIds = new Set(
      scopedEvidence.map((item) => item.evidenceId),
    );
    const opportunities =
      candidate.analysis?.opportunities.filter(
        (item) =>
          item.questionId === original.id &&
          item.evidenceIds.length > 0 &&
          item.evidenceIds.every((id) => scopedEvidenceIds.has(id)),
      ) ?? [];
    if (!opportunities.length)
      throw new Error(
        '所选参照尚无该问题、语言与入口的改进依据，请先完成参照分析。',
      );
    const evidenceIds = new Set(
      opportunities.flatMap((item) => item.evidenceIds),
    );
    competitorReference = structuredClone({
      selectionId: selection.id,
      candidateId: candidate.id,
      name: candidate.name,
      aliases: candidate.aliases,
      officialUrls: candidate.officialUrls,
      selectedAt: selection.selectedAt,
      baseline: {
        batch: selection.baseline.batch,
        rows: selection.baseline.rows.filter(
          (row) =>
            row.questionId === original.id &&
            row.language === input.language &&
            row.engine === input.engine,
        ),
      },
      opportunities,
      evidence: scopedEvidence.filter(
        (item) => item.evidenceId && evidenceIds.has(item.evidenceId),
      ),
      quotes: candidate.analysis!.quotes?.filter((item) =>
        evidenceIds.has(item.evidenceId),
      ),
    });
  }
  const context: ResearchTaskContext = {
    projectId,
    batchId: batch.id,
    questionId: original.id,
    language: input.language,
    engine: input.engine,
    purpose,
    ...(competitorReference
      ? { candidateId: competitorReference.candidateId }
      : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl as string } : {}),
    ...(gapIndex >= 0
      ? {
          gap: original.gaps[gapIndex],
          gapId: `${projectId}:${batch.id}:${original.id}:gap:${gapIndex}`,
        }
      : {}),
    ...(targetAsset
      ? {
          targetAssetId: targetAsset.id,
          ...(targetAsset.publicUrl
            ? { targetUrl: targetAsset.publicUrl }
            : {}),
        }
      : {}),
    snapshot: {
      projectId,
      batchDate: batch.date,
      question: structuredClone(original),
      observations: structuredClone(observations),
      reportPath: batch.reportPath,
      sourceAuditPath: batch.sourceAuditPath,
      reviewPath: original.reviewPath || batch.reviewPath,
      capturedAt: new Date().toISOString(),
      candidateAssetIds,
      ...(targetAsset ? { targetAsset: structuredClone(targetAsset) } : {}),
      ...(competitorReference ? { competitorReference } : {}),
    },
  };
  return {
    context,
    question: workflowQuestion(context, original),
    observations: structuredClone(observations),
  };
}

/** Only persisted server snapshots enter this path; older tasks may resolve their original batch once. */
export function researchTaskQuestion(
  context: ResearchTaskContext,
  projectId: string,
): WorkflowQuestion {
  const snapshot = context.snapshot;
  if (
    !snapshot ||
    snapshot.projectId !== projectId ||
    snapshot.question.id !== context.questionId
  )
    throw new Error(
      '任务缺少当前项目的原始研究依据，请返回关键问题重新建立任务。',
    );
  if (!snapshot.question[context.language]?.trim())
    throw new Error('任务缺少已保存的原问题。');
  return workflowQuestion(context, snapshot.question);
}

export function assertResearchTaskSearchEligible(
  context: ResearchTaskContext,
): void {
  if (context.snapshot && context.snapshot.question.decision !== 'search_now')
    throw new Error(
      '这条任务用于核查原始缺口，原题尚未通过搜索审核。先补齐依据并重新审题，再从已审题建立搜索与改稿任务。',
    );
}

export function freezeResearchTaskContext(
  context: ResearchTaskContext,
  batch: ResearchBatch | null,
  projectId: string,
  collection: CollectionConfig,
  frozenAt: string,
  mode: 'live' | 'replay' = 'live',
  assets: GeoAsset[] = [],
): GeoWorkflow {
  const saved = context.snapshot
    ? context
    : resolveResearchTaskContext(context, batch, projectId, assets).context;
  const question = researchTaskQuestion(saved, projectId);
  assertResearchTaskSearchEligible(saved);
  const limit = collection.provider === 'deepseek' ? 128 : 2000;
  if (mode === 'live' && [...question.query].length > limit)
    throw new Error(
      `这道原题有 ${[...question.query].length} 个字符，超过 ${collection.label} 的 ${limit} 字符上限。请新建任务并选择能承接原题的采集入口；原题不会截短。`,
    );
  const questions = [question];
  return {
    version: 1,
    collection,
    questionPlanId: saved.batchId,
    questionPlanRevision: 1,
    frozenAt,
    questions,
    protocolKey: buildSearchProtocolKey(questions, collection),
    stage: 'search',
    proposalRevision: 0,
    appliedStrategyIds: [],
    // Saved browser observations remain references. Never manufacture an API baseline.
  };
}

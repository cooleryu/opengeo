import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import { resolveAssetOwnership } from './asset-ownership';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel from './chatgpt-model';
import {
  getDataForSeoCredentials,
  type DataForSeoCredentials,
  type GeoStructuredModel,
} from './connection-settings';
import {
  collectDemandSignals,
  type DemandSignalCollectionInput,
  type DemandSignalCollectionResult,
  type RankedDemandSignal,
} from './demand-signals';
import {
  computeDemandStatus,
  marketDraftSchema,
  marketModelSchema,
  marketParametersSchema,
  marketReviewOutputSchema,
  plainSignalSummary,
  sanitizeInternalIds,
  toStoredSignal,
} from './market-question-schemas';
import { projectContextExists, readProjectContext } from './project-context';
import { getProjectOnboardingPlanningContext } from './project-onboarding-store';
import { projectResearchContext } from './project-research-context';
import { buildInitialQuestionPlan, validateQuestionPlan } from './question-planner';
import type {
  GeoQuestionPlan,
  QuestionCandidate,
  QuestionDemandSignal,
  QuestionDemandStatus,
  QuestionGenerationCheckpoint,
  QuestionGenerationProgress,
  QuestionTactic,
} from './question-types';
import type { GeoAsset, GeoSeed } from './types';

const compact = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export type MarketPlanningRuntime = {
  model?: GeoStructuredModel;
  onProgress?: (progress: QuestionGenerationProgress) => void;
  resume?: readonly QuestionGenerationCheckpoint[];
  subscriptionModel?: (options: {
    timeoutMs: number;
    onActivity?: (activity: NonNullable<QuestionGenerationProgress['request']>) => void;
  }) => GeoStructuredModel;
  /** Override DataForSEO credentials (pass `null` to force free zero-key track). */
  dataForSeo?: Pick<DataForSeoCredentials, 'login' | 'password'> | null;
  /** Override L2 signal collection (used for deterministic offline unit tests). */
  collectSignals?: (input: DemandSignalCollectionInput) => Promise<DemandSignalCollectionResult>;
  /** Hard budget cap in USD for optional DataForSEO calls per run (default $0.06). */
  maxSeoBudgetUsd?: number;
};

type TrackedRuntime = MarketPlanningRuntime & {
  onActivity?: (activity: NonNullable<QuestionGenerationProgress['request']>) => void;
};

type HydratedDraft = {
  id: string;
  query: string;
  category: QuestionCandidate['category'];
  intent: string;
  target: 'project' | 'article';
  tactic: QuestionTactic;
  demandSignals: QuestionDemandSignal[];
  demandStatus: QuestionDemandStatus;
  fanoutQueries: string[];
  rationale: string;
  expectedResult: string;
};

function trackRuntime(
  runtime: MarketPlanningRuntime,
  initial: Pick<QuestionGenerationProgress, 'stage' | 'message' | 'workflowStep'>,
): TrackedRuntime {
  let current = { ...initial };
  return {
    ...runtime,
    onProgress(progress) {
      const workflowStep = progress.workflowStep ?? current.workflowStep;
      if (!progress.checkpoint) current = { stage: progress.stage, message: progress.message, workflowStep };
      runtime.onProgress?.({ ...progress, workflowStep });
    },
    onActivity(request) {
      runtime.onProgress?.({ ...current, request });
    },
  };
}

async function resolveModel(
  runtime: TrackedRuntime,
  parameters: z.infer<typeof marketParametersSchema>,
): Promise<GeoStructuredModel> {
  if (runtime.model) return runtime.model;
  if (runtime.subscriptionModel) {
    return runtime.subscriptionModel({ timeoutMs: parameters.subscriptionTimeoutMs, onActivity: runtime.onActivity });
  }
  const { loadGeoModel, shouldUseChatGPTSubscription } = await import('./connection-settings');
  return shouldUseChatGPTSubscription(getChatGPTStatus())
    ? new ChatGPTModel({ timeoutMs: parameters.subscriptionTimeoutMs, onActivity: runtime.onActivity })
    : loadGeoModel();
}

function buildProjectContext(seed: GeoSeed, positioning: string) {
  const { id, name, owner, description, siteUrl, repositoryUrl, targetLanguage } = seed.project;
  const understanding = getProjectOnboardingPlanningContext(id);
  const research = projectResearchContext(id);
  const projectFactSheet = projectContextExists(id)
    ? readProjectContext(id).markdown.trim().slice(0, 2400)
    : '';
  const targetLang: 'en' | 'zh' = targetLanguage === 'zh' ? 'zh' : 'en';
  let outputLanguage: 'en' | 'zh' = 'zh';
  if (understanding?.outputLanguage === 'en' || understanding?.outputLanguage === 'zh') {
    outputLanguage = understanding.outputLanguage;
  } else if (targetLang === 'en' && !/[\p{Script=Han}]/u.test(positioning)) {
    outputLanguage = 'en';
  }
  return {
    project: { id, name, owner, description, siteUrl, repositoryUrl, targetLanguage: targetLang },
    positioning,
    outputLanguage,
    ...(understanding ? { projectUnderstanding: understanding } : {}),
    ...(research ? { projectResearch: research } : {}),
    ...(projectFactSheet ? { projectFactSheet } : {}),
  };
}

function buildBoundedMaterialsContext(
  seed: GeoSeed,
  base: Record<string, unknown>,
  system: string,
  parameters: z.infer<typeof marketParametersSchema>,
  isEn: boolean,
) {
  let remaining = parameters.materials.maxTotalCharacters;
  const materials = seed.assets.map(asset => ({
    id: asset.id,
    title: asset.title,
    status: asset.status,
    publicUrl: asset.publicUrl,
    ...resolveAssetOwnership(asset, seed),
    summary: asset.summary.slice(0, 600),
    markdown: '',
    markdownIsExcerpt: Boolean((asset as GeoAsset & { markdownIsExcerpt?: boolean }).markdownIsExcerpt),
    originalCharacters: asset.markdown.length,
    providedCharacters: 0,
    truncated: asset.markdown.length > 0,
  }));
  const context = { ...base, materials };
  const fits = () =>
    Buffer.byteLength(system, 'utf8') + Buffer.byteLength(JSON.stringify(context), 'utf8') <= parameters.maxInputBytes;
  if (!fits()) {
    throw new Error(
      isEn
        ? 'Required question planning context exceeds the input budget; no model call was made.'
        : '问题准备所需信息超过输入预算；本次未调用模型。',
    );
  }
  for (let i = 0; i < seed.assets.length; i++) {
    const asset = seed.assets[i];
    const mat = materials[i];
    const limit = Math.min(asset.markdown.length, parameters.materials.maxCharactersPerAsset, remaining);
    if (limit <= 0) continue;
    let lo = 0;
    let hi = limit;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      mat.markdown = asset.markdown.slice(0, mid);
      mat.providedCharacters = mid;
      mat.truncated = mid < asset.markdown.length;
      if (fits()) lo = mid;
      else hi = mid - 1;
    }
    mat.markdown = asset.markdown.slice(0, lo);
    mat.providedCharacters = lo;
    mat.truncated = lo < asset.markdown.length;
    remaining -= lo;
  }
  return context;
}

function languageMandate(targetLanguage: 'en' | 'zh', outputLanguage: 'en' | 'zh'): string {
  const queryRule =
    targetLanguage === 'en'
      ? 'MANDATORY: project.targetLanguage is "en". Every "query" and "fanoutQueries" item MUST be natural, idiomatic English (zero Chinese characters).'
      : 'MANDATORY: project.targetLanguage is "zh". Every "query" MUST be natural, concise Chinese.';
  const explainRule =
    outputLanguage === 'en'
      ? 'Write all explanation fields (intent, rationale, expectedResult, reason, basis, gaps, summary) in concise, plain English.'
      : '所有说明字段（intent、rationale、expectedResult、reason、basis、gaps、summary）使用简洁平实的简体中文。';
  return `${queryRule}\n${explainRule}`;
}

function buildReviewedCandidates(
  hydratedDrafts: HydratedDraft[],
  reviewOutput: z.infer<typeof marketReviewOutputSchema>,
  validAssetIds: Set<string>,
  outputLang: 'en' | 'zh',
  now: string,
): QuestionCandidate[] {
  const reviewById = new Map(reviewOutput.reviews.map(r => [r.id, r]));
  return hydratedDrafts.map(draft => {
    const rev = reviewById.get(draft.id);
    if (!rev) {
      return {
        id: draft.id,
        origin: 'model',
        query: draft.query,
        category: draft.category,
        intent: draft.intent,
        target: draft.target,
        assetIds: [],
        evidence: [],
        rationale: draft.rationale,
        expectedResult: draft.expectedResult,
        demandStatus: draft.demandStatus,
        ...(draft.demandSignals.length ? { demandSignals: draft.demandSignals } : {}),
        ...(draft.fanoutQueries.length ? { fanoutQueries: draft.fanoutQueries } : {}),
        tactic: draft.tactic,
        selected: false,
        review: {
          decision: 'explore',
          priority: 'low',
          reason: outputLang === 'en' ? 'Held for manual review.' : '保留供人工复核。',
          concerns: [],
          source: 'model',
          status: 'reviewed',
          reviewedAt: now,
        },
      };
    }

    const assetIds = [...new Set(rev.assetIds.filter(id => validAssetIds.has(id)))];
    const hasExternal = draft.demandSignals.length > 0;
    const demandBasis =
      rev.demandBasis === 'public-observation' && !hasExternal
        ? 'inferred'
        : hasExternal && rev.demandBasis === 'unknown'
          ? 'public-observation'
          : rev.demandBasis;
    const verdict =
      rev.decision === 'exclude'
        ? 'no'
        : rev.worthVerdict === 'no'
          ? 'uncertain'
          : rev.worthVerdict;
    const gaps =
      rev.supportLevel !== 'supported' && rev.gaps.length === 0
        ? [{
            kind: 'content' as const,
            description:
              outputLang === 'en'
                ? 'Current project pages do not yet clearly answer this buyer question.'
                : '现有公开页面尚未充分回答这一问题。',
          }]
        : rev.gaps;

    return {
      id: draft.id,
      origin: 'model',
      query: draft.query,
      category: draft.category,
      intent: draft.intent,
      target: draft.target,
      assetIds,
      evidence: [],
      rationale: draft.rationale,
      expectedResult: draft.expectedResult,
      demandStatus: draft.demandStatus,
      ...(draft.demandSignals.length ? { demandSignals: draft.demandSignals } : {}),
      ...(draft.fanoutQueries.length ? { fanoutQueries: draft.fanoutQueries } : {}),
      tactic: draft.tactic,
      selected: false,
      review: {
        decision: rev.decision,
        priority: rev.priority,
        reason: sanitizeInternalIds(rev.reason),
        concerns: rev.concerns.map(sanitizeInternalIds).filter(Boolean),
        source: 'model',
        status: 'reviewed',
        reviewedAt: now,
        assessment: {
          worthPursuing: {
            verdict,
            reason: sanitizeInternalIds(rev.worthReason),
            demandBasis,
            basis: sanitizeInternalIds(rev.demandBasisReason),
          },
          currentSupport: {
            level: rev.supportLevel,
            reason: sanitizeInternalIds(rev.supportReason),
          },
          evidence: [],
          gaps,
        },
      },
    };
  });
}

/**
 * Market-grounded 5-layer question planner (Engineering x Multi-layer AI).
 * - L1 [AI]: Market modeling (personas, short seeds, pain verbs, real competitors from docs first).
 * - L2 [Engineering]: Dual-track demand signal collection (Free zero-key + optional DataForSEO <= $0.06) + self-correction.
 * - L3+L4 [AI]: Denoise, JTBD cluster, concise natural query synthesis (4-14 words, no README stuffing), Query Fan-Out.
 * - L5 [Engineering + AI]: Deterministic signal hydration + lightweight README coverage check & final selection (<= 8).
 */
export async function generateMarketQuestionPlan(
  seed: GeoSeed,
  positioning: string,
  runtime: MarketPlanningRuntime = {},
): Promise<GeoQuestionPlan> {
  const parameters = readAgentParameters('question-planning', marketParametersSchema);
  const initial = buildInitialQuestionPlan(seed);
  validateQuestionPlan({ ...initial, positioning }, seed);
  const historical = initial.candidates.filter(candidate => candidate.origin === 'existing');
  const ctxBase = buildProjectContext(seed, positioning);
  const targetLang = ctxBase.project.targetLanguage;
  const outputLang = ctxBase.outputLanguage;
  const isEn = outputLang === 'en';
  const step1Msg = isEn ? 'Researching peer products and real search phrasing.' : '正在研究同类产品与用户真实搜法。';
  const step2Msg = isEn ? 'Selecting high-value buyer questions.' : '正在筛选高价值核心问题。';
  const step3Msg = isEn ? 'Checking how your pages cover these questions.' : '正在核对你的页面承接情况。';

  const saved = new Map((runtime.resume ?? []).map(cp => [cp.key, cp]));
  const emitCheckpoint = (
    rt: TrackedRuntime,
    stage: QuestionGenerationProgress['stage'],
    workflowStep: NonNullable<QuestionGenerationProgress['workflowStep']>,
    message: string,
    checkpoint: Omit<QuestionGenerationCheckpoint, 'completedAt'>,
  ) => {
    rt.onProgress?.({ stage, workflowStep, message, checkpoint });
  };

  // --- L1: AI Market Modeling (1 LLM call) ---
  const l1Runtime = trackRuntime(runtime, { stage: 'discovering', workflowStep: 'planning', message: step1Msg });
  let marketModel: z.infer<typeof marketModelSchema>;
  const savedL1 = saved.get('market-model');
  if (savedL1) {
    marketModel = marketModelSchema.parse(savedL1.payload);
  } else {
    l1Runtime.onProgress?.({ stage: 'discovering', workflowStep: 'planning', message: step1Msg });
    const l1System = `${readAgentText('question-planning', 'market-model.md')}\n\n${languageMandate(targetLang, outputLang)}`;
    const l1Context = buildBoundedMaterialsContext(seed, ctxBase, l1System, parameters, isEn);
    const llm = await resolveModel(l1Runtime, parameters);
    marketModel = marketModelSchema.parse(
      await llm.generateObject({
        schema: marketModelSchema,
        messages: [
          { role: 'system', content: l1System },
          { role: 'user', content: JSON.stringify(l1Context) },
        ],
        options: parameters.planning,
      }),
    );
  }
  emitCheckpoint(l1Runtime, 'discovering', 'planning', step1Msg, {
    key: 'market-model',
    title: isEn ? 'Market seeds & peers' : '目标市场与竞品',
    items: marketModel.categorySeeds,
    payload: marketModel,
  });

  // --- L2: Engineering Dual-Track Demand Signal Collection (0 LLM calls) ---
  let signalResult: DemandSignalCollectionResult;
  const savedL2 = saved.get('market-signals');
  if (savedL2) {
    signalResult = savedL2.payload as DemandSignalCollectionResult;
  } else {
    const dfsCreds = runtime.dataForSeo !== undefined ? runtime.dataForSeo : getDataForSeoCredentials();
    const collect = runtime.collectSignals ?? collectDemandSignals;
    signalResult = await collect({
      seeds: marketModel.categorySeeds,
      painVerbs: marketModel.painVerbs,
      competitors: marketModel.competitors,
      targetLanguage: targetLang,
      includeHn: marketModel.includeHn,
      dataForSeo: dfsCreds ? { login: dfsCreds.login, password: dfsCreds.password } : null,
      maxBudgetUsd: runtime.maxSeoBudgetUsd ?? 0.06,
    });
  }
  emitCheckpoint(l1Runtime, 'discovering', 'planning', step1Msg, {
    key: 'market-signals',
    title: isEn ? 'External demand signals' : '外部需求参考',
    items: signalResult.signals.slice(0, 6).map(s => s.keyword),
    payload: signalResult,
  });

  const signalById = new Map<string, RankedDemandSignal>(signalResult.signals.map(sig => [sig.id, sig]));

  // --- L3 + L4: AI Denoise, Cluster, Short Natural Query Synthesis & Fan-Out (1 LLM call) ---
  const l3Runtime = trackRuntime(runtime, { stage: 'generating', workflowStep: 'generating', message: step2Msg });
  const maxDrafts = Math.min(14, parameters.maxNewCandidates);
  let hydratedDrafts: HydratedDraft[];
  const savedDrafts = saved.get('market-drafts');
  if (savedDrafts) {
    hydratedDrafts = savedDrafts.payload as HydratedDraft[];
  } else {
    l3Runtime.onProgress?.({ stage: 'generating', workflowStep: 'generating', message: step2Msg });
    const l3System = `${readAgentText('question-planning', 'market-propose.md')
      .replace('{{maxNewCandidates}}', String(maxDrafts))}\n\n${languageMandate(targetLang, outputLang)}`;
    const compactSignals = signalResult.signals.slice(0, 55).map(sig => ({
      id: sig.id,
      keyword: sig.keyword,
      source: sig.source,
      ...(sig.searchVolume !== undefined ? { volume: sig.searchVolume } : {}),
      ...(sig.cpc !== undefined ? { cpc: sig.cpc } : {}),
      ...(sig.kd !== undefined ? { kd: sig.kd } : {}),
      ...(sig.intent ? { intent: sig.intent } : {}),
      ...(sig.competitorDomain ? { competitor: sig.competitorDomain } : {}),
      ...(sig.tacticHint ? { tacticHint: sig.tacticHint } : {}),
    }));
    const l3Payload = {
      ...ctxBase,
      personas: marketModel.personas,
      competitors: marketModel.competitors,
      existingQuestions: seed.questions.map(q => ({ id: q.id, query: q.query })),
      externalSignals: compactSignals,
    };
    const llm = await resolveModel(l3Runtime, parameters);
    const proposeSchema = z.object({ candidates: z.array(marketDraftSchema).max(maxDrafts) }).strict();
    const generated = proposeSchema.parse(
      await llm.generateObject({
        schema: proposeSchema,
        messages: [
          { role: 'system', content: l3System },
          { role: 'user', content: JSON.stringify(l3Payload) },
        ],
        options: parameters.propose,
      }),
    );

    const seenKeys = new Set(historical.map(c => compact(c.query)));
    hydratedDrafts = [];
    for (const draft of generated.candidates) {
      const key = compact(draft.query);
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const verifiedSignals: QuestionDemandSignal[] = [];
      const seenSig = new Set<string>();
      for (const sigId of draft.signalIds) {
        if (seenSig.has(sigId)) continue;
        const found = signalById.get(sigId);
        if (found) {
          seenSig.add(sigId);
          verifiedSignals.push(toStoredSignal(found));
        }
      }
      const fanout = [...new Set(draft.fanoutQueries.map(q => q.trim()).filter(q => q.length >= 2))].slice(0, 5);
      hydratedDrafts.push({
        id: `model-${hydratedDrafts.length + 1}`,
        query: draft.query.trim(),
        category: draft.category,
        intent: sanitizeInternalIds(draft.intent),
        target: draft.target,
        tactic: draft.tactic,
        demandSignals: verifiedSignals,
        demandStatus: computeDemandStatus(verifiedSignals),
        fanoutQueries: fanout,
        rationale: sanitizeInternalIds(draft.rationale),
        expectedResult: sanitizeInternalIds(draft.expectedResult),
      });
    }
  }
  emitCheckpoint(l3Runtime, 'generating', 'generating', step2Msg, {
    key: 'market-drafts',
    title: isEn ? 'Candidate questions' : '候选问题',
    items: hydratedDrafts.map(d => d.query),
    payload: hydratedDrafts,
  });

  // --- L5: Decoupled Coverage Diagnosis + Portfolio Finalizer (1 LLM call + deterministic guards) ---
  const l5Runtime = trackRuntime(runtime, { stage: 'reviewing', workflowStep: 'reviewing', message: step3Msg });
  let reviewOutput: z.infer<typeof marketReviewOutputSchema>;
  const savedL5 = saved.get('market-review');
  if (savedL5) {
    reviewOutput = marketReviewOutputSchema.parse(savedL5.payload);
  } else if (hydratedDrafts.length === 0) {
    reviewOutput = {
      reviews: [],
      selectedIds: [],
      summary: isEn ? 'No new candidate questions were generated; existing questions remain unchanged.' : '未生成新的候选问题，保留已有问题。',
    };
  } else {
    l5Runtime.onProgress?.({ stage: 'reviewing', workflowStep: 'reviewing', message: step3Msg });
    const l5System = `${readAgentText('question-planning', 'market-review.md')}\n\n${languageMandate(targetLang, outputLang)}`;
    const reviewCandidates = hydratedDrafts.map(draft => ({
      id: draft.id,
      query: draft.query,
      category: draft.category,
      intent: draft.intent,
      target: draft.target,
      tactic: draft.tactic,
      expectedResult: draft.expectedResult,
      hasExternalSignal: draft.demandSignals.length > 0,
      signalSummary: plainSignalSummary(draft.demandSignals, outputLang),
    }));
    const l5Context = buildBoundedMaterialsContext(
      seed,
      {
        ...ctxBase,
        maxSelected: 8,
        existingQuestions: seed.questions.map(q => ({ id: q.id, query: q.query })),
        candidates: reviewCandidates,
      },
      l5System,
      parameters,
      isEn,
    );
    const llm = await resolveModel(l5Runtime, parameters);
    reviewOutput = marketReviewOutputSchema.parse(
      await llm.generateObject({
        schema: marketReviewOutputSchema,
        messages: [
          { role: 'system', content: l5System },
          { role: 'user', content: JSON.stringify(l5Context) },
        ],
        options: parameters.review,
      }),
    );
  }
  emitCheckpoint(l5Runtime, 'reviewing', 'reviewing', step3Msg, {
    key: 'market-review',
    title: isEn ? 'Coverage & final selection' : '承接核对与精选',
    items: reviewOutput.selectedIds,
    payload: reviewOutput,
  });

  const now = new Date().toISOString();
  const reviewedCandidates = buildReviewedCandidates(
    hydratedDrafts,
    reviewOutput,
    new Set(seed.assets.map(a => a.id)),
    outputLang,
    now,
  );

  const draftPlan = validateQuestionPlan(
    {
      ...initial,
      positioning,
      source: 'model',
      createdAt: now,
      updatedAt: now,
      candidates: [...historical.map(c => ({ ...c, selected: false })), ...reviewedCandidates],
      notes: [
        sanitizeInternalIds(reviewOutput.summary),
        signalResult.signals.length > 0
          ? isEn
            ? 'Grounded in external search and peer product signals, then checked against your current pages.'
            : '本轮推荐已结合外部公开搜索与同类产品信号，并对照现有页面核查承接情况。'
          : isEn
            ? 'External signals were unavailable; questions were inferred from your positioning and materials.'
            : '本轮未获取到外部公开信号，问题基于产品定位与现有材料推导。',
      ],
    },
    seed,
  );

  const eligible = new Set(
    draftPlan.candidates
      .filter(c => c.origin === 'model' && c.review.decision === 'include' && c.review.status === 'reviewed')
      .map(c => c.id),
  );
  const chosen: string[] = [];
  for (const id of reviewOutput.selectedIds) {
    if (chosen.length >= 8) break;
    if (eligible.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  if (chosen.length < Math.min(8, eligible.size)) {
    const priOrder = { high: 0, medium: 1, low: 2 };
    const extras = draftPlan.candidates
      .filter(c => eligible.has(c.id) && !chosen.includes(c.id))
      .sort((a, b) => priOrder[a.review.priority ?? 'medium'] - priOrder[b.review.priority ?? 'medium']);
    for (const extra of extras) {
      if (chosen.length >= 8) break;
      chosen.push(extra.id);
    }
  }
  const finalSelected =
    chosen.length > 0
      ? new Set(chosen)
      : new Set(historical.filter(c => c.selected).slice(0, 8).map(c => c.id));

  return validateQuestionPlan(
    {
      ...draftPlan,
      candidates: draftPlan.candidates.map(c => ({ ...c, selected: finalSelected.has(c.id) })),
    },
    seed,
  );
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getGeoModelConnection, loadGeoModel, type GeoStructuredModel } from './connection-settings';
import { singleRequestModel } from './connection-test';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel from './chatgpt-model';
import { COMPETITOR_ANALYSIS_VERSION, readCompetitorAnalysis, readLatestCompetitorAnalysis, saveCompetitorAnalysis, type StoredCompetitorAnalysis } from './competitor-store';
import type { CompetitorCandidate, CompetitorComparison, CompetitorRanking, CompetitorRankingScope, CompetitorRecommendationEvidence } from './competitor-types';
import { RESEARCH_ENGINE_NAMES } from './research-engines';
import type { MetricSummary } from './overview-metrics';
import type { GeoProject } from './types';
import { observationTime } from './research-view';
import { readAgentParameters, readAgentText } from './agent-files';

const statement = z.string().trim().min(1).max(650);
const evidenceId = z.string().min(1).max(100);
export const competitorResultSchema = z.object({
  summary: statement,
  assessments: z.array(z.object({
    candidateId: z.string(),
    recommended: z.boolean(),
    description: statement,
    reason: statement,
    strengths: z.array(statement).max(4),
    opportunities: z.array(z.object({
      questionId: z.string().min(1), title: z.string().trim().min(1).max(160),
      observed: statement, hypothesis: statement, action: statement,
      evidenceIds: z.array(evidenceId).min(1).max(4),
    }).strict()).max(3),
    limitations: z.array(statement).min(1).max(6),
    quotes: z.array(z.object({ evidenceId, quote: z.string().trim().min(3).max(500) }).strict()).min(1).max(4),
  }).strict()).max(12),
}).strict();

export interface PreparedCompetitorAnalysis {
  inputKey: string;
  legacyInputKey: string;
  legacyEvidenceSignature?: string;
  batchId: string | null;
  candidates: CompetitorCandidate[];
  input: {
    version: string;
    project: { id: string; name: string; description: string; siteUrl: string; repositoryUrl: string };
    batchId: string | null;
    availableCandidates: number;
    candidates: {
      id: string; name: string; aliases: string[]; officialUrls: string[];
      evidence: { id: string; questionId: string; question: string; engine: string; language: string;
        sourceUrl: string; excerpt: string; ownMention: string; targetMention: string; entryType: string; evidencePath: string }[];
    }[];
  };
}

function evidenceSignature(candidates: CompetitorCandidate[], batchId: string | null, includeCollectedAt = true): string {
  const records = [...candidates].sort((a, b) => a.id.localeCompare(b.id)).map((candidate) => ({
    id: candidate.id,
    evidence: candidate.questions.filter((item) => item.batchId === batchId).map((item) => JSON.stringify([
      item.evidenceId, item.questionId, item.question, item.engine, item.language, item.recordedAt,
      ...(includeCollectedAt ? [item.collectedAt ?? null] : []), item.evidencePath, item.answerPath ?? null,
      item.observationIndex, item.sourceUrl, item.excerpt,
    ])).sort(),
  }));
  return createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

export function eligibleCompetitorCandidates(candidates: CompetitorCandidate[]): CompetitorCandidate[] {
  return candidates.filter((candidate) => candidate.analysis?.status === 'ready' && candidate.analysis.recommended === true);
}

const defaultRankingScope: CompetitorRankingScope = { language: 'zh', engine: 'all' };
const exactMetric = (metric: MetricSummary | undefined): metric is MetricSummary => Boolean(metric &&
  metric.rate !== null && Number.isFinite(metric.rate) && metric.completed > 0 && metric.unknown === 0);

function comparableMetrics(metrics: (MetricSummary | undefined)[]): boolean {
  const first = metrics[0];
  return Boolean(exactMetric(first) && metrics.every((metric) => exactMetric(metric) &&
    metric.completed === first.completed && metric.questions === first.questions && metric.unmeasured === first.unmeasured));
}

function rateText(rate: number): string {
  return Number(rate.toFixed(1)).toString();
}

/** Only observed AI metrics determine order. AI review supplies relevance, not a score. */
export function rankCompetitorCandidates(candidates: CompetitorCandidate[], scope: CompetitorRankingScope = defaultRankingScope,
  evidenceByCandidate: ReadonlyMap<string, CompetitorRecommendationEvidence> = new Map()): {
  candidates: CompetitorCandidate[]; allCandidates: CompetitorCandidate[]; ranking: CompetitorRanking;
} {
  const maxRecommendations = readParameters().maxRecommendations;
  // V1 persisted a combined model decision and numeric threshold. Its rejected
  // identities cannot be reliably classified again without a new relevance review.
  const reviewed = eligibleCompetitorCandidates(candidates).map((candidate) => {
    const metrics = candidate.performance?.scopes[`${scope.language}:${scope.engine}`]?.metrics;
    const mention = metrics?.find((metric) => metric.id === 'mention');
    const citation = metrics?.find((metric) => metric.id === 'citation');
    return { candidate, mention: mention?.target, own: mention?.own, citation: citation?.target,
      evidence: evidenceByCandidate.get(candidate.id) };
  });
  const entries = reviewed.filter((entry) => !entry.candidate.analysis!.version.startsWith('competitor-v1') &&
    exactMetric(entry.mention) && entry.mention.yes > 0 && entry.evidence?.language === scope.language &&
    (scope.engine === 'all' || entry.evidence.engine === scope.engine));
  const comparable = comparableMetrics(entries.map((entry) => entry.mention));
  const tieGroups = new Map<number, typeof entries>();
  if (comparable) for (const entry of entries) {
    const group = tieGroups.get(entry.mention!.rate!) ?? [];
    group.push(entry);
    tieGroups.set(entry.mention!.rate!, group);
  }
  const useCitations = new Set([...tieGroups].filter(([, group]) => group.length > 1 &&
    comparableMetrics(group.map((entry) => entry.citation)) && group.every((entry) =>
      entry.citation!.completed === entry.mention!.completed && entry.citation!.questions === entry.mention!.questions))
    .map(([rate]) => rate));
  const compareObserved = (a: typeof entries[number], b: typeof entries[number]) => {
    const aRate = a.mention?.rate ?? null;
    const bRate = b.mention?.rate ?? null;
    // Known measurements may be inspected first, but partial/incomparable sets
    // below never receive a rank or a declared leader.
    if (aRate === null || bRate === null) return aRate === bRate ? 0 : aRate === null ? 1 : -1;
    if (aRate !== bRate) return bRate - aRate;
    return comparable && useCitations.has(aRate) ? b.citation!.rate! - a.citation!.rate! : 0;
  };
  entries.sort((a, b) => compareObserved(a, b) || a.candidate.id.localeCompare(b.candidate.id));
  const leader = comparable && entries.length === reviewed.length && entries.length > 1 &&
    compareObserved(entries[0], entries[1]) < 0 ? entries[0] : undefined;
  const status = comparable ? 'ranked' as const : 'candidate' as const;
  const ranking: CompetitorRanking = { status, scope: { ...scope }, eligibleCount: entries.length,
    reason: entries.length ? `根据当前已核实的同题回答，推荐 ${entries.slice(0, maxRecommendations).map((entry) => entry.candidate.name).join('、')} 作为参照。`
      : '当前范围尚无同时通过相关性审核和实测提及核实的推荐参照。',
    ...(leader ? { leaderId: leader.candidate.id } : {}) };
  let rank = 1;
  const ranked = entries.map((entry, index) => {
    if (index > 0 && compareObserved(entries[index - 1], entry) !== 0) rank = index + 1;
    const metric = entry.mention;
    const evidence = entry.evidence!;
    const parts = [`${RESEARCH_ENGINE_NAMES[evidence.engine]} 在“${evidence.question}”的${evidence.language === 'zh' ? '中文' : '英文'}回答中明确提及 ${entry.candidate.name}`,
      `当前已测回答的 AI 提及率为 ${rateText(metric!.rate!)}%（按问题等权），已确认 ${metric!.yes}/${metric!.completed} 条回答`];
    if (comparable && useCitations.has(metric!.rate!)) parts.push(`官方引用率 ${rateText(entry.citation!.rate!)}%（按问题等权），已确认 ${entry.citation!.yes}/${entry.citation!.completed} 条，用于同提及率对照`);
    const reason = `${parts.join('；')}。`;
    return { ...entry.candidate, reason, recommendation: { status, reason,
      evidence, ...(comparable ? { rank } : {}), isLeader: entry.candidate.id === leader?.candidate.id } };
  });
  const recommendations = new Map(ranked.map((candidate) => [candidate.id, candidate]));
  const allCandidates = reviewed.map((entry) => recommendations.get(entry.candidate.id) ?? { ...entry.candidate,
    recommendation: { status: 'candidate' as const, isLeader: false,
      reason: entry.candidate.analysis!.version.startsWith('competitor-v1') ? '旧候选资格待新版审核。'
        : '尚未同时满足当前范围的实测提及核实与原文证据要求。' } });
  return { candidates: ranked.slice(0, maxRecommendations), allCandidates, ranking };
}

export function rankedCompetitorRecommendations(candidates: CompetitorCandidate[], scope?: CompetitorRankingScope): CompetitorCandidate[] {
  return rankCompetitorCandidates(candidates, scope).candidates;
}

export function competitorRecommendationSummary(candidates: CompetitorCandidate[], scope?: CompetitorRankingScope): string {
  return rankCompetitorCandidates(candidates, scope).ranking.reason;
}

/** Bounds one explicit analysis to twelve identities and four excerpts per identity. */
export function prepareCompetitorAnalysis(project: GeoProject, batchId: string | null,
  candidates: CompetitorCandidate[], comparisons: Map<string, CompetitorComparison>, availableCandidates = candidates.length,
  evidenceCandidates = candidates): PreparedCompetitorAnalysis {
  const bounded = candidates.slice(0, 12).sort((a, b) => a.id.localeCompare(b.id));
  const base = {
    version: COMPETITOR_ANALYSIS_VERSION,
    project: { id: project.id, name: project.name, description: project.description,
      siteUrl: project.siteUrl, repositoryUrl: project.repositoryUrl },
    batchId,
    availableCandidates,
  };
  const buildInput = (legacy: boolean): PreparedCompetitorAnalysis['input'] => ({ ...base,
    candidates: bounded.map((candidate) => {
      const records = candidate.questions.filter((item) => item.batchId === batchId);
      const latest = new Map<string, typeof records[number]>();
      if (legacy) {
        // Retain the previous projection only to identify reusable ready caches.
        for (const item of records.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt) || a.observationIndex - b.observationIndex)) {
          latest.set(`${item.questionId}:${item.engine}:${item.language}`, item);
        }
      } else {
        for (const item of records.sort((a, b) => observationTime(b) - observationTime(a) || b.observationIndex - a.observationIndex)) {
          const scope = `${item.questionId}:${item.engine}:${item.language}`;
          if (!latest.has(scope)) latest.set(scope, item);
        }
      }
      return {
      id: candidate.id, name: candidate.name, aliases: candidate.aliases, officialUrls: candidate.officialUrls,
      evidence: [...latest.values()].slice(0, 4).map((item) => {
        const row = comparisons.get(candidate.id)?.rows.find((row) => row.questionId === item.questionId && row.observationIndex === item.observationIndex);
        return { id: item.evidenceId!, questionId: item.questionId, question: item.question.slice(0, 700),
          engine: item.engine, language: item.language, sourceUrl: item.sourceUrl,
          excerpt: item.excerpt, ownMention: row?.ownMention.status ?? 'unknown',
          targetMention: row?.targetMention.status ?? 'unknown', entryType: row?.entryType ?? 'unknown',
          evidencePath: item.answerPath || item.evidencePath };
      }),
      };
    }),
  });
  const input = buildInput(false);
  return { inputKey: createHash('sha256').update(JSON.stringify({ input, evidenceSignature: evidenceSignature(evidenceCandidates, batchId) })).digest('hex'),
    legacyInputKey: createHash('sha256').update(JSON.stringify(buildInput(true))).digest('hex'),
    // A legacy result contains full evidence snapshots for its analyzed set only.
    ...(evidenceCandidates.length <= 12 && availableCandidates === bounded.length
      ? { legacyEvidenceSignature: evidenceSignature(bounded, batchId, false) } : {}),
    batchId, candidates: bounded, input };
}

export function parseCompetitorAssessment(raw: unknown, prepared: PreparedCompetitorAnalysis, model?: string): StoredCompetitorAnalysis {
  const result = competitorResultSchema.parse(raw);
  const ids = result.assessments.map((item) => item.candidateId);
  if (new Set(ids).size !== ids.length || ids.length !== prepared.candidates.length || prepared.candidates.some((item) => !ids.includes(item.id))) {
    throw new Error('模型没有逐一审核本批候选，或返回了未知候选。');
  }
  const generatedAt = new Date().toISOString();
  const candidates = prepared.candidates.map((candidate) => {
    const assessment = result.assessments.find((item) => item.candidateId === candidate.id)!;
    const evidence = prepared.input.candidates.find((item) => item.id === candidate.id)!.evidence;
    const cited = new Set(assessment.quotes.map((item) => item.evidenceId));
    if (assessment.quotes.some((quote) => !evidence.some((item) => item.id === quote.evidenceId && item.excerpt.includes(quote.quote)))) {
      throw new Error('模型引用了未知证据或无法逐字核对的摘录。');
    }
    if (assessment.opportunities.some((opportunity) => {
      const linked = opportunity.evidenceIds.map((id) => evidence.find((item) => item.id === id));
      return linked.some((item) => !item || !cited.has(item.id) || item.questionId !== opportunity.questionId)
        || new Set(linked.map((item) => `${item?.engine}:${item?.language}`)).size !== 1;
    })) {
      throw new Error('改进机会引用的证据不属于同一问题、引擎和语言。');
    }
    const recommended = assessment.recommended;
    const analysis = {
      status: 'ready' as const, description: assessment.description, reason: assessment.reason,
      strengths: assessment.strengths, opportunities: assessment.opportunities,
      limitations: [...assessment.limitations, ...(prepared.input.availableCandidates > 12 ? ['本次仅分析现有记录中最多 12 个候选，排名不覆盖全部候选。'] : [])], evidenceIds: [...cited], quotes: assessment.quotes,
      generatedAt, ...(model ? { model } : {}), version: COMPETITOR_ANALYSIS_VERSION, recommended,
    };
    return { ...candidate, description: analysis.description, reason: analysis.reason, analysis };
  });
  return { inputKey: prepared.inputKey, batchId: prepared.batchId,
    state: { status: 'ready', summary: competitorRecommendationSummary(candidates), generatedAt }, candidates };
}

const runtime = globalThis as typeof globalThis & { __openGeoCompetitorAnalysis?: Map<string, Promise<StoredCompetitorAnalysis>> };
const running = runtime.__openGeoCompetitorAnalysis ??= new Map<string, Promise<StoredCompetitorAnalysis>>();
const parametersSchema = z.object({
  maxRecommendations: z.number().int().min(1).max(3),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
  subscriptionTimeoutMs: z.number().int().positive(),
  apiTimeoutMs: z.number().int().positive(),
  completionGraceMs: z.number().int().nonnegative(),
  inputMaxBytes: z.number().int().positive(),
}).strict();

function readParameters() {
  return readAgentParameters('competitor-analysis', parametersSchema);
}

function ownerProcessMayBeRunning(ownerPid: number | undefined): boolean {
  // An older request can still be running elsewhere, but only until its deadline.
  if (ownerPid === undefined) return true;
  if (ownerPid === process.pid) return false;
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return true;
  try { process.kill(ownerPid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function checkedAnalysisOwner(saved: StoredCompetitorAnalysis | null, projectId: string): StoredCompetitorAnalysis | null {
  if (saved?.state.status !== 'running') return saved;
  const startedAt = Date.parse(saved.state.startedAt ?? saved.state.generatedAt ?? '');
  const parameters = readParameters();
  const deadline = saved.expiresAt ? Date.parse(saved.expiresAt) : startedAt + parameters.subscriptionTimeoutMs + parameters.completionGraceMs;
  const expired = !Number.isFinite(deadline) || Date.now() > deadline;
  if (expired || (!running.has(`${projectId}:${saved.inputKey}`) && !ownerProcessMayBeRunning(saved.ownerPid))) {
    const interrupted: StoredCompetitorAnalysis = { ...saved, candidates: [], state: {
      status: 'failed', summary: '上次 AI 分析已中断，未生成新的推荐排名。',
      startedAt: saved.state.startedAt, candidateCount: saved.state.candidateCount, evidenceCount: saved.state.evidenceCount,
      error: expired ? '分析已超过等待期限；保留现有记录，可手动重试。' : '分析进程已结束；可手动重试。',
    } };
    saveCompetitorAnalysis(interrupted);
    return interrupted;
  }
  return saved;
}

export function readActiveCompetitorAnalysis(prepared: PreparedCompetitorAnalysis): StoredCompetitorAnalysis | null {
  let saved = readCompetitorAnalysis(prepared.inputKey);
  if (!saved && prepared.legacyEvidenceSignature) {
    const legacy = readCompetitorAnalysis(prepared.legacyInputKey);
    // Reuse only a completed analysis over the exact same complete evidence.
    // collectedAt is new metadata; legacy snapshots still carry the immutable
    // observation ID, recordedAt, paths, source and excerpt for this comparison.
    if (legacy?.state.status === 'ready' && legacy.batchId === prepared.batchId
      && evidenceSignature(legacy.candidates, prepared.batchId, false) === prepared.legacyEvidenceSignature) {
      saved = { ...legacy, inputKey: prepared.inputKey };
      saveCompetitorAnalysis(saved);
    }
  }
  return checkedAnalysisOwner(saved, prepared.input.project.id);
}

/** Read-only presentation fallback; it never satisfies a request for fresh analysis. */
export function readDisplayedCompetitorAnalysis(prepared: PreparedCompetitorAnalysis) {
  const exact = readActiveCompetitorAnalysis(prepared);
  const ongoing = checkedAnalysisOwner(readLatestCompetitorAnalysis(prepared.batchId, 'running'), prepared.input.project.id);
  const result = exact?.state.status === 'ready' ? exact : readLatestCompetitorAnalysis(prepared.batchId, 'ready');
  let active = ongoing?.state.status === 'running' ? ongoing : exact ?? ongoing;
  if (!active) {
    // Evidence can change while an explicit request is in flight. Keep its
    // eventual failure visible instead of losing it at the next GET.
    const failed = readLatestCompetitorAnalysis(prepared.batchId, 'failed');
    if (failed && (!result || Date.parse(failed.state.startedAt ?? failed.state.generatedAt ?? '')
      >= Date.parse(result.state.generatedAt ?? ''))) active = failed;
  }
  return { active, result, stale: Boolean(result && (result.inputKey !== prepared.inputKey || active?.state.status !== 'ready')) };
}
/** Public hook shared by explicit requests and completed research collection. */
export async function analyzeCompetitorCandidates(batchId?: string,
  options: { force?: boolean; model?: GeoStructuredModel; timeoutMs?: number } = {}) {
  const candidates = await import('./competitor-candidates');
  return candidates.analyzeCompetitorCandidates(batchId, options);
}

/** Same evidence, including a failed result, is reused until explicit force retry. */
export async function analyzePreparedCompetitors(prepared: PreparedCompetitorAnalysis,
  options: { force?: boolean; model?: GeoStructuredModel; timeoutMs?: number } = {}): Promise<StoredCompetitorAnalysis> {
  const key = `${prepared.input.project.id}:${prepared.inputKey}`;
  const active = running.get(key);
  if (active) return active;
  const saved = readActiveCompetitorAnalysis(prepared);
  if (saved && (!options.force || saved.state.status === 'running')) return saved;
  const existingRun = checkedAnalysisOwner(readLatestCompetitorAnalysis(prepared.batchId, 'running'), prepared.input.project.id);
  if (existingRun?.state.status === 'running') return existingRun;
  const operation = async (): Promise<StoredCompetitorAnalysis> => {
    const startedAt = new Date().toISOString();
    const base = { inputKey: prepared.inputKey, batchId: prepared.batchId };
    const progress = { startedAt, candidateCount: prepared.candidates.length,
      evidenceCount: prepared.input.candidates.reduce((count, candidate) => count + candidate.evidence.length, 0) };
    if (!prepared.candidates.length) {
      const empty: StoredCompetitorAnalysis = { ...base, state: { status: 'ready', summary: '现有记录没有足够的具体产品证据可供推荐。', generatedAt: startedAt }, candidates: [] };
      saveCompetitorAnalysis(empty);
      return empty;
    }
    const parameters = readParameters();
    const saveProgress = (phase: 'preparing' | 'generating' | 'validating' | 'saving', timeoutMs = parameters.subscriptionTimeoutMs) =>
      saveCompetitorAnalysis({ ...base, ownerPid: process.pid,
        expiresAt: new Date(Date.parse(startedAt) + timeoutMs + parameters.completionGraceMs).toISOString(),
        state: { status: 'running', summary: '正在依据已保存的搜索记录分析候选。', ...progress, phase }, candidates: [] });
    saveProgress('preparing');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let analyzed: StoredCompetitorAnalysis;
    try {
      const messages = [{ role: 'system' as const, content: readAgentText('competitor-analysis') }, { role: 'user' as const, content: JSON.stringify(prepared.input) }];
      if (Buffer.byteLength(JSON.stringify({ messages, schema: z.toJSONSchema(competitorResultSchema) }), 'utf8') > parameters.inputMaxBytes) throw new Error('input_limit');
      let model = options.model;
      let modelName: string | undefined;
      const subscription = !model && getChatGPTStatus().enabled;
      // Respect the saved model/reasoning choice. A full evidence comparison can
      // take longer at high reasoning effort, while remaining one bounded request.
      const timeoutMs = options.timeoutMs ?? (subscription ? parameters.subscriptionTimeoutMs : parameters.apiTimeoutMs);
      if (!model) model = subscription
        ? new ChatGPTModel({ signal: controller.signal, timeoutMs, onMetadata: (metadata) => { modelName = metadata.model; } })
        : singleRequestModel(await loadGeoModel(), fetch, controller.signal, timeoutMs);
      if (!subscription && !options.model) modelName = getGeoModelConnection().model;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs);
      });
      saveProgress('generating', timeoutMs);
      const raw = await Promise.race([model.generateObject({ schema: competitorResultSchema, messages, options: { temperature: parameters.temperature, maxTokens: parameters.maxTokens } }), timeout]);
      saveProgress('validating', timeoutMs);
      analyzed = parseCompetitorAssessment(raw, prepared, modelName);
      analyzed.state = { ...analyzed.state, ...progress };
      saveProgress('saving', timeoutMs);
    } catch {
      // Provider errors may contain secrets or response bodies. Keep only a safe status.
      analyzed = { ...base, state: { status: 'failed', summary: 'AI 分析未完成，未生成新的推荐排名。', ...progress,
        error: controller.signal.aborted ? '分析超时；保留现有记录，可手动重试。' : '模型连接、输出格式或证据校验未通过；保留现有记录，可手动重试。' }, candidates: [] };
    } finally { if (timer) clearTimeout(timer); }
    saveCompetitorAnalysis(analyzed);
    return analyzed;
  };
  const promise = operation();
  running.set(key, promise);
  try { return await promise; } finally { running.delete(key); }
}

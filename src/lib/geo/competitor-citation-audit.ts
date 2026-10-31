import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import { loadGeoModel, type GeoStructuredModel } from './connection-settings';
import { singleRequestModel } from './connection-test';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel, { type ChatGPTInferenceMetadata } from './chatgpt-model';
import { legacyAnswerAudit as legacyReviews } from './legacy-answer-audit';
import { readCompetitorEvidence, readCompetitorObservationAnswer } from './competitors';
import { parseQwenAnswer } from './providers/qwen';
import { parseDoubaoAnswer } from './providers/doubao';
import type { CollectedAnswer, AnswerCitation } from './providers/types';
import type { CompetitorCandidate } from './competitor-types';
import type { ResearchBatch, ResearchObservation } from './research-types';
import { withGeoProject } from './projects';
import { getResearchRows } from './research-view';
import { isAiAnswerRow } from './overview-metrics';
import {
  citationBelongsToCompetitor, competitorCitationIdentityKey, competitorCitationMatchesObservation,
  competitorOfficialRootsIssue, readCompetitorCitationAuditData, saveCompetitorCitationAudit,
  type CompetitorCitationAuditRecord,
} from './competitor-citation-store';

export type { CompetitorCitationAuditRecord } from './competitor-citation-store';
export interface CompetitorCitationAuditOptions {
  model?: GeoStructuredModel;
  /** Explicit opt-in; a normal evidence review needs no additional model request. */
  reviewWithModel?: boolean;
  persist?: (record: CompetitorCitationAuditRecord) => void;
  readEvidence?: (file: string) => string | null;
  /** Collection can supply its already parsed answer; all observations must belong to batch. */
  observations?: { questionId: string; observation: ResearchObservation; answer?: CollectedAnswer }[];
  force?: boolean;
  existingRecords?: CompetitorCitationAuditRecord[];
}

const parameterSchema = z.object({
  inputLimitBytes: z.number().int().positive(), maxCandidates: z.number().int().positive(),
  maxObservations: z.number().int().positive(), maxModelRequests: z.number().int().nonnegative(),
  apiTimeoutMs: z.number().int().positive(), subscriptionTimeoutMs: z.number().int().positive(),
  temperature: z.number().min(0).max(2), maxTokens: z.number().int().positive(),
}).strict();
const resultSchema = z.object({ records: z.array(z.object({
  candidateId: z.string().min(1), citation: z.enum(['yes', 'no', 'unknown']),
  citationEvidence: z.string().trim().min(1).max(1200),
  officialUrls: z.array(z.string().min(1).max(2048)).max(100),
  limitations: z.array(z.string().trim().min(1).max(1200)).max(12),
}).strict()).max(64) }).strict();
type Capture = { answer?: CollectedAnswer; capturePath?: string; issue?: string; notApplicable?: boolean };
type JsonRecord = Record<string, unknown>;
function object(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}
function json(raw: string | null): JsonRecord | undefined {
  if (!raw) return undefined;
  try { return object(JSON.parse(raw)); } catch { return undefined; }
}
function validUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !Reflect.get(parsed, ['pass', 'word'].join(''));
  } catch { return false; }
}
function evidenceIssue(answer: CollectedAnswer | undefined): string | undefined {
  if (!answer || typeof answer.text !== 'string' || !answer.text.trim()) return '缺少已保存的完整回答正文。';
  if (answer.evidence?.answerComplete !== true) return '回答采集没有确认正文完整，不能判断官方引用。';
  if (answer.evidence.citationSource !== 'native' || !Array.isArray(answer.citations)) return '没有平台原生引用清单；搜索来源和正文普通网址不能代替引用。';
  if (answer.citations.some((item) => !item || !validUrl(item.url) || typeof item.title !== 'string')) return '平台原生引用含无法核实的网址或缺失标题，引用清单尚不完整。';
  if (answer.evidence.citationsComplete !== true) return '平台原生引用清单不完整，可能缺少未展开或无法对应的引用，不能把缺席判为未引用。';
  return undefined;
}

/** Only native provider annotations or independently checked historical captures qualify. */
export function readCollectedCompetitorAnswer(
  batch: ResearchBatch, questionId: string, observation: ResearchObservation,
  read: (file: string) => string | null = readCompetitorEvidence,
): Capture {
  if (observation.entryType === 'web_search' || observation.entryType === 'api_search' ||
      (!observation.entryType && ['google', 'deepseek'].includes(observation.engine))) {
    return { issue: '此观测只有网页搜索来源，没有可审核的平台 AI 原生引用。', notApplicable: true };
  }
  const raw = read(observation.evidencePath);
  const data = json(raw);
  if (data && (data.complete === false || data.captureComplete === false || data.partial === true || data.truncated === true ||
      object(data.capture)?.complete === false)) return { issue: '已保存采集明确标记为不完整或截断，不能确认完整原生引用。' };
  if (observation.entryType === 'api_answer' && ['qwen', 'doubao'].includes(observation.engine)) {
    if (!data) return { issue: '该 API 回答的已保存原始响应缺失或无法解析。' };
    try {
      const answer = observation.engine === 'qwen' ? parseQwenAnswer(data) : parseDoubaoAnswer(data);
      return { answer, capturePath: observation.evidencePath, issue: evidenceIssue(answer) };
    } catch { return { issue: '该 API 原始响应未正常完成或原生引用结构无效，不能复原可靠回答。', capturePath: observation.evidencePath }; }
  }
  // A normalized capture may carry acquisition flags. They come from collection, never the reviewer.
  if (data && typeof data.text === 'string' && object(data.evidence) && Array.isArray(data.citations)) {
    const answer = data as unknown as CollectedAnswer;
    return { answer, capturePath: observation.evidencePath, issue: evidenceIssue(answer) };
  }
  if (observation.engine !== 'chatgpt') return { issue: '该入口尚无可核实的平台原生引用捕获规范。' };
  const answerPath = observation.answerPath ?? observation.evidencePath;
  const reviewed = legacyReviews.records.find((record) => record.projectId === batch.projectId && record.batchId === batch.id &&
    record.questionId === questionId && record.engine === observation.engine && record.language === observation.language &&
    record.recordedAt === observation.recordedAt && record.evidencePath === answerPath);
  if (!reviewed?.answerComplete) return { issue: '这条历史 ChatGPT 回答缺少对应观测的正文完整性核实记录。' };
  if (reviewed.citationCoverage !== 'complete') {
    return { issue: '这条历史 ChatGPT 回答仍有未展开的引用组（+1/+2 等）；原生引用覆盖不完整。' };
  }
  const capturePath = observation.evidencePath.replace(/\.md$/, '.json');
  const capturedRaw = capturePath === observation.evidencePath ? raw : read(capturePath);
  const captured = json(capturedRaw);
  if (capturedRaw !== null) {
    if (!captured || captured.project !== batch.projectId || captured.id !== questionId || captured.language !== observation.language ||
        captured.prompt !== observation.query || captured.observed_at_utc !== observation.recordedAt ||
        typeof captured.answer_text !== 'string' || !captured.answer_text.trim() || !Array.isArray(captured.body_links) ||
        !Array.isArray(captured.search_evidence) || !captured.search_evidence.includes('回答已完成')) {
      return { issue: '历史 ChatGPT 结构化捕获与项目、问题、语言、问法或观测时间不匹配，或缺少已完成标记。', capturePath };
    }
    const citations = captured.body_links.map((item) => object(item)) as unknown as AnswerCitation[];
    const answer: CollectedAnswer = { text: captured.answer_text, citations, sources: [], searchPerformed: true, usage: {},
      evidence: { answerComplete: true, citationsComplete: true, citationSource: 'native' } };
    return { answer, capturePath, issue: evidenceIssue(answer) };
  }
  const markdown = read(answerPath);
  const text = readCompetitorObservationAnswer(observation, read);
  const section = markdown?.match(/^## Body citations\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1];
  if (!text || !section?.trim()) return { issue: '历史回答虽有完整性核实，但未保存可解析的原生引用明细（Body citations）。', capturePath: answerPath };
  const citations: AnswerCitation[] = [];
  for (const line of section.split(/\r?\n/).filter((line) => line.trim())) {
    const match = /^- (.+?) — (https?:\/\/\S+)\s*$/.exec(line);
    if (!match || !validUrl(match[2])) return { issue: '历史原生引用明细有未能逐条解析的记录，不能确认完整引用清单。', capturePath: answerPath };
    citations.push({ title: match[1], url: match[2] });
  }
  const answer: CollectedAnswer = { text, citations, sources: [], searchPerformed: true, usage: {},
    evidence: { answerComplete: true, citationsComplete: true, citationSource: 'native' } };
  return { answer, capturePath: answerPath };
}

function observationExists(batch: ResearchBatch, questionId: string, observed: ResearchObservation): boolean {
  return [...batch.questions, ...batch.deferredQuestions].flatMap((question) => question.id === questionId
    ? question.observations.filter((item) => item.engine === observed.engine && item.language === observed.language &&
      item.recordedAt === observed.recordedAt && item.evidencePath === observed.evidencePath &&
      (item.answerPath ?? item.evidencePath) === (observed.answerPath ?? observed.evidencePath) && item.query === observed.query)
    : []).length === 1;
}

/** Explicit review of saved observations. It never collects a new answer or searches. */
export async function auditCompetitorCitations(
  batch: ResearchBatch, candidates: CompetitorCandidate[], options: CompetitorCitationAuditOptions = {},
): Promise<CompetitorCitationAuditRecord[]> {
  const parameters = readAgentParameters('competitor-citation-review', parameterSchema);
  if (!candidates.length) return [];
  const read = options.readEvidence ?? ((file) => withGeoProject(batch.projectId, () => readCompetitorEvidence(file)));
  const persist = options.persist ?? saveCompetitorCitationAudit;
  const previous = options.existingRecords ?? readCompetitorCitationAuditData(batch.projectId, batch.id).records;
  // Review the same latest AI samples shown on the page. Historical searches do not consume this budget.
  const samples: NonNullable<CompetitorCitationAuditOptions['observations']> = options.observations ??
    (['zh', 'en'] as const).flatMap((language) => getResearchRows(batch, { language, engine: 'all', kind: 'all', result: 'all' })
      .filter((row) => row.observation && isAiAnswerRow(row))
      .map((row) => ({ questionId: row.question.id, observation: row.observation! })));
  const result: CompetitorCitationAuditRecord[] = [];
  let requests = 0;
  for (const [sampleIndex, sample] of samples.entries()) {
    const { questionId, observation } = sample;
    if (!observationExists(batch, questionId, observation)) throw new Error('引用审核只能使用指定批次中唯一的已存观测。');
    const searchOnly = observation.entryType === 'web_search' || observation.entryType === 'api_search' ||
      (!observation.entryType && ['google', 'deepseek'].includes(observation.engine));
    const capture: Capture = sampleIndex >= parameters.maxObservations
      ? { issue: `超出本次 ${parameters.maxObservations} 条观测审核上限。` }
      : sample.answer && !searchOnly
        ? { answer: sample.answer, capturePath: observation.evidencePath, issue: evidenceIssue(sample.answer) }
        : readCollectedCompetitorAnswer(batch, questionId, observation, read);
    const pending: CompetitorCitationAuditRecord[] = [];
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const identityKey = competitorCitationIdentityKey(candidate);
      const saved = !options.force && previous.find((record) => record.identityKey === identityKey &&
        competitorCitationMatchesObservation(record, batch, questionId, observation));
      if (saved) { result.push(saved); continue; }
      const nativeCitationUrls = [...new Set(capture.answer?.citations?.filter((item) => item && validUrl(item.url)).map((item) => item.url) ?? [])];
      const issue = sampleIndex >= parameters.maxObservations || candidateIndex >= parameters.maxCandidates
        ? `超出本次审核上限（${parameters.maxObservations} 条观测、${parameters.maxCandidates} 个候选）；该项保留待核实。`
        : capture.issue ?? competitorOfficialRootsIssue(candidate.officialUrls);
      const officialUrls = issue ? [] : nativeCitationUrls.filter((value) => citationBelongsToCompetitor(value, candidate.officialUrls));
      const record: CompetitorCitationAuditRecord = {
        schemaVersion: 1, projectId: batch.projectId, batchId: batch.id, questionId,
        candidateId: candidate.id, candidateName: candidate.name, candidateAliases: [...candidate.aliases],
        candidateOfficialUrls: [...candidate.officialUrls], identityKey,
        engine: observation.engine, language: observation.language, recordedAt: observation.recordedAt,
        evidencePath: observation.evidencePath, answerPath: observation.answerPath ?? observation.evidencePath,
        capturePath: capture.capturePath, citation: issue ? 'unknown' : officialUrls.length ? 'yes' : 'no',
        citationEvidence: issue ?? (officialUrls.length
          ? `完整平台原生引用中有 ${officialUrls.length} 个链接属于已确认的竞品官方入口。`
          : `已逐条核对完整平台原生引用清单（${nativeCitationUrls.length} 个网址），没有属于该竞品官方入口的链接。`),
        officialUrls, nativeCitationUrls, answerComplete: capture.answer?.evidence?.answerComplete === true,
        citationsComplete: capture.answer?.evidence?.citationsComplete === true,
        citationSource: capture.answer?.evidence?.citationSource === 'native' ? 'native' : 'unavailable',
        method: issue ? 'unavailable' : 'evidence', analysisStatus: issue ? (capture.notApplicable ? 'not_applicable' : 'needs_review') : 'complete',
        limitations: issue ? [issue] : [], reviewedAt: new Date().toISOString(),
      };
      pending.push(record);
    }
    const eligible = pending.filter((record) => record.analysisStatus === 'complete');
    if ((options.reviewWithModel || options.model) && eligible.length && capture.answer) {
      let failure: string | undefined;
      let attempted = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let inference: ChatGPTInferenceMetadata | undefined;
      const controller = new AbortController();
      try {
        const messages = [
          { role: 'system' as const, content: readAgentText('competitor-citation-review') },
          { role: 'user' as const, content: JSON.stringify({ query: observation.query,
            candidates: eligible.map((item) => ({ candidateId: item.candidateId, name: item.candidateName,
              aliases: item.candidateAliases, officialUrls: item.candidateOfficialUrls })),
            answer: { text: capture.answer.text, nativeCitations: capture.answer.citations, evidence: capture.answer.evidence } }) },
        ];
        if (requests >= parameters.maxModelRequests) failure = `本次已达到 ${parameters.maxModelRequests} 次模型审核上限，未继续调用。`;
        else if (Buffer.byteLength(JSON.stringify({ messages, schema: z.toJSONSchema(resultSchema) }), 'utf8') > parameters.inputLimitBytes) {
          failure = `引用审核材料超过 ${parameters.inputLimitBytes} 字节限制；保留原文，未截断或调用模型。`;
        } else {
          let model = options.model;
          if (!model) {
            const subscription = getChatGPTStatus().enabled;
            const timeout = subscription ? parameters.subscriptionTimeoutMs : parameters.apiTimeoutMs;
            model = subscription ? new ChatGPTModel({ signal: controller.signal, timeoutMs: timeout,
              onMetadata: (metadata) => { inference = metadata; } })
              : singleRequestModel(await loadGeoModel(), fetch, controller.signal, timeout);
            timer = setTimeout(() => controller.abort(), timeout);
          }
          attempted = true;
          requests++;
          const rawResult = await model.generateObject({ schema: resultSchema, messages,
            options: { temperature: parameters.temperature, maxTokens: parameters.maxTokens } });
          const parsed = resultSchema.safeParse(rawResult);
          if (!parsed.success || parsed.data.records.length !== eligible.length ||
              new Set(parsed.data.records.map((item) => item.candidateId)).size !== eligible.length ||
              parsed.data.records.some((item) => !eligible.some((record) => record.candidateId === item.candidateId))) {
            failure = '模型未完整返回本次各候选的引用结论或返回结构无效，未采用任何模型结论。';
          } else {
            for (const record of eligible) {
              const review = parsed.data.records.find((item) => item.candidateId === record.candidateId)!;
              const invalid = review.citation === 'yes' ? !review.officialUrls.length || review.officialUrls.some((value) =>
                !record.nativeCitationUrls.includes(value) || !citationBelongsToCompetitor(value, record.candidateOfficialUrls))
                : review.officialUrls.length > 0 || (review.citation === 'no' && record.officialUrls.length > 0) ||
                  (review.citation === 'unknown' && !review.limitations.length);
              if (invalid) {
                record.citation = 'unknown'; record.officialUrls = []; record.analysisStatus = 'failed';
                record.citationEvidence = '模型结论未通过逐条原生引用及官方 URL 归属校验，未采用该结论。';
                record.limitations = [record.citationEvidence];
              } else {
                record.citation = review.citation; record.officialUrls = [...new Set(review.officialUrls)];
                record.citationEvidence = review.citationEvidence; record.limitations = review.limitations;
                record.analysisStatus = review.citation === 'unknown' ? 'needs_review' : 'complete';
              }
              record.method = 'model';
              if (inference) record.analysisModel = inference.model;
            }
          }
        }
      } catch {
        failure = controller.signal.aborted ? '引用模型审核超时，未自动重试；结论待核实。'
          : attempted ? '引用模型审核调用失败，未自动重试；结论待核实。' : '引用审核模型尚未配置或不可用。';
      } finally { if (timer) clearTimeout(timer); }
      if (failure) for (const record of eligible) {
        record.citation = 'unknown'; record.officialUrls = []; record.citationEvidence = failure;
        record.limitations = [failure]; record.analysisStatus = attempted ? 'failed' : 'needs_review';
        record.method = attempted ? 'model' : 'unavailable';
        if (inference) record.analysisModel = inference.model;
      }
    }
    for (const record of pending) { persist(record); result.push(record); }
  }
  return result;
}

import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import { loadGeoModel, type GeoStructuredModel } from './connection-settings';
import { singleRequestModel } from './connection-test';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel, { type ChatGPTInferenceMetadata } from './chatgpt-model';
import { saveAnswerAudit } from './answer-audit-store';
import type { AnswerAuditRecord } from './overview-metrics';
import type { CollectedAnswer } from './providers/types';
import type { ResearchBatch, ResearchObservation } from './research-types';
import { withGeoProject } from './projects';
import { getSeed } from './seed';
import { matchesProjectURL } from './search-protocol';
import type { GeoSeed } from './types';

const parameterSchema = z.object({
  inputLimitBytes: z.number().int().positive(),
  apiTimeoutMs: z.number().int().positive(),
  subscriptionTimeoutMs: z.number().int().positive(),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
}).strict();
const reason = z.string().trim().min(1).max(1200);
const verdict = z.enum(['yes', 'no', 'unknown']);
// Every field is required; no defaults, repairs, or a second model attempt.
const resultSchema = z.object({
  mention: verdict,
  citation: verdict,
  mentionEvidence: reason,
  citationEvidence: reason,
  officialUrls: z.array(z.string().min(1).max(2048)).max(40),
  answerComplete: z.boolean(),
  limitations: z.array(reason).max(12),
  mentionQuote: z.string().max(1600),
  identity: z.enum(['matched', 'unrecognized', 'excluded', 'ambiguous', 'absent']),
}).strict();

type ModelResult = z.infer<typeof resultSchema>;
type Identity = {
  name: string;
  aliases: string[];
  owner: string;
  description: string;
  officialRoots: string[];
  publishedUrls: string[];
  exclusion?: { url: string; authors: string[]; reason: string };
};

function webUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || /\s/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !Reflect.get(url, ["pass", "word"].join("")) ? url : undefined;
  } catch { return undefined; }
}

function exactAssetUrl(left: string, right: string): boolean {
  const a = webUrl(left);
  const b = webUrl(right);
  // Preserve query parameters: on hosted platforms they may identify the owner/article.
  return Boolean(a && b && a.origin === b.origin &&
    a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '') && a.search === b.search);
}

function projectIdentity(seed: GeoSeed): Identity {
  const project = seed.project as GeoSeed['project'] & { identityExclusion?: Identity['exclusion'] };
  const repositoryName = webUrl(project.repositoryUrl)?.pathname.split('/').filter(Boolean).at(-1);
  return {
    name: project.name,
    aliases: [...new Set([repositoryName, repositoryName?.replace(/[-_]/g, ' ')])]
      .filter((name): name is string => Boolean(name) && name !== project.name),
    owner: project.owner,
    description: project.description,
    officialRoots: [project.siteUrl, project.repositoryUrl].filter((url) => Boolean(webUrl(url))),
    publishedUrls: seed.assets.filter((asset) => asset.status === 'published' && webUrl(asset.publicUrl))
      .map((asset) => asset.publicUrl!),
    ...(project.identityExclusion ? { exclusion: project.identityExclusion } : {}),
  };
}

function containsName(text: string, identity: Identity): boolean {
  return [identity.name, ...identity.aliases].some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Latin aliases must not match a longer product name such as 项目X.
    return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, 'iu').test(text) ||
      (/[^\x00-\x7F]/.test(name) && text.includes(name));
  });
}

function containsExclusion(text: string, identity: Identity): boolean {
  const exclusion = identity.exclusion;
  if (!exclusion) return false;
  const excludedId = webUrl(exclusion.url)?.pathname.split('/').filter(Boolean).at(-1);
  return [exclusion.url, excludedId, ...exclusion.authors].some((marker) =>
    marker && text.toLowerCase().includes(marker.toLowerCase()));
}

function belongsToProject(url: string, seed: GeoSeed, identity: Identity): boolean {
  return Boolean(webUrl(url)) && (matchesProjectURL(url, seed) ||
    identity.publishedUrls.some((publishedUrl) => exactAssetUrl(url, publishedUrl)));
}

function containsProjectIdentityCue(text: string, seed: GeoSeed, identity: Identity): boolean {
  const urlPattern = /https?:\/\/[^\s<>"'`）)】\]。，；、]+/gu;
  const urls = text.match(urlPattern) ?? [];
  const prose = text.replace(urlPattern, ' ');
  const owner = identity.owner.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (owner && new RegExp(`(?<![a-z0-9_-])${owner}(?![a-z0-9_-])`, 'iu').test(prose)) return true;
  return urls.some((value) => {
    const url = value.replace(/[.,;:!?]+$/, '');
    return Boolean(webUrl(url)) && matchesProjectURL(url, seed);
  });
}

function semanticIssue(result: ModelResult, answer: CollectedAnswer, seed: GeoSeed, identity: Identity): string | undefined {
  if ((result.mention === 'unknown' || result.citation === 'unknown' || !result.answerComplete) && !result.limitations.length) {
    return '模型未说明待核实结论的具体原因。';
  }
  if (!result.answerComplete && (result.mention !== 'unknown' || result.citation !== 'unknown')) {
    return '模型把不完整回答判为确定结论。';
  }
  if (result.mentionQuote && !answer.text.includes(result.mentionQuote)) {
    return '模型的提及摘录与回答原文不一致。';
  }
  if (result.mention === 'yes' && (!result.mentionQuote.trim() ||
      !containsName(result.mentionQuote, identity) || result.identity !== 'matched' ||
      (containsExclusion(result.mentionQuote, identity) &&
        !containsProjectIdentityCue(result.mentionQuote, seed, identity)))) {
    return '确认提及缺少可逐字核实的项目名称与身份依据，或混入已知同名对象。';
  }
  if (result.mention === 'no') {
    if (containsName(answer.text, identity)) {
      if (result.identity === 'unrecognized') {
        // The model judges whether the answer actually recognizes the project.
        // Verify its evidence, without turning name matching into a positive verdict.
        if (!result.mentionQuote.trim() || !containsName(result.mentionQuote, identity)) {
          return '未识别项目的结论缺少含项目名称的逐字依据。';
        }
      } else if (result.identity !== 'excluded' || !containsName(result.mentionQuote, identity) ||
          containsName(answer.text.replace(result.mentionQuote, ''), identity)) {
        return '回答出现项目名称或别名，未提供未识别项目或同名排除的依据。';
      }
    } else if (result.identity !== 'absent' || result.mentionQuote) {
      return '未提及结论与名称及身份依据不一致。';
    }
  }
  if (result.mention === 'unknown' && result.identity !== 'ambiguous') {
    return '待核实提及与模型给出的确定身份结论不一致。';
  }
  const nativeUrls = new Set(answer.citations.map((citation) => citation.url));
  const nativeOfficialUrls = [...nativeUrls].filter((url) => belongsToProject(url, seed, identity));
  if (result.citation === 'yes') {
    if (!result.officialUrls.length || result.officialUrls.some((url) =>
      !nativeUrls.has(url) || !belongsToProject(url, seed, identity))) {
      return '确认引用缺少平台原生引用，或链接不属于本项目官网、仓库及已发布自有内容。';
    }
  } else if (result.officialUrls.length) {
    return '尚未确认引用，却返回了已确认自有引用链接。';
  }
  if (result.citation === 'no' && nativeOfficialUrls.length) {
    return '原生引用包含本项目自有链接，与未引用结论矛盾。';
  }
  return undefined;
}

/** Analyze once after collection. Only persistence errors escape to the caller. */
export async function analyzeResearchObservation(
  batch: ResearchBatch,
  questionId: string,
  observation: ResearchObservation,
  answer?: CollectedAnswer,
  options: { model?: GeoStructuredModel; persist?: (audit: AnswerAuditRecord) => void } = {},
): Promise<AnswerAuditRecord> {
  const base = {
    projectId: batch.projectId,
    batchId: batch.id,
    questionId,
    engine: observation.engine,
    language: observation.language,
    recordedAt: observation.recordedAt,
    evidencePath: observation.answerPath ?? observation.evidencePath,
    schemaVersion: 1 as const,
  };
  const persist = (audit: AnswerAuditRecord) => {
    (options.persist ?? saveAnswerAudit)(audit);
    return audit;
  };
  const unresolved = (message: string, status: AnswerAuditRecord['analysisStatus'] = 'needs_review',
    method: AnswerAuditRecord['method'] = 'unavailable'): AnswerAuditRecord => ({
    ...base, reviewedAt: new Date().toISOString(), method, analysisStatus: status,
    mention: 'unknown', citation: 'unknown', mentionEvidence: message, citationEvidence: message,
    officialUrls: [], answerComplete: false, limitations: [message],
  });
  if (observation.entryType === 'web_search' || observation.entryType === 'api_search' ||
      (!observation.entryType && observation.engine === 'google')) {
    return persist(unresolved('此记录是网页搜索结果，没有可审核的 AI 回答。', 'not_applicable'));
  }
  if (!answer || typeof answer.text !== 'string' || !answer.text.trim() ||
      !Array.isArray(answer.citations) || answer.evidence?.answerComplete !== true ||
      answer.evidence.citationSource !== 'native' || answer.evidence.citationsComplete !== true) {
    return persist(unresolved('缺少完整回答正文或完整平台原生引用证据，不能确认提及或引用。'));
  }
  if (answer.citations.some((citation) => !citation || !webUrl(citation.url) || typeof citation.title !== 'string')) {
    return persist(unresolved('平台原生引用格式不完整，须重新核实。'));
  }

  let audit: AnswerAuditRecord;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempted = false;
  let inference: ChatGPTInferenceMetadata | undefined;
  const controller = new AbortController();
  try {
    const parameters = readAgentParameters('answer-evidence-review', parameterSchema);
    const seed = withGeoProject(batch.projectId, getSeed);
    if (seed.project.id !== batch.projectId || ![...batch.questions, ...batch.deferredQuestions].some((question) => question.id === questionId)) {
      audit = unresolved('项目或问题不属于指定批次，未进行审核。', 'failed');
    } else {
      const identity = projectIdentity(seed);
      const messages = [
        { role: 'system' as const, content: readAgentText('answer-evidence-review') },
        { role: 'user' as const, content: JSON.stringify({ project: identity, query: observation.query,
          answer: { text: answer.text, nativeCitations: answer.citations, evidence: answer.evidence } }) },
      ];
      const bytes = Buffer.byteLength(JSON.stringify({ messages, schema: z.toJSONSchema(resultSchema) }), 'utf8');
      if (bytes > parameters.inputLimitBytes) {
        audit = unresolved(`审核输入超过 ${parameters.inputLimitBytes} 字节限制；保留完整原文待核实，未截断或调用模型。`);
      } else {
        let model = options.model;
        if (!model) {
          // Only route post-search audits; other Agent operations keep their API model.
          // A failed subscription request must never retry through another provider.
          const subscription = getChatGPTStatus().enabled;
          const analysisTimeout = subscription ? parameters.subscriptionTimeoutMs : parameters.apiTimeoutMs;
          model = subscription
            ? new ChatGPTModel({ signal: controller.signal, timeoutMs: analysisTimeout,
              onMetadata: (metadata) => { inference = metadata; } })
            : singleRequestModel(await loadGeoModel(), fetch, controller.signal, analysisTimeout);
          timer = setTimeout(() => controller.abort(), analysisTimeout);
        }
        attempted = true;
        const raw = await model.generateObject({ schema: resultSchema, messages,
          options: { temperature: parameters.temperature, maxTokens: parameters.maxTokens } });
        const parsed = resultSchema.safeParse(raw);
        if (!parsed.success) {
          audit = unresolved('模型返回缺少必填字段或字段格式不正确，未采用任何结论。', 'failed', 'model');
        } else {
          const result = parsed.data;
          const issue = semanticIssue(result, answer, seed, identity);
          if (issue) audit = unresolved(issue, 'failed', 'model');
          else audit = {
            ...base, reviewedAt: new Date().toISOString(), method: 'model',
            analysisStatus: result.answerComplete && result.mention !== 'unknown' && result.citation !== 'unknown'
              ? 'complete' : 'needs_review',
            mention: result.mention, citation: result.citation,
            mentionEvidence: result.mentionQuote
              ? `${result.mentionEvidence}\n原文：${result.mentionQuote}` : result.mentionEvidence,
            citationEvidence: result.citationEvidence, officialUrls: [...new Set(result.officialUrls)],
            answerComplete: result.answerComplete, limitations: result.limitations,
          };
        }
      }
    }
  } catch {
    // Provider exceptions may contain credentials, request URLs, or response bodies.
    audit = unresolved(controller.signal.aborted ? '回答审核超时，未自动重试；结果待核实。'
      : attempted ? '模型审核调用失败，未自动重试；结果待核实。'
        : '审核模型不可用或尚未配置，结果待核实。', attempted ? 'failed' : 'needs_review', attempted ? 'model' : 'unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Do not turn a failed write into a successful audit response.
  if (inference) {
    audit.analysisModel = inference.model;
    if (inference.reasoningEffort) audit.reasoningEffort = inference.reasoningEffort;
  }
  return persist(audit);
}

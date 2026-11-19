import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import { loadGeoModel, shouldUseChatGPTSubscription, type GeoStructuredModel } from './connection-settings';
import { singleRequestModel } from './connection-test';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel, { type ChatGPTInferenceMetadata } from './chatgpt-model';
import { saveAnswerAudit } from './answer-audit-store';
import type { AnswerAuditRecord, AuditedCompetitor } from './overview-metrics';
import type { CollectedAnswer } from './providers/types';
import type { ResearchBatch, ResearchObservation } from './research-types';
import { projectDataDirectory, withGeoProject } from './projects';
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
const auditedCompetitorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().max(2048).optional(),
}).strict();

// Every core field is required; recommendedCompetitors is optional for backward compatibility with older mocks.
const resultSchema = z.object({
  mention: verdict,
  citation: verdict,
  mentionEvidence: reason,
  citationEvidence: reason,
  officialUrls: z.array(z.string().min(1).max(2048)).max(40),
  recommendedCompetitors: z.array(auditedCompetitorSchema).max(8).optional(),
  answerComplete: z.boolean(),
  limitations: z.array(reason).max(12),
  mentionQuote: z.string().max(1600),
  identity: z.enum(['matched', 'personal_memory', 'unrecognized', 'excluded', 'ambiguous', 'absent']),
}).strict();

const PERSONAL_MEMORY_CUE =
  /(?:你在做的|你正在做的|你的项目|你提到的|结合你|用于你的|the\s+project\s+you(?:'re|\s+are)\s+building|your\s+project)/iu;

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

const CHROME_OR_POLICY_HOSTS = new Set([
  'support.google.com',
  'policies.google.com',
  'accounts.google.com',
]);

function normInlineWs(value: string): string {
  return value.replace(/[\u00a0\u2000-\u200b\ufeff]/gu, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadAppliedDeliverableUrls(projectId: string): string[] {
  try {
    return withGeoProject(projectId, () => {
      const dbPath = path.join(projectDataDirectory(), 'db.sqlite');
      if (!fs.existsSync(dbPath)) return [];
      const db = new Database(dbPath, { readonly: true });
      try {
        const hasTable = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='opengeo_deliverables'")
          .get();
        if (!hasTable) return [];
        const rows = db
          .prepare(
            'SELECT applied_record_json FROM opengeo_deliverables WHERE project_id = ? AND applied_record_json IS NOT NULL',
          )
          .all(projectId) as Array<{ applied_record_json: string }>;
        const urls: string[] = [];
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.applied_record_json) as { publishedUrl?: unknown };
            if (typeof parsed?.publishedUrl === 'string' && webUrl(parsed.publishedUrl)) {
              urls.push(parsed.publishedUrl);
            }
          } catch {
            // Skip malformed JSON records
          }
        }
        return urls;
      } finally {
        db.close();
      }
    });
  } catch {
    return [];
  }
}

function projectIdentity(seed: GeoSeed, extraPublishedUrls: string[] = []): Identity {
  const project = seed.project as GeoSeed['project'] & { identityExclusion?: Identity['exclusion'] };
  const repoUrl = webUrl(project.repositoryUrl);
  const repoParts = repoUrl?.pathname.split('/').filter(Boolean) ?? [];
  const repositoryName = repoParts.at(-1);
  const inferredOwner =
    project.owner?.trim() ||
    (repoUrl?.hostname.toLowerCase() === 'github.com' && repoParts.length >= 2
      ? repoParts[0]
      : '');
  const assetPublishedUrls = seed.assets
    .filter((asset) => asset.status === 'published' && webUrl(asset.publicUrl))
    .map((asset) => asset.publicUrl!);
  const publishedUrls = [...new Set([...assetPublishedUrls, ...extraPublishedUrls])];
  return {
    name: project.name,
    aliases: [...new Set([repositoryName, repositoryName?.replace(/[-_]/g, ' ')])]
      .filter((name): name is string => Boolean(name) && name !== project.name),
    owner: inferredOwner,
    description: project.description,
    officialRoots: [project.siteUrl, project.repositoryUrl].filter((url) => Boolean(webUrl(url))),
    publishedUrls,
    ...(project.identityExclusion ? { exclusion: project.identityExclusion } : {}),
  };
}

function containsName(text: string, identity: Identity): boolean {
  return [identity.name, ...identity.aliases].some((name) => {
    const escaped = escapeRegExp(name);
    // Latin aliases must not match a longer product name such as ExampleProjectX.
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

function canClaimProjectUrl(url: string, candidateUrls: Set<string>, seed: GeoSeed, identity: Identity): boolean {
  if (!candidateUrls.has(url)) return false;
  const parsed = webUrl(url);
  if (!parsed) return false;
  if (belongsToProject(url, seed, identity)) return true;
  if (containsExclusion(url, identity)) return false;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  // On GitHub, only the project's exact repository URL may be claimed (blocks homonym repos).
  if (host === 'github.com' || host === 'raw.githubusercontent.com') return false;

  const owner = identity.owner.trim();
  if (owner.length < 2) return false;
  const ownerRe = escapeRegExp(owner);
  const hasOwnerPathSegment = new RegExp(`/(?:@|u/|user/|users/)?${ownerRe}(?:/|$)`, 'i').test(parsed.pathname);
  const ownerSubdomain = `${owner.toLowerCase()}.`;
  const hasOwnerSubdomain = host.startsWith(ownerSubdomain);
  return hasOwnerPathSegment || hasOwnerSubdomain;
}

function getCandidateCitations(answer: CollectedAnswer): Array<{ title: string; url: string }> {
  if (answer.evidence?.citationSource === 'native') {
    return answer.citations;
  }
  const seen = new Set<string>();
  const combined: Array<{ title: string; url: string }> = [];
  for (const item of [...answer.citations, ...(answer.sources ?? [])]) {
    const parsed = item ? webUrl(item.url) : undefined;
    if (!parsed || CHROME_OR_POLICY_HOSTS.has(parsed.hostname.toLowerCase())) continue;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    combined.push({ title: item.title || parsed.hostname, url: item.url });
  }
  return combined;
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
  const normalizedText = normInlineWs(answer.text);
  const normalizedQuote = normInlineWs(result.mentionQuote);
  if (result.mentionQuote && !normalizedText.includes(normalizedQuote)) {
    return '模型的提及摘录与回答原文不一致。';
  }
  if (
    result.identity === 'personal_memory' ||
    (normalizedQuote && PERSONAL_MEMORY_CUE.test(normalizedQuote))
  ) {
    if (result.mention !== 'no' || result.identity !== 'personal_memory') {
      return '检测到“你在做的…”等个人记忆提及，不属于陌生用户自然曝光，mention 必须判为 no 且 identity 为 personal_memory。';
    }
  }
  if (result.mention === 'yes' && (!normalizedQuote.trim() ||
      !containsName(normalizedQuote, identity) || result.identity !== 'matched' ||
      (containsExclusion(normalizedQuote, identity) &&
        !containsProjectIdentityCue(normalizedQuote, seed, identity)))) {
    return '确认提及缺少可逐字核实的项目名称与身份依据，或混入已知同名对象。';
  }
  if (result.mention === 'no') {
    if (containsName(answer.text, identity)) {
      if (result.identity === 'unrecognized') {
        // The model judges whether the answer actually recognizes the project.
        // Verify its evidence, without turning name matching into a positive verdict.
        if (!normalizedQuote.trim() || !containsName(normalizedQuote, identity)) {
          return '未识别项目的结论缺少含项目名称的逐字依据。';
        }
      } else if (
        (result.identity !== 'excluded' &&
          result.identity !== 'ambiguous' &&
          result.identity !== 'personal_memory') ||
        !containsName(normalizedQuote, identity)
      ) {
        return '回答出现项目名称或别名，未提供未识别项目、个人记忆或同名排除的依据。';
      } else if (containsProjectIdentityCue(normalizedText.replace(normalizedQuote, ''), seed, identity)) {
        return '摘录之外仍有本项目所有者或官方链接，不能仅凭同名摘录确认未提及。';
      }
    } else if (
      result.identity === 'matched' ||
      (result.identity === 'absent' && Boolean(normalizedQuote.trim())) ||
      (result.identity !== 'absent' && !normalizedQuote.trim()) ||
      containsProjectIdentityCue(normalizedText, seed, identity)
    ) {
      return '未提及结论与名称及身份依据不一致。';
    }
  }
  if (result.mention === 'unknown' && result.identity !== 'ambiguous') {
    return '待核实提及与模型给出的确定身份结论不一致。';
  }
  const candidateCitations = getCandidateCitations(answer);
  const candidateUrls = new Set(candidateCitations.map((c) => c.url));
  const exactOwnedCandidates = candidateCitations
    .map((c) => c.url)
    .filter((url) => belongsToProject(url, seed, identity));
  if (result.citation === 'yes') {
    if (!result.officialUrls.length || result.officialUrls.some((url) =>
      !canClaimProjectUrl(url, candidateUrls, seed, identity))) {
      return '确认引用缺少可核实来源，或链接不属于本项目官网、仓库及已发布自有内容。';
    }
  } else if (result.officialUrls.length) {
    return '尚未确认引用，却返回了已确认自有引用链接。';
  }
  if (result.citation === 'no' && exactOwnedCandidates.length) {
    return '采集到的引用或来源包含本项目自有链接，与未引用结论矛盾。';
  }
  return undefined;
}

function sanitizeRecommendedCompetitors(
  items: ModelResult['recommendedCompetitors'],
  seed: GeoSeed,
  identity: Identity,
): AuditedCompetitor[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const ownNames = new Set(
    [identity.name, ...identity.aliases]
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );
  const seen = new Set<string>();
  const out: AuditedCompetitor[] = [];
  for (const raw of items) {
    const name = raw.name.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (ownNames.has(key) || seen.has(key)) continue;

    let cleanUrl: string | undefined;
    if (raw.url && raw.url.trim()) {
      const parsed = webUrl(raw.url.trim());
      if (
        parsed &&
        !/google\.[a-z.]+\/goto/i.test(parsed.href) &&
        !CHROME_OR_POLICY_HOSTS.has(parsed.hostname.toLowerCase())
      ) {
        const isOwn =
          matchesProjectURL(parsed.href, seed) ||
          identity.publishedUrls.some((pub) => exactAssetUrl(parsed.href, pub));
        if (isOwn) continue;
        cleanUrl = parsed.href;
      }
    }

    seen.add(key);
    out.push(cleanUrl ? { name, url: cleanUrl } : { name });
    if (out.length >= 8) break;
  }
  return out;
}

/** Analyze once after collection. Only persistence errors escape to the caller. */
export async function analyzeResearchObservation(
  batch: ResearchBatch,
  questionId: string,
  observation: ResearchObservation,
  answer?: CollectedAnswer,
  options: { model?: GeoStructuredModel; persist?: (audit: AnswerAuditRecord) => void;
    onValidatedResult?: (result: ModelResult, issue?: string) => void } = {},
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
      !['native', 'unknown', 'none'].includes(answer.evidence.citationSource)) {
    return persist(unresolved('缺少完整回答正文或引用采集记录，不能确认提及或引用。'));
  }
  if (answer.citations.some((citation) => !citation || !webUrl(citation.url) || typeof citation.title !== 'string')) {
    return persist(unresolved('平台原生引用格式不完整，须重新核实。'));
  }

  let audit: AnswerAuditRecord;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempted = false;
  let inference: ChatGPTInferenceMetadata | undefined;
  let validated: { result: ModelResult; issue?: string } | undefined;
  const controller = new AbortController();
  try {
    const parameters = readAgentParameters('answer-evidence-review', parameterSchema);
    const seed = withGeoProject(batch.projectId, getSeed);
    if (seed.project.id !== batch.projectId || ![...batch.questions, ...batch.deferredQuestions].some((question) => question.id === questionId)) {
      audit = unresolved('项目或问题不属于指定批次，未进行审核。', 'failed');
    } else {
      const appliedUrls = loadAppliedDeliverableUrls(batch.projectId);
      const identity = projectIdentity(seed, appliedUrls);
      const candidateCitations = getCandidateCitations(answer).slice(0, 20);
      const observedSourceHints = (answer.sources ?? [])
        .slice(0, 20)
        .map((s) => ({ title: s.title, url: s.url }));
      const messages = [
        { role: 'system' as const, content: readAgentText('answer-evidence-review') },
        { role: 'user' as const, content: JSON.stringify({ project: identity, query: observation.query,
          answer: { text: answer.text,
            nativeCitations: answer.evidence.citationSource === 'native' ? answer.citations : [],
            candidateCitations,
            ...(observedSourceHints.length ? { observedSourceHints } : {}),
            evidence: answer.evidence } }) },
      ];
      const bytes = Buffer.byteLength(JSON.stringify({ messages, schema: z.toJSONSchema(resultSchema) }), 'utf8');
      if (bytes > parameters.inputLimitBytes) {
        audit = unresolved(`审核输入超过 ${parameters.inputLimitBytes} 字节限制；保留完整原文待核实，未截断或调用模型。`);
      } else {
        let model = options.model;
        if (!model) {
          // Only route post-search audits; other Agent operations keep their API model.
          // A failed subscription request must never retry through another provider.
          const subscription = shouldUseChatGPTSubscription(getChatGPTStatus());
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
          validated = { result, issue };
          if (issue) audit = unresolved(issue, 'failed', 'model');
          else {
            const recommendedCompetitors = sanitizeRecommendedCompetitors(
              result.recommendedCompetitors,
              seed,
              identity,
            );
            audit = {
              ...base, reviewedAt: new Date().toISOString(), method: 'model',
              analysisStatus: result.answerComplete && result.mention !== 'unknown' && result.citation !== 'unknown'
                ? 'complete' : 'needs_review',
              mention: result.mention, citation: result.citation,
              mentionEvidence: result.mentionQuote
                ? `${result.mentionEvidence}\n原文：${result.mentionQuote}` : result.mentionEvidence,
              citationEvidence: result.citationEvidence, officialUrls: [...new Set(result.officialUrls)],
              ...(recommendedCompetitors.length ? { recommendedCompetitors } : {}),
              answerComplete: result.answerComplete, limitations: result.limitations,
            };
          }
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
  // Evidence storage failures must surface as write failures, not model failures.
  if (validated) options.onValidatedResult?.(validated.result, validated.issue);
  // Do not turn a failed write into a successful audit response.
  if (inference) {
    audit.analysisModel = inference.model;
    if (inference.reasoningEffort) audit.reasoningEffort = inference.reasoningEffort;
  }
  return persist(audit);
}

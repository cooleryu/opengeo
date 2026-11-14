import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import { readAgentParameters, readAgentText } from './agent-files';
import { loadGeoModel, shouldUseChatGPTSubscription, type GeoStructuredModel } from './connection-settings';
import { singleRequestModel } from './connection-test';
import { getChatGPTStatus } from './chatgpt-auth';
import ChatGPTModel from './chatgpt-model';
import { loadProjectSeed } from './project-data';
import { evidenceLocation, projectDataDirectory, withGeoProject } from './projects';
import { completeProjectOnboarding, getProjectOnboarding, updateProjectOnboarding } from './project-onboarding-store';
import { PublicSourceError, readPublicSource, type PublicSource } from './project-public-source';
import type { OnboardingRecord } from './project-onboarding-types';
import { researchProject, type ProjectResearchSearch } from './project-research';
import { projectResearch } from './project-research-context';
import { availableProjectResearchSearch, searchProjectResearch } from './project-research-search';
import { startOnboardingQuestionGeneration, type QuestionGenerationRuntime } from './store';

const parameterSchema = z.object({
  sourceTimeoutMs: z.number().int().positive(), sourceMaxBytes: z.number().int().positive(),
  totalSourceMaxBytes: z.number().int().positive(), modelSourceMaxBytes: z.number().int().positive(),
  inputLimitBytes: z.number().int().positive(), relatedSourceLimit: z.number().int().min(0).max(2),
  apiTimeoutMs: z.number().int().positive(), subscriptionTimeoutMs: z.number().int().positive(),
  temperature: z.number().min(0).max(2), maxTokens: z.number().int().positive(),
}).strict();
const resultSchema = z.object({
  summary: z.string().trim().min(1).max(240), audience: z.string().trim().min(1).max(200),
  capabilities: z.array(z.string().trim().min(1).max(240)).max(3),
  unknowns: z.array(z.string().trim().min(1).max(260)).max(5),
}).strict();
type Parameters = z.infer<typeof parameterSchema>;
type ReadSource = (url: string, options: { maxBytes: number; timeoutMs: number; accept?: string }) => Promise<PublicSource>;
type ReadDocument = { title: string; url: string; markdown: string; readAt: string; type: string };
export type OnboardingRuntime = { readSource?: ReadSource; model?: GeoStructuredModel; questionGeneration?: QuestionGenerationRuntime | false;
  research?: false | { search?: ProjectResearchSearch | false } };
class UnderstandingError extends Error {}

function documentFromPage(source: PublicSource, fallbackTitle: string): ReadDocument {
  const html = /(?:text\/html|application\/xhtml)/i.test(source.contentType) || /^\s*<!doctype html|^\s*<html[\s>]/i.test(source.text);
  if (!html) {
    if (source.text.trim().length < 80) throw new PublicSourceError('公开页面没有足够正文，无法形成项目理解。');
    return { title: fallbackTitle, url: source.url, markdown: source.text, readAt: source.readAt, type: 'document' };
  }
  const dom = new JSDOM(source.text);
  try {
    const doc = dom.window.document;
    const title = doc.title.trim() || fallbackTitle;
    if (/^(?:just a moment|access denied|attention required|verify you are human|security verification|登录|登入|安全验证|访问验证)/i.test(title) ||
      doc.querySelector('#challenge-form, #cf-challenge-running, .g-recaptcha')) {
      throw new PublicSourceError('网站要求登录或访问验证，未能读取公开正文。');
    }
    // Preserve real navigation links for the discovery step, without executing page code.
    const navigationLinks: string[] = [];
    doc.querySelectorAll('a[href]').forEach(node => {
      try {
        const url = new URL(node.getAttribute('href')!, source.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
        const label = (node.textContent ?? '').trim().slice(0, 160);
        if (!label) return;
        const link = `[${label}](${url.href})`;
        if (node.closest('nav, header, footer') && navigationLinks.length < 20) navigationLinks.push(link);
        node.textContent = link;
      } catch { /* Invalid links cannot be read. */ }
    });
    doc.querySelectorAll('script, style, noscript, svg, iframe, nav, footer, header, form').forEach(node => node.remove());
    const content = doc.querySelector('main, article, [role="main"]') ?? doc.body;
    content.querySelectorAll('p, div, section, h1, h2, h3, h4, li, br, tr').forEach(node => node.append('\n'));
    let markdown = (content.textContent ?? '').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (markdown.length < 120 || (/sign in|log in|登录|登陆|验证码/i.test(title) && markdown.length < 800)) {
      throw new PublicSourceError('页面未提供足够公开正文，可能需要登录或动态加载；请提供可公开阅读的介绍页。');
    }
    if (navigationLinks.length) markdown += '\n\n' + [...new Set(navigationLinks)].join('\n');
    return { title: title.slice(0, 200), url: source.url, markdown, readAt: source.readAt, type: 'website' };
  } finally { dom.window.close(); }
}

function githubRepository(value: string): { owner: string; name: string } | undefined {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname !== 'github.com' || parts.length < 2 || !parts.slice(0, 2).every(part => /^[a-zA-Z0-9_.-]+$/.test(part))) return;
  return { owner: parts[0], name: parts[1].replace(/\.git$/i, '') };
}

function githubReadme(source: PublicSource, repository: { owner: string; name: string }): ReadDocument {
  let raw: unknown;
  try { raw = JSON.parse(source.text); } catch { throw new PublicSourceError('GitHub 未返回可读取的 README。'); }
  const parsed = z.object({ encoding: z.literal('base64'), content: z.string(), html_url: z.string().url(), name: z.string() }).safeParse(raw);
  if (!parsed.success || !/^[A-Za-z0-9+/=\s]+$/.test(parsed.data.content)) throw new PublicSourceError('GitHub 未返回完整的公开 README。');
  const url = new URL(parsed.data.html_url);
  if (url.hostname !== 'github.com' || url.pathname.split('/').slice(1, 3).join('/').toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase()) {
    throw new PublicSourceError('GitHub README 的来源与项目入口不一致。');
  }
  const markdown = Buffer.from(parsed.data.content, 'base64').toString('utf8');
  if (markdown.trim().length < 80) throw new PublicSourceError('README 内容不足，暂时无法形成项目理解。');
  return { title: `${repository.name} · ${parsed.data.name}`, url: url.href, markdown, readAt: source.readAt, type: 'readme' };
}

function relatedDocuments(readme: ReadDocument, limit: number): { title: string; url: string; publicUrl: string }[] {
  const found: { title: string; url: string; publicUrl: string }[] = [];
  const seen = new Set([readme.url]);
  for (const match of readme.markdown.matchAll(/(?<!!)\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g)) {
    if (found.length >= limit) break;
    const [, label, href] = match;
    if (href.startsWith('#')) continue;
    try {
      const url = new URL(href, readme.url);
      if (!/docs?|documentation|guide|tutorial|readme|文档|指南|教程|使用说明|官网|website|homepage/i.test(label) &&
        !/(?:^|\/)(?:docs?|documentation|guides?|tutorials?)(?:\/|$)|(?:^|\/)readme(?:\.[^/]*)?$/i.test(url.pathname)) continue;
      url.hash = '';
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      const publicUrl = url.href;
      const repo = githubRepository(readme.url);
      if (url.hostname === 'github.com') {
        const parts = url.pathname.split('/').filter(Boolean);
        if (!repo || parts[0] !== repo.owner || parts[1] !== repo.name || parts[2] !== 'blob' || parts.length < 5) continue;
        url.hostname = 'raw.githubusercontent.com';
        url.pathname = '/' + [...parts.slice(0, 2), ...parts.slice(3)].join('/');
      }
      seen.add(publicUrl);
      found.push({ title: label.slice(0, 200), url: url.href, publicUrl });
    } catch { /* Malformed links are not evidence. */ }
  }
  return found;
}

async function readDocuments(record: OnboardingRecord, parameters: Parameters, read: ReadSource) {
  let remaining = parameters.totalSourceMaxBytes;
  const readOne = async (url: string, accept?: string) => {
    if (remaining <= 0) throw new PublicSourceError('已达到公开资料总读取大小上限。');
    const source = await read(url, { maxBytes: Math.min(parameters.sourceMaxBytes, remaining), timeoutMs: parameters.sourceTimeoutMs, accept });
    remaining -= Buffer.byteLength(source.text, 'utf8');
    if (remaining < 0) throw new PublicSourceError('公开资料超过总读取大小上限。');
    return source;
  };
  const repository = record.kind === 'repository' ? githubRepository(record.url) : undefined;
  const first = repository
    ? githubReadme(await readOne(`https://api.github.com/repos/${repository.owner}/${repository.name}/readme`, 'application/vnd.github+json'), repository)
    : documentFromPage(await readOne(record.url), new URL(record.url).hostname);
  const documents = [first];
  const limitations: string[] = [];
  if (repository) {
    for (const related of relatedDocuments(first, parameters.relatedSourceLimit)) {
      try {
        const source = await readOne(related.url);
        const document = documentFromPage(source, related.title);
        // A raw GitHub file has a human-readable page; other redirects retain the actual final URL.
        if (source.url === related.url && new URL(source.url).hostname === 'raw.githubusercontent.com') document.url = related.publicUrl;
        documents.push(document);
      } catch (error) {
        limitations.push(`关联文档“${related.title}”未读取：${error instanceof PublicSourceError ? error.message : '读取失败。'}`);
      }
    }
  }
  return { documents, limitations };
}

function modelSources(documents: ReadDocument[], maxBytes: number) {
  // Keep every source represented; the complete source remains in the saved asset.
  const eachLimit = Math.floor(maxBytes / documents.length);
  return documents.map(document => ({ title: document.title, url: document.url, readAt: document.readAt || null,
    excerpt: Buffer.byteLength(document.markdown, 'utf8') > eachLimit,
    ownership: 'ownership' in document ? document.ownership : 'unknown',
    text: Buffer.from(document.markdown, 'utf8').subarray(0, eachLimit).toString('utf8').replace(/\uFFFD$/, '') }));
}

function savedDocuments(record: OnboardingRecord): ReadDocument[] {
  const research = projectResearch(record.projectId);
  if (research?.documents.length) return research.documents;
  const sourceUrls = new Set(record.analysis?.sources?.map(source => source.url));
  const assets = loadProjectSeed(record.projectId).assets.filter(asset => asset.publicUrl && asset.markdown.trim() &&
    (sourceUrls.size ? sourceUrls.has(asset.publicUrl) : asset.sourcePath.startsWith('data/geo-evidence/onboarding-')));
  if (!assets.length) throw new UnderstandingError('已保存的公开正文不足，暂时无法修订；原理解和补充均已保留。');
  return assets.map(asset => {
    let readAt = record.sourceReads?.find(source => source.url === asset.publicUrl)?.readAt ?? '';
    // Older records kept read times in the source bundle, before sourceReads was added.
    if (!readAt) {
      try {
        const location = withGeoProject(record.projectId, () => evidenceLocation(asset.sourcePath));
        const metadata: unknown = JSON.parse(fs.readFileSync(path.join(path.dirname(location.target), 'sources.json'), 'utf8'));
        if (Array.isArray(metadata)) {
          const source = metadata.find(item => item && item.url === asset.publicUrl && typeof item.readAt === 'string');
          if (source) readAt = source.readAt;
        }
      } catch { /* Missing historical read time remains unknown; do not invent a new observation. */ }
    }
    return { title: asset.title, url: asset.publicUrl!, markdown: asset.markdown, type: asset.type, readAt };
  });
}

function researchModel(parameters: Parameters, injected?: GeoStructuredModel): GeoStructuredModel {
  return { generateObject: async input => {
    if (Buffer.byteLength(JSON.stringify({ messages: input.messages, schema: z.toJSONSchema(input.schema) }), 'utf8') > parameters.inputLimitBytes) {
      throw new UnderstandingError('补充调查输入超过材料预算，已保存原文。');
    }
    const controller = new AbortController();
    const subscription = !injected && shouldUseChatGPTSubscription(getChatGPTStatus());
    const timeoutMs = subscription ? parameters.subscriptionTimeoutMs : parameters.apiTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new UnderstandingError('补充调查超时。')); }, timeoutMs);
      });
      const call = async () => {
        const model = injected ?? (subscription ? new ChatGPTModel({ signal: controller.signal, timeoutMs })
          : singleRequestModel(await loadGeoModel(), fetch, controller.signal, timeoutMs));
        return model.generateObject(input);
      };
      return await Promise.race([call(), timeout]);
    } finally { if (timer) clearTimeout(timer); }
  } };
}

const EN_LIMITATIONS: Record<string, string> = {
  '外部搜索未配置，本次仅沿已读资料中的链接补充调查。': 'External search is not configured; discovery followed links from read documents only.',
  '部分补充页面读取失败，已有原文和成功读取的资料均已保留。': 'Some linked pages could not be read; readable public sources were preserved.',
  '模型提出的部分链接不在已读资料或实际搜索结果中，未读取这些链接。': 'Some candidate links were outside verified sources and were skipped.',
  '部分资料较长，关系整理仅使用所提供的正文片段，完整原文已保留。': 'Longer documents were excerpted during relation extraction; full text is preserved.',
  '已达到本次补充资料读取上限，部分链接尚未读取。': 'Reached the supplementary page read limit; analysis covers the pages read so far.',
  '已达到本次补充资料读取上限，结果仅覆盖已读取资料。': 'Reached the supplementary page read limit; analysis covers the pages read so far.',
  '已达到本次补充调查轮数上限，结果仅覆盖已读取资料。': 'Reached the discovery round limit; analysis covers the pages read so far.',
  '部分关系无法对应已提供正文中的逐字依据，已丢弃；关系整理仅部分完成。': 'Some extracted relations lacked verbatim source quotes and were omitted.',
};

function localizeLimitations(limitations: string[], uiLanguage?: 'en' | 'zh'): string[] {
  if (uiLanguage !== 'en') return limitations;
  return limitations.map(item => {
    if (EN_LIMITATIONS[item]) return EN_LIMITATIONS[item];
    const docMatch = item.match(/^关联文档“(.+?)”未读取：/);
    if (docMatch) return `Related document "${docMatch[1]}" could not be read.`;
    return /[\p{Script=Han}]/u.test(item) ? 'Some supplementary checks were partial; readable public sources were preserved.' : item;
  });
}

async function understand(record: OnboardingRecord, documents: ReadDocument[], limitations: string[], parameters: Parameters, model?: GeoStructuredModel) {
  const effectiveLimitations = localizeLimitations(limitations, record.uiLanguage);
  const baseSystem = readAgentText('project-onboarding', 'understand.md');
  const system = record.uiLanguage === 'en'
    ? `${baseSystem}\n\nMANDATORY OUTPUT LANGUAGE: English ("en"). Every field in the JSON response (summary, audience, capabilities, unknowns) MUST be written strictly in concise, natural English (zero Chinese characters). Format each capabilities item as "Short title: one specific sentence".`
    : baseSystem;
  const schema = z.toJSONSchema(resultSchema);
  const makeMessages = (sourceBytes: number) => [{ role: 'system' as const, content: system },
    { role: 'user' as const, content: JSON.stringify({ kind: record.kind, entry: record.url,
      userGoalsAndConstraints: record.notes,
      ...(record.uiLanguage ? { outputLanguage: record.uiLanguage } : {}),
      ...(record.revision ? { priorUnderstanding: record.revision.previousAnalysis,
        userCorrections: [{ id: record.revision.id, feedback: record.revision.feedback }],
        currentRevisionId: record.revision.id } : {}),
      sources: modelSources(documents, sourceBytes), readLimitations: effectiveLimitations }) }];
  const fits = (sourceBytes: number) => Buffer.byteLength(JSON.stringify({ messages: makeMessages(sourceBytes), schema }), 'utf8') <= parameters.inputLimitBytes;
  // Keep current user intent intact and excerpt source text when JSON escaping or a long correction needs more room.
  let sourceBytes = parameters.modelSourceMaxBytes;
  if (!fits(sourceBytes)) {
    let low = 0;
    let high = sourceBytes;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (fits(mid)) low = mid; else high = mid - 1;
    }
    sourceBytes = low;
  }
  if (sourceBytes < documents.length || !fits(sourceBytes)) {
    throw new UnderstandingError('理解输入超过材料预算；资料与补充已保存，未调用模型。请缩短补充后重新提交。');
  }
  const messages = makeMessages(sourceBytes);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempted = false;
  try {
    const subscription = !model && shouldUseChatGPTSubscription(getChatGPTStatus());
    const timeoutMs = subscription ? parameters.subscriptionTimeoutMs : parameters.apiTimeoutMs;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new UnderstandingError('项目理解超时，未自动重试。公开原文已保存。')); }, timeoutMs);
    });
    const run = async () => {
      const selected = model ?? (subscription
        ? new ChatGPTModel({ signal: controller.signal, timeoutMs })
        : singleRequestModel(await loadGeoModel(), fetch, controller.signal, timeoutMs));
      attempted = true;
      const raw = await selected.generateObject({ schema: resultSchema, messages,
        options: { temperature: parameters.temperature, maxTokens: parameters.maxTokens } });
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success) throw new UnderstandingError('模型返回的理解结果格式不完整，未采用结论；公开原文已保存。');
      return parsed.data;
    };
    return await Promise.race([run(), timeout]);
  } catch (error) {
    if (error instanceof UnderstandingError) throw error;
    throw new UnderstandingError(attempted ? '模型理解调用失败，未自动重试；公开原文已保存，可检查分析 Agent 设置后重试。'
      : '分析 Agent 尚未配置或当前不可用；公开原文已保存，请检查设置后重试。');
  } finally { if (timer) clearTimeout(timer); }
}

/** Read and understand once, then continue the authorized question preparation without waiting for it. */
export async function analyzeProjectOnboarding(projectId: string, runtime: OnboardingRuntime = {}): Promise<void> {
  const record = getProjectOnboarding(projectId);
  // Failed jobs require an explicit retry. Reading/polling a record cannot consume feedback again.
  if (!record || record.status !== 'queued') return;
  try {
    const parameters = readAgentParameters('project-onboarding', parameterSchema);
    let documents: ReadDocument[];
    let limitations: string[];
    if (record.revision) {
      documents = savedDocuments(record);
      limitations = record.readLimitations ?? [];
      updateProjectOnboarding(projectId, { status: 'analyzing', message: '正在结合已保存资料与用户补充修订理解。' });
    } else {
      updateProjectOnboarding(projectId, { status: 'reading', message: '正在读取入口和公开资料。' });
      ({ documents, limitations } = await readDocuments(record, parameters, runtime.readSource ?? readPublicSource));
      let remaining = Math.max(0, parameters.totalSourceMaxBytes - documents.reduce((sum, document) => sum + Buffer.byteLength(document.markdown, 'utf8'), 0));
      const configuredSearch = runtime.research && runtime.research.search;
      const research = await researchProject({ projectId, entry: record.url, notes: record.notes, documents, limitations,
        discover: runtime.research !== false, model: researchModel(parameters, runtime.model),
        search: configuredSearch === false ? undefined : configuredSearch ?? (availableProjectResearchSearch() ? searchProjectResearch : undefined),
        readDocument: async url => {
          if (remaining <= 0) throw new PublicSourceError('已达到公开资料总读取大小上限。');
          const source = await (runtime.readSource ?? readPublicSource)(url, {
            maxBytes: Math.min(parameters.sourceMaxBytes, remaining), timeoutMs: parameters.sourceTimeoutMs });
          remaining -= Buffer.byteLength(source.text, 'utf8');
          if (remaining < 0) throw new PublicSourceError('公开资料超过总读取大小上限。');
          return documentFromPage(source, new URL(url).hostname);
        },
        onProgress: message => updateProjectOnboarding(projectId, { status: 'reading', message }),
      });
      documents = research.documents;
      limitations = research.limitations;
      updateProjectOnboarding(projectId, { status: 'analyzing', message: `已保存 ${documents.length} 份公开资料，正在理解项目。`,
        readLimitations: limitations, sourceReads: documents.map(({ title, url, readAt }) => ({ title, url, readAt })) });
    }
    const localizedLimitations = localizeLimitations(limitations, record.uiLanguage);
    const result = await understand(record, documents, localizedLimitations, parameters, runtime.model);
    const analysis: NonNullable<OnboardingRecord['analysis']> = { ...result,
      unknowns: [...new Set([...result.unknowns, ...localizedLimitations])],
      sources: documents.map(document => ({ title: document.title, url: document.url })) };
    completeProjectOnboarding(projectId, analysis, record.revision ? undefined : documents[0].readAt.slice(0, 10));
    // Keep completion and the durable queued job in the same synchronous turn: a status request
    // cannot observe ready before the continuation exists. Question errors belong to that job.
    if (runtime.questionGeneration !== false) {
      try { startOnboardingQuestionGeneration(projectId, runtime.questionGeneration); }
      catch {
        updateProjectOnboarding(projectId, { message: '项目理解已完成，问题准备暂未启动，可以在问题监测中重试。' });
      }
    }
  } catch (error) {
    const message = error instanceof PublicSourceError || error instanceof UnderstandingError
      ? error.message : '项目理解未完成，请重试；已读取的资料会保留。';
    updateProjectOnboarding(projectId, { status: 'failed', message, error: message });
  }
}

const globals = globalThis as typeof globalThis & { __openGeoOnboardingRuns?: Map<string, Promise<void>> };
const runs = globals.__openGeoOnboardingRuns ??= new Map<string, Promise<void>>();

/** Stable across hot reloads. The API starts this promise without waiting for completion. */
export function startProjectOnboarding(projectId: string, runtime: OnboardingRuntime = {}): Promise<void> {
  const existing = runs.get(projectId);
  if (existing) return existing;
  // Defer execution so the guard is installed before any synchronous persistence work.
  const run = Promise.resolve().then(() => analyzeProjectOnboarding(projectId, runtime)).finally(() => runs.delete(projectId));
  runs.set(projectId, run);
  return run;
}

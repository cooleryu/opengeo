import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readAgentText } from './agent-files';
import type { GeoStructuredModel } from './connection-settings';
import type { ProjectResearchDocument, ProjectResearchRelation } from './project-research-types';

const MAX_ROUNDS = 2;
const MAX_READS = 4;
const MAX_DOCUMENT_CHARS = 6000;
const MAX_SOURCE_CHARS = 24000;
const MAX_RELATIONS = 12;

const discoverySchema = z.object({
  readUrls: z.array(z.string().min(1).max(2048)).max(MAX_READS),
  searchQueries: z.array(z.string().trim().min(1).max(300)).max(1),
  done: z.boolean(),
}).strict();
const relationSchema = z.object({
  kind: z.enum(['capability', 'contribution', 'need']),
  statement: z.string().trim().min(1).max(400),
  audience: z.string().trim().min(1).max(200),
  basis: z.enum(['source', 'inferred']),
  evidence: z.array(z.object({ sourceId: z.string().min(1), quote: z.string().min(1).max(1200) }).strict()).min(1).max(3),
}).strict();
const relationsSchema = z.object({ relations: z.array(relationSchema).max(MAX_RELATIONS) }).strict();

type ReadDocument = Pick<ProjectResearchDocument, 'title' | 'url' | 'markdown' | 'readAt' | 'type'>;
type SearchResult = { url: string; title: string };
export type ProjectResearchDiscoveryInput = {
  documents: ProjectResearchDocument[];
  notes: string;
  model: GeoStructuredModel;
  readDocument: (url: string) => Promise<ReadDocument>;
  search?: (query: string) => Promise<SearchResult[]>;
  onProgress?: (message: string) => void;
  /** Persist each successful read before the next model call. Storage failures propagate. */
  onDocument?: (document: ProjectResearchDocument) => void;
};

export function researchDocumentId(url: string, markdown: string): string {
  return `s-${createHash('sha256').update(`${url}\n${markdown}`).digest('hex').slice(0, 20)}`;
}

function normalizedUrl(value: string, base?: string): string | undefined {
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}

function readUrl(publicUrl: string): string {
  const url = new URL(publicUrl);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com' && parts[2] === 'blob' && parts.length >= 5) {
    url.hostname = 'raw.githubusercontent.com';
    url.pathname = `/${[...parts.slice(0, 2), ...parts.slice(3)].join('/')}`;
  }
  return url.href;
}

function sourcesForModel(documents: ProjectResearchDocument[]) {
  // Share the text allowance so a newly read page is represented in the next round.
  const eachLimit = Math.min(MAX_DOCUMENT_CHARS, Math.floor(MAX_SOURCE_CHARS / Math.max(documents.length, 1)));
  return documents.map(document => ({
    id: document.id, title: document.title.slice(0, 200), url: document.url,
    origin: document.origin, ownership: document.ownership ?? 'unknown',
    markdown: document.markdown.slice(0, eachLimit), excerpt: document.markdown.length > eachLimit,
  }));
}

function linkedUrls(markdown: string, base: string): string[] {
  const found = new Set<string>();
  const add = (href: string) => {
    if (href.startsWith('#')) return;
    const url = normalizedUrl(href.replace(/&amp;/g, '&'), base);
    if (url) found.add(url);
  };
  for (const match of markdown.matchAll(/(?<!!)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)) add(match[1] ?? match[2]);
  for (const match of markdown.matchAll(/^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)) add(match[1]);
  for (const match of markdown.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of markdown.matchAll(/https?:\/\/[^\s<>"'\]\)]+/g)) add(match[0].replace(/[.,;!?，。；！？]+$/, ''));
  return [...found];
}

/** Bounded research on actual material; network safety and model selection belong to the caller. */
export async function discoverProjectResearch(input: ProjectResearchDiscoveryInput): Promise<{
  documents: ProjectResearchDocument[]; relations: ProjectResearchRelation[]; limitations: string[];
}> {
  const documents = input.documents.map(document => ({ ...document }));
  const limitations: string[] = [];
  const limit = (message: string) => { if (!limitations.includes(message)) limitations.push(message); };
  const seen = new Set(documents.flatMap(document => {
    const url = normalizedUrl(document.url);
    return url ? [url, readUrl(url)] : [];
  }));
  const searchedUrls = new Map<string, SearchResult>();
  let readAttempts = 0;
  let searchAttempted = false;
  let stopped = false;
  const notes = input.notes.slice(0, 4000);
  if (notes.length < input.notes.length) limit('用户补充较长，本次调查仅使用前 4000 字，原补充不变。');
  if (!input.search) limit('外部搜索未配置，本次仅沿已读资料中的链接补充调查。');

  for (let round = 0; round < MAX_ROUNDS && !stopped; round += 1) {
    const sources = sourcesForModel(documents);
    const allowed = new Map<string, ProjectResearchDocument['origin']>();
    for (const source of sources) {
      for (const url of linkedUrls(source.markdown, source.url)) if (!seen.has(url) && !seen.has(readUrl(url))) allowed.set(url, 'linked');
    }
    for (const url of searchedUrls.keys()) if (!seen.has(url) && !seen.has(readUrl(url))) allowed.set(url, 'external');
    input.onProgress?.('正在查找与项目有关的补充资料。');
    let decision: z.infer<typeof discoverySchema>;
    try {
      const raw = await input.model.generateObject({
        schema: discoverySchema,
        messages: [
          { role: 'system', content: readAgentText('project-onboarding', 'discover.md') },
          { role: 'user', content: JSON.stringify({ sources, userGoalsAndConstraints: notes,
            allowedReadUrls: [...allowed.keys()], searchResults: [...searchedUrls.values()],
            remaining: { rounds: MAX_ROUNDS - round, reads: MAX_READS - readAttempts,
              searches: input.search && !searchAttempted ? 1 : 0 }, limitations }) },
        ], options: { temperature: 0.1, maxTokens: 1200 },
      });
      const parsed = discoverySchema.safeParse(raw);
      if (!parsed.success) { limit('补充调查返回格式不完整，已保留读取资料并继续整理已有依据。'); break; }
      decision = parsed.data;
    } catch {
      limit('补充调查调用失败，已保留读取资料并继续整理已有依据。');
      break;
    }

    // A search only makes its actual results available to the next model decision.
    if (decision.searchQueries.length) {
      if (!input.search) limit('外部搜索未配置，本次仅沿已读资料中的链接补充调查。');
      else if (searchAttempted) limit('已达到本次外部搜索次数上限，未执行额外搜索。');
      else {
        searchAttempted = true;
        input.onProgress?.('正在搜索补充资料。');
        try {
          const results = await input.search(decision.searchQueries[0]);
          for (const result of results) {
            const url = normalizedUrl(result.url);
            if (url) searchedUrls.set(url, { url, title: result.title.slice(0, 200) });
          }
          if (!searchedUrls.size) limit('外部搜索未返回可读取的链接，未补充外部正文。');
        } catch { limit('外部搜索失败，已保留读取资料。'); }
      }
    }

    for (const requested of decision.readUrls) {
      const publicUrl = normalizedUrl(requested);
      if (!publicUrl || !allowed.has(publicUrl)) {
        limit('模型提出的部分链接不在已读资料或实际搜索结果中，未读取这些链接。');
        continue;
      }
      const target = readUrl(publicUrl);
      if (seen.has(publicUrl) || seen.has(target)) continue;
      if (readAttempts >= MAX_READS) { limit('已达到本次补充资料读取上限，部分链接尚未读取。'); break; }
      readAttempts += 1;
      seen.add(publicUrl);
      seen.add(target);
      input.onProgress?.('正在读取补充资料。');
      let document: ProjectResearchDocument;
      try {
        const source = await input.readDocument(target);
        if (!source.markdown.trim()) throw new Error();
        const sourceUrl = normalizedUrl(source.url);
        if (!sourceUrl) throw new Error();
        // Keep the human-readable GitHub location when its raw file did not redirect.
        const url = target !== publicUrl && sourceUrl === target ? publicUrl : sourceUrl;
        document = { ...source, url, id: researchDocumentId(url, source.markdown),
          origin: allowed.get(publicUrl)!, sourcePath: '' };
      } catch {
        limit('部分补充页面读取失败，已有原文和成功读取的资料均已保留。');
        continue;
      }
      // Deliberately outside the read failure handler: persistence must not fail silently.
      input.onDocument?.(document);
      documents.push(document);
      const finalUrl = normalizedUrl(document.url)!;
      seen.add(finalUrl);
      seen.add(readUrl(finalUrl));
    }
    if (!decision.done && readAttempts >= MAX_READS) limit('已达到本次补充资料读取上限，结果仅覆盖已读取资料。');
    stopped = decision.done || readAttempts >= MAX_READS;
    if (!stopped && round === MAX_ROUNDS - 1) limit('已达到本次补充调查轮数上限，结果仅覆盖已读取资料。');
    if (decision.searchQueries.length && (stopped || round === MAX_ROUNDS - 1) &&
        [...searchedUrls.keys()].some(url => !seen.has(url) && !seen.has(readUrl(url)))) {
      limit('部分搜索结果尚未读取正文，未作为关系结论的证据。');
    }
  }

  input.onProgress?.('正在整理产品能力、已有贡献与用户需求的关系。');
  const sources = sourcesForModel(documents);
  if (sources.some(source => source.excerpt)) limit('部分资料较长，关系整理仅使用所提供的正文片段，完整原文已保留。');
  const sourceText = new Map(sources.map(source => [source.id, source.markdown]));
  const relations: ProjectResearchRelation[] = [];
  try {
    const raw = await input.model.generateObject({
      schema: relationsSchema,
      messages: [
        { role: 'system', content: readAgentText('project-onboarding', 'relations.md') },
        { role: 'user', content: JSON.stringify({ sources, userGoalsAndConstraints: notes, limitations }) },
      ], options: { temperature: 0.1, maxTokens: 4200 },
    });
    // Validate relations separately so one unsupported claim does not discard valid ones.
    const envelope = z.object({ relations: z.array(z.unknown()) }).strict().safeParse(raw);
    if (!envelope.success) limit('关系整理返回格式不完整，未采用结论；读取资料已保留。');
    else {
      if (envelope.data.relations.length > MAX_RELATIONS) limit('关系结论超过本次上限，仅核对前 12 条。');
      for (const candidate of envelope.data.relations.slice(0, MAX_RELATIONS)) {
        const parsed = relationSchema.safeParse(candidate);
        if (!parsed.success || !parsed.data.evidence.every(item =>
          item.quote.trim().length > 0 && sourceText.get(item.sourceId)?.includes(item.quote))) {
          limit('部分关系无法对应已提供正文中的逐字依据，已丢弃；关系整理仅部分完成。');
          continue;
        }
        const relation = parsed.data;
        const id = `r-${createHash('sha256').update(JSON.stringify(relation)).digest('hex').slice(0, 20)}`;
        if (!relations.some(item => item.id === id)) relations.push({ id, ...relation });
      }
    }
  } catch { limit('关系整理调用失败，未生成关系结论；读取资料已保留。'); }
  return { documents, relations, limitations };
}

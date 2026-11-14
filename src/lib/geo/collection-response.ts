import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { GeoQuestion, GeoRun } from './types';
import type { CollectionTask } from './collection-runtime';
import { getSeed } from './seed';
import { matchesQuestionTarget } from './search-protocol';
import { parseDoubaoAnswer } from './providers/doubao';
import { parseQwenAnswer } from './providers/qwen';

export const collectionQuestionFile = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : createHash('sha256').update(id).digest('hex');

/** Publish only complete files, without replacing immutable evidence. */
function writeCompleteFile(file: string, value: string): void {
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== value) throw new Error('已保存的采集证据不一致，未覆盖原记录。');
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { flag: 'wx' });
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== value) throw error;
    }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function writeCollectionRequest(file: string, request: Record<string, unknown>): string {
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const { at: _savedAt, ...savedInput } = saved;
    const { at: _at, ...input } = request;
    if (!isDeepStrictEqual(savedInput, input)) throw new Error('待发送请求与原采集条件不一致，未发送。');
    return saved.at;
  }
  writeCompleteFile(file, JSON.stringify(request, null, 2));
  return request.at as string;
}

export interface SavedCollectionResponse {
  questionId: string;
  query: string;
  protocolKey?: string;
  measuredAt: string;
  httpStatus: number;
  raw: string;
}

/** The response envelope is sufficient to rebuild the raw file after a crash. */
export function saveCollectionResponse(directory: string, response: SavedCollectionResponse): void {
  const name = collectionQuestionFile(response.questionId);
  writeCompleteFile(path.join(directory, `${name}.response.json`), JSON.stringify(response));
  writeCompleteFile(path.join(directory, `${name}.json`), response.raw);
}

export function saveCollectionSummary(directory: string, run: GeoRun): void {
  const file = path.join(directory, 'run.json');
  // A complete summary may precede a crash during the subsequent analysis.
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as GeoRun;
    if (saved.id !== run.id || saved.protocolKey !== run.protocolKey) throw new Error('已保存的采集汇总不属于本次运行。');
    return;
  }
  writeCompleteFile(file, JSON.stringify(run, null, 2));
}

export function readCollectionResponse(directory: string, question: GeoQuestion, protocolKey?: string): SavedCollectionResponse | null {
  const file = path.join(directory, `${collectionQuestionFile(question.id)}.response.json`);
  if (!fs.existsSync(file)) return null;
  const response = JSON.parse(fs.readFileSync(file, 'utf8')) as SavedCollectionResponse;
  if (response.questionId !== question.id || response.query !== question.query || response.protocolKey !== protocolKey
    || !Number.isInteger(response.httpStatus) || !Number.isFinite(Date.parse(response.measuredAt)) || typeof response.raw !== 'string') {
    throw new Error('保存的返回与本次请求条件不一致。');
  }
  writeCompleteFile(path.join(directory, `${collectionQuestionFile(question.id)}.json`), response.raw);
  return response;
}

/** Shared parsing keeps recovery equivalent to the original provider execution. */
export function questionFromCollectionResponse(task: CollectionTask, runId: string, question: GeoQuestion,
  response: SavedCollectionResponse): GeoQuestion {
  if (response.httpStatus < 200 || response.httpStatus >= 300) throw new Error(`HTTP ${response.httpStatus}`);
  const collection = task.workflow!.collection!;
  const target = task.workflow!.questions.find(item => item.id === question.id);
  const seed = getSeed();
  const evidencePath = `data/geo-evidence/${runId}/${collectionQuestionFile(question.id)}.json`;
  if (collection.provider === 'deepseek') {
    const parsed = JSON.parse(response.raw) as { results?: unknown };
    if (!Array.isArray(parsed.results)) throw new Error('返回缺少 results，不能记作零命中。');
    if (parsed.results.some(result => !result || typeof result !== 'object' || typeof result.url !== 'string')) throw new Error('搜索结果条目缺少有效 URL。');
    const results = parsed.results as { url: string; title?: string }[];
    const firstHit = results.findIndex(result => matchesQuestionTarget(result.url, target, seed));
    return { ...question, measurementAt: response.measuredAt, provider: 'DeepSeek Search API', resultCount: results.length,
      projectHit: firstHit >= 0, rank: firstHit >= 0 ? firstHit + 1 : null, aiCited: null, evidencePath,
      topSources: results.slice(0, 3).map((source, index) => {
        let domain = ''; try { domain = new URL(source.url).hostname; } catch { /* Preserve raw malformed links. */ }
        return { position: index + 1, title: source.title || domain || '未提供标题', url: source.url, domain,
          isHomonym: /2609\.38260/i.test(`${source.url} ${source.title || ''}`) };
      }) };
  }
  const answer = collection.provider === 'doubao' ? parseDoubaoAnswer(JSON.parse(response.raw)) : parseQwenAnswer(JSON.parse(response.raw));
  if (!answer.searchPerformed) throw new Error('没有取得有效联网搜索证据，不能记作零引用。');
  const cited = answer.citations.some(source => matchesQuestionTarget(source.url, target, seed));
  return { ...question, providerId: collection.provider, provider: collection.label, measurementAt: response.measuredAt,
    answer, resultCount: answer.sources.length, projectHit: cited, rank: null, aiCited: cited, evidencePath,
    topSources: answer.sources.slice(0, 3).map((source, index) => ({ position: index + 1, title: source.title,
      url: source.url, domain: new URL(source.url).hostname, isHomonym: /2609\.38260/i.test(`${source.url} ${source.title}`) })) };
}

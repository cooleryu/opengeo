import fs from 'node:fs';
import path from 'node:path';
import { getSeed } from './seed';
import { evidenceLocation } from './projects';
import { getCollectionConfig } from './providers/config';
import { matchesProjectURL } from './search-protocol';
import type { ResearchObservation } from './research-types';
import type { GeoQuestion } from './types';

/** Preserve all returned web results, or native answer citations, at acquisition time. */
export function observationFromResult(result: GeoQuestion, runId: string, provider: 'deepseek' | 'qwen' | 'doubao'): ResearchObservation {
  const seed = getSeed();
  const language = result.language.startsWith('zh') ? 'zh' : 'en';
  const { target, root } = evidenceLocation(result.evidencePath);
  const actual = fs.realpathSync(target);
  if (!actual.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('搜索记录路径不属于当前项目。');
  let sources: ResearchObservation['sources'];
  let answerPath: string | undefined;
  let searchConditions = '参数见原始采集记录';
  if (provider === 'deepseek') {
    const raw = JSON.parse(fs.readFileSync(actual, 'utf8'));
    if (!Array.isArray(raw.results)) throw new Error('原始搜索记录缺少结果列表，不能计作零命中。');
    const requestFile = actual.replace(/\.json$/, '.request.json');
    if (fs.existsSync(requestFile)) {
      const payload = JSON.parse(fs.readFileSync(requestFile, 'utf8')).payload;
      if (payload && typeof payload.count === 'number' && typeof payload.need_content === 'boolean') searchConditions = `count=${payload.count} · need_content=${payload.need_content}`;
    }
    sources = raw.results.map((item: { url: string; title?: string }, index: number) => ({
      url: item.url, title: item.title || item.url, position: index + 1,
      kind: matchesProjectURL(item.url, seed) ? 'official' : 'other',
    }));
  } else {
    if (!result.answer?.searchPerformed) throw new Error('回答缺少有效联网记录，不能计作零命中。');
    sources = [...new Map(result.answer.citations.map(citation => [citation.url, citation])).values()].map(citation => ({
      url: citation.url, title: citation.title || result.answer!.sources.find(source => source.url === citation.url)?.title || citation.url,
      kind: matchesProjectURL(citation.url, seed) ? 'official' : 'other',
    }));
    answerPath = result.evidencePath.replace(/\.json$/, '.answer.md');
    const answerFile = evidenceLocation(answerPath).target;
    if (!fs.existsSync(answerFile)) fs.writeFileSync(answerFile, result.answer.text, { flag: 'wx' });
  }
  const found = sources.some(source => source.kind === 'official');
  return {
    id: `${runId}:${result.id}:${language}:${provider}`, runId, engine: provider, language,
    query: result.query, recordedAt: result.measurementAt, collectedAt: result.measurementAt,
    entryType: provider === 'deepseek' ? 'api_search' : 'api_answer',
    status: found ? 'found' : 'not_observed', sources, evidencePath: result.evidencePath,
    ...(answerPath ? { answerPath } : {}),
    summary: provider === 'deepseek'
      ? `返回 ${sources.length} 条网页结果，${found ? '包含本项目官方页面' : '本次未发现本项目官方页面'}。`
      : result.answer!.text.slice(0, 260),
    conditions: provider === 'deepseek'
      ? `DeepSeek Search API · ${searchConditions} · 非消费端 AI 回答；地区未指定。`
      : `${getCollectionConfig(provider).label} · ${result.answer?.model || getCollectionConfig(provider).model} · 强制联网；仅统计回答原生引用，非消费端观测。`,
  };
}

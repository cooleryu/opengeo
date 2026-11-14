import { collectionKey, collectionReservation, getCollectionConfig } from './providers/config';

export type ProjectResearchSearchResult = {
  results: { url: string; title: string }[];
  confirmedCostCny: number | null;
  /** Only unresolved charges remain reserved; confirmed outcomes release the reservation. */
  reservedCostCny: number;
  error?: string;
};

export function availableProjectResearchSearch(): boolean {
  try { return Boolean(collectionKey('deepseek').trim()); }
  catch { return false; }
}

function unbilled(error?: string): ProjectResearchSearchResult {
  return { results: [], confirmedCostCny: 0, reservedCostCny: 0, ...(error ? { error } : {}) };
}

/** One public-search request; the caller owns authorization, reservation persistence and the run limit. */
export async function searchProjectResearch(query: string): Promise<ProjectResearchSearchResult> {
  if (!query.trim() || [...query].length > 128) {
    return unbilled('补充搜索词为空或超过 128 个字符，未发送请求。');
  }
  let key: string;
  let config: ReturnType<typeof getCollectionConfig>;
  let reserve: number;
  try {
    key = collectionKey('deepseek');
    config = getCollectionConfig('deepseek');
    reserve = collectionReservation('deepseek');
    if (!key.trim()) return unbilled('外部搜索未配置，未发送请求。');
  } catch { return unbilled('无法读取外部搜索配置，未发送请求。'); }

  const uncertain = (error: string): ProjectResearchSearchResult => ({
    results: [], confirmedCostCny: null, reservedCostCny: reserve, error,
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProjectResearchSearchResult>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(uncertain('补充搜索超时，费用尚未确认，未自动重试。'));
    }, 30000);
  });
  try {
    return await Promise.race([timeout, (async (): Promise<ProjectResearchSearchResult> => {
      const response = await fetch(config.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        // Research only needs a small URL list; full pages are read separately and preserved.
        body: JSON.stringify({ ...config.parameters, query, count: 10, need_content: false }),
      });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        return unbilled('补充搜索接口返回失败，本次未取得搜索结果。');
      }
      let raw: unknown;
      try { raw = await response.json(); }
      catch { return uncertain('补充搜索响应无法解析，费用尚未确认。'); }
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results)) {
        return uncertain('补充搜索响应缺少有效结果列表，费用尚未确认。');
      }
      const returned = (raw as { results: unknown[] }).results;
      if (!returned.length) return unbilled();
      const results: ProjectResearchSearchResult['results'] = [];
      for (const item of returned) {
        if (!item || typeof item !== 'object' || typeof (item as { url?: unknown }).url !== 'string') {
          return uncertain('补充搜索结果格式不完整，未采用这些结果，费用尚未确认。');
        }
        const candidate = item as { url: string; title?: unknown };
        let url: URL;
        try { url = new URL(candidate.url); }
        catch { return uncertain('补充搜索包含无效链接，未采用这些结果，费用尚未确认。'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || candidate.url.length > 2048) {
          return uncertain('补充搜索包含无效链接，未采用这些结果，费用尚未确认。');
        }
        if (results.length < 10 && !results.some(result => result.url === candidate.url)) {
          results.push({ url: candidate.url, title: typeof candidate.title === 'string' ? candidate.title.slice(0, 200) : candidate.url });
        }
      }
      return { results, confirmedCostCny: reserve, reservedCostCny: 0 };
    })()]);
  } catch {
    return uncertain(controller.signal.aborted
      ? '补充搜索超时，费用尚未确认，未自动重试。'
      : '补充搜索请求中断，费用尚未确认，未自动重试。');
  } finally { if (timer) clearTimeout(timer); }
}

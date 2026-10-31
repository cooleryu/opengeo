import type {
  AnswerCitation,
  AnswerRequest,
  AnswerSource,
  CollectedAnswer,
  CollectionConfig,
} from './types';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** DashScope preserves search sources and native citation markers; Chat Completions does not. */
export function buildQwenRequest(
  query: string,
  config: CollectionConfig,
  apiKey: string,
): AnswerRequest {
  if (config.provider !== 'qwen' || !config.model || !query.trim() || !apiKey.trim()) {
    throw new Error('千问联网回答缺少有效的问题、模型或 API Key。');
  }
  const endpoint = new URL(config.endpoint);
  const allowedHost = endpoint.hostname === 'dashscope.aliyuncs.com' ||
    /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(endpoint.hostname);
  if (!allowedHost || endpoint.protocol !== 'https:' || endpoint.username ||
      endpoint.password || endpoint.port || endpoint.search || endpoint.hash ||
      endpoint.pathname !== '/api/v1/services/aigc/text-generation/generation') {
    throw new Error('千问联网回答需要北京地域的 DashScope 文本生成接口。');
  }
  const searchOptions = object(config.parameters.search_options);
  if (config.parameters.enable_search !== true ||
      config.parameters.result_format !== 'message' ||
      searchOptions.forced_search !== true || searchOptions.enable_source !== true ||
      searchOptions.enable_citation !== true ||
      searchOptions.citation_format !== '[ref_<number>]') {
    throw new Error('千问采样协议必须启用联网搜索、搜索来源和引用角标。');
  }
  return {
    url: endpoint.href,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: {
      model: config.model,
      input: { messages: [{ role: 'user', content: query }] },
      parameters: config.parameters,
    },
  };
}

/** Official schema: https://help.aliyun.com/zh/model-studio/web-search/ */
export function parseQwenAnswer(raw: unknown): CollectedAnswer {
  const response = object(raw);
  if ((typeof response.code === 'string' && response.code) ||
      (typeof response.status_code === 'number' && response.status_code !== 200)) {
    throw new Error(`千问联网回答失败（${String(response.code || response.status_code)}）。`);
  }
  const output = object(response.output);
  const choices = Array.isArray(output.choices) ? output.choices : [];
  const choice = object(choices[0]);
  const message = object(choice.message);
  if (choice.finish_reason !== 'stop') {
    throw new Error('千问回答未正常完成或已被截断，本次不能作为有效观测。');
  }
  if (typeof message.content !== 'string' || !message.content.trim() ||
      (typeof message.refusal === 'string' && message.refusal.trim())) {
    throw new Error('千问没有返回完整的回答正文。');
  }
  const text = message.content;
  const searchInfo = object(output.search_info);
  const results = Array.isArray(searchInfo.search_results) ? searchInfo.search_results : [];
  const sources: AnswerSource[] = [];
  const sourceUrls = new Set<string>();
  const indexedSources = new Map<number, AnswerSource | null>();
  for (const value of results) {
    const result = object(value);
    const url = webUrl(result.url);
    if (!url) continue;
    const source: AnswerSource = {
      url,
      title: typeof result.title === 'string' && result.title.trim() ? result.title : url,
      ...(typeof result.snippet === 'string' ? { snippet: result.snippet } : {}),
      ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
    };
    if (!sourceUrls.has(url)) {
      sourceUrls.add(url);
      sources.push(source);
    }
    const index = tokenCount(result.index);
    if (index === undefined || index < 1) continue;
    // Conflicting URLs for one marker are ambiguous, so neither becomes a citation.
    if (!indexedSources.has(index)) indexedSources.set(index, source);
    else if (indexedSources.get(index)?.url !== url) indexedSources.set(index, null);
  }
  const citations: AnswerCitation[] = [];
  let citationsComplete = Array.isArray(searchInfo.search_results);
  for (const match of text.matchAll(/\[ref_(\d+)\]/g)) {
    const source = indexedSources.get(Number(match[1]));
    if (!source) { citationsComplete = false; continue; }
    citations.push({
      url: source.url,
      title: source.title,
      startIndex: match.index,
      endIndex: match.index! + match[0].length,
    });
  }
  const usage = object(response.usage);
  if (/\[ref_/i.test(text.replace(/\[ref_\d+\]/g, ''))) citationsComplete = false;
  const searchUsage = object(object(usage.plugins).search);
  return {
    text,
    evidence: { answerComplete: true, citationsComplete, citationSource: 'native' },
    citations,
    sources,
    // A search count is set at intent detection, even when search is skipped or limited.
    // Require returned web evidence before admitting this as a searched observation.
    searchPerformed: sources.length > 0,
    usage: {
      inputTokens: tokenCount(usage.input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      // Provider-reported attempts, not completed searches or billable usage.
      searchCalls: tokenCount(searchUsage.count),
    },
    responseId: typeof response.request_id === 'string' ? response.request_id : undefined,
    model: typeof response.model === 'string' ? response.model : undefined,
  };
}

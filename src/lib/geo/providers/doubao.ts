import type {
  AnswerCitation,
  AnswerRequest,
  AnswerSource,
  CollectedAnswer,
  CollectionConfig,
} from './types';

// Ark's content plugin, not the separately billed Doubao Search Custom route.
// https://docs.volcengine.com/docs/ark/web-search?lang=en
// https://docs.volcengine.com/docs/ark/create-model-responses-api?lang=zh
export function buildDoubaoRequest(
  query: string,
  config: CollectionConfig,
  apiKey: string,
): AnswerRequest {
  if (config.provider !== 'doubao' || config.endpoint !== 'https://ark.cn-beijing.volces.com/api/v3/responses') {
    throw new Error('豆包联网回答仅使用官方北京方舟 Responses 接口。');
  }
  if (!query.trim()) throw new Error('豆包联网回答的问题不能为空。');
  if (!apiKey.trim()) throw new Error('缺少方舟 API Key。');

  const body: Record<string, unknown> = {
    thinking: { type: 'disabled' },
    max_output_tokens: 1600,
    // The provider describes this as a best-effort round limit, not a hard cost cap.
    max_tool_calls: 1,
    tool_choice: { type: 'web_search' },
    tools: [
      {
        type: 'web_search',
        sources: ['search_engine'],
        limit: 10,
        max_keyword: 1,
      },
    ],
    store: false,
    ...config.parameters,
    model: config.model || 'doubao-seed-2-0-lite-260428',
    input: query,
    stream: false,
  };

  const webTools = Array.isArray(body.tools) ? body.tools.map(record) : [];
  if (
    webTools.length !== 1 ||
    webTools[0].type !== 'web_search' ||
    !Array.isArray(webTools[0].sources) ||
    webTools[0].sources.length !== 1 ||
    webTools[0].sources[0] !== 'search_engine'
  ) {
    throw new Error('豆包采样仅使用方舟联网内容插件的 search_engine 来源。');
  }

  return {
    url: config.endpoint,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function webUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Only provider annotations are citations; URLs in generated prose are not. */
export function parseDoubaoAnswer(raw: unknown): CollectedAnswer {
  const response = record(raw);
  if (response.error) throw new Error('豆包返回了接口错误，原始响应已保留。');
  if (response.status !== 'completed' || response.incomplete_details) {
    throw new Error('豆包回答未完整结束，不能作为成功的联网观测。');
  }
  if (!Array.isArray(response.output)) {
    throw new Error('豆包响应缺少回答内容。');
  }

  const citations: AnswerCitation[] = [];
  const sources = new Map<string, AnswerSource>();
  const citationKeys = new Set<string>();
  const texts: string[] = [];
  let completedSearchCalls = 0;
  let textLength = 0;
  let citationsComplete = true;

  for (const value of response.output) {
    const item = record(value);
    if (item.type === 'web_search_call') {
      if (item.status !== 'completed') {
        throw new Error('豆包联网搜索未完成，不能记为有效观测。');
      }
      completedSearchCalls += 1;
      continue;
    }
    if (item.type !== 'message') continue;
    if (item.role !== 'assistant' || item.status !== 'completed' || item.partial === true) {
      throw new Error('豆包回答包含未完成的消息。');
    }
    if (!Array.isArray(item.content)) throw new Error('豆包回答内容格式不完整。');

    for (const partValue of item.content) {
      const part = record(partValue);
      if (part.type !== 'output_text') continue;
      if (typeof part.text !== 'string') throw new Error('豆包回答缺少文本。');
      const offset = textLength + (texts.length > 0 ? 1 : 0);
      texts.push(part.text);
      textLength = offset + part.text.length;

      if (!Array.isArray(part.annotations)) citationsComplete = false;
      for (const annotationValue of Array.isArray(part.annotations) ? part.annotations : []) {
        const annotation = record(annotationValue);
        if (annotation.type !== 'url_citation') { citationsComplete = false; continue; }
        const url = webUrl(annotation.url);
        if (!url) { citationsComplete = false; continue; }
        const title = typeof annotation.title === 'string' ? annotation.title : url;
        const start = nonnegativeInteger(annotation.start_index);
        const end = nonnegativeInteger(annotation.end_index);
        const citation: AnswerCitation = { url, title };
        if (start !== undefined && end !== undefined && end >= start && end <= part.text.length) {
          citation.startIndex = offset + start;
          citation.endIndex = offset + end;
        }
        const key = JSON.stringify([url, citation.startIndex, citation.endIndex]);
        if (!citationKeys.has(key)) {
          citations.push(citation);
          citationKeys.add(key);
        }
        // Ark exposes cited-source metadata, not a complete ranked search result list.
        sources.set(url, {
          url,
          title,
          ...(typeof annotation.summary === 'string' ? { summary: annotation.summary } : {}),
        });
      }
    }
  }

  const text = texts.join('\n');
  if (!text.trim()) throw new Error('豆包没有返回完整的回答正文。');
  const usage = record(response.usage);
  const toolUsage = record(usage.tool_usage);
  return {
    text,
    evidence: { answerComplete: true, citationsComplete, citationSource: 'native' },
    citations,
    sources: [...sources.values()],
    searchPerformed: completedSearchCalls > 0,
    usage: {
      inputTokens: nonnegativeInteger(usage.input_tokens),
      outputTokens: nonnegativeInteger(usage.output_tokens),
      searchCalls: nonnegativeInteger(toolUsage.web_search) ?? completedSearchCalls,
    },
    responseId: typeof response.id === 'string' ? response.id : undefined,
    model: typeof response.model === 'string' ? response.model : undefined,
  };
}

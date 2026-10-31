import { getGeoSearchConnection } from '../connection-settings';
import type { CollectionConfig, CollectionProvider, CollectionProviderStatus } from './types';

export function collectionProvider(value: unknown): CollectionProvider {
  if (value === undefined || value === 'deepseek') return 'deepseek';
  if (value === 'doubao' || value === 'qwen') return value;
  throw new Error('请选择 DeepSeek、豆包或千问观测入口。');
}

export function collectionKey(provider: CollectionProvider): string {
  return getGeoSearchConnection(provider).apiKey;
}

export function getCollectionConfig(provider: CollectionProvider = 'deepseek'): CollectionConfig {
  if (provider === 'doubao') return {
    provider, label: '豆包联网回答 API', endpoint: 'https://ark.cn-beijing.volces.com/api/v3/responses',
    model: getGeoSearchConnection(provider).model!, metric: 'answer_target_citation',
    parameters: { tools: [{ type: 'web_search', sources: ['search_engine'], limit: 10, max_keyword: 1 }],
      tool_choice: { type: 'web_search' }, max_tool_calls: 1, thinking: { type: 'disabled' }, max_output_tokens: 2048, stream: false },
  };
  if (provider === 'qwen') return {
    provider, label: '千问联网回答 API', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    model: getGeoSearchConnection(provider).model!, metric: 'answer_target_citation',
    parameters: { result_format: 'message', enable_search: true, enable_thinking: false, max_tokens: 2048,
      search_options: { forced_search: true, enable_source: true, enable_citation: true, citation_format: '[ref_<number>]', search_strategy: 'turbo' } },
  };
  return { provider, label: 'DeepSeek Search API', endpoint: 'https://api.deepseek.com/v1/tools/search',
    parameters: { count: 50, need_content: true }, metric: 'web_target_hit' };
}

// Answer providers bill tokens and tool usage separately. This is a reservation,
// not a provider bill or a guaranteed per-request spending cap.
export function collectionReservation(provider: CollectionProvider): number { return provider === 'deepseek' ? 0.005 : 0.1; }

export function collectionStatuses(): CollectionProviderStatus[] {
  return (['deepseek', 'doubao', 'qwen'] as const).map(id => ({
    id, label: getCollectionConfig(id).label, configured: Boolean(collectionKey(id)),
    missing: collectionKey(id) ? [] : [id === 'doubao' ? 'ARK_API_KEY' : id === 'qwen' ? 'DASHSCOPE_API_KEY' : 'DEEPSEEK_API_KEY'],
    model: getCollectionConfig(id).model || null,
    costNote: id === 'deepseek' ? '成功且有结果的搜索每题 ¥0.005；诊断模型另计。'
      : '每题预留 ¥0.10；联网搜索和模型生成分别计费，实际以供应商账单为准，诊断模型另计。',
  }));
}

export function requireCollectionKey(provider: CollectionProvider): string {
  const key = collectionKey(provider);
  if (!key) throw new Error(`尚未配置 ${collectionStatuses().find(item => item.id === provider)!.missing.join('、')}，未发送请求。`);
  return key;
}

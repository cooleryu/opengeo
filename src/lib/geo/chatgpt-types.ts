/** Public metadata only. Never add OAuth tokens or authorization codes here. */
export const CHATGPT_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ChatGPTReasoningEffort = typeof CHATGPT_REASONING_EFFORTS[number];
export const CHATGPT_REASONING_LABELS: Record<ChatGPTReasoningEffort, string> = {
  none: '关闭 · None', minimal: '最少 · Minimal', low: '低 · Low', medium: '中 · Medium',
  high: '高 · High', xhigh: '很高 · XHigh', max: '最高 · Max',
};
export function isChatGPTReasoningEffort(value: unknown): value is ChatGPTReasoningEffort {
  return typeof value === 'string' && (CHATGPT_REASONING_EFFORTS as readonly string[]).includes(value);
}

export type ChatGPTStatus = {
  connected: boolean;
  planEnabled: boolean;
  enabled: boolean;
  model: string;
  reasoningEffort?: ChatGPTReasoningEffort;
  accountLabel: string;
  pending: boolean;
  error?: string;
};

export type ChatGPTModel = { id: string; name: string; reasoningEfforts?: ChatGPTReasoningEffort[]; defaultReasoningEffort?: ChatGPTReasoningEffort };

export const CHATGPT_PENDING_COOKIE = 'opengeo_chatgpt_pending';
export const CHATGPT_SESSION_COOKIE = 'opengeo_chatgpt_session';

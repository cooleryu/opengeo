/**
 * Model providers as plain data (safe to import in client components).
 * Talking to each provider is done by the Vercel AI SDK packages; model names come from
 * the provider at runtime, so nothing here lists models beyond one starter default.
 */
export const MODEL_PROVIDER_IDS = ['deepseek', 'openai', 'anthropic', 'gemini', 'openrouter', 'custom'] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export type ModelProviderInfo = {
  label: string;
  /** Official API endpoint. Empty for "custom", where the user supplies one. */
  baseURL: string;
  /** Starter model shown before the live list loads; any model name the provider accepts works. */
  defaultModel?: string;
  /** Environment variable read when no key is saved in Settings. */
  envKey?: string;
  hosts: string[];
};

export const MODEL_PROVIDERS: Record<ModelProviderId, ModelProviderInfo> = {
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-flash', envKey: 'DEEPSEEK_API_KEY', hosts: ['api.deepseek.com'] },
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', hosts: ['api.openai.com'] },
  anthropic: { label: 'Anthropic Claude', baseURL: 'https://api.anthropic.com/v1', envKey: 'ANTHROPIC_API_KEY', hosts: ['api.anthropic.com'] },
  gemini: { label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-3.8-flash', envKey: 'GEMINI_API_KEY', hosts: ['generativelanguage.googleapis.com'] },
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', hosts: ['openrouter.ai'] },
  custom: { label: 'OpenAI-compatible', baseURL: '', hosts: [] },
};

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return typeof value === 'string' && (MODEL_PROVIDER_IDS as readonly string[]).includes(value);
}

export function inferModelProvider(baseURL: string): ModelProviderId {
  try {
    const hostname = new URL(baseURL).hostname;
    return MODEL_PROVIDER_IDS.find((id) => MODEL_PROVIDERS[id].hosts.includes(hostname)) ?? 'custom';
  } catch {
    return 'custom';
  }
}

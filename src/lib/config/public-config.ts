import type { ConfigModelProvider, UIConfigField } from './types';

function secretKeys(fields: UIConfigField[]): string[] {
  return [...new Set(['apiKey', ...fields.filter(field => field.type === 'password').map(field => field.key)])];
}

/** Browser settings show whether a secret exists, never its value. */
export function publicModelProvider(provider: ConfigModelProvider, fields: UIConfigField[]): ConfigModelProvider & { configuredSecrets: string[] } {
  const config = { ...provider.config };
  const configuredSecrets: string[] = [];
  for (const key of secretKeys(fields)) {
    if (config[key]) configuredSecrets.push(key);
    if (key in config) config[key] = '';
  }
  return { ...provider, config, hash: '', configuredSecrets };
}

/** Empty password inputs mean keep the server's existing value. */
export function mergeProviderConfig(previous: Record<string, any>, incoming: Record<string, any>, fields: UIConfigField[]) {
  const config = { ...incoming };
  for (const key of secretKeys(fields)) {
    if ((config[key] == null || (typeof config[key] === 'string' && !config[key].trim())) && previous[key]) {
      config[key] = previous[key];
    }
  }
  return config;
}

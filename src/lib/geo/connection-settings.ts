import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelCallSettings } from '@/lib/models/ai-sdk';
import { inferModelProvider, isModelProviderId, MODEL_PROVIDERS } from '@/lib/models/providers';
import type { GenerateObjectInput } from '@/lib/models/types';
import type { GeoConnectionSettings, GeoModelProvider, GeoSettingsSource, GeoSettingsUpdate } from './connection-settings-types';
import { translateServerCode, type ServerErrorParams } from './i18n-server';

type ModelValues = { provider?: GeoModelProvider; baseURL?: string; model?: string; apiKey?: string };
type SeoDataValues = { dataForSeoLogin?: string; dataForSeoPassword?: string };
type SavedSettings = { version: 1; model?: ModelValues; search?: unknown; seoData?: SeoDataValues };
export type DataForSeoCredentials = { login: string; password: string; source: GeoSettingsSource };
export type GeoModelConnection = {
  provider: GeoModelProvider; baseURL: string; model: string; apiKey: string;
  configured: boolean; source: GeoSettingsSource;
};
export type GeoStructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };

export class GeoSettingsError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public params?: ServerErrorParams,
    public detail?: string,
  ) {
    super(translateServerCode('zh', code, params));
  }
}

const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : '';
const dataPath = (file: string) => path.join(process.env.DATA_DIR || process.cwd(), 'data', file);

function validBaseURL(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch { throw new GeoSettingsError('invalid_settings', 400, { field: 'baseURL' }); }
}
function safeBaseURL(value: string): string {
  try { return validBaseURL(value); } catch { return ''; }
}

function readSavedSettings(): SavedSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('geo-settings.json'), 'utf8'));
    if (!parsed || parsed.version !== 1 || (parsed.model && (typeof parsed.model !== 'object' || Array.isArray(parsed.model))) ||
      (parsed.search && (typeof parsed.search !== 'object' || Array.isArray(parsed.search))) ||
      (parsed.seoData && (typeof parsed.seoData !== 'object' || Array.isArray(parsed.seoData)))) throw new Error();
    return parsed as SavedSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
    // Never echo parser or filesystem errors: a malformed file can contain keys.
    throw new GeoSettingsError('invalid_settings', 500, { field: 'file' });
  }
}

function resolveModel(saved: SavedSettings): GeoModelConnection {
  const values = saved.model;
  const geminiKey = stringValue(process.env.GEMINI_API_KEY);
  const explicitBaseURL = stringValue(process.env.OPENGEO_LLM_BASE_URL);
  const environmentBaseURL = explicitBaseURL
    || (geminiKey ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://api.openai.com/v1');
  const baseURL = safeBaseURL(values?.baseURL ?? environmentBaseURL);
  const provider = values?.provider ?? inferModelProvider(baseURL);
  const explicitModel = stringValue(process.env.OPENGEO_LLM_MODEL);
  const model = values?.model ?? (explicitModel || (provider === 'gemini' && geminiKey ? 'gemini-3.8-flash' : ''));
  const explicitKey = stringValue(process.env.OPENGEO_LLM_API_KEY);
  const providerEnvKey = MODEL_PROVIDERS[provider]?.envKey;
  const envKeyForProvider = explicitKey || (providerEnvKey ? stringValue(process.env[providerEnvKey]) : '');
  const apiKey = values?.apiKey ?? envKeyForProvider;
  return { provider, baseURL, model, apiKey, configured: Boolean(model && apiKey && baseURL),
    source: values ? 'saved' : 'environment' };
}

export function getGeoModelConnection(): GeoModelConnection { return resolveModel(readSavedSettings()); }

/** Optional DataForSEO credentials (saved settings take precedence over .env.local). Never throws if absent. */
export function getDataForSeoCredentials(): DataForSeoCredentials | null {
  let saved: SavedSettings = { version: 1 };
  try { saved = readSavedSettings(); } catch { /* Optional SEO data never blocks core flows. */ }
  const savedLogin = stringValue(saved.seoData?.dataForSeoLogin);
  const savedPassword = stringValue(saved.seoData?.dataForSeoPassword);
  if (savedLogin && savedPassword) return { login: savedLogin, password: savedPassword, source: 'saved' };
  const envLogin = stringValue(process.env.DATAFORSEO_LOGIN);
  const envPassword = stringValue(process.env.DATAFORSEO_PASSWORD);
  if (envLogin && envPassword) return { login: envLogin, password: envPassword, source: 'environment' };
  return null;
}

export function shouldUseChatGPTSubscription(
  status: { enabled?: boolean; connected?: boolean },
  apiConfigured = getGeoModelConnection().configured,
): boolean {
  if (!status.enabled) return false;
  if (status.connected === false && apiConfigured) return false;
  return true;
}

function publicSettings(saved: SavedSettings): GeoConnectionSettings {
  const { apiKey, ...model } = resolveModel(saved);
  return {
    model: { ...model, keyConfigured: Boolean(apiKey) },
  };
}
export function getGeoConnectionSettings(): GeoConnectionSettings { return publicSettings(readSavedSettings()); }

function validateUpdate(input: unknown): GeoSettingsUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GeoSettingsError('invalid_request');
  const { section, values } = input as GeoSettingsUpdate;
  if (section !== 'model' || !values || typeof values !== 'object' || Array.isArray(values)) throw new GeoSettingsError('invalid_settings', 400, { field: 'section' });
  const allowed = ['provider', 'baseURL', 'model', 'apiKey'];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new GeoSettingsError('invalid_settings', 400, { field: 'unknown' });
  const normalized: GeoSettingsUpdate['values'] = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new GeoSettingsError('invalid_settings', 400, { field: key });
    const trimmed = value.trim();
    if (key === 'apiKey') {
      if (!trimmed) continue; // An untouched key field never clears a key.
      if (trimmed.length > 8192 || /\s/.test(trimmed)) throw new GeoSettingsError('invalid_settings', 400, { field: 'apiKey' });
      normalized.apiKey = trimmed;
    } else if (key === 'provider') {
      if (!isModelProviderId(trimmed)) throw new GeoSettingsError('invalid_settings', 400, { field: 'provider' });
      normalized.provider = trimmed;
    } else if (key === 'baseURL') {
      if (trimmed.length > 2048) throw new GeoSettingsError('invalid_settings', 400, { field: 'baseURL' });
      normalized.baseURL = validBaseURL(trimmed);
    } else {
      if (!trimmed || trimmed.length > 200 || /[\r\n\x00-\x1f]/.test(trimmed)) throw new GeoSettingsError('invalid_settings', 400, { field: 'model' });
      normalized.model = trimmed;
    }
  }
  return { section, values: normalized };
}

export function saveGeoConnectionSettings(input: unknown): GeoConnectionSettings {
  const { values } = validateUpdate(input);
  // Read and merge synchronously at write time; parallel section requests cannot
  // overwrite one another with a stale cached object in this server process.
  const saved = readSavedSettings();
  if (Object.keys(values).length === 0) return publicSettings(saved);
  const current = resolveModel(saved);
  const nextBaseURL = values.baseURL ?? current.baseURL;
  const nextProvider = values.provider ?? current.provider;
  if (current.apiKey && !values.apiKey && (nextBaseURL !== current.baseURL || nextProvider !== current.provider)) {
    throw new GeoSettingsError('invalid_settings', 400, { field: 'apiKey' });
  }
  saved.model = { ...saved.model, ...values };
  const file = dataPath('geo-settings.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch {
    throw new GeoSettingsError('invalid_settings', 500, { field: 'file' });
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* The successful rename already removed it. */ }
  }
  return publicSettings(saved);
}

/** Resolve every time a new operation starts; no restart or module cache reset. */
export function requireGeoModelConnection(): GeoModelConnection {
  const connection = getGeoModelConnection();
  if (!connection.configured) throw new GeoSettingsError('model_not_configured', 400);
  return connection;
}

export async function loadGeoModel(settings?: ModelCallSettings): Promise<GeoStructuredModel> {
  const connection = requireGeoModelConnection();
  const { createStructuredModel } = await import('@/lib/models/ai-sdk');
  return createStructuredModel(connection, settings);
}

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GenerateObjectInput } from '@/lib/models/types';
import type { GeoConnectionSettings, GeoModelProvider, GeoSettingsSource, GeoSettingsUpdate } from './connection-settings-types';

type ModelValues = { provider?: GeoModelProvider; baseURL?: string; model?: string; apiKey?: string };
type SavedSettings = { version: 1; model?: ModelValues; search?: unknown };
export type GeoModelConnection = {
  provider: GeoModelProvider; baseURL: string; model: string; apiKey: string;
  configured: boolean; source: GeoSettingsSource;
};
export type GeoStructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };

export class GeoSettingsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const modelProviders = ['gemini', 'deepseek', 'openai', 'custom'] as const;
const stringValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/^["']|["']$/g, '') : '';
const dataPath = (file: string) => path.join(process.env.DATA_DIR || process.cwd(), 'data', file);

function validBaseURL(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch { throw new GeoSettingsError('API 地址必须是完整的 HTTP(S) 地址，且不能包含用户名、密码、查询参数或片段。'); }
}
function safeBaseURL(value: string): string {
  try { return validBaseURL(value); } catch { return ''; }
}
function inferProvider(baseURL: string): GeoModelProvider {
  try {
    const hostname = new URL(baseURL).hostname;
    if (hostname === 'generativelanguage.googleapis.com') return 'gemini';
    return hostname === 'api.deepseek.com' ? 'deepseek' : hostname === 'api.openai.com' ? 'openai' : 'custom';
  } catch { return 'custom'; }
}

function readSavedSettings(): SavedSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataPath('geo-settings.json'), 'utf8'));
    if (!parsed || parsed.version !== 1 || (parsed.model && (typeof parsed.model !== 'object' || Array.isArray(parsed.model))) ||
      (parsed.search && (typeof parsed.search !== 'object' || Array.isArray(parsed.search)))) throw new Error();
    return parsed as SavedSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
    // Never echo parser or filesystem errors: a malformed file can contain keys.
    throw new GeoSettingsError('无法读取已保存的连接设置，请检查设置文件。', 500);
  }
}

function resolveModel(saved: SavedSettings): GeoModelConnection {
  const values = saved.model;
  const geminiKey = stringValue(process.env.GEMINI_API_KEY);
  const explicitBaseURL = stringValue(process.env.OPENGEO_LLM_BASE_URL);
  const environmentBaseURL = explicitBaseURL
    || (geminiKey ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://api.openai.com/v1');
  const baseURL = safeBaseURL(values?.baseURL ?? environmentBaseURL);
  const provider = values?.provider ?? inferProvider(baseURL);
  const explicitModel = stringValue(process.env.OPENGEO_LLM_MODEL);
  const model = values?.model ?? (explicitModel || (provider === 'gemini' && geminiKey ? 'gemini-3.8-flash' : ''));
  const explicitKey = stringValue(process.env.OPENGEO_LLM_API_KEY);
  const deepseekKey = stringValue(process.env.DEEPSEEK_API_KEY);
  const envKeyForProvider = explicitKey || (provider === 'gemini' ? geminiKey : provider === 'deepseek' ? deepseekKey : '');
  const apiKey = values?.apiKey ?? envKeyForProvider;
  return { provider, baseURL, model, apiKey, configured: Boolean(model && apiKey && baseURL),
    source: values ? 'saved' : 'environment' };
}

export function getGeoModelConnection(): GeoModelConnection { return resolveModel(readSavedSettings()); }

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
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GeoSettingsError('设置格式无效。');
  const { section, values } = input as GeoSettingsUpdate;
  if (section !== 'model' || !values || typeof values !== 'object' || Array.isArray(values)) throw new GeoSettingsError('请选择有效的设置项目。');
  const allowed = ['provider', 'baseURL', 'model', 'apiKey'];
  if (Object.keys(values).some(key => !allowed.includes(key))) throw new GeoSettingsError('设置包含不支持的字段。');
  const normalized: GeoSettingsUpdate['values'] = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string') throw new GeoSettingsError('设置字段必须填写文字。');
    const trimmed = value.trim();
    if (key === 'apiKey') {
      if (!trimmed) continue; // An untouched key field never clears a key.
      if (trimmed.length > 8192 || /\s/.test(trimmed)) throw new GeoSettingsError('API Key 格式无效。');
      normalized.apiKey = trimmed;
    } else if (key === 'provider') {
      if (!modelProviders.includes(trimmed as GeoModelProvider)) throw new GeoSettingsError('请选择有效的模型服务。');
      normalized.provider = trimmed as GeoModelProvider;
    } else if (key === 'baseURL') {
      if (trimmed.length > 2048) throw new GeoSettingsError('API 地址过长。');
      normalized.baseURL = validBaseURL(trimmed);
    } else {
      if (!trimmed || trimmed.length > 200 || /[\r\n\x00-\x1f]/.test(trimmed)) throw new GeoSettingsError('请填写有效的模型名称。');
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
    throw new GeoSettingsError('切换模型服务或 API 地址时，请填写该服务的新 API Key；原设置尚未改变。');
  }
  saved.model = { ...saved.model, ...values };
  const file = dataPath('geo-settings.json');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch {
    throw new GeoSettingsError('连接设置保存失败，请重试。', 500);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* The successful rename already removed it. */ }
  }
  return publicSettings(saved);
}

/** Resolve every time a new operation starts; no restart or module cache reset. */
export async function loadGeoModel(): Promise<GeoStructuredModel> {
  const connection = getGeoModelConnection();
  if (!connection.configured) throw new GeoSettingsError('请先在设置中配置模型名称、API 地址和 API Key。');
  const { default: OpenAILLM } = await import('@/lib/models/providers/openai/openaiLLM');
  return new OpenAILLM({ apiKey: connection.apiKey, model: connection.model, baseURL: connection.baseURL });
}

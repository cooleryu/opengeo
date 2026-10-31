import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GenerateObjectInput } from '@/lib/models/types';
import type { GeoConnectionSettings, GeoModelProvider, GeoSearchProvider, GeoSettingsSource, GeoSettingsUpdate } from './connection-settings-types';

type ModelValues = { provider?: GeoModelProvider; baseURL?: string; model?: string; apiKey?: string };
type SearchValues = { apiKey?: string; model?: string };
type SavedSettings = { version: 1; model?: ModelValues; search?: Partial<Record<GeoSearchProvider, SearchValues>> };
export type GeoModelConnection = {
  provider: GeoModelProvider; baseURL: string; model: string; apiKey: string;
  configured: boolean; source: GeoSettingsSource | 'vane'; vaneProviderId?: string;
};
export type GeoStructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };

export class GeoSettingsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const modelProviders = ['deepseek', 'openai', 'custom'] as const;
const searchProviders = ['deepseek', 'qwen', 'doubao'] as const;
const stringValue = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
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

// Read legacy metadata without importing ConfigManager, which writes on startup.
function legacyOpenAIConnection(providerId: string): { apiKey: string; baseURL: string } | undefined {
  if (!providerId) return undefined;
  try {
    const config = JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8'));
    const provider = Array.isArray(config.modelProviders) && config.modelProviders.find((item: { id?: string }) => item.id === providerId);
    if (provider?.type !== 'openai') return undefined;
    return { apiKey: stringValue(provider.config?.apiKey), baseURL: safeBaseURL(stringValue(provider.config?.baseURL) || 'https://api.openai.com/v1') };
  } catch { return undefined; }
}

function resolveModel(saved: SavedSettings): GeoModelConnection {
  const vaneProviderId = stringValue(process.env.OPENGEO_VANE_PROVIDER_ID);
  const legacy = legacyOpenAIConnection(vaneProviderId);
  const values = saved.model;
  const useVane = Boolean(vaneProviderId && !values);
  const environmentBaseURL = stringValue(process.env.OPENGEO_LLM_BASE_URL) || 'https://api.openai.com/v1';
  const baseURL = safeBaseURL(values?.baseURL ?? (useVane && legacy ? legacy.baseURL : environmentBaseURL));
  const model = values?.model ?? stringValue(process.env.OPENGEO_LLM_MODEL);
  const apiKey = values?.apiKey ?? (useVane && legacy ? legacy.apiKey : stringValue(process.env.OPENGEO_LLM_API_KEY));
  const provider = values?.provider ?? inferProvider(baseURL);
  return { provider, baseURL, model, apiKey, configured: Boolean(model && (useVane || (apiKey && baseURL))),
    source: values ? 'saved' : useVane ? 'vane' : 'environment', ...(useVane ? { vaneProviderId } : {}) };
}

export function getGeoModelConnection(): GeoModelConnection { return resolveModel(readSavedSettings()); }

function resolveSearch(provider: GeoSearchProvider, saved: SavedSettings): { apiKey: string; model: string | null; source: GeoSettingsSource } {
  const values = saved.search?.[provider];
  const environmentKey = provider === 'doubao' ? process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY
    : provider === 'qwen' ? process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY : process.env.DEEPSEEK_API_KEY;
  const environmentModel = provider === 'doubao' ? stringValue(process.env.OPENGEO_DOUBAO_MODEL) || 'doubao-seed-2-0-lite-260428'
    : provider === 'qwen' ? stringValue(process.env.OPENGEO_QWEN_MODEL) || 'qwen-plus-2025-07-14' : null;
  return { apiKey: values?.apiKey ?? stringValue(environmentKey), model: provider === 'deepseek' ? null : values?.model ?? environmentModel,
    source: values ? 'saved' : 'environment' };
}

export function getGeoSearchConnection(provider: GeoSearchProvider) { return resolveSearch(provider, readSavedSettings()); }

function publicSettings(saved: SavedSettings): GeoConnectionSettings {
  const { apiKey, vaneProviderId: _vaneProviderId, ...model } = resolveModel(saved);
  return {
    model: { ...model, keyConfigured: Boolean(apiKey) },
    search: searchProviders.map(id => {
      const connection = resolveSearch(id, saved);
      return { id, name: id === 'deepseek' ? 'DeepSeek Search API' : id === 'qwen' ? '千问联网回答 API' : '豆包联网回答 API',
        model: connection.model, configured: Boolean(connection.apiKey), keyConfigured: Boolean(connection.apiKey), source: connection.source };
    }),
  };
}
export function getGeoConnectionSettings(): GeoConnectionSettings { return publicSettings(readSavedSettings()); }

function validateUpdate(input: unknown): GeoSettingsUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new GeoSettingsError('设置格式无效。');
  const { section, values } = input as GeoSettingsUpdate;
  if (!['model', ...searchProviders].includes(section) || !values || typeof values !== 'object' || Array.isArray(values)) throw new GeoSettingsError('请选择有效的设置项目。');
  const allowed = section === 'model' ? ['provider', 'baseURL', 'model', 'apiKey'] : section === 'deepseek' ? ['apiKey'] : ['model', 'apiKey'];
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
  const { section, values } = validateUpdate(input);
  // Read and merge synchronously at write time; parallel section requests cannot
  // overwrite one another with a stale cached object in this server process.
  const saved = readSavedSettings();
  if (Object.keys(values).length === 0) return publicSettings(saved);
  if (section === 'model') {
    const current = resolveModel(saved);
    const nextBaseURL = values.baseURL ?? current.baseURL;
    const nextProvider = values.provider ?? current.provider;
    if (current.apiKey && !values.apiKey && (nextBaseURL !== current.baseURL || nextProvider !== current.provider)) {
      throw new GeoSettingsError('切换模型服务或 API 地址时，请填写该服务的新 API Key；原设置尚未改变。');
    }
    if (current.source === 'vane' && !values.apiKey && !current.apiKey) {
      throw new GeoSettingsError('切换到 OpenGEO 模型设置时，请填写 API Key；原连接尚未改变。');
    }
    saved.model = { ...saved.model, ...values };
    // A supported legacy OpenAI connection can be adopted without erasing its
    // existing key. Other legacy provider types stay on their original path.
    if (current.source === 'vane') saved.model = { provider: current.provider, baseURL: current.baseURL,
      model: current.model, apiKey: current.apiKey, ...saved.model };
  } else {
    saved.search = { ...saved.search, [section]: { ...saved.search?.[section], ...values } };
  }
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
  if (connection.vaneProviderId) {
    const { default: ModelRegistry } = await import('@/lib/models/registry');
    return new ModelRegistry().loadChatModel(connection.vaneProviderId, connection.model);
  }
  const { default: OpenAILLM } = await import('@/lib/models/providers/openai/openaiLLM');
  return new OpenAILLM({ apiKey: connection.apiKey, model: connection.model, baseURL: connection.baseURL });
}

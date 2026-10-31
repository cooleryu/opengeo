export type GeoModelProvider = 'deepseek' | 'openai' | 'custom';
export type GeoSearchProvider = 'deepseek' | 'qwen' | 'doubao';
export type GeoSettingsSection = 'model' | GeoSearchProvider;
export type GeoSettingsSource = 'environment' | 'saved';

export type GeoConnectionSettings = {
  model: {
    provider: GeoModelProvider;
    baseURL: string;
    model: string;
    configured: boolean;
    keyConfigured: boolean;
    source: GeoSettingsSource | 'vane';
  };
  search: Array<{
    id: GeoSearchProvider;
    name: string;
    model: string | null;
    configured: boolean;
    keyConfigured: boolean;
    source: GeoSettingsSource;
  }>;
};

export type GeoSettingsUpdate = {
  section: GeoSettingsSection;
  values: { provider?: GeoModelProvider; baseURL?: string; model?: string; apiKey?: string };
};

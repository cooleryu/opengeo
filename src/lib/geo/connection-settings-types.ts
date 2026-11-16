export type GeoModelProvider = 'gemini' | 'deepseek' | 'openai' | 'custom';
export type GeoSettingsSection = 'model';
export type GeoSettingsSource = 'environment' | 'saved';

export type GeoConnectionSettings = {
  model: {
    provider: GeoModelProvider;
    baseURL: string;
    model: string;
    configured: boolean;
    keyConfigured: boolean;
    source: GeoSettingsSource;
  };
};

export type GeoSettingsUpdate = {
  section: GeoSettingsSection;
  values: { provider?: GeoModelProvider; baseURL?: string; model?: string; apiKey?: string };
};

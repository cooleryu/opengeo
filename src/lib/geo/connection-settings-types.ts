export type { ModelProviderId as GeoModelProvider } from '@/lib/models/providers';
import type { ModelProviderId as GeoModelProvider } from '@/lib/models/providers';
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
  modelConfigured?: boolean;
};

export type GeoSettingsUpdate = {
  section: GeoSettingsSection;
  values: { provider?: GeoModelProvider; baseURL?: string; model?: string; apiKey?: string };
};

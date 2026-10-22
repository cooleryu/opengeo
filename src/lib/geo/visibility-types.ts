export type GeoProviderId = 'chatgpt' | 'google' | 'gemini' | 'deepseek';

export interface GeoVisibilitySource {
  title: string;
  url: string;
  position: number | null;
  attribution: 'citation' | 'link' | 'web_result';
  assetId?: string;
}

export interface GeoVisibilityResult {
  providerId: GeoProviderId;
  status: 'found' | 'not_found' | 'unmeasured';
  query: string | null;
  recordedAt: string | null;
  summary: string;
  sources: GeoVisibilitySource[];
  evidencePath: string | null;
  sampleCount: number;
  mode?: string;
  caveat: string;
  searchResultCount?: number;
}

export interface GeoVisibilityQuestion {
  id: string;
  title: string;
  kind: 'brand' | 'scenario';
  relatedAssetIds: string[];
  results: GeoVisibilityResult[];
}

export interface GeoVisibility {
  providers: {
    id: GeoProviderId;
    label: string;
    kind: 'answer' | 'web';
  }[];
  questions: GeoVisibilityQuestion[];
  updatedAt: string;
}

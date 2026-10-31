import type { TrafficErrorCode, TrafficRange } from './traffic-types';

export interface ConversionSummary {
  articleVisitors: number;
  githubVisitors: number;
  /** Ordered-funnel visitors / article visitors; null when the denominator is zero. */
  conversionRate: number | null;
}

export interface ConversionJourney extends ConversionSummary {
  source: string;
  landingPage: string;
  entryScope: 'tab-30m' | 'page';
}

export interface ConversionSnapshot {
  projectId: string;
  provider: 'umami';
  status: 'not_configured' | 'unsupported' | 'ready' | 'empty' | 'error';
  range: TrafficRange;
  fetchedAt: string | null;
  summary: ConversionSummary | null;
  journeys: ConversionJourney[];
  limit: number;
  windowMinutes: number;
  /** Candidate ordering uses article event counts, never a conversion denominator. */
  grouping: {
    rankedBy: 'article_events';
    returnedValues: number;
    invalidValues: number;
    truncated: boolean;
  };
  error?: { code: TrafficErrorCode; message: string };
}

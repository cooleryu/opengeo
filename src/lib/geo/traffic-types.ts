export interface TrafficRange {
  startDate: string;
  endDate: string;
  startAt: number;
  endAt: number;
  timezone: 'Asia/Shanghai';
}

export type TrafficErrorCode =
  | 'configuration'
  | 'authorization'
  | 'upstream'
  | 'invalid_response'
  | 'timeout';

export interface TrafficSnapshot {
  projectId: string;
  provider: 'umami';
  status: 'not_configured' | 'ready' | 'empty' | 'error';
  range: TrafficRange;
  fetchedAt: string | null;
  summary: { pageviews: number; visitors: number } | null;
  /** Per-page visitors, deduplicated by Umami session_id within this range. */
  pages: { path: string; visitors: number }[];
  /** Per-domain visitors; Umami excludes empty and same-site referrer domains. */
  referrers: { referrer: string; visitors: number }[];
  /** The page and referrer tables each contain at most this many ranked rows. */
  limit: number;
  error?: { code: TrafficErrorCode; message: string };
}

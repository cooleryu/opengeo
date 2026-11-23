import type { z } from 'zod';
import type {
  docDraftModelSchema,
  prPatchModelSchema,
  videoScriptModelSchema,
} from './action-board-schemas';

/**
 * Action board schema v3.
 *
 * Every string on a card is one of three kinds, and the field decides which:
 * - Tok: language-neutral (enum, number, URL, path, product name, verbatim quote). Shown as-is.
 * - Label: a short creator-facing judgement, generated as an { en, zh } pair in the same model call,
 *   so switching the UI language never needs a regeneration.
 * - Pub: publishable text in the project's target language. Rendered with lang={targetLanguage}
 *   inside a "what you'll post" zone and never translated.
 * Counts, badges, titles and order are computed in code and rendered through translateUi.
 */
export const ACTION_BOARD_SCHEMA_VERSION = 3;

export const ACTION_CARD_KINDS = [
  'page_diff',
  'doc_draft',
  'video_script',
  'community_reply',
  'form_pack',
  'pr_patch',
  'outreach_email',
] as const;
export type ActionCardKind = (typeof ACTION_CARD_KINDS)[number];

/** Seven action kinds share four interfaces. */
export type ActionCardInterface = 'file_change' | 'message' | 'form' | 'storyboard';
export const KIND_INTERFACE: Record<ActionCardKind, ActionCardInterface> = {
  page_diff: 'file_change',
  doc_draft: 'file_change',
  pr_patch: 'file_change',
  community_reply: 'message',
  outreach_email: 'message',
  form_pack: 'form',
  video_script: 'storyboard',
};

export type Label = { en: string; zh: string };

export type CardReason =
  | 'brand_absent'
  | 'homonym'
  | 'page_gaps'
  | 'competitor_named'
  | 'channel_cited'
  | 'roundup_cited';

export type AnswerEngine = 'chatgpt' | 'google';

/** Computed from the citation landscape; never written by a model. */
export interface CardEvidence {
  questionIds: string[];
  questions?: Array<{ id: string; query: string }>;
  engines: AnswerEngine[];
  questionCount: number;
  citationCount: number;
}

export interface CardTarget {
  label: string;
  url?: string;
  path?: string;
  /** Page to check when no audit exists yet. */
  assetId?: string;
}

export interface CardSeedPage {
  title: string;
  url: string;
  channel: string;
}

export interface ActionCardSkeleton {
  id: string;
  kind: ActionCardKind;
  rank: number;
  placement: 'primary' | 'secondary';
  reason: CardReason;
  target: CardTarget;
  evidence: CardEvidence;
  seeds: {
    pages?: CardSeedPage[];
    competitors?: string[];
    findingIds?: string[];
  };
}

export const STORYBOARD_SCREENS = ['product', 'browser', 'chatgpt', 'google', 'terminal', 'code', 'slide'] as const;
export type StoryboardScreen = (typeof STORYBOARD_SCREENS)[number];

export const FORM_FIELD_KEYS = ['name', 'tagline', 'description', 'category', 'pricing', 'license', 'website', 'repository'] as const;
export type FormFieldKey = (typeof FORM_FIELD_KEYS)[number];

// --- Hydrated payloads (what the board stores) ---

export interface PageDiffPayload {
  kind: 'page_diff';
  auditId: string | null;
  targetLabel: string;
  targetUrl: string | null;
  edits: Array<{ findingId: string; title?: Label; why?: Label }>;
}

export interface DocDraftPayload extends Omit<z.infer<typeof docDraftModelSchema>, 'whyDoThis'> {
  kind: 'doc_draft';
  path: string | null;
  canSaveToRepo: boolean;
  screenshotUrl?: string;
  markdown: string;
  wordCount: number;
}

export type ThreadFetchStatus = 'fetched' | 'title_only';
export type ThreadFetchReason = 'blocked' | 'timeout' | 'not_found' | 'unsupported' | 'error';

export interface ThreadSource {
  status: ThreadFetchStatus;
  reason?: ThreadFetchReason;
  fetchedAt: string;
  op?: { author?: string; body: string; score?: number };
  replies?: Array<{ author?: string; body: string; score?: number }>;
  commentCount?: number;
  locked?: boolean;
}

export interface CommunityThread {
  url: string;
  platform: string;
  community: string;
  title: string;
  source: ThreadSource;
  angle?: Label;
  body: string;
  disclosure: string;
}

export interface CommunityReplyPayload {
  kind: 'community_reply';
  threads: CommunityThread[];
}

export interface VideoScriptPayload extends Omit<z.infer<typeof videoScriptModelSchema>, 'whyDoThis'> {
  kind: 'video_script';
  platform: string;
  duration: string;
  studioUrl: string;
  screenshotUrl: string;
  links: Array<{ label: string; url: string }>;
  description: string;
}

export interface FormPackPayload {
  kind: 'form_pack';
  targets: Array<{ siteName: string; url: string }>;
  fields: Array<{ key: FormFieldKey; value: string }>;
}

export interface PrPatchPayload {
  kind: 'pr_patch';
  targets: Array<z.infer<typeof prPatchModelSchema>['targets'][number] & { repoSlug: string }>;
}

export interface OutreachEmailPayload {
  kind: 'outreach_email';
  /** The pitch is written in English; the post zone is tagged with this language. */
  language: 'en';
  targets: Array<{
    siteName: string;
    articleTitle: string;
    articleUrl: string;
    articles?: Array<{ title: string; url: string }>;
    contactHint?: string;
    subject: string;
    body: string;
    blurb: string;
  }>;
}

export type ActionCardPayload =
  | PageDiffPayload
  | DocDraftPayload
  | CommunityReplyPayload
  | VideoScriptPayload
  | FormPackPayload
  | PrPatchPayload
  | OutreachEmailPayload;

export interface ActionBoardWorkerTelemetry {
  agentId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  source: 'llm' | 'deterministic' | 'failed';
}

export type CardFailureCode = 'interrupted' | 'model_failed' | 'no_audit';

export interface ActionBoardCard extends ActionCardSkeleton {
  status: 'pending' | 'ready' | 'failed';
  payload: ActionCardPayload | null;
  /** Why this action matters, written with the draft. Missing or too long → the UI shows a fixed line. */
  why?: Label;
  failure?: CardFailureCode;
  errorMessage?: string;
  telemetry?: ActionBoardWorkerTelemetry;
  completedAt?: string;
  publishedUrl?: string;
}

export interface ActionBoardCoverage {
  questions: number;
  answers: number;
  mentions: number;
  citations: number;
  engines: AnswerEngine[];
  homonymRisk: boolean;
  homonymClues?: string[];
}

export interface ActionBoardRecord {
  schemaVersion: typeof ACTION_BOARD_SCHEMA_VERSION;
  id: string;
  projectId: string;
  brandName: string;
  targetLanguage: 'en' | 'zh';
  coverage: ActionBoardCoverage;
  cards: ActionBoardCard[];
  telemetry: { skeletonMs: number; hydrationWallMs?: number; promptTokens: number; completionTokens: number };
  createdAt: string;
  updatedAt: string;
}

export function isCurrentActionBoard(value: unknown): value is ActionBoardRecord {
  const record = value as Partial<ActionBoardRecord> | null;
  return Boolean(record && record.schemaVersion === ACTION_BOARD_SCHEMA_VERSION && Array.isArray(record.cards));
}

/** The "why do this" line stays one crisp sentence; anything longer is dropped, never cut. */
export const WHY_MAX = { en: 220, zh: 96 } as const;

const HAN = /[\u3400-\u9fff]/;

const VIDEO_PLATFORMS: Array<[RegExp, string]> = [
  [/youtu/i, 'YouTube'],
  [/bilibili/i, 'Bilibili'],
  [/vimeo/i, 'Vimeo'],
];

/** The name people know a video site by ("youtube.com" → "YouTube"); unknown sites keep their label. */
export function videoPlatformName(label: string): string {
  return VIDEO_PLATFORMS.find(([re]) => re.test(label))?.[1] ?? label;
}

export function acceptWhy(value: { en?: string; zh?: string } | null | undefined): Label | undefined {
  const en = (value?.en ?? '').replace(/\s+/g, ' ').trim();
  const zh = (value?.zh ?? '').replace(/\s+/g, ' ').trim();
  if (en.length < 12 || en.length > WHY_MAX.en || HAN.test(en)) return undefined;
  if ([...zh].length < 6 || [...zh].length > WHY_MAX.zh || !HAN.test(zh)) return undefined;
  return { en, zh };
}

/** Clamp a model string for display safety without paying for a retry. */
export function clampText(value: string, max: number): string {
  const clean = value.replace(/\s+\n/g, '\n').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

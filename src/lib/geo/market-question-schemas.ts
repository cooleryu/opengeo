import { z } from 'zod';
import type { RankedDemandSignal } from './demand-signals';
import type { QuestionDemandSignal, QuestionDemandStatus } from './question-types';

export const demandStatusSchema = z.enum(['search-backed', 'public-observed', 'user-provided', 'unverified']);

export const demandSignalSchema = z.object({
  id: z.string().min(1).max(80),
  source: z.enum(['dataforseo_ranked', 'dataforseo_overview', 'google_autocomplete', 'competitor_sitemap', 'hn_discussion', 'csv_import']),
  keyword: z.string().trim().min(1).max(300),
  searchVolume: z.number().nonnegative().optional(),
  cpc: z.number().nonnegative().optional(),
  kd: z.number().min(0).max(100).optional(),
  intent: z.string().max(80).optional(),
  competitorDomain: z.string().max(255).optional(),
  competitorRank: z.number().int().positive().optional(),
  url: z.string().max(2048).optional(),
}).strict();

export const tacticSchema = z.enum(['direct-content', 'outreach-monitor', 'competitor-intercept', 'brand-check']);

const callOptionsSchema = z.object({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().positive(),
}).strict();

export const marketParametersSchema = z.object({
  maxNewCandidates: z.number().int().positive().max(100),
  maxInputBytes: z.number().int().positive().max(48 * 1024),
  subscriptionTimeoutMs: z.number().int().positive(),
  maxConcurrency: z.number().int().positive().max(3).default(3),
  materials: z.object({
    maxTotalCharacters: z.number().int().positive(),
    maxCharactersPerAsset: z.number().int().positive(),
  }).strict(),
  planning: callOptionsSchema,
  propose: callOptionsSchema,
  review: callOptionsSchema,
}).strict();

export const marketModelSchema = z.object({
  personas: z.array(z.string().trim().min(3).max(240)).min(1).max(4),
  categorySeeds: z.array(z.string().trim().min(2).max(100)).min(1).max(6),
  painVerbs: z.array(z.string().trim().min(3).max(120)).max(5).default([]),
  competitors: z.array(z.object({
    name: z.string().trim().min(2).max(100),
    domain: z.string().trim().max(200).optional(),
  }).strict()).max(5).default([]),
  includeHn: z.boolean().default(true),
}).strict();

const categorySchema = z.enum(['brand', 'positioning', 'problem', 'content', 'comparison', 'boundary']);
const decisionSchema = z.enum(['include', 'explore', 'exclude']);
const prioritySchema = z.enum(['high', 'medium', 'low']);

export const marketDraftSchema = z.object({
  query: z.string().trim().min(3).max(260),
  category: categorySchema,
  intent: z.string().trim().min(5).max(500),
  target: z.enum(['project', 'article']),
  signalIds: z.array(z.string().trim().min(1).max(40)).max(6).default([]),
  tactic: tacticSchema,
  fanoutQueries: z.array(z.string().trim().min(2).max(160)).max(6).default([]),
  rationale: z.string().trim().min(5).max(700),
  expectedResult: z.string().trim().min(5).max(500),
}).strict();

export const marketReviewItemSchema = z.object({
  id: z.string().min(1).max(180),
  decision: decisionSchema,
  priority: prioritySchema,
  reason: z.string().trim().min(5).max(700),
  concerns: z.array(z.string().trim().min(1).max(300)).max(6).default([]),
  assetIds: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
  worthVerdict: z.enum(['yes', 'uncertain', 'no']),
  worthReason: z.string().trim().min(5).max(700),
  demandBasis: z.enum(['user-provided', 'public-observation', 'inferred', 'unknown']),
  demandBasisReason: z.string().trim().min(5).max(700),
  supportLevel: z.enum(['supported', 'partial', 'unverified', 'missing']),
  supportReason: z.string().trim().min(5).max(700),
  gaps: z.array(z.object({
    kind: z.enum(['content', 'evidence', 'capability', 'investigation']),
    description: z.string().trim().min(5).max(350),
  }).strict()).max(6).default([]),
}).strict();

export const marketReviewOutputSchema = z.object({
  reviews: z.array(marketReviewItemSchema).max(30),
  selectedIds: z.array(z.string().min(1).max(180)).max(8),
  summary: z.string().trim().min(5).max(600),
}).strict();

export function sanitizeInternalIds(text: string): string {
  return text
    .replace(/\(\s*sig-\d+(?:\s*,\s*sig-\d+)*\s*\)/gi, '')
    .replace(/\bsig-\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function toStoredSignal(sig: RankedDemandSignal): QuestionDemandSignal {
  return {
    id: sig.id,
    source: sig.source,
    keyword: sig.keyword,
    ...(sig.searchVolume !== undefined ? { searchVolume: sig.searchVolume } : {}),
    ...(sig.cpc !== undefined ? { cpc: sig.cpc } : {}),
    ...(sig.kd !== undefined ? { kd: sig.kd } : {}),
    ...(sig.intent ? { intent: sig.intent } : {}),
    ...(sig.competitorDomain ? { competitorDomain: sig.competitorDomain } : {}),
    ...(sig.competitorRank !== undefined ? { competitorRank: sig.competitorRank } : {}),
    ...(sig.url ? { url: sig.url } : {}),
  };
}

export function computeDemandStatus(signals: QuestionDemandSignal[]): QuestionDemandStatus {
  if (
    signals.some(
      s =>
        s.source === 'dataforseo_ranked' ||
        s.source === 'csv_import' ||
        (s.source === 'dataforseo_overview' && (s.searchVolume ?? 0) > 0),
    )
  ) {
    return 'search-backed';
  }
  if (signals.length > 0) return 'public-observed';
  return 'unverified';
}

/** Human-readable signal summary for L5 without leaking raw KD/CPC/volume jargon. */
export function plainSignalSummary(signals: QuestionDemandSignal[], outputLanguage: 'en' | 'zh'): string {
  if (!signals.length) {
    return outputLanguage === 'en'
      ? 'No external search signal matched; derived from product positioning and user context.'
      : '未匹配到外部公开搜索信号，基于产品定位与用户场景推导。';
  }
  const domains = [...new Set(signals.map(s => s.competitorDomain).filter((d): d is string => Boolean(d)))];
  const hasSearch = signals.some(s => s.source === 'dataforseo_ranked' || s.source === 'dataforseo_overview');
  const hasAutocomplete = signals.some(s => s.source === 'google_autocomplete');
  const hasSitemap = signals.some(s => s.source === 'competitor_sitemap');
  const hasHn = signals.some(s => s.source === 'hn_discussion');

  const parts: string[] = [];
  if (outputLanguage === 'en') {
    if (hasSearch) parts.push('live search demand');
    if (hasAutocomplete) parts.push('real search suggestions');
    if (hasSitemap || domains.length) {
      parts.push(domains.length ? `competitor topics (${domains.slice(0, 2).join(', ')})` : 'competitor comparison pages');
    }
    if (hasHn) parts.push('developer community discussions');
    return `Grounded in ${parts.join(', ')}.`;
  }
  if (hasSearch) parts.push('真实搜索需求');
  if (hasAutocomplete) parts.push('搜索下拉高频词');
  if (hasSitemap || domains.length) {
    parts.push(domains.length ? `同类产品核心话题（${domains.slice(0, 2).join('、')}）` : '同类产品核心专题');
  }
  if (hasHn) parts.push('公开社区真实讨论');
  return `已关联外部真实信号：${parts.join('、')}。`;
}

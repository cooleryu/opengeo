import { KNOWN_DIRECTORY_HOST_RE } from '../outreach/external-page-meta';
import type {
  ActionBoardCard,
  ActionBoardCoverage,
  ActionBoardRecord,
  ActionCardKind,
  ActionCardSkeleton,
  AnswerEngine,
  CardEvidence,
  CardReason,
  CardSeedPage,
} from './action-board-catalog';
import type { ChannelCitationEntry, OptimizationStrategicBrief } from './citation-landscape';
import type { PageAuditRecord, PageAuditTargetOption } from './page-audit';

/**
 * Stage 1, computed in code: which cards to show, in what order, with what evidence.
 * Every number on a card comes from here, so badges are true by construction.
 */

const FORUM_HOST_RE =
  /(?:^|\.)(?:reddit\.com|quora\.com|v2ex\.com|zhihu\.com|stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|indiehackers\.com)$/i;
const VIDEO_HOST_RE = /(?:^|\.)(?:youtube\.com|youtu\.be|bilibili\.com|vimeo\.com)$/i;
const AWESOME_URL_RE = /^https?:\/\/github\.com\/[^/]+\/awesome[\w.-]*/i;
const MAX_PRIMARY = 4;

export interface PlannerInput {
  brief: OptimizationStrategicBrief;
  audit: PageAuditRecord | null;
  auditTarget: PageAuditTargetOption | null;
  previous: ActionBoardRecord | null;
  brandName: string;
  repositoryUrl: string;
}

interface Candidate extends Omit<ActionCardSkeleton, 'rank' | 'placement'> {
  score: number;
  forceSecondary?: boolean;
}

const hostOf = (entry: ChannelCitationEntry) => (entry.domains[0] || entry.label).toLowerCase();

function entryScore(entry: ChannelCitationEntry): number {
  return entry.questionCount * 10 + entry.totalCitations * 2 + (entry.engines.length > 1 ? 5 : 0);
}

function mergeEvidence(entries: ChannelCitationEntry[]): CardEvidence {
  const questionIds = [...new Set(entries.flatMap((e) => e.questionIds))];
  const engines = [...new Set(entries.flatMap((e) => e.engines))].sort() as AnswerEngine[];
  return {
    questionIds,
    engines,
    questionCount: questionIds.length,
    citationCount: entries.reduce((sum, e) => sum + e.totalCitations, 0),
  };
}

function pagesOf(entries: ChannelCitationEntry[], limit: number): CardSeedPage[] {
  const seen = new Set<string>();
  const pages: CardSeedPage[] = [];
  for (const entry of entries) {
    for (const page of entry.samplePages) {
      if (!page.url || seen.has(page.url)) continue;
      seen.add(page.url);
      pages.push({ title: page.title, url: page.url, channel: entry.label });
    }
  }
  return pages.slice(0, limit);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function summarizeCoverage(brief: OptimizationStrategicBrief): ActionBoardCoverage {
  const { coverage } = brief;
  const engines = (['chatgpt', 'google'] as const).filter((e) => coverage.byEngine[e].measured > 0);
  return {
    questions: coverage.totalQuestions,
    answers: coverage.measuredAnswers,
    mentions: coverage.mentionYes,
    citations: coverage.citationYes,
    engines: [...engines],
    homonymRisk: coverage.brand.homonymRisk,
    ...(coverage.brand.homonymClues?.length ? { homonymClues: coverage.brand.homonymClues.slice(0, 3) } : {}),
  };
}

function competitorsNamed(brief: OptimizationStrategicBrief, brandName: string) {
  const counts = new Map<string, number>();
  const questionIds = new Set<string>();
  const engines = new Set<AnswerEngine>();
  const self = brandName.toLowerCase();
  for (const row of brief.questionMatrix) {
    for (const engine of ['chatgpt', 'google'] as const) {
      const brands = (row[engine]?.recommendedBrands ?? []).filter((b) => b.toLowerCase() !== self);
      if (!brands.length) continue;
      questionIds.add(row.questionId);
      engines.add(engine);
      for (const brand of brands) counts.set(brand, (counts.get(brand) ?? 0) + 1);
    }
  }
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  return { names, questionIds: [...questionIds], engines: [...engines].sort() as AnswerEngine[] };
}

function pageDiffCandidate(input: PlannerInput): Candidate | null {
  const { audit, brief, auditTarget } = input;
  const coverage = brief.coverage;
  const reason: CardReason = coverage.brand.homonymRisk
    ? 'homonym'
    : coverage.mentionYes === 0
      ? 'brand_absent'
      : 'page_gaps';
  const allQuestionIds = brief.questionMatrix.map((q) => q.questionId);
  const measuredEngines = (['chatgpt', 'google'] as const).filter((e) => coverage.byEngine[e].measured > 0);
  const evidence: CardEvidence = {
    questionIds: allQuestionIds,
    engines: [...measuredEngines],
    questionCount: allQuestionIds.length,
    citationCount: 0,
  };
  if (!audit) {
    if (!auditTarget) return null;
    return {
      id: `page_diff:${slugify(auditTarget.label) || 'page'}`,
      kind: 'page_diff',
      reason,
      target: { label: auditTarget.label, url: auditTarget.publicUrl ?? undefined, assetId: auditTarget.assetId },
      evidence,
      seeds: { findingIds: [] },
      score: 900,
    };
  }
  const open = audit.findings
    .filter((f) => f.status === 'open')
    .sort((a, b) => (a.impact === b.impact ? 0 : a.impact === 'high' ? -1 : 1));
  if (!open.length) return null;
  const engines = [...new Set(open.flatMap((f) => f.citedEngines))].sort() as AnswerEngine[];
  return {
    id: `page_diff:${slugify(audit.targetLabel) || 'page'}`,
    kind: 'page_diff',
    reason,
    target: { label: audit.targetLabel, url: audit.targetUrl ?? undefined },
    evidence: { ...evidence, engines: engines.length ? engines : evidence.engines },
    seeds: { findingIds: open.slice(0, 5).map((f) => f.id) },
    score: 1000,
  };
}

function docDraftCandidate(input: PlannerInput): Candidate | null {
  const { brief, brandName, repositoryUrl } = input;
  const named = competitorsNamed(brief, brandName);
  if (named.names.length < 2) return null;
  if (brief.alreadyShipped.existingRepoDocs.some((d) => d.startsWith('docs/comparisons/'))) return null;
  const competitors = named.names.slice(0, 3);
  const inRepo = /github\.com\//i.test(repositoryUrl);
  const path = inRepo ? `docs/comparisons/${slugify(competitors.join('-'))}-alternatives.md` : undefined;
  const pages = pagesOf(
    [...brief.citationLandscape.directCompetitorSites, ...brief.citationLandscape.thirdPartyRoundups],
    6,
  );
  return {
    id: `doc_draft:${slugify(competitors.join('-'))}`,
    kind: 'doc_draft',
    reason: 'competitor_named',
    target: { label: path ?? competitors.join(' / '), path },
    evidence: {
      questionIds: named.questionIds,
      engines: named.engines,
      questionCount: named.questionIds.length,
      citationCount: 0,
    },
    seeds: { competitors, pages },
    score: named.questionIds.length * 10 + 20,
  };
}

function channelCandidate(
  kind: ActionCardKind,
  entries: ChannelCitationEntry[],
  pageLimit: number,
  weight = 1,
): Candidate | null {
  if (!entries.length) return null;
  const pages = pagesOf(entries, pageLimit);
  if (!pages.length) return null;
  const top = entries[0];
  return {
    id: `${kind}:${slugify(entries.map(hostOf).join('-'))}`,
    kind,
    reason: kind === 'outreach_email' ? 'roundup_cited' : 'channel_cited',
    target: { label: kind === 'video_script' ? top.label : entries.map((e) => e.label).join(' · '), url: pages[0]?.url },
    evidence: mergeEvidence(entries),
    seeds: { pages },
    score: entries.reduce((sum, e) => sum + entryScore(e), 0) * weight,
  };
}

function awesomeListEntries(brief: OptimizationStrategicBrief): ChannelCitationEntry[] {
  const landscape = brief.citationLandscape;
  return [...landscape.openChannel, ...landscape.directCompetitorRepos, ...landscape.thirdPartyRoundups]
    .map((e) => ({ ...e, samplePages: e.samplePages.filter((p) => AWESOME_URL_RE.test(p.url)) }))
    .filter((e) => e.samplePages.length > 0);
}

export function planActionBoard(input: PlannerInput): ActionBoardCard[] {
  const { brief } = input;
  const open = brief.citationLandscape.openChannel;
  const forums = open.filter((e) => FORUM_HOST_RE.test(hostOf(e)));
  const videos = open.filter((e) => VIDEO_HOST_RE.test(hostOf(e)));
  const directories = open.filter((e) => KNOWN_DIRECTORY_HOST_RE.test(hostOf(e)));
  const outreach = channelCandidate('outreach_email', brief.citationLandscape.thirdPartyRoundups, 6, 0.5);

  const candidates = [
    pageDiffCandidate(input),
    docDraftCandidate(input),
    channelCandidate('community_reply', forums, 4),
    channelCandidate('video_script', videos.slice(0, 1), 2),
    channelCandidate('form_pack', directories, 4, 0.8),
    channelCandidate('pr_patch', awesomeListEntries(brief), 3, 0.9),
    outreach ? { ...outreach, forceSecondary: true } : null,
  ].filter((c): c is Candidate => Boolean(c));

  const previousById = new Map((input.previous?.cards ?? []).map((c) => [c.id, c]));
  const queryById = new Map(brief.questionMatrix.map((q) => [q.questionId, q.query]));
  const isDone = (c: Candidate) => Boolean(previousById.get(c.id)?.completedAt);
  candidates.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || b.score - a.score);

  let primaryCount = 0;
  return candidates.map((candidate, index) => {
    const { score: _score, forceSecondary, ...skeleton } = candidate;
    void _score;
    const primary = !forceSecondary && !isDone(candidate) && primaryCount < MAX_PRIMARY;
    if (primary) primaryCount += 1;
    const carried = previousById.get(candidate.id);
    const questions = skeleton.evidence.questionIds
      .map((id) => ({ id, query: queryById.get(id) ?? '' }))
      .filter((item) => Boolean(item.query));
    return {
      ...skeleton,
      evidence: { ...skeleton.evidence, ...(questions.length ? { questions } : {}) },
      rank: index + 1,
      placement: primary ? 'primary' : 'secondary',
      status: 'pending',
      payload: null,
      ...(carried?.completedAt ? { completedAt: carried.completedAt } : {}),
      ...(carried?.publishedUrl ? { publishedUrl: carried.publishedUrl } : {}),
    } satisfies ActionBoardCard;
  });
}

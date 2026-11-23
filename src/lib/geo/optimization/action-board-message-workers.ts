import type { z } from 'zod';
import type { AgentSpec } from '../../agent-hub';
import { extractCleanHost, humanizeCitedPageTitle } from '../outreach/external-page-meta';
import { fetchExternalPages } from './action-board-browser-fetch';
import {
  acceptWhy,
  type ActionBoardCard,
  type CardSeedPage,
  type CommunityThread,
  type OutreachEmailPayload,
  type ThreadSource,
} from './action-board-catalog';
import { normalizeEvidenceUrl, type WorkerContext } from './action-board-context';
import { communityReplyModelSchema, outreachEmailModelSchema } from './action-board-schemas';
import { communityLabel, fetchThreadSources } from './action-board-threads';
import {
  FACT_RULES,
  WHY_RULE,
  emptyTelemetry,
  languageRules,
  runWorker,
  type WorkerResult,
  type WorkerRunOptions,
} from './action-board-worker-kit';

const MAX_THREADS = 3;
const MAX_EMAIL_SITES = 4;

interface ThreadBrief {
  url: string;
  platform: string;
  community: string;
  title: string;
  source: ThreadSource;
}

interface ReplyInput {
  ctx: WorkerContext;
  threads: ThreadBrief[];
  targetLanguage: 'en' | 'zh';
}

const DANGLING_WORD_RE = /\s+(?:in|for|of|to|with|on|at|by|from|the|a|an|and|or)$/i;

/** Adds an ellipsis when a Reddit URL slug was clipped mid-phrase by search results. */
export function polishThreadTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (!clean || /[.?!…]$/.test(clean)) return clean;
  return DANGLING_WORD_RE.test(clean) ? `${clean}…` : clean;
}

const replyAgent: AgentSpec<ReplyInput, z.infer<typeof communityReplyModelSchema>> = {
  id: 'action-card-community-reply',
  title: 'Community Reply Worker',
  thinking: true,
  maxTurns: 2,
  temperature: 0.4,
  maxTokens: 16384,
  outputSchema: communityReplyModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'You draft one helpful reply per thread, written by the project maintainer.',
        'When `source.status` is "fetched": answer what the poster actually asked in `source.op.body`; do not repeat points already made in `source.replies`; add one concrete thing they missed.',
        'When `source.status` is "title_only": the thread text could not be read. Answer only what the title asks, keep it general, and never refer to details of the post or its replies.',
        'Name the project once, near the end, with a single link (repositoryUrl or siteUrl). No marketing tone, no headings, 60-160 words.',
        '`disclosure` is one honest sentence saying the author maintains the project. `angle` is a short {en, zh} label naming the reply\'s main point.',
        'Return one item per input thread with the same `url`.',
        `${WHY_RULE} Here the action is replying in these cited community threads — explain why adding a useful answer on those specific platforms puts the project into AI answers.`,
        languageRules(input.targetLanguage),
        FACT_RULES,
      ].join('\n\n'),
      user: JSON.stringify({ project: input.ctx.project, questions: input.ctx.prompts, threads: input.threads }),
    };
  },
  validate(output, input) {
    const urls = new Set(input.threads.map((t) => normalizeEvidenceUrl(t.url)));
    const bad = output.threads.find((t) => !urls.has(normalizeEvidenceUrl(t.url)));
    return bad ? `Thread url "${bad.url}" is not one of the input threads.` : null;
  },
};

export async function hydrateCommunityReply(
  card: ActionBoardCard,
  ctx: WorkerContext,
  opts: WorkerRunOptions,
): Promise<WorkerResult> {
  void card;
  const pages = ctx.pages.slice(0, MAX_THREADS);
  const fetched = await fetchThreadSources(
    pages.map((p) => p.url),
    { allowBrowser: true },
  );
  const threads: ThreadBrief[] = pages.map((page, i) => {
    const { platform, community } = communityLabel(page.url);
    const fallbackTitle = humanizeCitedPageTitle(page.title, page.url, extractCleanHost(page.url));
    const title = polishThreadTitle(fetched[i].resolvedTitle || fallbackTitle);
    return {
      url: page.url,
      platform,
      community,
      title,
      source: fetched[i].source,
    };
  });
  const { output, telemetry } = await runWorker(replyAgent, { ctx, threads, targetLanguage: opts.targetLanguage }, opts);
  const drafts = new Map(output.threads.map((t) => [normalizeEvidenceUrl(t.url), t]));
  const hydrated: CommunityThread[] = threads.flatMap((thread) => {
    const draft = drafts.get(normalizeEvidenceUrl(thread.url));
    return draft ? [{ ...thread, angle: draft.angle, body: draft.body.trim(), disclosure: draft.disclosure.trim() }] : [];
  });
  return { payload: { kind: 'community_reply', threads: hydrated }, telemetry, why: acceptWhy(output.whyDoThis) };
}

/** Re-drafts a single community thread after reading its real post body (via local Chrome or user paste). */
export async function redraftSingleCommunityThread(
  thread: CommunityThread,
  source: ThreadSource,
  resolvedTitle: string | undefined,
  ctx: WorkerContext,
  opts: WorkerRunOptions,
): Promise<CommunityThread> {
  const brief: ThreadBrief = {
    url: thread.url,
    platform: thread.platform,
    community: thread.community,
    title: polishThreadTitle(resolvedTitle || thread.title),
    source,
  };
  const { output } = await runWorker(replyAgent, { ctx, threads: [brief], targetLanguage: opts.targetLanguage }, opts);
  const draft = output.threads.find((t) => normalizeEvidenceUrl(t.url) === normalizeEvidenceUrl(thread.url)) ?? output.threads[0];
  if (!draft) return { ...brief, angle: thread.angle, body: thread.body, disclosure: thread.disclosure };
  return { ...brief, angle: draft.angle, body: draft.body.trim(), disclosure: draft.disclosure.trim() };
}

// --- outreach_email: domain-grouped, live-read roundups, complete sentences (never sliced mid-sentence) ---

export interface GroupedRoundupSite {
  siteName: string;
  articles: Array<{ title: string; url: string }>;
}

/** Strips trailing " — site.com" or " | Site" suffix from page titles so email subjects look human. */
function cleanArticleHeadline(title: string, siteName: string): string {
  const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title
    .replace(new RegExp(`\\s*[—–|:-]\\s*(?:www\\.)?${escaped}\\s*$`, 'i'), '')
    .replace(/\s*[—–|]\s*[^—–|]{2,36}$/i, (tail) => (tail.toLowerCase().includes(siteName.split('.')[0]) ? '' : tail))
    .trim() || title.trim();
}

/** Groups cited roundup pages by clean domain so we never tell a founder to cold-email one site twice. */
export function groupRoundupsBySite(pages: CardSeedPage[], maxSites = MAX_EMAIL_SITES): GroupedRoundupSite[] {
  const bySite = new Map<string, GroupedRoundupSite>();
  for (const page of pages) {
    const host = extractCleanHost(page.url) || page.channel.toLowerCase();
    if (!host) continue;
    const headline = cleanArticleHeadline(humanizeCitedPageTitle(page.title, page.url, host), host);
    const existing = bySite.get(host);
    if (existing) {
      if (!existing.articles.some((a) => normalizeEvidenceUrl(a.url) === normalizeEvidenceUrl(page.url))) {
        existing.articles.push({ title: headline, url: page.url });
      }
      continue;
    }
    if (bySite.size >= maxSites) continue;
    bySite.set(host, { siteName: host, articles: [{ title: headline, url: page.url }] });
  }
  return [...bySite.values()];
}

/** Keeps full sentences cleanly under `maxChars`; never cuts off mid-phrase. */
export function cleanCompleteSentence(raw: string, maxChars = 240): string {
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return /[.!?。！？]$/.test(clean) ? clean : `${clean}.`;
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]/g) ?? [];
  let acc = '';
  for (const sentence of sentences) {
    const next = acc ? `${acc} ${sentence.trim()}` : sentence.trim();
    if (next.length > maxChars) break;
    acc = next;
  }
  if (acc.length >= 40) return acc;
  const cut = clean.slice(0, maxChars).replace(/\s+\S*$/, '').replace(/[,:;—–-]+$/, '').trim();
  return cut ? `${cut}.` : clean.slice(0, maxChars);
}

interface OutreachSiteBrief {
  siteName: string;
  articles: Array<{ title: string; url: string; headings: string[]; excerpt: string }>;
  contactHint?: string;
}

interface OutreachInput {
  ctx: WorkerContext;
  sites: OutreachSiteBrief[];
}

const outreachEmailAgent: AgentSpec<OutreachInput, z.infer<typeof outreachEmailModelSchema>> = {
  id: 'action-card-outreach-email',
  title: 'Roundup Outreach Worker',
  thinking: true,
  maxTurns: 2,
  temperature: 0.35,
  maxTokens: 16384,
  outputSchema: outreachEmailModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'You write one concise, polite English pitch email per unique publication in `sites`, from the maintainer of `ctx.project.name`.',
        'If a publication has multiple cited articles in `articles`, mention them together in ONE email — never ask to email the same site twice.',
        'Sound like a real indie maintainer, never a mass outreach bot: greet cleanly ("Hi editorial team," or "Hi <Brand> team," — never raw domain names like "Hi example.com team,"), keep subjects short without quoting raw site suffixes, reference what their guide covers from `headings`/`excerpt` when available, and explain clearly why adding this project makes their roundup more complete.',
        '`blurb` is 1-2 complete English sentences (<= 220 chars, complete grammar, never truncated) summarizing the project for an editor to paste.',
        'Return one item per input site with the exact matching `siteName`.',
        `${WHY_RULE} Here the action is pitching these cited roundup publications — explain that AI models rely on these roundup articles when recommending tools, so getting added puts the project into AI answers.`,
        FACT_RULES,
      ].join('\n\n'),
      user: JSON.stringify({ project: input.ctx.project, questions: input.ctx.prompts, sites: input.sites }),
    };
  },
  validate(output, input) {
    const known = new Set(input.sites.map((s) => s.siteName.toLowerCase()));
    const bad = output.targets.find((t) => !known.has(t.siteName.toLowerCase()));
    return bad ? `Unknown siteName "${bad.siteName}".` : null;
  },
};

function buildFallbackEmail(site: OutreachSiteBrief, ctx: WorkerContext): OutreachEmailPayload['targets'][number] {
  const project = ctx.project;
  const productUrl = project.siteUrl || project.repositoryUrl;
  const blurb = cleanCompleteSentence(project.englishSummary || project.description, 220);
  const primary = site.articles[0];
  const more = site.articles.slice(1);
  const articleList = more.length
    ? `your guides "${primary.title}" (${primary.url}) and "${more[0].title}" (${more[0].url})`
    : `your guide "${primary.title}" (${primary.url})`;
  const brandLabel = site.siteName.split('.')[0];
  const greetingName = brandLabel.charAt(0).toUpperCase() + brandLabel.slice(1);
  const body = [
    `Hi ${greetingName} editorial team,`,
    '',
    `I came across ${articleList}. Most tools in similar roundups are paid cloud platforms — if you refresh the list, an open-source, self-hosted option could round out the comparison for technical readers.`,
    '',
    `Short summary you are welcome to adapt:`,
    `- ${project.name}${productUrl ? ` (${productUrl})` : ''}: ${blurb}`,
    ...(project.screenshotUrl ? [`- Product screenshot: ${project.screenshotUrl}`] : []),
    '',
    `Disclosure: I maintain ${project.name}. Happy to share any technical details if helpful — no pressure either way.`,
  ].join('\n');
  return {
    siteName: site.siteName,
    articleTitle: primary.title,
    articleUrl: primary.url,
    articles: site.articles.map((a) => ({ title: a.title, url: a.url })),
    ...(site.contactHint ? { contactHint: site.contactHint } : {}),
    subject: `Open-source option for "${primary.title}"`,
    body,
    blurb,
  };
}

export async function hydrateOutreachEmail(
  card: ActionBoardCard,
  ctx: WorkerContext,
  opts: WorkerRunOptions,
): Promise<WorkerResult> {
  void card;
  const grouped = groupRoundupsBySite(ctx.pages, MAX_EMAIL_SITES);
  const urls = grouped.flatMap((g) => g.articles.slice(0, 2).map((a) => a.url));
  const snapshots = urls.length ? await fetchExternalPages(urls, { timeoutMs: 9_000 }) : new Map();

  const sites: OutreachSiteBrief[] = grouped.map((group) => {
    let contactHint: string | undefined;
    const articles = group.articles.map((article) => {
      const snap = snapshots.get(article.url);
      if (!contactHint && snap?.contactHints?.length) contactHint = snap.contactHints[0];
      const liveTitle = snap?.ok && snap.title ? cleanArticleHeadline(snap.title, group.siteName) : article.title;
      return {
        title: liveTitle,
        url: article.url,
        headings: snap?.ok ? snap.headings.slice(0, 6) : [],
        excerpt: snap?.ok ? (snap.description || snap.bodyText.slice(0, 500)) : '',
      };
    });
    return { siteName: group.siteName, articles, contactHint };
  });

  if (!sites.length) {
    return {
      payload: { kind: 'outreach_email', language: 'en', targets: [] },
      telemetry: emptyTelemetry('outreach-email', 'deterministic'),
    };
  }

  try {
    const { output, telemetry } = await runWorker(outreachEmailAgent, { ctx, sites }, opts);
    const bySite = new Map(output.targets.map((t) => [t.siteName.toLowerCase(), t]));
    const targets: OutreachEmailPayload['targets'] = sites.map((site) => {
      const drafted = bySite.get(site.siteName.toLowerCase());
      if (!drafted) return buildFallbackEmail(site, ctx);
      const primary = site.articles[0];
      return {
        siteName: site.siteName,
        articleTitle: primary.title,
        articleUrl: primary.url,
        articles: site.articles.map((a) => ({ title: a.title, url: a.url })),
        ...(site.contactHint ? { contactHint: site.contactHint } : {}),
        subject: drafted.subject.trim(),
        body: drafted.body.trim(),
        blurb: cleanCompleteSentence(drafted.blurb, 240),
      };
    });
    return {
      payload: { kind: 'outreach_email', language: 'en', targets },
      telemetry,
      why: acceptWhy(output.whyDoThis),
    };
  } catch {
    return {
      payload: { kind: 'outreach_email', language: 'en', targets: sites.map((s) => buildFallbackEmail(s, ctx)) },
      telemetry: emptyTelemetry('outreach-email', 'deterministic'),
    };
  }
}

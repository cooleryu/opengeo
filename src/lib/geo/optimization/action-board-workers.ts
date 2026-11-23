import type { z } from 'zod';
import type { AgentSpec } from '../../agent-hub';
import { fetchExternalPages, type RenderedPageSnapshot } from './action-board-browser-fetch';
import {
  acceptWhy,
  clampText,
  videoPlatformName,
  type ActionBoardCard,
  type DocDraftPayload,
  type PageDiffPayload,
  type VideoScriptPayload,
} from './action-board-catalog';
import { allowedUrlSet, normalizeEvidenceUrl, type WorkerContext } from './action-board-context';
import {
  docDraftModelSchema,
  editLabelsModelSchema,
  formPackModelSchema,
  prPatchModelSchema,
  videoScriptModelSchema,
} from './action-board-schemas';
import { hydrateCommunityReply, hydrateOutreachEmail } from './action-board-message-workers';
import {
  FACT_RULES,
  WHY_RULE,
  emptyTelemetry,
  languageRules,
  runWorker,
  type WorkerResult,
  type WorkerRunOptions,
} from './action-board-worker-kit';
import { previewPageFindingBatch, readLatestPageAudit } from './page-audit';

interface WorkerInput {
  card: ActionBoardCard;
  ctx: WorkerContext;
  targetLanguage: 'en' | 'zh';
}

const userPayload = (input: WorkerInput, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ctx: input.ctx, evidence: input.card.evidence, target: input.card.target, ...extra });

// --- doc_draft ---

interface CompetitorPageBrief {
  competitor: string;
  url: string;
  title: string;
  description: string;
  headings: string[];
  excerpt: string;
}

interface DocDraftInput extends WorkerInput {
  competitorPages: CompetitorPageBrief[];
}

function matchCompetitorRootUrl(competitor: string, pages: WorkerContext['pages']): string | null {
  const tokens = competitor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t !== 'ai' && t !== 'io');
  for (const page of pages) {
    try {
      const u = new URL(page.url);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (tokens.some((t) => host.includes(t))) return `${u.origin}/`;
    } catch {
      // Ignore invalid URL.
    }
  }
  return null;
}

async function collectCompetitorPages(ctx: WorkerContext): Promise<CompetitorPageBrief[]> {
  const pairs: Array<{ competitor: string; urls: string[] }> = [];
  for (const competitor of ctx.competitors.slice(0, 3)) {
    const root = matchCompetitorRootUrl(competitor, ctx.pages);
    if (!root) continue;
    const origin = root.replace(/\/$/, '');
    pairs.push({ competitor, urls: [root, `${origin}/pricing`] });
  }
  const allUrls = pairs.flatMap((p) => p.urls);
  if (!allUrls.length) return [];
  const snapshots = await fetchExternalPages(allUrls, { timeoutMs: 10_000 });
  const briefs: CompetitorPageBrief[] = [];
  for (const { competitor, urls } of pairs) {
    for (const url of urls) {
      const snap: RenderedPageSnapshot | undefined = snapshots.get(url);
      if (!snap?.ok) continue;
      briefs.push({
        competitor,
        url: snap.finalUrl || url,
        title: snap.title,
        description: snap.description,
        headings: snap.headings.slice(0, 8),
        excerpt: snap.bodyText.slice(0, 1600),
      });
    }
  }
  return briefs;
}

const docDraftAgent: AgentSpec<DocDraftInput, z.infer<typeof docDraftModelSchema>> = {
  id: 'action-card-doc-draft',
  title: 'Comparison Page Worker',
  thinking: true,
  maxTurns: 2,
  temperature: 0.3,
  maxTokens: 20480,
  outputSchema: docDraftModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'You draft a sharp, buyer-facing comparison page that both humans love reading and AI answers can quote directly.',
        '`tldr` is 1-2 crisp, specific sentences summarizing the core architectural and cost difference, under 280 characters. Never write "not stated in the sources reviewed here" in the TL;DR.',
        '`verdict` is a required 2-column executive summary: `ownHeadline` + 3 crisp `ownPoints` (when to pick this project), and `saasHeadline` + 3 crisp `saasPoints` (when a hosted SaaS competitor fits better — be genuinely fair!).',
        '`bestFor` is a required array with ONE decision card per product in `table.products` (in the same order): short `badge` (e.g. "Local-first · MIT · $0" or "Enterprise AI marketing"), concrete `idealFor` (1 sentence), and honest `tradeOff` (1 sentence).',
        '`workflow` is a required side-by-side 3-4 step loop contrasting `traditionalTitle` / `traditionalSteps` (e.g. typical hosted SaaS workflow — be fair and stay strictly consistent with the comparison table, never caricature competitors as "guessing and hoping") against `ownTitle` / `ownSteps` (this project\'s local browser capture -> citation audit -> diff draft -> re-run loop). Keep each step concise (<= 55 chars).',
        '`table.products` lists the project first, then the competitors from `ctx.competitors`. Every row has one cell per product, in the same order.',
        'Use the live fetched `competitorPages` (vendor homepages and pricing pages) to fill real, verifiable facts about each competitor (positioning, deployment/hosting, pricing model or starting tier if shown, AI engines/features highlighted, target team).',
        'Pick 5-6 comparison dimensions that have concrete answers across the columns from `competitorPages` and `ctx.project`. Never pad the table with rows where every competitor cell says "Not stated". Only write "Custom / contact sales" or "Not publicly listed" when a specific vendor actually omits it on their page.',
        '`sections` answer the buyer questions in `ctx.prompts`; set `questionId` to the question a section answers. Bodies are Markdown, vivid and scannable (use short bold lead-ins or bullets), 80-180 words each.',
        '`claims` lists the concrete statements you made about competitors (3-6 claims) that a founder should verify before publishing, with `sourceUrl` pointing to the exact `competitorPages[].url` or `ctx.pages[].url` it came from.',
        WHY_RULE,
        languageRules(input.targetLanguage),
        FACT_RULES,
      ].join('\n\n'),
      user: userPayload(input, { competitorPages: input.competitorPages }),
    };
  },
  validate(output, input) {
    const products = output.table.products;
    if (products[0]?.toLowerCase() !== input.ctx.project.name.toLowerCase()) {
      return `table.products[0] must be "${input.ctx.project.name}".`;
    }
    const bad = output.table.rows.find((row) => row.cells.length !== products.length);
    return bad ? `Row "${bad.dimension}" must have exactly ${products.length} cells.` : null;
  },
};

export function assembleDocMarkdown(
  doc: Omit<z.infer<typeof docDraftModelSchema>, 'whyDoThis'> & { screenshotUrl?: string },
): string {
  const head = `| | ${doc.table.products.join(' | ')} |`;
  const rule = `| --- |${doc.table.products.map(() => ' --- |').join('')}`;
  const rows = doc.table.rows.map((r) => `| ${r.dimension} | ${r.cells.join(' | ')} |`);
  const verdictBlock = doc.verdict
    ? [
        '## Quick verdict',
        '',
        `### ${doc.verdict.ownHeadline}`,
        ...doc.verdict.ownPoints.map((p) => `- ${p}`),
        '',
        `### ${doc.verdict.saasHeadline}`,
        ...doc.verdict.saasPoints.map((p) => `- ${p}`),
        '',
      ]
    : [];
  const screenshotBlock = doc.screenshotUrl
    ? [`![${doc.table.products[0]} product interface](${doc.screenshotUrl})`, '']
    : [];
  const bestForBlock = doc.bestFor?.length
    ? [
        '## Who should pick which?',
        '',
        ...doc.bestFor.map((b) => `- **${b.product}** (${b.badge}) — **Best for:** ${b.idealFor} *Trade-off:* ${b.tradeOff}`),
        '',
      ]
    : [];
  const sanitizeMermaid = (text: string) => text.replace(/["[\](){}]/g, '').trim();
  const workflowBlock = doc.workflow
    ? [
        '## Workflow comparison',
        '',
        '```mermaid',
        'flowchart LR',
        `  subgraph T["${sanitizeMermaid(doc.workflow.traditionalTitle)}"]`,
        `    ${doc.workflow.traditionalSteps.map((s, i) => `T${i}["${sanitizeMermaid(s)}"]`).join(' --> ')}`,
        '  end',
        `  subgraph O["${sanitizeMermaid(doc.workflow.ownTitle)}"]`,
        `    ${doc.workflow.ownSteps.map((s, i) => `O${i}["${sanitizeMermaid(s)}"]`).join(' --> ')}`,
        '  end',
        '```',
        '',
      ]
    : [];
  return [
    `# ${doc.title}`,
    '',
    head,
    rule,
    ...rows,
    '',
    `**TL;DR** ${doc.tldr}`,
    '',
    ...screenshotBlock,
    ...verdictBlock,
    ...bestForBlock,
    ...workflowBlock,
    ...doc.sections.flatMap((s) => [`## ${s.heading}`, '', s.body.trim(), '']),
  ]
    .join('\n')
    .trim();
}

async function hydrateDocDraft(input: WorkerInput, opts: WorkerRunOptions): Promise<WorkerResult> {
  const competitorPages = await collectCompetitorPages(input.ctx);
  const { output, telemetry } = await runWorker(docDraftAgent, { ...input, competitorPages }, opts);
  const { whyDoThis, ...draft } = output;
  const allowed = allowedUrlSet([
    ...input.ctx.pages,
    ...competitorPages.map((p) => ({ title: p.title, url: p.url, channel: p.competitor })),
  ]);
  const promptIds = new Set(input.ctx.prompts.map((p) => p.id));
  const screenshotUrl = input.ctx.project.screenshotUrl || undefined;
  const doc = {
    ...draft,
    screenshotUrl,
    sections: draft.sections.map((s) => ({ ...s, questionId: s.questionId && promptIds.has(s.questionId) ? s.questionId : undefined })),
    claims: draft.claims.map((c) => ({
      ...c,
      sourceUrl: c.sourceUrl && allowed.has(normalizeEvidenceUrl(c.sourceUrl)) ? c.sourceUrl : null,
    })),
  };
  const markdown = assembleDocMarkdown(doc);
  const payload: DocDraftPayload = {
    kind: 'doc_draft',
    ...doc,
    path: input.card.target.path ?? null,
    canSaveToRepo: Boolean(input.card.target.path) && input.ctx.project.ownsWorkspaceRepo,
    markdown,
    wordCount: markdown.split(/\s+/).filter(Boolean).length,
  };
  return { payload, telemetry, why: acceptWhy(whyDoThis) };
}

// --- video_script ---

const videoAgent: AgentSpec<WorkerInput, z.infer<typeof videoScriptModelSchema>> = {
  id: 'action-card-video-script',
  title: 'Video Storyboard Worker',
  thinking: true,
  maxTurns: 2,
  temperature: 0.35,
  maxTokens: 16384,
  outputSchema: videoScriptModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'You storyboard a tight 90-second to 2-minute product demo for the video platform AI answers cite.',
        '4-5 beats spaced 20-30 seconds apart (e.g. 0:00, 0:20, 0:45, 1:10, 1:35). `t` is the start time (m:ss). `screen` says what is on screen (vary screens across beats). `shot` is a short {en, zh} filming note for the creator. `onScreen` is the caption burned into the video (<= 32 chars). `lines` are 2-3 natural spoken lines that actually take ~15-25 seconds to read aloud.',
        '`titles`: 2-3 options under 70 characters (never hard-code a second/minute count like "in 90 Seconds" since total duration is computed from the script). `thumbText`: 2-5 punchy words. `descriptionIntro`: 1-2 sentences for the video description; chapter timestamps and links are added by code.',
        `${WHY_RULE} Here the action is publishing a short demo video on the cited video platform in target.label (e.g. YouTube) — explain why AI answers citing videos on that platform makes recording a demo worth doing.`,
        languageRules(input.targetLanguage),
        FACT_RULES,
      ].join('\n\n'),
      user: userPayload(input),
    };
  },
};

const STUDIO_URLS: Record<string, string> = {
  YouTube: 'https://studio.youtube.com/',
  Bilibili: 'https://member.bilibili.com/platform/upload/video/frame',
  Vimeo: 'https://vimeo.com/upload',
};

function formatClock(totalSeconds: number): string {
  const safe = Math.max(30, Math.round(totalSeconds / 5) * 5);
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

/** Re-aligns beat timestamps & total duration to actual spoken word pace (~130 wpm + visual cut pause). */
export function normalizeStoryboardTiming<T extends { t: string; lines: string[] }>(
  beats: T[],
): { beats: T[]; duration: string } {
  let cursor = 0;
  const timed = beats.map((beat) => {
    const start = formatClock(cursor);
    const words = beat.lines.join(' ').split(/\s+/).filter(Boolean).length;
    const hanChars = (beat.lines.join('').match(/[\u3400-\u9fff]/g) ?? []).length;
    const spokenSec = hanChars > words ? hanChars / 3.8 : words / 2.2;
    const beatSec = Math.max(15, Math.min(40, Math.round((spokenSec + 6) / 5) * 5));
    cursor += beatSec;
    return { ...beat, t: cursor === beatSec ? '0:00' : start };
  });
  return { beats: timed, duration: formatClock(cursor) };
}

async function hydrateVideo(input: WorkerInput, opts: WorkerRunOptions): Promise<WorkerResult> {
  const { output: modelOutput, telemetry } = await runWorker(videoAgent, input, opts);
  const { whyDoThis, ...output } = modelOutput;
  const platform = videoPlatformName(input.card.target.label);
  const studioUrl = STUDIO_URLS[platform] ?? input.card.target.url ?? '';
  const project = input.ctx.project;
  const links: VideoScriptPayload['links'] = [];
  if (project.repositoryUrl) links.push({ label: 'GitHub', url: project.repositoryUrl });
  if (project.siteUrl) links.push({ label: 'Website', url: project.siteUrl });
  if (project.repositoryUrl && input.ctx.existingRepoDocs.includes('docs/getting-started.md')) {
    links.push({ label: 'Getting started', url: `${project.repositoryUrl.replace(/\/+$/, '')}/blob/main/docs/getting-started.md` });
  }
  const { beats, duration } = normalizeStoryboardTiming(output.beats);
  const chapters = beats.map((b) => `${b.t} ${b.onScreen}`).join('\n');
  const payload: VideoScriptPayload = {
    kind: 'video_script',
    ...output,
    beats,
    thumbText: clampText(output.thumbText, 32),
    platform,
    duration,
    studioUrl,
    screenshotUrl: project.screenshotUrl,
    links,
    description: [output.descriptionIntro, '', chapters, '', ...links.map((l) => `${l.label}: ${l.url}`)].join('\n').trim(),
  };
  return { payload, telemetry, why: acceptWhy(whyDoThis) };
}

// --- form_pack ---

const formAgent: AgentSpec<WorkerInput, z.infer<typeof formPackModelSchema>> = {
  id: 'action-card-form-pack',
  title: 'Directory Listing Worker',
  maxTurns: 2,
  temperature: 0.2,
  maxTokens: 2400,
  outputSchema: formPackModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'You fill a software-directory listing. Write `tagline` (<= 90 chars), `description` (2-3 sentences), `category`, `pricing` and `license` from the facts only.',
        WHY_RULE,
        languageRules(input.targetLanguage),
        FACT_RULES,
      ].join('\n\n'),
      user: userPayload(input),
    };
  },
};

async function hydrateForm(input: WorkerInput, opts: WorkerRunOptions): Promise<WorkerResult> {
  const { output, telemetry } = await runWorker(formAgent, input, opts);
  const project = input.ctx.project;
  const fixed = new Map<string, string>([['name', project.name]]);
  if (project.siteUrl || project.repositoryUrl) fixed.set('website', project.siteUrl || project.repositoryUrl);
  if (project.repositoryUrl) fixed.set('repository', project.repositoryUrl);
  const modelFields = output.fields.filter((f) => !['name', 'website', 'repository'].includes(f.key));
  const fields = [
    ...(['name', 'website', 'repository'] as const).filter((k) => fixed.has(k)).map((key) => ({ key, value: fixed.get(key) ?? '' })),
    ...modelFields,
  ];
  const targets = input.ctx.pages.map((p) => ({ siteName: p.channel, url: p.url }));
  return { payload: { kind: 'form_pack', targets, fields }, telemetry, why: acceptWhy(output.whyDoThis) };
}

// --- pr_patch ---

const prAgent: AgentSpec<WorkerInput, z.infer<typeof prPatchModelSchema>> = {
  id: 'action-card-pr-patch',
  title: 'Awesome List PR Worker',
  maxTurns: 2,
  temperature: 0.2,
  maxTokens: 2400,
  outputSchema: prPatchModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'You prepare one pull request per cited list repository in `ctx.pages`. `repoUrl` is that repository root. `entryLine` is the single Markdown list line to add, matching common awesome-list style. Keep the PR body short and polite.',
        WHY_RULE,
        languageRules(input.targetLanguage),
        FACT_RULES,
      ].join('\n\n'),
      user: userPayload(input),
    };
  },
  validate(output, input) {
    const roots = new Set(input.ctx.pages.map((p) => repoRoot(p.url)));
    const bad = output.targets.find((t) => !roots.has(repoRoot(t.repoUrl)));
    return bad ? `repoUrl "${bad.repoUrl}" is not one of the cited repositories.` : null;
  },
};

function repoRoot(url: string): string {
  return (url.match(/^https?:\/\/github\.com\/[^/]+\/[^/#?]+/i)?.[0] ?? url).toLowerCase().replace(/\.git$/, '');
}

async function hydratePr(input: WorkerInput, opts: WorkerRunOptions): Promise<WorkerResult> {
  const { output, telemetry } = await runWorker(prAgent, input, opts);
  const targets = output.targets.map((t) => ({ ...t, repoSlug: repoRoot(t.repoUrl).replace(/^https?:\/\/github\.com\//, '') }));
  return { payload: { kind: 'pr_patch', targets }, telemetry, why: acceptWhy(output.whyDoThis) };
}

// --- page_diff: reuse the live page audit, add patches and bilingual labels ---

interface EditLabelInput {
  /** What the board knows about the page: the gap reason, conflicting homonym clues, and which page it is. */
  page: { label: string; reason: string; homonymClues: string[] };
  findings: Array<{ findingId: string; category: string; title: string; whyAiMissed: string; suggestedDirection: string }>;
}

const editLabelAgent: AgentSpec<EditLabelInput, z.infer<typeof editLabelsModelSchema>> = {
  id: 'action-card-edit-labels',
  title: 'Edit Label Worker',
  role: 'fast',
  maxTurns: 2,
  temperature: 0.1,
  maxTokens: 2400,
  outputSchema: editLabelsModelSchema,
  buildPrompt(input) {
    return {
      system: [
        'Rewrite each page-audit finding as two short labels for a review list.',
        '`title`: the change, as a plain natural action (en <= 60 chars, zh <= 26 chars; avoid translationese like "自包含定义" or "成本口径"). `why`: one plain reason tied to how AI answers (en <= 120 chars, zh <= 50 chars).',
        'Return one item per input finding with the same `findingId`. Both languages, same meaning, no jargon.',
        `${WHY_RULE} Here the action is shipping these edits to \`page.label\`; \`page.reason\` says what AI gets wrong today (homonym: AI confuses the project with a same-name project detailed in \`page.homonymClues\` — name that conflicting project in plain English for \`en\` and Chinese for \`zh\`, never putting Chinese characters in \`en\`; brand_absent: AI never names it; page_gaps: AI finds nothing to quote).`,
      ].join('\n'),
      user: JSON.stringify(input),
    };
  },
  validate(output, input) {
    const ids = new Set(input.findings.map((f) => f.findingId));
    const bad = output.edits.find((e) => !ids.has(e.findingId));
    return bad ? `Unknown findingId "${bad.findingId}".` : null;
  },
};

async function hydratePageDiff(card: ActionBoardCard, ctx: WorkerContext, opts: WorkerRunOptions): Promise<WorkerResult> {
  const audit = readLatestPageAudit(opts.projectId);
  const findingIds = card.seeds.findingIds ?? [];
  if (!audit || !findingIds.length) {
    const payload: PageDiffPayload = {
      kind: 'page_diff',
      auditId: audit?.id ?? null,
      targetLabel: card.target.label,
      targetUrl: card.target.url ?? null,
      edits: [],
    };
    return { payload, telemetry: emptyTelemetry('page-diff', 'deterministic') };
  }
  const startedAt = Date.now();
  const findings = audit.findings.filter((f) => findingIds.includes(f.id));
  const needPatch = findings.filter((f) => !f.patchPreview).slice(0, 3).map((f) => f.id);
  const [labels] = await Promise.all([
    runWorker(
      editLabelAgent,
      {
        page: { label: card.target.label, reason: card.reason, homonymClues: ctx.homonymClues },
        findings: findings.map((f) => ({
          findingId: f.id,
          category: f.category,
          title: f.title,
          whyAiMissed: f.whyAiMissed,
          suggestedDirection: f.suggestedDirection,
        })),
      },
      opts,
    ).catch(() => null),
    needPatch.length
      ? previewPageFindingBatch(opts.projectId, needPatch, { signal: opts.signal, concurrency: 3 }).catch(() => null)
      : Promise.resolve(null),
  ]);
  const byId = new Map((labels?.output.edits ?? []).map((e) => [e.findingId, e]));
  const payload: PageDiffPayload = {
    kind: 'page_diff',
    auditId: audit.id,
    targetLabel: audit.targetLabel,
    targetUrl: audit.targetUrl ?? null,
    edits: findingIds.map((findingId) => {
      const label = byId.get(findingId);
      return label ? { findingId, title: label.title, why: label.why } : { findingId };
    }),
  };
  const telemetry = labels?.telemetry ?? emptyTelemetry('page-diff', 'deterministic');
  return { payload, telemetry: { ...telemetry, durationMs: Date.now() - startedAt }, why: acceptWhy(labels?.output.whyDoThis) };
}

export async function hydrateCard(card: ActionBoardCard, ctx: WorkerContext, opts: WorkerRunOptions): Promise<WorkerResult> {
  const input: WorkerInput = { card, ctx, targetLanguage: opts.targetLanguage };
  switch (card.kind) {
    case 'page_diff':
      return hydratePageDiff(card, ctx, opts);
    case 'doc_draft':
      return hydrateDocDraft(input, opts);
    case 'video_script':
      return hydrateVideo(input, opts);
    case 'form_pack':
      return hydrateForm(input, opts);
    case 'pr_patch':
      return hydratePr(input, opts);
    case 'community_reply':
      return hydrateCommunityReply(card, ctx, opts);
    case 'outreach_email':
      return hydrateOutreachEmail(card, ctx, opts);
  }
}

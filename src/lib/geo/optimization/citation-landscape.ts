import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isProjectOwnedUrl } from '../asset-ownership';
import { ensureProjectRelationalData, parseSourcesJson, withProjectDb } from '../db';
import { readOutreachRecords } from '../outreach/outreach-store';
import { loadProjectSeed } from '../project-data';
import { evidenceLocation, withGeoProject } from '../projects';
import { extractRegistrableDomainParts, parseGitHubRepoUrl } from '../source-identity';
import type { GeoProject } from '../types';
import {
  AUTHORITY_EDITORIAL_DOMAINS,
  classifyCitedChannel,
  classifyOwnedWedge,
  loadQuestionPlanSignalsMap,
  lookupQuestionPlanMeta,
  normalizeUrlMeta,
  OPEN_CHANNEL_DOMAINS,
  parseRecommendedBrands,
  pickUnifiedEntityKey,
  type CitedChannelBucket,
  type OwnedContentWedge,
  type QuestionPlanMeta,
} from './citation-classifier';

export {
  classifyCitedChannel,
  formatWriterTargetQuestions,
  loadActiveQuestionsWithPlanMeta,
  loadQuestionPlanSignalsMap,
  lookupQuestionPlanMeta,
  normalizeUrlMeta,
  type CitedChannelBucket,
  type CompactCitedSource,
  type EnrichedTargetQuestion,
  type OwnedContentWedge,
  type QuestionPlanMeta,
} from './citation-classifier';

export interface ChannelCitationEntry {
  label: string;
  domains: string[];
  channel: CitedChannelBucket;
  questionCount: number;
  questionIds: string[];
  totalCitations: number;
  engines: Array<'chatgpt' | 'google'>;
  samplePages: Array<{ title: string; path: string; url: string }>;
}

export interface StrategicQuestionRow {
  questionId: string;
  category: string;
  query: string;
  tactic?: QuestionPlanMeta['tactic'];
  demandStatus?: string;
  demandStrength?: QuestionPlanMeta['demandStrength'];
  fanoutQueries: string[];
  ownedContentWedge: OwnedContentWedge;
  chatgpt?: { mention: string; citation: string; recommendedBrands: string[]; topCited: string[]; evidenceSnippet: string };
  google?: { mention: string; citation: string; recommendedBrands: string[]; topCited: string[]; evidenceSnippet: string };
}

export interface OptimizationStrategicBrief {
  coverage: {
    totalQuestions: number;
    measuredAnswers: number;
    mentionYes: number;
    citationYes: number;
    brand: {
      questions: number;
      measured: number;
      mentionYes: number;
      homonymRisk: boolean;
      homonymClues: string[];
    };
    discovery: { questions: number; measured: number; mentionYes: number };
    byEngine: Record<'chatgpt' | 'google', { measured: number; mentionYes: number; citationYes: number }>;
  };
  citationLandscape: {
    openChannel: ChannelCitationEntry[];
    directCompetitorRepos: ChannelCitationEntry[];
    directCompetitorSites: ChannelCitationEntry[];
    thirdPartyRoundups: ChannelCitationEntry[];
    authorityEditorial: ChannelCitationEntry[];
    channelGuidance: string[];
  };
  questionMatrix: StrategicQuestionRow[];
  alreadyShipped: {
    existingRepoDocs: string[];
    recentShippedDeliverables: Array<{ title: string; destination: string; kind: string; appliedAt: string }>;
    outreachItems: Array<{ title: string; kind: string; status: string; resultUrl?: string }>;
  };
}

const HOMONYM_CLUE_RE =
  /(?:同名|另一个|并非|不是.*项目|another project|multiple projects|unrelated|homonym|same name)/i;

/** True only when this checkout's `origin` is the project's own GitHub repository, so local repo files belong to it. */
export function isWorkspaceRepoForProject(project: Pick<GeoProject, 'repositoryUrl'>): boolean {
  const projectSlug = parseGitHubRepoUrl(project.repositoryUrl ?? '', { allowSubpaths: true });
  if (!projectSlug) return false;
  try {
    const rawRemote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_500,
    }).trim();
    const sshMatch = rawRemote.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
    const remoteSlug = sshMatch
      ? { owner: sshMatch[1], repo: sshMatch[2] }
      : parseGitHubRepoUrl(rawRemote, { allowSubpaths: true });
    if (
      !remoteSlug ||
      remoteSlug.owner.toLowerCase() !== projectSlug.owner.toLowerCase() ||
      remoteSlug.repo.toLowerCase() !== projectSlug.repo.toLowerCase()
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

export function listWorkspaceRepoDocs(project: Pick<GeoProject, 'repositoryUrl'>): string[] {
  if (!isWorkspaceRepoForProject(project)) return [];
  const root = path.resolve(process.cwd());
  const docs: string[] = [];
  for (const rel of ['README.md', 'docs/getting-started.md']) {
    if (fs.existsSync(path.join(root, rel))) docs.push(rel);
  }
  for (const folder of ['blog', 'comparisons']) {
    const dir = path.join(root, 'docs', folder);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (/\.md$/i.test(entry) && !/\.zh-CN\.md$/i.test(entry)) docs.push(`docs/${folder}/${entry}`);
    }
  }
  return docs.sort();
}

export function buildOptimizationStrategicBrief(
  projectId: string,
  options?: { targetLanguage?: 'en' | 'zh' },
): OptimizationStrategicBrief {
  const seed = loadProjectSeed(projectId);
  const project = seed.project;
  const targetLang = options?.targetLanguage ?? project.targetLanguage ?? 'en';
  const planMaps = loadQuestionPlanSignalsMap(projectId);

  const { questions, latestObsByQuestion, recentShipped } = withProjectDb(projectId, (db, id) => {
    ensureProjectRelationalData(id, db);
    const qRows = db
      .prepare(
        `SELECT id, category, query_zh AS queryZh, query_en AS queryEn
         FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order ASC`,
      )
      .all(id) as Array<{ id: string; category: string | null; queryZh: string; queryEn: string }>;

    const obsRows = db
      .prepare(
        `SELECT o.id, o.question_id AS questionId, o.engine, o.language, o.sources_json AS sourcesJson,
                o.summary, a.mention, a.citation, a.mention_evidence AS mentionEvidence,
                a.recommended_competitors_json AS recommendedCompetitorsJson
         FROM opengeo_observations o
         JOIN opengeo_questions q ON q.project_id = o.project_id AND q.id = o.question_id
         LEFT JOIN opengeo_answer_audits a
           ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
         WHERE o.project_id = ? AND q.status = 'active' AND o.engine IN ('chatgpt', 'google')
         ORDER BY o.seq DESC`,
      )
      .all(id) as Array<{
      id: string;
      questionId: string;
      engine: 'chatgpt' | 'google';
      language: 'en' | 'zh';
      sourcesJson: string;
      summary: string;
      mention: string | null;
      citation: string | null;
      mentionEvidence: string | null;
      recommendedCompetitorsJson: string | null;
    }>;

    const latestMap = new Map<string, Map<'chatgpt' | 'google', (typeof obsRows)[number]>>();
    for (const row of obsRows) {
      let byEngine = latestMap.get(row.questionId);
      if (!byEngine) {
        byEngine = new Map();
        latestMap.set(row.questionId, byEngine);
      }
      const existing = byEngine.get(row.engine);
      if (!existing || (existing.language !== targetLang && row.language === targetLang)) {
        byEngine.set(row.engine, row);
      }
    }

    const shippedRows = db
      .prepare(
        `SELECT title, destination, kind, applied_record_json AS appliedRecordJson, updated_at AS updatedAt
         FROM opengeo_deliverables WHERE project_id = ? AND status = 'applied' ORDER BY updated_at DESC LIMIT 8`,
      )
      .all(id) as Array<{
      title: string;
      destination: string;
      kind: string;
      appliedRecordJson: string | null;
      updatedAt: string;
    }>;

    const shipped = shippedRows.map((r) => {
      let appliedAt = r.updatedAt;
      if (r.appliedRecordJson) {
        try {
          const rec = JSON.parse(r.appliedRecordJson) as { appliedAt?: string };
          if (rec.appliedAt) appliedAt = rec.appliedAt;
        } catch {
          // Keep updatedAt
        }
      }
      return { title: r.title, destination: r.destination, kind: r.kind, appliedAt };
    });

    return { questions: qRows, latestObsByQuestion: latestMap, recentShipped: shipped };
  });

  const knownSiteRoots = new Set<string>();
  const allSiteStems = new Set<string>();
  for (const byEngine of latestObsByQuestion.values()) {
    for (const obs of byEngine.values()) {
      for (const src of parseSourcesJson(obs.sourcesJson)) {
        if (!src.url || isProjectOwnedUrl(src.url, project)) continue;
        const meta = normalizeUrlMeta(src.url);
        if (!meta || meta.host === 'github.com') continue;
        if (OPEN_CHANNEL_DOMAINS.has(meta.registrable) || AUTHORITY_EDITORIAL_DOMAINS.has(meta.registrable)) {
          continue;
        }
        if (meta.isRootOrProduct) {
          knownSiteRoots.add(meta.registrable);
          const sld = extractRegistrableDomainParts(meta.registrable)?.sld;
          if (sld) allSiteStems.add(sld);
        }
      }
    }
  }

  const entityMap = new Map<
    string,
    {
      label: string;
      domains: Set<string>;
      channel: CitedChannelBucket;
      questionIds: Set<string>;
      totalCitations: number;
      engines: Set<'chatgpt' | 'google'>;
      samplePages: Map<string, { title: string; path: string; url: string }>;
    }
  >();

  let measuredAnswers = 0;
  let mentionYes = 0;
  let citationYes = 0;
  let brandQuestions = 0;
  let brandMeasured = 0;
  let brandMentionYes = 0;
  let discoveryQuestions = 0;
  let discoveryMeasured = 0;
  let discoveryMentionYes = 0;
  const homonymClues: string[] = [];
  const byEngineStats: Record<'chatgpt' | 'google', { measured: number; mentionYes: number; citationYes: number }> = {
    chatgpt: { measured: 0, mentionYes: 0, citationYes: 0 },
    google: { measured: 0, mentionYes: 0, citationYes: 0 },
  };
  const questionMatrix: StrategicQuestionRow[] = [];

  for (const q of questions) {
    const planMeta = lookupQuestionPlanMeta(planMaps, q);
    const isBrand = q.category === 'brand' || planMeta?.tactic === 'brand-check';
    if (isBrand) brandQuestions += 1;
    else discoveryQuestions += 1;

    const byEngine = latestObsByQuestion.get(q.id);
    const rowChannels = new Set<CitedChannelBucket>();
    const engineSummary: Partial<
      Record<
        'chatgpt' | 'google',
        { mention: string; citation: string; recommendedBrands: string[]; topCited: string[]; evidenceSnippet: string }
      >
    > = {};

    for (const engine of ['chatgpt', 'google'] as const) {
      const obs = byEngine?.get(engine);
      if (!obs) continue;
      measuredAnswers += 1;
      byEngineStats[engine].measured += 1;
      const m = obs.mention ?? 'unknown';
      const c = obs.citation ?? 'unknown';
      if (m === 'yes') {
        mentionYes += 1;
        byEngineStats[engine].mentionYes += 1;
      }
      if (c === 'yes') {
        citationYes += 1;
        byEngineStats[engine].citationYes += 1;
      }
      if (isBrand) {
        brandMeasured += 1;
        if (m === 'yes') brandMentionYes += 1;
      } else {
        discoveryMeasured += 1;
        if (m === 'yes') discoveryMentionYes += 1;
      }

      const topCitedLabels: string[] = [];
      const seenInObs = new Set<string>();
      for (const src of parseSourcesJson(obs.sourcesJson)) {
        if (!src.url || isProjectOwnedUrl(src.url, project)) continue;
        const meta = normalizeUrlMeta(src.url);
        if (!meta) continue;
        const title = (src.title ?? '').replace(/\s+/g, ' ').trim();
        const channel = classifyCitedChannel(meta.url, title, knownSiteRoots);
        rowChannels.add(channel);

        const gh = meta.host === 'github.com' ? parseGitHubRepoUrl(meta.url, { allowSubpaths: true }) : null;
        const ghKey = gh ? `github:${gh.owner}/${gh.repo}` : null;
        const unified = pickUnifiedEntityKey(meta.registrable, channel, ghKey, allSiteStems);

        if (!seenInObs.has(unified.label)) {
          seenInObs.add(unified.label);
          if (topCitedLabels.length < 6) topCitedLabels.push(`${unified.label} [${channel}]`);
        }

        let bucket = entityMap.get(unified.key);
        if (!bucket) {
          bucket = {
            label: unified.label,
            domains: new Set([meta.registrable]),
            channel,
            questionIds: new Set([q.id]),
            totalCitations: 1,
            engines: new Set([engine]),
            samplePages: new Map(),
          };
          entityMap.set(unified.key, bucket);
        } else {
          bucket.domains.add(meta.registrable);
          bucket.questionIds.add(q.id);
          bucket.totalCitations += 1;
          bucket.engines.add(engine);
        }
        if (bucket.samplePages.size < 2 && !bucket.samplePages.has(meta.url)) {
          bucket.samplePages.set(meta.url, {
            title: title.slice(0, 64) || meta.registrable,
            path: meta.path.slice(0, 60),
            url: meta.url,
          });
        }
      }

      const evidenceSnippet = (obs.mentionEvidence || obs.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (isBrand && m === 'no' && (HOMONYM_CLUE_RE.test(evidenceSnippet) || topCitedLabels.length > 0)) {
        homonymClues.push(`${engine}: ${evidenceSnippet}`);
      }
      engineSummary[engine] = {
        mention: m,
        citation: c,
        recommendedBrands: parseRecommendedBrands(obs.recommendedCompetitorsJson),
        topCited: topCitedLabels,
        evidenceSnippet,
      };
    }

    questionMatrix.push({
      questionId: q.id,
      category: q.category ?? 'problem',
      query: targetLang === 'en' ? q.queryEn || q.queryZh : q.queryZh || q.queryEn,
      ...(planMeta?.tactic ? { tactic: planMeta.tactic } : {}),
      ...(planMeta?.demandStatus ? { demandStatus: planMeta.demandStatus } : {}),
      ...(planMeta?.demandStrength ? { demandStrength: planMeta.demandStrength } : {}),
      fanoutQueries: planMeta?.fanoutQueries ?? [],
      ownedContentWedge: classifyOwnedWedge({
        category: q.category ?? 'problem',
        tactic: planMeta?.tactic,
        channels: rowChannels,
      }),
      ...(engineSummary.chatgpt ? { chatgpt: engineSummary.chatgpt } : {}),
      ...(engineSummary.google ? { google: engineSummary.google } : {}),
    });
  }

  const byBucket = (channel: CitedChannelBucket): ChannelCitationEntry[] =>
    [...entityMap.values()]
      .filter((e) => e.channel === channel)
      .sort((a, b) => b.questionIds.size - a.questionIds.size || b.totalCitations - a.totalCitations)
      .slice(0, 6)
      .map((e) => ({
        label: e.label,
        domains: [...e.domains],
        channel: e.channel,
        questionCount: e.questionIds.size,
        questionIds: [...e.questionIds],
        totalCitations: e.totalCitations,
        engines: [...e.engines],
        samplePages: [...e.samplePages.values()],
      }));

  const openChannel = byBucket('open_channel');
  const directCompetitorRepos = byBucket('direct_competitor_repo');
  const directCompetitorSites = byBucket('direct_competitor_site');
  const thirdPartyRoundups = byBucket('third_party_roundup');
  const authorityEditorial = byBucket('authority_editorial');

  const channelGuidance: string[] = [];
  if (authorityEditorial.length > 0) {
    channelGuidance.push(
      `Authority/editorial giants (${authorityEditorial.slice(0, 3).map((e) => e.label).join(', ')}) dominate generic glossary queries — avoid writing a generic definition clone; win via focused comparisons and practical workflows.`,
    );
  }
  if (thirdPartyRoundups.length > 0 || directCompetitorRepos.length > 0) {
    channelGuidance.push(
      `Independent comparison blogs (${thirdPartyRoundups.slice(0, 3).map((e) => e.label).join(', ') || 'none'}) and open-source repos (${directCompetitorRepos.slice(0, 3).map((e) => e.label).join(', ') || 'none'}) are actively cited — dedicated comparison & alternative guides are the highest-leverage owned-content wedge.`,
    );
  }
  if (openChannel.length > 0) {
    channelGuidance.push(
      `Self-serve open channels (${openChannel.slice(0, 3).map((e) => `${e.label} ${e.questionCount}q`).join(', ')}) hold heavy citation share — pair owned docs with clear quotable answers and off-site distribution.`,
    );
  }

  let outreachItems: Array<{ title: string; kind: string; status: string; resultUrl?: string }> = [];
  try {
    outreachItems = readOutreachRecords(projectId)
      .slice(0, 8)
      .map((r) => ({
        title: r.title,
        kind: r.kind,
        status: r.status,
        ...(r.resultUrl ? { resultUrl: r.resultUrl } : {}),
      }));
  } catch {
    outreachItems = [];
  }

  return {
    coverage: {
      totalQuestions: questions.length,
      measuredAnswers,
      mentionYes,
      citationYes,
      brand: {
        questions: brandQuestions,
        measured: brandMeasured,
        mentionYes: brandMentionYes,
        homonymRisk: brandQuestions > 0 && brandMentionYes === 0 && homonymClues.length > 0,
        homonymClues: homonymClues.slice(0, 3),
      },
      discovery: { questions: discoveryQuestions, measured: discoveryMeasured, mentionYes: discoveryMentionYes },
      byEngine: byEngineStats,
    },
    citationLandscape: {
      openChannel,
      directCompetitorRepos,
      directCompetitorSites,
      thirdPartyRoundups,
      authorityEditorial,
      channelGuidance,
    },
    questionMatrix,
    alreadyShipped: {
      existingRepoDocs: listWorkspaceRepoDocs(project),
      recentShippedDeliverables: recentShipped,
      outreachItems,
    },
  };
}

export function formatCitationLandscapeForContext(brief: OptimizationStrategicBrief): string[] {
  const lines: string[] = [];
  const { directCompetitorSites, directCompetitorRepos, thirdPartyRoundups, authorityEditorial, openChannel } =
    brief.citationLandscape;
  const renderBucket = (heading: string, items: ChannelCitationEntry[]) => {
    if (!items.length) return;
    lines.push(`### ${heading}`);
    for (const item of items.slice(0, 5)) {
      const sample = item.samplePages[0];
      const urlHint = sample ? ` (${sample.url})` : '';
      lines.push(
        `- ${item.label}${urlHint} — cited across ${item.questionCount} prompt(s) (${item.engines.join(' + ')})`,
      );
    }
    lines.push('');
  };
  renderBucket('Direct Competitors (Product Sites & Open-Source Repos)', [
    ...directCompetitorSites.slice(0, 4),
    ...directCompetitorRepos.slice(0, 4),
  ]);
  renderBucket('Independent Roundups & Comparison Guides Cited', thirdPartyRoundups);
  renderBucket('High-Authority Editorial Sources Cited', authorityEditorial);
  renderBucket('Open Community, Video & Directory Channels Cited', openChannel);
  return lines;
}

export function buildCompactCitationSummary(projectId: string, targetLanguage?: 'en' | 'zh') {
  const brief = buildOptimizationStrategicBrief(projectId, { targetLanguage });
  const pick = (items: ChannelCitationEntry[]) =>
    items.slice(0, 5).map((i) => ({ label: i.label, questions: i.questionCount, engines: i.engines }));
  return {
    directCompetitors: pick([
      ...brief.citationLandscape.directCompetitorSites,
      ...brief.citationLandscape.directCompetitorRepos,
    ]),
    thirdPartyRoundups: pick(brief.citationLandscape.thirdPartyRoundups),
    authorityEditorial: pick(brief.citationLandscape.authorityEditorial),
    openChannels: pick(brief.citationLandscape.openChannel),
    channelGuidance: brief.citationLandscape.channelGuidance,
  };
}

export function buildOutreachDraftPayload(
  projectId: string,
  target: { title: string; targetUrl: string; channelLabel?: string },
  project: Pick<GeoProject, 'name' | 'description' | 'repositoryUrl' | 'siteUrl'>,
  projectContextMarkdown: string,
) {
  const targetMeta = normalizeUrlMeta(target.targetUrl);
  const matchedPrompts: string[] = [];
  const answerExcerpts: string[] = [];
  try {
    const planMaps = loadQuestionPlanSignalsMap(projectId);
    withProjectDb(projectId, (db, id) => {
      ensureProjectRelationalData(id, db);
      const rows = db
        .prepare(
          `SELECT q.id AS questionId, q.query_en AS queryEn, q.query_zh AS queryZh,
                  o.engine, o.sources_json AS sourcesJson, o.summary, o.answer_path AS answerPath,
                  a.mention_evidence AS mentionEvidence
           FROM opengeo_observations o
           JOIN opengeo_questions q ON q.project_id = o.project_id AND q.id = o.question_id
           LEFT JOIN opengeo_answer_audits a
             ON a.project_id = o.project_id AND a.observation_id = o.id AND a.is_current = 1
           WHERE o.project_id = ? AND q.status = 'active' ORDER BY o.seq DESC`,
        )
        .all(id) as Array<{
        questionId: string;
        queryEn: string;
        queryZh: string;
        engine: string;
        sourcesJson: string;
        summary: string;
        answerPath: string | null;
        mentionEvidence: string | null;
      }>;
      const seenQ = new Set<string>();
      for (const row of rows) {
        const hit = parseSourcesJson(row.sourcesJson).some((s) => {
          const m = normalizeUrlMeta(s.url ?? '');
          if (targetMeta && m) {
            return m.url === targetMeta.url || (m.host === targetMeta.host && m.path === targetMeta.path);
          }
          return Boolean(target.title && (s.title ?? '').toLowerCase().includes(target.title.toLowerCase()));
        });
        if (!hit || seenQ.has(row.questionId)) continue;
        seenQ.add(row.questionId);
        const promptText = row.queryEn || row.queryZh;
        const planMeta = lookupQuestionPlanMeta(planMaps, {
          id: row.questionId,
          queryEn: row.queryEn,
          queryZh: row.queryZh,
        });
        const subAngles = planMeta?.fanoutQueries?.length
          ? ` (related: ${planMeta.fanoutQueries.slice(0, 3).join(', ')})`
          : '';
        matchedPrompts.push(`${promptText}${subAngles}`);
        let excerpt = (row.mentionEvidence || row.summary || '').replace(/\s+/g, ' ').trim();
        if (row.answerPath) {
          try {
            const fullPath = withGeoProject(projectId, () => evidenceLocation(row.answerPath!).target);
            if (fs.existsSync(fullPath)) {
              excerpt = fs.readFileSync(fullPath, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 420);
            }
          } catch {
            // Keep summary excerpt
          }
        }
        if (excerpt) answerExcerpts.push(`[${row.engine}] ${excerpt.slice(0, 360)}`);
        if (matchedPrompts.length >= 3) break;
      }
    });
  } catch {
    // Non-fatal fallback
  }

  return {
    channel: target.channelLabel ?? target.title,
    targetUrl: target.targetUrl,
    project: { name: project.name, repoUrl: project.repositoryUrl || project.siteUrl || '', description: project.description },
    projectContextExcerpt: projectContextMarkdown.slice(0, 1800),
    ...(matchedPrompts.length ? { buyerPromptsCitingThisThread: matchedPrompts } : {}),
    ...(answerExcerpts.length ? { aiAnswerExcerpts: answerExcerpts } : {}),
  };
}

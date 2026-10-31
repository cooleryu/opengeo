import { createHash } from 'node:crypto';
import { currentGeoProject, withGeoProject } from './projects';
import { getLatestResearch, getResearchBatch } from './research';
import { getSeed } from './seed';
import { attachOverviewData } from './overview-data';
import { attachCompetitorPerformance } from './competitor-performance';
import { getResearchRows } from './research-view';
import { isAiAnswerRow } from './overview-metrics';
import { COMPETITOR_ANALYSIS_VERSION, competitorCandidateId, getCompetitorSelection, readStoredCompetitors, saveStoredCompetitor } from './competitor-store';
import { analyzePreparedCompetitors, eligibleCompetitorCandidates, prepareCompetitorAnalysis, rankCompetitorCandidates, readDisplayedCompetitorAnalysis } from './competitor-analysis';
import type { CompetitorCitationAuditOptions } from './competitor-citation-audit';
import type { GeoStructuredModel } from './connection-settings';
import {
  buildCompetitorComparison,
  CompetitorError,
  matchCompetitorIdentity,
  matchCompetitorNames,
  matchesOfficialUrl,
  normalizeCompetitorTarget,
  readCompetitorEvidence,
  readCompetitorObservationAnswer,
  readCompetitorTarget,
  saveCompetitorTarget,
} from './competitors';
import type {
  CompetitorCandidate,
  CompetitorCandidates,
  CompetitorComparison,
  CompetitorRankingScope,
  CompetitorRecommendationEvidence,
  CompetitorTarget,
} from './competitor-types';
import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
  ResearchSource,
} from './research-types';
import type { GeoProject } from './types';

// A publisher or community root is not a product identity. Article URLs never
// qualify below; this list also excludes common shared publishing home pages.
const publishingHosts =
  /(^|\.)(?:youtube\.com|youtu\.be|bilibili\.com|reddit\.com|medium\.com|substack\.com|csdn\.net|zhihu\.com|arxiv\.org|aclanthology\.org|wikipedia\.org|twitter\.com|x\.com|facebook\.com|news\.ycombinator\.com|weixin\.qq\.com|greasyfork\.org)$/i;
const collectionName =
  /(?:^|[-_\s/])(?:awesome|weekly|news|book|guide|guides|compass|cheat[-_ ]?sheet)(?:$|[-_\s/])|精选列表|资源合集|论文列表|reading list|curated list/i;
const compact = (value: string) =>
  value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function sourceIdentity(source: ResearchSource): {
  name: string;
  aliases: string[];
  url: string;
  repository: boolean;
} | null {
  if (source.kind === 'self_submission' || source.kind === 'mirror')
    return null;
  try {
    const url = new URL(source.url);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'github.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      // An issue, discussion, source file or wiki can be about another product.
      // A concrete repository root is the only discovery entry point here.
      if (
        parts.length !== 2 ||
        !parts.every((part) => /^[a-z0-9_.-]+$/i.test(part))
      )
        return null;
      const [owner, repository] = parts;
      if (collectionName.test(repository) || collectionName.test(source.title))
        return null;
      const titleName = source.title.trim();
      const name =
        compact(titleName) === compact(repository) && titleName.length <= 120
          ? titleName
          : repository;
      const aliases = [
        ...new Set([repository, repository.replace(/[-_]+/g, ' ')]),
      ].filter((alias) => alias.toLowerCase() !== name.toLowerCase());
      return {
        name,
        aliases,
        url: `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`,
        repository: true,
      };
    }
    if (
      publishingHosts.test(host) ||
      url.pathname.replace(/\//g, '') ||
      url.search
    )
      return null;
    const name = source.title
      .replace(/\s*[|｜].*$/, '')
      .split(/\s+[—–-]\s+/)[0]
      .trim();
    const domainName = host.split('.')[0];
    // A title naming the same brand as its dedicated home page is a bounded
    // identity hint. Do not derive a competitor from arbitrary article domains.
    if (
      name.length < 3 ||
      name.length > 80 ||
      (compact(name) !== compact(domainName) && compact(name) !== compact(host))
    )
      return null;
    return {
      name,
      aliases: [],
      url: `${url.protocol}//${url.host}/`,
      repository: false,
    };
  } catch {
    return null;
  }
}

function isOwnEntry(source: string, official: string): boolean {
  try {
    const left = new URL(source);
    const right = new URL(official);
    if (left.hostname === 'github.com' && right.hostname === 'github.com') {
      left.pathname = left.pathname.toLowerCase();
      right.pathname = right.pathname.toLowerCase();
      return matchesOfficialUrl(left.href, right.href);
    }
  } catch {
    return false;
  }
  return matchesOfficialUrl(source, official);
}

/** Discover identities only from stored observations. This performs no search or model call. */
export function discoverCompetitorCandidates(
  project: GeoProject,
  batch: ResearchBatch | null,
  read: (file: string) => string | null = readCompetitorEvidence,
): CompetitorCandidate[] {
  if (!batch || batch.projectId !== project.id) return [];
  const ownUrls = [project.siteUrl, project.repositoryUrl].filter(Boolean);
  const ownNames = [project.name];
  try {
    const repositoryName = new URL(project.repositoryUrl).pathname
      .split('/')
      .filter(Boolean)
      .at(-1);
    if (repositoryName) ownNames.push(repositoryName);
  } catch {
    /* A website-only project has no repository alias. */
  }
  const candidates = new Map<string, CompetitorCandidate>();
  const evidenceCache = new Map<string, string | null>();
  const cachedRead = (file: string) => {
    if (!evidenceCache.has(file)) evidenceCache.set(file, read(file));
    return evidenceCache.get(file)!;
  };
  const answers: {
    question: ResearchQuestion;
    observation: ResearchObservation;
    observationIndex: number;
    answer: string | null;
  }[] = [];
  for (const question of batch.questions) {
    // Pure own-brand navigation often returns homonyms. Those sources do not
    // establish a shared need and must not populate the competitor pool.
    if (
      question.category === 'brand' ||
      [question.zh, question.en].some(
        (query) =>
          matchCompetitorNames(
            query.replace(/[-_]+/g, ' '),
            ownNames.map((name) => name.replace(/[-_]+/g, ' ')),
          ).status === 'matched' &&
          /是什么|官方仓库|官方(?:网站|入口)|what is|official (?:repository|repo|website|documentation)|where.*(?:repository|documentation)/i.test(
            query,
          ),
      )
    )
      continue;
    for (const [
      observationIndex,
      observation,
    ] of question.observations.entries()) {
      const answer = readCompetitorObservationAnswer(observation, cachedRead);
      answers.push({ question, observation, observationIndex, answer });
      const observed = new Set<string>();
      for (const source of observation.sources) {
        if (
          observation.engine === 'google' &&
          (!Number.isInteger(source.position) || (source.position ?? 0) < 1)
        )
          continue;
        const identity = sourceIdentity(source);
        if (
          !identity ||
          ownUrls.some(
            (url) =>
              isOwnEntry(identity.url, url) || isOwnEntry(source.url, url),
          )
        )
          continue;
        const id = competitorCandidateId(project.id, identity.url);
        if (observed.has(id)) continue;
        observed.add(id);
        let candidate = candidates.get(id);
        if (!candidate) {
          candidate = {
            id,
            name: identity.name,
            aliases: identity.aliases,
            officialUrls: [identity.url],
            description: source.title.slice(0, 240),
            reason: identity.repository
              ? '同题搜索记录包含这个具体开源仓库；是否构成替代或直接竞争仍待确认。'
              : '同题搜索记录包含名称相符的产品主页；是否构成替代或直接竞争仍待确认。',
            saved: false,
            questions: [],
          };
          candidates.set(id, candidate);
        }
        const mention = matchCompetitorNames(answer, [
          identity.name,
          ...identity.aliases,
        ]);
        candidate.questions.push({
          batchId: batch.id,
          questionId: question.id,
          question: question[observation.language],
          language: observation.language,
          engine: observation.engine,
          recordedAt: observation.recordedAt,
          collectedAt: observation.collectedAt,
          evidencePath: observation.evidencePath,
          answerPath: observation.answerPath,
          observationIndex,
          sourceUrl: source.url,
          excerpt: (mention.excerpts[0] || source.title).slice(0, 320),
        });
      }
    }
  }
  // Once an identity has a concrete discovery source, connect its mentions in
  // other readable answers without inventing identities or rereading evidence.
  for (const candidate of candidates.values()) {
    const linked = new Set(
      candidate.questions.map(
        (item) => `${item.questionId}:${item.observationIndex}`,
      ),
    );
    for (const { question, observation, observationIndex, answer } of answers) {
      if (linked.has(`${question.id}:${observationIndex}`)) continue;
      const mention = matchCompetitorIdentity(
        answer,
        [candidate.name, ...candidate.aliases],
        candidate.officialUrls,
      );
      if (mention.status !== 'matched') continue;
      const officialSource = observation.sources.find((source) =>
        candidate.officialUrls.some((url) =>
          matchesOfficialUrl(source.url, url),
        ),
      );
      candidate.questions.push({
        batchId: batch.id,
        questionId: question.id,
        question: question[observation.language],
        language: observation.language,
        engine: observation.engine,
        recordedAt: observation.recordedAt,
        collectedAt: observation.collectedAt,
        evidencePath: observation.evidencePath,
        answerPath: observation.answerPath,
        observationIndex,
        sourceUrl: officialSource?.url || '',
        excerpt: (mention.excerpts[0] || '').slice(0, 320),
      });
    }
  }
  for (const candidate of candidates.values()) candidate.questions = candidate.questions.map((item) => ({
    ...item, evidenceId: `evidence-${createHash('sha256').update(JSON.stringify([project.id, item.batchId, item.questionId, item.engine, item.language, item.recordedAt, item.evidencePath, item.answerPath, item.observationIndex, item.sourceUrl])).digest('hex').slice(0, 24)}`,
  }));
  return [...candidates.values()].sort(
    (a, b) =>
      b.questions.length - a.questions.length || a.name.localeCompare(b.name),
  );
}

export function readSavedCompetitorCandidates(): CompetitorCandidate[] {
  return readStoredCompetitors().filter((candidate) => candidate.saved);
}

function selectedBatch(
  projectId: string,
  batchId?: string,
): ResearchBatch | null {
  if (
    batchId !== undefined &&
    (typeof batchId !== 'string' || !batchId.trim() || batchId.length > 200)
  )
    throw new CompetitorError('研究批次编号无效。');
  const batch =
    batchId === undefined
      ? getLatestResearch(projectId)
      : getResearchBatch(projectId, batchId);
  if (batchId !== undefined && !batch)
    throw new CompetitorError('没有找到当前项目的研究批次。', 404);
  return batch;
}

function candidateContext(batchId?: string) {
  const project = getSeed().project;
  const batch = attachOverviewData(selectedBatch(project.id, batchId));
  const stored = readStoredCompetitors();
  const evidenceCache = new Map<string, string | null>();
  const read = (file: string) => {
    if (!evidenceCache.has(file)) evidenceCache.set(file, readCompetitorEvidence(file));
    return evidenceCache.get(file)!;
  };
  const discovered = discoverCompetitorCandidates(project, batch, read);
  const target = readCompetitorTarget();
  const selection = getCompetitorSelection();
  const current = new Map(stored.map((candidate) => [candidate.id, candidate]));
  for (const candidate of discovered) {
    const previous = current.get(candidate.id);
    current.set(candidate.id, { ...candidate, saved: previous?.saved ?? false, analysis: previous?.analysis });
  }
  const all = [...current.values()];
  // Historical identities stay previewable; only current-batch evidence enters
  // a new analysis. Reserve a slot for the chosen target when it has evidence.
  const independentCoverage = (candidate: CompetitorCandidate) => new Set(candidate.questions
    .filter((item) => item.batchId === batch?.id).map((item) => `${item.questionId}:${item.engine}:${item.language}`)).size;
  const eligible = all.filter((candidate) => independentCoverage(candidate) > 0)
    .sort((a, b) => independentCoverage(b) - independentCoverage(a) || a.id.localeCompare(b.id));
  const bounded = eligible.slice(0, 12);
  const selected = eligible.find((candidate) => candidate.id === selection?.candidateId);
  if (selected && !bounded.some((candidate) => candidate.id === selected.id)) bounded.splice(11, 1, selected);
  const comparisons = new Map(bounded.map((candidate) => [candidate.id, buildCompetitorComparison(project, batch, normalizeCompetitorTarget(candidate), read)]));
  const prepared = prepareCompetitorAnalysis(project, batch?.id ?? null, bounded, comparisons, eligible.length, eligible);
  return { project, batch, target, selection, all, prepared, read };
}

function citationCandidates(candidates: CompetitorCandidate[], context: ReturnType<typeof candidateContext>): CompetitorCandidate[] {
  const selected = context.all.find((candidate) => candidate.id === context.selection?.candidateId);
  // A user's explicit target is also a valid audit identity, even if a later
  // relevance review does not recommend it. Merely discovered URLs are excluded.
  return [...new Map([...eligibleCompetitorCandidates(candidates), ...(selected ? [selected] : [])]
    .map((candidate) => [candidate.id, candidate])).values()];
}

export function getCompetitorCandidates(batchId?: string, previewId?: string, scope?: CompetitorRankingScope): CompetitorCandidates {
  const { project, batch, target, selection, all, prepared, read } = candidateContext(batchId);
  const { active, result: saved, stale } = readDisplayedCompetitorAnalysis(prepared);
  const analysis = active?.state ?? saved?.state ?? { status: 'pending' as const, summary: '等待根据已保存的搜索记录进行 AI 推荐。' };
  // Only the same project's same-batch success can supply previous assessments.
  // Its quoted evidence stays attached; comparisons below always use current observations.
  const byId = new Map(all.map((candidate) => {
    const { analysis: _previousAnalysis, ...identity } = candidate;
    return [candidate.id, identity] as const;
  }));
  for (const candidate of saved?.candidates ?? []) byId.set(candidate.id, { ...candidate,
    saved: byId.get(candidate.id)?.saved ?? false,
    ...(candidate.analysis ? { analysis: { ...candidate.analysis, stale } } : {}) });
  const pendingCandidate = (candidate: CompetitorCandidate): CompetitorCandidate => candidate.analysis ? candidate : { ...candidate,
    analysis: { status: 'pending', description: '', reason: '', strengths: [], opportunities: [], limitations: ['尚未完成 AI 介绍与证据审核。'], evidenceIds: [], version: COMPETITOR_ANALYSIS_VERSION } };
  const comparisons = new Map<string, CompetitorComparison>();
  const comparisonFor = (identity: CompetitorTarget): CompetitorComparison => {
    const key = JSON.stringify([identity.name, identity.aliases, identity.officialUrls]);
    if (!comparisons.has(key)) {
      const comparison = buildCompetitorComparison(project, batch, identity, read);
      comparisons.set(key, attachCompetitorPerformance(batch, comparison, read));
    }
    return comparisons.get(key)!;
  };
  const withPerformance = (candidate: CompetitorCandidate): CompetitorCandidate => ({
    ...candidate, performance: comparisonFor(normalizeCompetitorTarget(candidate)!).performance,
  });
  // Measure every reviewed relevant candidate before limiting the cards to three.
  // In particular, a low legacy AI score must not hide a stronger observed result.
  // Keep rejected records in this handoff so legacy eligibility limits remain
  // visible, while computing performance only for the displayed eligible set.
  const eligibleIds = new Set(eligibleCompetitorCandidates(saved?.candidates ?? []).map((candidate) => candidate.id));
  const rankingScope = scope ?? { language: 'zh' as const, engine: 'all' as const };
  const currentRows = new Set(batch ? getResearchRows(batch, {
    ...rankingScope, kind: 'all', result: 'all',
  }).filter((row) => row.observation && isAiAnswerRow(row)).map((row) =>
    `${row.question.id}:${row.question.observations.indexOf(row.observation!)}:${row.engine}:${rankingScope.language}`) : []);
  const evidenceByCandidate = new Map<string, CompetitorRecommendationEvidence>();
  for (const candidate of saved?.candidates ?? []) {
    if (!eligibleIds.has(candidate.id)) continue;
    const comparison = comparisonFor(normalizeCompetitorTarget(byId.get(candidate.id)!)!);
    const row = comparison.rows.find((row) => row.targetMention.status === 'matched' &&
      currentRows.has(`${row.questionId}:${row.observationIndex}:${row.engine}:${row.language}`));
    if (row && comparison.batch) evidenceByCandidate.set(candidate.id, {
      batchId: comparison.batch.id, questionId: row.questionId, question: row.query || row.question,
      engine: row.engine, language: row.language, observationIndex: row.observationIndex,
    });
  }
  const ranked = rankCompetitorCandidates((saved?.candidates ?? []).map((candidate) =>
    eligibleIds.has(candidate.id) ? withPerformance(byId.get(candidate.id)!) : byId.get(candidate.id)!), rankingScope, evidenceByCandidate);
  const displayAnalysis = { ...analysis, ...(saved ? { generatedAt: saved.state.generatedAt, stale,
    summary: ranked.ranking.reason } : {}) };
  const recommendationById = new Map(ranked.allCandidates.map((candidate) => [candidate.id, candidate.recommendation]));
  const candidateForDisplay = (candidate: CompetitorCandidate) => ({ ...withPerformance(pendingCandidate(candidate)),
    ...(recommendationById.has(candidate.id) ? { recommendation: recommendationById.get(candidate.id),
      reason: recommendationById.get(candidate.id)!.reason } : {}) });
  const result: CompetitorCandidates = {
    projectId: project.id, batch: batch ? { id: batch.id, date: batch.date } : null, target,
    candidates: ranked.candidates, ranking: ranked.ranking,
    analysis: displayAnalysis, selection,
    selectedCandidate: selection && byId.has(selection.candidateId) ? candidateForDisplay(byId.get(selection.candidateId)!) : null,
  };
  if (target) result.comparison = { ...comparisonFor(target), selection };
  if (previewId !== undefined) {
    const candidate = byId.get(previewId);
    if (!candidate) throw new CompetitorError('没有找到当前项目的候选对象。', 404);
    result.previewCandidate = candidateForDisplay(candidate);
    result.comparison = { ...comparisonFor(normalizeCompetitorTarget(candidate)!),
      selection: selection?.candidateId === candidate.id ? selection : null };
  }
  return result;
}

export async function analyzeCompetitorCandidates(batchId?: string,
  options: { force?: boolean; model?: GeoStructuredModel; timeoutMs?: number } = {}): Promise<CompetitorCandidates> {
  const projectId = currentGeoProject();
  return withGeoProject(projectId, async () => {
    const context = candidateContext(batchId);
    const result = await analyzePreparedCompetitors(context.prepared, options);
    if (result.state.status === 'ready' && context.batch) {
      const { auditCompetitorCitations } = await import('./competitor-citation-audit');
      await auditCompetitorCitations(context.batch, citationCandidates(result.candidates, context));
    }
    return getCompetitorCandidates(batchId);
  });
}

/** Explicit local citation verification; viewing or switching scope never runs it. */
export async function auditCompetitorCandidateCitations(batchId?: string,
  options: CompetitorCitationAuditOptions = {}): Promise<CompetitorCandidates> {
  const projectId = currentGeoProject();
  return withGeoProject(projectId, async () => {
    const context = candidateContext(batchId);
    if (context.batch) {
      const { auditCompetitorCitations } = await import('./competitor-citation-audit');
      const { result } = readDisplayedCompetitorAnalysis(context.prepared);
      await auditCompetitorCitations(context.batch, citationCandidates(result?.candidates ?? [], context), options);
    }
    return getCompetitorCandidates(batchId);
  });
}

export function updateCompetitorCandidate(action: unknown, id: unknown, batchId?: string): CompetitorCandidates {
  if (!['save', 'unsave', 'select'].includes(String(action)) || typeof id !== 'string' || !/^candidate-[a-f0-9]{24}$/.test(id)) {
    throw new CompetitorError('候选操作格式无效。');
  }
  const context = candidateContext(batchId);
  const candidate = context.all.find((item) => item.id === id);
  if (!candidate) throw new CompetitorError('没有找到当前项目的候选对象。', 404);
  saveStoredCompetitor({ ...candidate, saved: action !== 'unsave' });
  if (action === 'select') saveCompetitorTarget(candidate, batchId);
  return getCompetitorCandidates(batchId);
}

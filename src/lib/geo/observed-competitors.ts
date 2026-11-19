import { isProjectOwnedUrl } from './asset-ownership';
import {
  auditRows,
  isAiAnswerRow,
  type AuditedResearchRow,
} from './overview-metrics';
import {
  getBatchResearchEngines,
  RESEARCH_ENGINE_NAMES,
} from './research-engines';
import type {
  ResearchBatch,
  ResearchEngine,
  ResearchQuestion,
} from './research-types';
import {
  extractOverviewGapSources,
  extractQuestionTopWinners,
  getLatestResearchObservation,
  getResearchRows,
  isBrandPrompt,
  normalizeExternalCitedSource,
  observationTime,
  type OverviewGapSource,
  type TopExternalCitedSource,
} from './research-view';
import type { GeoProject } from './types';

export type ObservedEngineStatus =
  | 'cited'
  | 'mentioned'
  | 'missed'
  | 'uncertain'
  | 'unmeasured';

export interface ObservedCompetitorEntry {
  key: string;
  label: string;
  url: string;
  questionCount: number;
  missedByYouCount: number;
  totalHits: number;
  engines: ResearchEngine[];
  questionIds: string[];
  samplePages: Array<{ title: string; url: string; engine: ResearchEngine }>;
}

export interface ObservedCompetitorQuestionRow {
  question: ResearchQuestion;
  isBrand: boolean;
  engineStatuses: Array<{
    engine: ResearchEngine;
    status: ObservedEngineStatus;
    row?: AuditedResearchRow;
  }>;
  youCovered: boolean;
  youCited: boolean;
  winners: TopExternalCitedSource[];
}

export interface ObservedCompetitorEngineSummary {
  engine: ResearchEngine;
  measured: number;
  ownMentionYes: number;
  ownCitationYes: number;
  topWinner: { label: string; questionCount: number } | null;
}

export interface ObservedCompetitorSnapshot {
  projectName: string;
  language: 'zh' | 'en';
  engines: ResearchEngine[];
  totalQuestions: number;
  measuredAnswers: number;
  ownMentionYes: number;
  ownCitationYes: number;
  ownCoveredQuestions: number;
  ownCitedQuestions: number;
  perEngine: ObservedCompetitorEngineSummary[];
  competitors: ObservedCompetitorEntry[];
  gapSources: OverviewGapSource[];
  questionRows: ObservedCompetitorQuestionRow[];
  latestObservedDate: string | null;
}

function classifyRowStatus(row?: AuditedResearchRow): ObservedEngineStatus {
  if (!row?.observation) return 'unmeasured';
  if (isAiAnswerRow(row)) {
    const audit = row.audit;
    if (!audit) return 'uncertain';
    if (audit.citation === 'yes') return 'cited';
    if (audit.mention === 'yes') return 'mentioned';
    if (audit.mention === 'no') return 'missed';
    return 'uncertain';
  }
  return row.observation.status === 'found' ? 'cited' : 'missed';
}

function resolveEffectiveLanguage(
  batch: ResearchBatch,
  preferredLanguage?: 'zh' | 'en',
): 'zh' | 'en' {
  const target: 'zh' | 'en' = preferredLanguage ?? 'en';
  const hasTarget = batch.questions.some((q) =>
    q.observations.some((obs) => obs.language === target),
  );
  if (hasTarget) return target;
  const fallback: 'zh' | 'en' = target === 'en' ? 'zh' : 'en';
  const hasFallback = batch.questions.some((q) =>
    q.observations.some((obs) => obs.language === fallback),
  );
  return hasFallback ? fallback : target;
}

/**
 * Builds a deterministic, zero-empty-shell competitor & winner comparison directly
 * from real captured AI answers (same canonical entity rules as Overview & Studio).
 */
export function buildObservedCompetitorSnapshot(
  batch: ResearchBatch | null | undefined,
  project: Pick<GeoProject, 'name' | 'repositoryUrl' | 'siteUrl' | 'targetLanguage'>,
  options?: {
    language?: 'zh' | 'en';
    engine?: 'all' | ResearchEngine;
    maxCompetitors?: number;
  },
): ObservedCompetitorSnapshot {
  const preferredLang = options?.language ?? project.targetLanguage ?? 'en';
  const engines = batch ? getBatchResearchEngines(batch) : ['chatgpt', 'google'] as ResearchEngine[];
  const activeEngines =
    options?.engine && options.engine !== 'all'
      ? engines.filter((e) => e === options.engine)
      : engines;

  if (!batch?.questions?.length) {
    return {
      projectName: project.name,
      language: preferredLang,
      engines: activeEngines,
      totalQuestions: 0,
      measuredAnswers: 0,
      ownMentionYes: 0,
      ownCitationYes: 0,
      ownCoveredQuestions: 0,
      ownCitedQuestions: 0,
      perEngine: activeEngines.map((engine) => ({
        engine,
        measured: 0,
        ownMentionYes: 0,
        ownCitationYes: 0,
        topWinner: null,
      })),
      competitors: [],
      gapSources: [],
      questionRows: [],
      latestObservedDate: null,
    };
  }

  const language = resolveEffectiveLanguage(batch, preferredLang);
  const rawRows = activeEngines.flatMap((engine) =>
    getResearchRows(batch, {
      language,
      engine,
      kind: 'all',
      result: 'all',
    }),
  );
  const audited = auditRows(batch, rawRows, batch.answerAudits ?? []);

  let measuredAnswers = 0;
  let ownMentionYes = 0;
  let ownCitationYes = 0;
  let latestMs = Number.NEGATIVE_INFINITY;

  const perEngineMap = new Map<
    ResearchEngine,
    {
      measured: number;
      ownMentionYes: number;
      ownCitationYes: number;
      winnerCounts: Map<string, { label: string; questionIds: Set<string> }>;
    }
  >();
  for (const engine of activeEngines) {
    perEngineMap.set(engine, {
      measured: 0,
      ownMentionYes: 0,
      ownCitationYes: 0,
      winnerCounts: new Map(),
    });
  }

  const rowLookup = new Map<string, AuditedResearchRow>();
  for (const row of audited) {
    rowLookup.set(`${row.question.id}:${row.engine}`, row);
    if (!row.observation) continue;
    const ms = observationTime(row.observation);
    if (Number.isFinite(ms) && ms > latestMs) latestMs = ms;

    const bucket = perEngineMap.get(row.engine);
    const status = classifyRowStatus(row);
    measuredAnswers += 1;
    if (bucket) bucket.measured += 1;
    if (status === 'cited' || status === 'mentioned') {
      ownMentionYes += 1;
      if (bucket) bucket.ownMentionYes += 1;
    }
    if (status === 'cited') {
      ownCitationYes += 1;
      if (bucket) bucket.ownCitationYes += 1;
    }
  }

  const ownCoveredSet = new Set<string>();
  const ownCitedSet = new Set<string>();
  const questionRows: ObservedCompetitorQuestionRow[] = batch.questions.map((question) => {
    const engineStatuses = activeEngines.map((engine) => {
      const row = rowLookup.get(`${question.id}:${engine}`);
      return {
        engine,
        status: classifyRowStatus(row),
        row,
      };
    });
    const youCovered = engineStatuses.some(
      (item) => item.status === 'cited' || item.status === 'mentioned',
    );
    const youCited = engineStatuses.some((item) => item.status === 'cited');
    if (youCovered) ownCoveredSet.add(question.id);
    if (youCited) ownCitedSet.add(question.id);

    const winners = extractQuestionTopWinners(
      question,
      activeEngines,
      project,
      language,
      3,
    );
    return {
      question,
      isBrand: isBrandPrompt(question, project.name),
      engineStatuses,
      youCovered,
      youCited,
      winners,
    };
  });

  // Aggregate canonical external competitors across latest web_answer observations
  const compMap = new Map<
    string,
    {
      rawKey: string;
      label: string;
      mergedLabel?: string;
      url: string;
      rawUrls: Set<string>;
      questionIds: Set<string>;
      missedQuestionIds: Set<string>;
      engines: Set<ResearchEngine>;
      totalHits: number;
      samplePages: Map<string, { title: string; url: string; engine: ResearchEngine }>;
    }
  >();

  for (const question of batch.questions) {
    const youCovered = ownCoveredSet.has(question.id);
    for (const engine of activeEngines) {
      const engineBucket = perEngineMap.get(engine);
      const auditedRow = rowLookup.get(`${question.id}:${engine}`);
      const aiCompetitors = auditedRow?.audit?.recommendedCompetitors;

      if (aiCompetitors && aiCompetitors.length > 0) {
        for (const comp of aiCompetitors) {
          const cleanName = comp.name.replace(/\s+/g, ' ').trim();
          if (!cleanName) continue;
          const normalized = comp.url ? normalizeExternalCitedSource(comp.url) : null;
          if (comp.url && isProjectOwnedUrl(comp.url, project)) continue;
          const entityKey = normalized?.entityKey ?? `ai:${cleanName.toLowerCase()}`;
          const resolvedUrl = normalized?.url ?? comp.url ?? '';

          let entry = compMap.get(entityKey);
          if (!entry) {
            entry = {
              rawKey: normalized?.key ?? entityKey,
              label: cleanName,
              mergedLabel: cleanName,
              url: resolvedUrl,
              rawUrls: new Set(resolvedUrl ? [resolvedUrl] : []),
              questionIds: new Set([question.id]),
              missedQuestionIds: youCovered ? new Set() : new Set([question.id]),
              engines: new Set([engine]),
              totalHits: 1,
              samplePages: new Map(),
            };
            compMap.set(entityKey, entry);
          } else {
            if (resolvedUrl) {
              entry.rawUrls.add(resolvedUrl);
              if (!entry.url) entry.url = resolvedUrl;
            }
            entry.questionIds.add(question.id);
            if (!youCovered) entry.missedQuestionIds.add(question.id);
            entry.engines.add(engine);
            entry.totalHits += 1;
          }

          if (resolvedUrl && entry.samplePages.size < 3 && !entry.samplePages.has(resolvedUrl)) {
            entry.samplePages.set(resolvedUrl, {
              title: cleanName,
              url: resolvedUrl,
              engine,
            });
          }

          if (engineBucket) {
            const engWinner = engineBucket.winnerCounts.get(entityKey);
            if (!engWinner) {
              engineBucket.winnerCounts.set(entityKey, {
                label: entry.label,
                questionIds: new Set([question.id]),
              });
            } else {
              engWinner.label = entry.label;
              engWinner.questionIds.add(question.id);
            }
          }
        }
        continue;
      }

      const matching = question.observations.filter(
        (obs) =>
          obs.engine === engine &&
          obs.entryType === 'web_answer' &&
          obs.language === language,
      );
      const fallback =
        matching.length > 0
          ? matching
          : question.observations.filter(
              (obs) => obs.engine === engine && obs.entryType === 'web_answer',
            );
      const latest = getLatestResearchObservation(fallback);
      if (!latest) continue;

      for (const ref of latest.sources ?? []) {
        if (!ref?.url) continue;
        if (isProjectOwnedUrl(ref.url, project)) continue;
        const normalized = normalizeExternalCitedSource(ref.url);
        if (!normalized) continue;

        let entry = compMap.get(normalized.entityKey);
        if (!entry) {
          entry = {
            rawKey: normalized.key,
            label: normalized.label,
            mergedLabel: normalized.mergedLabel,
            url: normalized.url,
            rawUrls: new Set([normalized.url]),
            questionIds: new Set([question.id]),
            missedQuestionIds: youCovered ? new Set() : new Set([question.id]),
            engines: new Set([engine]),
            totalHits: 1,
            samplePages: new Map(),
          };
          compMap.set(normalized.entityKey, entry);
        } else {
          entry.rawUrls.add(normalized.url);
          if (entry.rawUrls.size > 1 && entry.mergedLabel) {
            entry.label = entry.mergedLabel;
            if (!normalized.url.includes('github.com')) {
              if (
                entry.url.includes('github.com') ||
                normalized.url.length < entry.url.length
              ) {
                entry.url = normalized.url;
              }
            }
          }
          entry.questionIds.add(question.id);
          if (!youCovered) entry.missedQuestionIds.add(question.id);
          entry.engines.add(engine);
          entry.totalHits += 1;
        }

        const pageTitle = (ref.title ?? '').replace(/\s+/g, ' ').trim();
        if (
          entry.samplePages.size < 3 &&
          !entry.samplePages.has(ref.url) &&
          !ref.url.includes('google.com/goto')
        ) {
          entry.samplePages.set(ref.url, {
            title: pageTitle || normalized.label,
            url: ref.url,
            engine,
          });
        }

        if (engineBucket) {
          const engWinner = engineBucket.winnerCounts.get(normalized.entityKey);
          if (!engWinner) {
            engineBucket.winnerCounts.set(normalized.entityKey, {
              label: entry.label,
              questionIds: new Set([question.id]),
            });
          } else {
            engWinner.label = entry.label;
            engWinner.questionIds.add(question.id);
          }
        }
      }
    }
  }

  const maxCompetitors = Math.max(1, options?.maxCompetitors ?? 10);
  const competitors: ObservedCompetitorEntry[] = [...compMap.entries()]
    .map(([entityKey, entry]) => ({
      key: entry.rawUrls.size > 1 ? entityKey : entry.rawKey,
      label: entry.label,
      url: entry.url,
      questionCount: entry.questionIds.size,
      missedByYouCount: entry.missedQuestionIds.size,
      totalHits: entry.totalHits,
      engines: [...entry.engines],
      questionIds: [...entry.questionIds],
      samplePages: [...entry.samplePages.values()],
    }))
    .sort(
      (a, b) =>
        b.questionCount - a.questionCount ||
        b.engines.length - a.engines.length ||
        b.totalHits - a.totalHits ||
        a.label.localeCompare(b.label),
    )
    .slice(0, maxCompetitors);

  const perEngine: ObservedCompetitorEngineSummary[] = activeEngines.map((engine) => {
    const bucket = perEngineMap.get(engine)!;
    const top = [...bucket.winnerCounts.values()].sort(
      (a, b) => b.questionIds.size - a.questionIds.size || a.label.localeCompare(b.label),
    )[0];
    return {
      engine,
      measured: bucket.measured,
      ownMentionYes: bucket.ownMentionYes,
      ownCitationYes: bucket.ownCitationYes,
      topWinner: top ? { label: top.label, questionCount: top.questionIds.size } : null,
    };
  });

  const gapSources = extractOverviewGapSources(batch, project, {
    engine: options?.engine ?? 'all',
    language,
    limit: 6,
  });

  return {
    projectName: project.name,
    language,
    engines: activeEngines,
    totalQuestions: batch.questions.length,
    measuredAnswers,
    ownMentionYes,
    ownCitationYes,
    ownCoveredQuestions: ownCoveredSet.size,
    ownCitedQuestions: ownCitedSet.size,
    perEngine,
    competitors,
    gapSources,
    questionRows,
    latestObservedDate: Number.isFinite(latestMs)
      ? new Date(latestMs).toISOString().slice(0, 10)
      : null,
  };
}

/**
 * Formats a concise, strictly factual Markdown report for team sharing or updates.
 */
export function formatObservedCompetitorReportMarkdown(
  snapshot: ObservedCompetitorSnapshot,
  isEn: boolean,
): string {
  const engineList = snapshot.engines
    .map((e) => RESEARCH_ENGINE_NAMES[e] ?? e)
    .join(' + ');
  const datePart = snapshot.latestObservedDate ?? (isEn ? 'unmeasured' : '待采集');

  const lines: string[] = isEn
    ? [
        `## ${snapshot.projectName} — AI Search Competitive Snapshot (${datePart})`,
        '',
        `- Scope: ${snapshot.totalQuestions} buyer prompts · ${snapshot.measuredAnswers} captured answers (${engineList})`,
        `- ${snapshot.projectName} visibility: mentioned in ${snapshot.ownMentionYes}/${snapshot.measuredAnswers} answers (${snapshot.ownCoveredQuestions}/${snapshot.totalQuestions} prompts); natively cited in ${snapshot.ownCitationYes}/${snapshot.measuredAnswers} answers`,
      ]
    : [
        `## ${snapshot.projectName} — AI 搜索竞品占位战报（${datePart}）`,
        '',
        `- 实测范围：${snapshot.totalQuestions} 道买家问题 · ${snapshot.measuredAnswers} 条真实回答（${engineList}）`,
        `- ${snapshot.projectName} 当前表现：${snapshot.ownMentionYes}/${snapshot.measuredAnswers} 条回答被提及（覆盖 ${snapshot.ownCoveredQuestions}/${snapshot.totalQuestions} 题），${snapshot.ownCitationYes}/${snapshot.measuredAnswers} 条带原生引用`,
      ];

  if (snapshot.competitors.length > 0) {
    lines.push('');
    lines.push(isEn ? '### Top External Sources AI Cites Instead' : '### 当前最常被 AI 引用的外部赢家');
    for (const [idx, comp] of snapshot.competitors.slice(0, 6).entries()) {
      const engNames = comp.engines.map((e) => RESEARCH_ENGINE_NAMES[e] ?? e).join(' / ');
      const urlPartEn = comp.url ? ` (${comp.url})` : '';
      const urlPartZh = comp.url ? `（${comp.url}）` : '';
      lines.push(
        isEn
          ? `${idx + 1}. **${comp.label}**${urlPartEn} — cited on ${comp.questionCount}/${snapshot.totalQuestions} prompts (${engNames})`
          : `${idx + 1}. **${comp.label}**${urlPartZh} — 占据 ${comp.questionCount}/${snapshot.totalQuestions} 题（${engNames}）`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

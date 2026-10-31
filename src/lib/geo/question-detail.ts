import {
  isResearchEngine,
  RESEARCH_ENGINES,
  RESEARCH_ENGINE_NAMES,
} from './research-engines';
import { getResearchRows } from './research-view';
import type { ResearchRow } from './research-view';
import type { ResearchBatch, ResearchSource } from './research-types';
import type {
  QuestionDetail,
  QuestionDetailFilters,
  QuestionDetailPlatform,
} from './question-detail-types';

export function parseQuestionDetailFilters(
  params: URLSearchParams,
): QuestionDetailFilters {
  for (const name of ['project', 'batch', 'question', 'language', 'engine', 'history']) {
    if (params.getAll(name).length > 1)
      throw new Error(`参数 ${name} 不能重复。`);
    if (params.has(name) && !params.get(name)?.trim()) {
      throw new Error(`参数 ${name} 不能为空。`);
    }
  }
  const language = params.get('language') ?? 'zh';
  const engine = params.get('engine') ?? 'all';
  const history = params.get('history') ?? '0';
  if (language !== 'zh' && language !== 'en') {
    throw new Error('语言仅支持 zh 或 en。');
  }
  if (engine !== 'all' && !isResearchEngine(engine)) {
    throw new Error('研究平台参数无效。');
  }
  if (history !== '0' && history !== '1') {
    throw new Error('history 仅支持 0 或 1。');
  }
  return { language, engine, includeHistory: history === '1' };
}

function hasSavedPosition(source: ResearchSource): boolean {
  return (
    typeof source.position === 'number' &&
    Number.isFinite(source.position) &&
    source.position > 0
  );
}

function uniqueSources(sources: ResearchSource[]): ResearchSource[] {
  const unique = new Map<string, ResearchSource>();
  for (const source of sources) {
    const existing = unique.get(source.url);
    // A duplicate citation must not hide an explicitly recorded web position.
    if (
      !existing ||
      (!hasSavedPosition(existing) && hasSavedPosition(source))
    ) {
      unique.set(source.url, { ...source });
    }
  }
  return [...unique.values()];
}

function platformFromRow(
  row: ResearchRow,
  language: 'zh' | 'en',
): QuestionDetailPlatform {
  const observation = row.observation;
  const entryType =
    observation?.entryType ??
    (row.engine === 'google'
      ? 'web_search'
      : row.engine === 'chatgpt'
        ? 'web_answer'
        : row.engine === 'deepseek'
          ? 'api_search'
          : 'api_answer');
  const entryLabels = {
    web_answer: '网页回答',
    web_search: '网页搜索',
    api_answer: 'API 回答',
    api_search: 'API 搜索',
  };
  const sources = uniqueSources(observation?.sources ?? []);
  const counted =
    row.engine === 'google' ? sources.filter(hasSavedPosition) : sources;
  const officialCount = counted.filter(
    (source) => source.kind === 'official',
  ).length;
  // Imported/failed records can carry a non-measurement status at runtime.
  // Only completed observations establish numeric counts, including zero.
  const measured =
    observation?.status === 'found' || observation?.status === 'not_observed';
  const status = !measured
    ? 'unmeasured'
    : row.engine === 'google'
      ? officialCount > 0
        ? 'found'
        : 'not_observed'
      : observation!.status;
  return {
    recordKey: row.key,
    observationIndex: observation
      ? Number(row.key.slice(row.key.lastIndexOf(':') + 1))
      : null,
    engine: row.engine,
    label: RESEARCH_ENGINE_NAMES[row.engine],
    entryLabel: entryLabels[entryType],
    recordedAt: observation
      ? observation.collectedAt || observation.recordedAt || null
      : null,
    status,
    officialCount: measured ? officialCount : null,
    otherCount: measured ? counted.length - officialCount : null,
    totalSources: measured ? counted.length : null,
    otherSourcesCount: measured ? sources.length - counted.length : null,
    sources,
    summary: observation?.summary ?? '',
    query: observation?.query ?? row.question[language],
    conditions: observation?.conditions ?? '',
    ...(observation?.answerPath ? { answerPath: observation.answerPath } : {}),
    ...(observation?.evidencePath
      ? { evidencePath: observation.evidencePath }
      : {}),
  };
}

/** A read-only view of one server-owned batch; no collection or persistence. */
export function buildQuestionDetail(
  batch: ResearchBatch | null | undefined,
  projectId: string,
  questionId: string,
  filters: QuestionDetailFilters,
): QuestionDetail | null {
  if (!batch || batch.projectId !== projectId) return null;
  const question = [...batch.questions, ...batch.deferredQuestions].find(
    (item) => item.id === questionId,
  );
  if (!question) return null;
  // Reuse row construction so links retain the original observation index,
  // including for a deferred question which has not entered the active batch.
  const selectedBatch = { ...batch, questions: [question] };
  const engines =
    filters.engine === 'all' ? RESEARCH_ENGINES : [filters.engine];
  const platforms = engines.flatMap((engine) =>
    getResearchRows(
      selectedBatch,
      {
        language: filters.language,
        engine,
        kind: 'all',
        result: 'all',
      },
      { includeHistory: filters.includeHistory },
    ).map((row) => platformFromRow(row, filters.language)),
  );
  return {
    version: 1,
    projectId: batch.projectId,
    batchId: batch.id,
    questionId: question.id,
    language: filters.language,
    title: question[filters.language],
    mode: filters.includeHistory ? 'history' : 'latest',
    platforms,
  };
}

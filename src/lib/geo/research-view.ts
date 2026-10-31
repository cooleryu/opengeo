import type {
  ResearchBatch,
  ResearchObservation,
  ResearchQuestion,
  ResearchEngine,
} from './research-types';
import { getBatchResearchEngines } from './research-engines';

export type ResearchFilter = {
  language: 'zh' | 'en';
  engine: 'all' | ResearchEngine;
  kind: 'all' | 'brand' | 'discovery';
  result: 'all' | 'found' | 'not_observed' | 'unmeasured';
};

export type ResearchRow = {
  key: string;
  question: ResearchQuestion;
  engine: ResearchEngine;
  observation?: ResearchObservation;
};

export function isBrandQuestion(question: ResearchQuestion): boolean {
  if (question.category) return question.category === 'brand' || question.category === 'positioning';
  return question.id === 'C01' || question.id === 'R01';
}

export function observationTime(observation: Pick<ResearchObservation, 'collectedAt' | 'recordedAt'>): number {
  for (const value of [observation.collectedAt, observation.recordedAt]) {
    if (!value) continue;
    const exact = Date.parse(value);
    if (Number.isFinite(exact)) return exact;
    // Imported records can describe an observation window in prose. Use its
    // dated prefix for ordering while preserving the original uncertainty text.
    const prefix = value.match(
      /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/,
    );
    if (prefix) return Date.parse(`${prefix[1]}T${prefix[2] || '00:00:00'}Z`);
  }
  return Number.NEGATIVE_INFINITY;
}

export function getLatestResearchObservation(
  observations: ResearchObservation[],
): ResearchObservation | undefined {
  return observations.reduce<ResearchObservation | undefined>(
    (latest, observation) =>
      !latest || observationTime(observation) >= observationTime(latest)
        ? observation
        : latest,
    undefined,
  );
}

export function getResearchRows(
  batch: ResearchBatch,
  filters: ResearchFilter,
  options: { includeHistory?: boolean } = {},
): ResearchRow[] {
  const engines: ResearchRow['engine'][] =
    filters.engine === 'all'
      ? getBatchResearchEngines(batch)
      : [filters.engine];
  const rows: ResearchRow[] = [];

  for (const question of batch.questions) {
    const brand = isBrandQuestion(question);
    if (filters.kind === 'brand' && !brand) continue;
    if (filters.kind === 'discovery' && brand) continue;

    for (const engine of engines) {
      const prefix = `${batch.id}:${question.id}:${engine}:${filters.language}`;
      const matching = question.observations.flatMap((observation, index) =>
        observation.engine === engine &&
        observation.language === filters.language
          ? [{ key: `${prefix}:${index}`, question, engine, observation }]
          : [],
      );
      // A missing record is a display row, never a synthetic observation.
      if (matching.length) {
        // Appended observations retain their original indices for saved links.
        // Current statistics use one latest record per question/language/entry.
        const latest = getLatestResearchObservation(
          matching.map((row) => row.observation),
        );
        rows.push(
          ...(options.includeHistory
            ? matching
            : [matching.findLast((row) => row.observation === latest)!]),
        );
      } else rows.push({ key: `${prefix}:unmeasured`, question, engine });
    }
  }

  return rows.filter(
    (row) =>
      filters.result === 'all' ||
      (row.observation?.status ?? 'unmeasured') === filters.result,
  );
}

export function getResearchMetrics(rows: ResearchRow[]): {
  completed: number;
  found: number;
  unmeasured: number;
  measuredQuestions: number;
  coveredQuestions: number;
  totalQuestions: number;
  rate: number | null;
} {
  let completed = 0;
  let found = 0;
  const questions = new Set<string>();
  const measuredQuestions = new Set<string>();
  const coveredQuestions = new Set<string>();

  for (const row of rows) {
    questions.add(row.question.id);
    if (!row.observation) continue;
    completed += 1;
    measuredQuestions.add(row.question.id);
    if (row.observation.status === 'found') {
      found += 1;
      coveredQuestions.add(row.question.id);
    }
  }

  return {
    completed,
    found,
    unmeasured: rows.length - completed,
    measuredQuestions: measuredQuestions.size,
    coveredQuestions: coveredQuestions.size,
    totalQuestions: questions.size,
    rate: completed ? (found / completed) * 100 : null,
  };
}

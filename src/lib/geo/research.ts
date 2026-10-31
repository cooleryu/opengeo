import { readLatestResearch } from './research-store';
import type { ResearchBatch } from './research-types';
export { appendResearchObservation, getResearchBatch, getResearchRun, listResearchRuns, saveResearchRun, listResearchBatches } from './research-store';
export type { ResearchRunRecord } from './research-store';

export function getLatestResearch(projectId: string): ResearchBatch | null {
  return readLatestResearch(projectId);
}

export function researchEvidencePaths(batch: ResearchBatch | null): string[] {
  if (!batch) return [];

  return Array.from(new Set([
    batch.reportPath,
    batch.sourceAuditPath,
    batch.reviewPath,
    ...[...batch.questions, ...batch.deferredQuestions].flatMap((question) => [
      question.reviewPath,
      ...question.observations.flatMap((observation) => [
        observation.evidencePath,
        ...(observation.answerPath ? [observation.answerPath] : []),
      ]),
    ]),
  ].filter(Boolean)));
}

import { getLatestResearch, getResearchBatch, getResearchRun, saveResearchRun, appendResearchObservation } from './research';
import { currentGeoProject } from './projects';
import { observationFromResult } from './research-observation';
import type { GeoRun, GeoTask } from './types';
import { analyzeResearchObservation } from './answer-audit';
import { listAnswerAudits } from './answer-audit-store';

/** Exact wording is required: old measurements never become evidence for a rewritten question. */
export function importTaskResearchRuns(task: GeoTask) {
  const projectId = currentGeoProject();
  if (task.projectId && task.projectId !== projectId) return;
  const batch = task.researchContext?.batchId ? getResearchBatch(projectId, task.researchContext.batchId) : getLatestResearch(projectId);
  if (!batch) return;
  const runs = [...task.runs, ...[task.workflow, ...(task.workflowHistory || [])].flatMap(w => w?.baseline ? [w.baseline] : [])];
  for (const run of runs) {
    if (run.mode !== 'live') continue;
    const provider = run.questions[0]?.providerId || task.workflow?.collection?.provider || task.collectionProvider || 'deepseek';
    const frozen = run.questions.length ? run.questions : (task.workflow?.questions || []);
    const languages = [...new Set(frozen.map(q => q.language.startsWith('zh') ? 'zh' as const : 'en' as const))];
    for (const language of languages.length ? languages : ['zh' as const]) {
      const id = `task-${run.id}-${language}`;
      if (getResearchRun(projectId, id)) continue;
      const measured = run.questions.filter(q => (q.language.startsWith('zh') ? 'zh' : 'en') === language);
      const questions = frozen.filter(q => (q.language.startsWith('zh') ? 'zh' : 'en') === language).map(q => {
        const matched = [...batch.questions, ...batch.deferredQuestions].find(candidate => candidate[language] === q.query);
        return { questionId: matched?.id || q.id, query: q.query };
      });
      saveResearchRun(projectId, {
        id, projectId, batchId: batch.id, provider, language, questions,
        status: run.status, startedAt: run.at, updatedAt: run.completedAt || run.at, completedAt: run.completedAt,
        spent: languages.length > 1 ? run.cost * questions.length / Math.max(1, frozen.length) : run.cost,
        ...(languages.length > 1 ? { costAllocation: 'per_query' as const } : {}),
        budgetLimit: Math.max(task.monitor.budgetLimit, run.cost), completedCount: measured.length,
        taskId: task.id, imported: true, importedRun: run as GeoRun,
        evidencePath: `data/geo-evidence/${run.id}/run.json`, error: run.error,
        entryType: provider === 'deepseek' ? 'api_search' : 'api_answer',
        matchedQuestionIds: questions.filter(q => [...batch.questions, ...batch.deferredQuestions].some(candidate => candidate.id === q.questionId && candidate[language] === q.query)).map(q => q.questionId),
      });
      for (const result of measured) {
        const match = [...batch.questions, ...batch.deferredQuestions].find(q => q[language] === result.query);
        if (!match) continue;
        // Incomplete historical raw files remain in the run archive, not zero-hit observations.
        let observation;
        try { observation = observationFromResult(result, id, provider); } catch { continue; }
        appendResearchObservation(projectId, batch.id, match.id, observation);
      }
    }
  }
}

/** Called after a new live run, never from getGeoState or a historical import. */
export async function analyzeImportedResearchRun(task: GeoTask, run: GeoRun): Promise<void> {
  if (run.mode !== 'live') return;
  const projectId = currentGeoProject();
  if (task.projectId && task.projectId !== projectId) return;
  const batch = task.researchContext?.batchId
    ? getResearchBatch(projectId, task.researchContext.batchId) : getLatestResearch(projectId);
  if (!batch) return;
  const saved = listAnswerAudits(projectId, batch.id);
  for (const result of run.questions) {
    const language = result.language.startsWith('zh') ? 'zh' : 'en';
    const question = [...batch.questions, ...batch.deferredQuestions].find(q => q[language] === result.query);
    const observation = question?.observations.find(o => o.runId === `task-${run.id}-${language}` && o.recordedAt === result.measurementAt);
    if (!question || !observation) continue;
    if (saved.some(a => a.questionId === question.id && a.engine === observation.engine && a.language === language &&
      a.recordedAt === observation.recordedAt && a.evidencePath === (observation.answerPath ?? observation.evidencePath))) continue;
    await analyzeResearchObservation(batch, question.id, observation, result.answer);
  }
  if (run.questions.length) {
    try {
      const { analyzeCompetitorCandidates } = await import('./competitor-analysis');
      await analyzeCompetitorCandidates(batch.id);
    } catch { /* Competitor analysis must not change a completed measurement. */ }
  }
}

import type { GeoState, GeoTask } from '@/lib/geo/types';

type QuestionLabelData = Pick<GeoState, 'project' | 'latestResearch'>;

/** Resolve display text from the task's saved question before the current batch. */
export function researchQuestionForTask(
  task: GeoTask,
  data: QuestionLabelData,
) {
  const context = task.researchContext;
  if (!context) return undefined;
  const snapshot = context.snapshot;
  if (
    snapshot?.projectId === (task.projectId || data.project.id) &&
    snapshot.question.id === context.questionId
  )
    return snapshot.question;

  const batch = data.latestResearch;
  return batch?.id === context.batchId &&
    batch.projectId === (task.projectId || data.project.id)
    ? [...batch.questions, ...batch.deferredQuestions].find(
        (question) => question.id === context.questionId,
      )
    : undefined;
}

export function displayTaskTitle(
  task: GeoTask,
  data: QuestionLabelData,
  fallback = task.title,
) {
  const context = task.researchContext;
  if (!context || task.proposal) return fallback;
  const question = researchQuestionForTask(task, data);
  const query =
    question?.[context.language] || task.workflow?.questions[0]?.query;
  const action = context.purpose === 'investigate_gap' ? '核查' : '改进';
  return query
    ? `${action}：${query}`
    : context.purpose === 'investigate_gap'
      ? '核查已有材料'
      : '改进问题回答';
}

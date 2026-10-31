import type { ResearchBatch } from './research-types';
import type { GeoTask } from './types';

/** Only the current batch's real records advance this overview. */
export function overviewProgress(batch: ResearchBatch, tasks: GeoTask[]) {
  const current = tasks.filter(
    (task) =>
      task.projectId === batch.projectId &&
      task.researchContext?.batchId === batch.id,
  );
  const nextTask =
    current.find((task) => task.status !== 'completed') ?? current[0];
  const diagnosed = current.filter((task) => task.workflow?.diagnosis);
  const checked = current.filter((task) => task.researchGapReview);
  const proposed = current.filter((task) => task.proposal);
  const implemented = current.filter(
    (task) => task.implementation?.kind === 'user_confirmed',
  );
  const measured = batch.questions.reduce(
    (sum, question) => sum + question.observations.length,
    0,
  );
  const step =
    nextTask?.implementation?.kind === 'user_confirmed'
      ? 5
      : nextTask?.proposal
        ? 4
        : 3;
  return {
    taskId: nextTask?.id,
    step,
    action:
      step === 5 ? '查看实施与跟测' : step === 4 ? '查看方案审核' : '继续核查',
    label: step === 5 ? '实施后跟测' : step === 4 ? '方案与审核' : '搜索与诊断',
    steps: [
      {
        title: '理解产品',
        status: batch.reportPath ? '已有调查记录' : '待调查',
      },
      { title: '确认问题', status: `已审 ${batch.questions.length} 题` },
      {
        title: '搜索与诊断',
        status: `${measured} 条观测 · ${diagnosed.length ? `${diagnosed.length} 项诊断` : checked.length ? `${checked.length} 项材料核查` : '待完善诊断'}`,
      },
      {
        title: '方案与审核',
        status: proposed.length
          ? `${proposed.length} 项方案 · 查看审核`
          : '尚无方案',
      },
      {
        title: '实施后跟测',
        status: implemented.length
          ? `${implemented.length} 项真实实施 · 查看跟测`
          : '尚未实施',
      },
    ],
  };
}

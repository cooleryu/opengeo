import type { ProjectOptimization } from '@/lib/geo/project-optimization-types';
import type { GeoTask } from '@/lib/geo/types';

export function isOpenProjectOptimizationTask(
  task: Pick<GeoTask, 'projectOptimization'>,
) {
  return Boolean(
    task.projectOptimization && task.projectOptimization.phase !== 'closed',
  );
}

export function getProjectOptimizationProgress(
  optimization: Pick<ProjectOptimization, 'phase' | 'progress' | 'review'>,
) {
  const { phase, review, progress } = optimization;
  const ready = phase === 'awaiting_review' && review?.passed === true;
  const states = {
    initializing: {
      label: '正在整理材料',
      message: '正在整理本轮已保存的问题、回答与内容。',
      actionLabel: '查看进展',
      stage: 0,
    },
    planning: {
      label: '正在形成方案',
      message: '正在合并相关问题的改进建议，形成项目优化方案。',
      actionLabel: '查看进展',
      stage: 0,
    },
    reviewing: {
      label: '正在独立审核',
      message: '正在逐项核查方案的证据、改动与验证方法。',
      actionLabel: '查看进展',
      stage: 1,
    },
    revising: {
      label: '正在修订方案',
      message: '正在根据独立审核意见修订方案，随后重新审核。',
      actionLabel: '查看进展',
      stage: 0,
    },
    awaiting_review: {
      label: ready ? '待你审阅' : '需处理 · 审核待核实',
      message: ready
        ? '独立审核已通过，等待你审阅。尚未实施或验证效果。'
        : '审核结果未通过或待核实，请先查看需处理的问题。',
      actionLabel: ready ? '审阅方案' : '查看原因',
      stage: ready ? 2 : 1,
    },
    blocked: {
      label: '需处理 · 方案待完善',
      message: review
        ? '独立审核未通过，请查看需要补齐的依据与改动。'
        : '本轮材料存在缺口，尚未完成独立审核。',
      actionLabel: '查看原因',
      stage: review ? 1 : 0,
    },
    failed: {
      label: '任务中断 · 需处理',
      message: '本次任务未完成，可查看原因并使用已保存的材料重试。',
      actionLabel: '查看原因',
      stage: -1,
    },
    closed: {
      label: '已结束本轮',
      message: '记录已保留，未实施，效果未验证。',
      actionLabel: '查看记录',
      stage: -1,
    },
  };
  const state = states[phase];
  const round = progress?.round;
  const maxRounds = progress?.maxRounds;
  const roundLabel =
    typeof round === 'number' && Number.isInteger(round) && round > 0
      ? typeof maxRounds === 'number' &&
        Number.isInteger(maxRounds) &&
        maxRounds >= round
        ? `第 ${round} / ${maxRounds} 轮`
        : `第 ${round} 轮`
      : '';
  return {
    ...state,
    message: progress?.message?.trim() || state.message,
    roundLabel,
    ready,
    running: ['initializing', 'planning', 'reviewing', 'revising'].includes(
      phase,
    ),
    firstStageLabel:
      phase === 'initializing'
        ? '整理材料'
        : phase === 'revising'
          ? '修订方案'
          : '形成方案',
  };
}

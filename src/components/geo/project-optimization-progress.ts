import type { ProjectOptimization } from '@/lib/geo/project-optimization-types';
import type { GeoTask } from '@/lib/geo/types';
import { buildQualityEvolution } from './quality-evolution-data';

/** Overview reads the whole task, so a reviewed plan cannot masquerade as implementation. */
export function getProjectTaskProgress(task: GeoTask) {
  const plan = task.projectOptimization!;
  const state = getProjectOptimizationProgress(plan);
  const delivery = plan.delivery;
  const result = { ...state, stage: 0, roundLabel: '', title: '' };
  if (plan.phase === 'closed') return result;
  if (task.status === 'failed') return { ...result, running: false, ready: false,
    label: '这次优化中断了', message: '已保存此前的进展，可以查看原因后继续。', actionLabel: '查看进展' };
  if (task.implementation?.kind === 'user_confirmed') {
    const outcome = task.workflow?.outcome;
    const labels = { improved: '复测观察到改善', unchanged: '本次复测未见改善', worse: '本次复测表现下降', inconclusive: '效果暂时无法判断' };
    return { ...result, stage: 3, running: false, ready: false,
      label: outcome ? labels[outcome.classification] : '改动已登记，等待复测',
      message: outcome ? outcome.summary : '按原问题、原平台和原条件复测后，再判断是否有改善。',
      title: task.proposal?.title ?? '', actionLabel: outcome ? '查看复测结果' : '查看实施与复测' };
  }
  if (task.implementation?.kind === 'rehearsal') return { ...result, stage: 2, ready: false, running: false,
    label: '演练已完成，等待实际实施', message: '演练不计作发布，也不计作效果改善。', actionLabel: '查看修改稿' };
  if (task.status === 'awaiting_implementation') return { ...result, stage: 2, ready: false, running: false,
    label: '修改稿已确认，等待实施', title: task.proposal?.title ?? '',
    message: '确认已保存；实际改动或发布完成后，才开始比较效果。', actionLabel: '查看待实施改动' };
  if (!delivery) {
    if (state.ready && plan.draftsReviewedAt && plan.draftsReviewedAt === plan.review?.reviewedAt) return {
      ...result, stage: 2, ready: true, running: false, label: '稿件已准备好，待你确认',
      message: `${plan.actions.length} 项实际稿件已通过独立审核，确认后再修改原文件或发布。`,
      actionLabel: '查看稿件',
    };
    if (state.ready) return { ...result, stage: 1, ready: false, label: '优先改动已选定',
      message: '下一步准备具体修改稿，并单独核查修改内容。', actionLabel: '查看优先改动' };
    // Keep process reports out of the overview, but retain them in task details.
    return { ...result, message: state.running ? '正在比较当前问题的回答和已有内容，找出最值得先做的一项改动。'
      : '本轮还没有可以实施的修改稿，已保存原因和候选内容。' };
  }
  const selected = plan.actions.find(action => action.id === delivery.actionId);
  const detail = { ...result, stage: 1, title: selected?.title ?? '', ready: false };
  if (task.status === 'investigating') {
    const labels = { reading: '正在读取要改的原文', comparing: '正在核实改动依据', drafting: '正在准备修改稿',
      reviewing: '正在检查修改稿', revising: '正在完善修改稿', ready: '正在保存修改稿', blocked: '正在继续处理' };
    return { ...detail, running: true, label: labels[delivery.phase], message: delivery.message, actionLabel: '查看进展' };
  }
  const evolution = buildQualityEvolution(task);
  const frame = evolution.frames.find(item => item.id === evolution.retainedFrameId);
  const approved = frame?.review.passed && frame.review.source === 'model' && frame.score !== null
    && !!task.workflow?.savedResearch && frame.review.geoAcceptanceRequired === true && !!frame.review.geoAcceptance
    && (!task.reviewContextUpdatedAt || Date.parse(frame.review.reviewedAt) >= Date.parse(task.reviewContextUpdatedAt));
  if (approved) return { ...detail, stage: 2, ready: true, running: false, label: '待你确认改动',
    title: task.proposal?.title ?? detail.title, message: '已通过独立审核。你只需确认这份具体改动。', actionLabel: '查看修改稿' };
  return { ...detail, running: false, label: '修改稿还未准备好',
    message: delivery.phase === 'blocked' ? delivery.message : '当前修改稿还需核查，暂不能实施。', actionLabel: '查看进展' };
}

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

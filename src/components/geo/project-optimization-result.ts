import type {
  ProjectOptimization,
  ProjectOptimizationActionReview,
} from '@/lib/geo/project-optimization-types';

export function getActionReviewNeeds(
  review: ProjectOptimizationActionReview | undefined,
): string[] {
  if (!review || review.passed) return [];
  const needs: string[] = [];
  if (review.evidenceGrounded !== 'pass' || review.scores.evidence < 70) {
    needs.push('依据还需核实');
  }
  if (review.scores.actionability < 70) needs.push('改法还不够具体');
  if (review.scores.verifiability < 70) needs.push('复测方法还需明确');
  if (review.scores.relevance < 70 || review.preservesGoal !== 'pass') {
    needs.push('需要重新对齐原问题');
  }
  return needs;
}

export function getOptimizationResultCopy(optimization: ProjectOptimization): {
  title: string;
  description: string;
  nextStep: string;
  issues: string[];
} {
  const { phase, review, stopReason, delivery } = optimization;
  const issues = Array.from(
    new Set(review?.actions.flatMap(getActionReviewNeeds) ?? []),
  );
  const repairNextStep =
    '需要补齐审核指出的依据或具体改法，才能交付修改稿。';

  if (delivery && phase !== 'closed') return {
    title: delivery.phase === 'blocked' ? '修改稿尚未就绪' : '正在准备具体修改稿',
    description: delivery.message,
    nextStep: delivery.phase === 'blocked' ? '原方案和依据已保留，补齐这一处后继续。' : '准备好后，会直接展示改哪里、改成什么。',
    issues: [],
  };

  if (phase === 'closed') {
    return {
      title: '本轮已结束',
      description: '方案与审核记录已保留；方案未实施，效果未验证。',
      nextStep: '如需继续，可使用最新材料新建优化任务。',
      issues,
    };
  }
  if (phase === 'failed') {
    return {
      title: '本次任务中断',
      description: '生成或审核未能完成，已保存的记录仍可查看。',
      nextStep: '排除中断原因后，可使用本轮保存的材料重新分析。',
      issues,
    };
  }
  if (phase === 'awaiting_review' && review?.passed === true) {
    if (optimization.draftsReviewedAt && optimization.draftsReviewedAt === review.reviewedAt) return {
      title: `${optimization.actions.length} 项稿件已准备好`,
      description: optimization.summary,
      nextStep: '查看下面的稿件；等你确认后，再修改原文件或发布。',
      issues: [],
    };
    return {
      title: '方案已通过审核',
      description: '建议已通过独立审核，尚未实施或验证效果。',
      nextStep: '接下来读取优先改动的原文，准备具体修改稿并独立审核。',
      issues: [],
    };
  }
  if (phase === 'blocked') {
    const descriptions = {
      no_evidence: '本轮已停止，现有材料尚不足以形成有依据的行动。',
      no_progress:
        review === null
          ? '本轮已停止，修订未形成实质改动，当前候选未再次审核。'
          : '本轮已停止，修订未形成实质改动。',
      round_limit: '已达到本轮修订上限，任务已停止，方案仍未通过审核。',
    };
    return {
      title: '本轮已停止，方案还需完善',
      description: stopReason
        ? descriptions[stopReason]
        : review === null
          ? '本轮已停止，当前候选尚未完成独立审核。'
          : '本轮已停止，方案尚未进入可交付状态。',
      nextStep:
        stopReason === 'no_evidence'
          ? '现有回答不足以支持判断，需要先补齐可用回答，再生成方案。'
          : repairNextStep,
      issues,
    };
  }
  if (phase === 'awaiting_review') {
    return {
      title: review === null ? '审核结果待核实' : '方案还需完善',
      description:
        review === null
          ? '当前没有完整的审核结果，尚不能交付这份方案。'
          : '方案尚未通过独立审核，暂不能作为实施方案。',
      nextStep: repairNextStep,
      issues,
    };
  }
  return {
    title: '正在准备方案',
    description: '方案仍在生成、修订或审核，当前候选仅供预览。',
    nextStep: '处理完成后，可在这里查看结果。',
    issues,
  };
}

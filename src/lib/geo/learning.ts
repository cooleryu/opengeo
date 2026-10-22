import { createHash } from 'node:crypto';
import type { GeoRun, GeoTask } from './types';
import type { GeoOutcome, StrategyMemory } from './workflow-types';
import { buildSearchProtocolKey } from './search-protocol';

const time = (value: string) => Date.parse(value);
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const sameStrings = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

function completeComparableRun(task: GeoTask, run: GeoRun, phase: 'baseline' | 'followup'): boolean {
  const workflow = task.workflow;
  if (!workflow || !workflow.questions.length || run.mode !== 'live' || run.status !== 'completed' || run.error || run.phase !== phase ||
      !run.protocolKey || run.protocolKey !== workflow.protocolKey || workflow.protocolKey !== buildSearchProtocolKey(workflow.questions) ||
      run.queryCount !== workflow.questions.length || run.completedCount !== workflow.questions.length || run.questions.length !== workflow.questions.length ||
      new Set(run.questions.map(question => question.id)).size !== workflow.questions.length ||
      run.hitCount !== run.questions.filter(question => question.projectHit).length || !Number.isFinite(time(run.at)) || !Number.isFinite(time(run.measurementAt)) ||
      !run.completedAt || !Number.isFinite(time(run.completedAt)) || time(run.completedAt) < time(run.at) ||
      time(run.measurementAt) < time(run.at) || time(run.measurementAt) > time(run.completedAt)) return false;
  return workflow.questions.every(question => run.questions.some(result => result.id === question.id && result.query === question.query &&
    result.language === question.language && result.provider === 'DeepSeek Search API' && Boolean(result.evidencePath) &&
    Number.isFinite(time(result.measurementAt)) && time(result.measurementAt) >= time(run.at) && time(result.measurementAt) <= time(run.completedAt!) &&
    sameStrings(result.matchingAssetIds || [], question.assetIds)));
}

function runTimes(run: GeoRun): number[] {
  return [time(run.at), time(run.measurementAt), time(run.completedAt || ''), ...run.questions.map(question => time(question.measurementAt))];
}

function evidence(run: GeoRun): string[] {
  return [`data/geo-evidence/${run.id}/run.json`, ...run.questions.map(question => question.evidencePath)];
}

export function evaluateOutcome(task: GeoTask): GeoOutcome {
  const workflow = task.workflow;
  const baseline = workflow?.baseline;
  const implementation = task.implementation;
  const limits = ['仅比较同一搜索 API、冻结题单和参数下的返回结果；不代表 ChatGPT、Gemini 或其他平台。',
    '搜索命中变化属于观察关联，无法排除自然波动、索引延迟和同期变化，不能证明因果；AI 原生引用仍未测。'];
  const result: GeoOutcome = {
    classification: 'inconclusive', summary: '还没有足够的可比真实观测，暂不能判断措施效果。', evaluatedAt: new Date().toISOString(),
    baselineRunId: baseline?.id || null, followupRunIds: [], beforeRate: null, afterRate: null,
    evidencePaths: baseline ? unique(evidence(baseline)) : [], limitations: limits,
  };
  if (!workflow || !baseline || !completeComparableRun(task, baseline, 'baseline') || baseline.implementationRevision !== 0) {
    result.limitations.push('缺少完整的真实实施前基线，或基线题单、参数、来源记录不一致；回放、失败和部分结果不参与效果比较。');
    return result;
  }
  if (!implementation || implementation.kind !== 'user_confirmed' || !Number.isFinite(time(implementation.at)) ||
      implementation.proposalRevision !== workflow.proposalRevision || !implementation.proposalRevision) {
    result.limitations.push('尚未确认当前方案版本的真实实施；演练或旧方案实施不能作为本次措施效果依据。');
    return result;
  }
  const frozenAt = time(workflow.frozenAt);
  const implementedAt = time(implementation.at);
  if (!Number.isFinite(frozenAt) || runTimes(baseline).some(at => at < frozenAt || at >= implementedAt)) {
    result.limitations.push('基线必须在题单冻结之后、实际实施之前完成；现有时间记录不满足比较条件。');
    return result;
  }
  const candidates = task.runs.filter(run => completeComparableRun(task, run, 'followup') &&
    run.implementationRevision === implementation.proposalRevision && runTimes(run).every(at => at >= implementedAt) && run.id !== baseline.id);
  const followups = [...new Map(candidates.map(run => [run.id, run])).values()].sort((left, right) => time(left.at) - time(right.at));
  result.beforeRate = baseline.questions.filter(question => question.projectHit).length / baseline.queryCount;
  if (!followups.length) {
    result.limitations.push('尚无当前实施版本之后的完整同协议真实复测；回放、失败、部分完成和其他版本均已排除。');
    return result;
  }
  result.followupRunIds = followups.map(run => run.id);
  result.evidencePaths = unique([...evidence(baseline), ...followups.flatMap(evidence)]);
  result.afterRate = followups.reduce((sum, run) => sum + run.questions.filter(question => question.projectHit).length, 0) /
    followups.reduce((sum, run) => sum + run.queryCount, 0);
  const delta = result.afterRate - result.beforeRate;
  result.classification = Math.abs(delta) < 1e-12 ? 'unchanged' : delta > 0 ? 'improved' : 'worse';
  const label = { improved: '上升', unchanged: '未变化', worse: '下降' }[result.classification];
  result.summary = `同协议真实搜索命中率由 ${(result.beforeRate * 100).toFixed(1)}% 到 ${(result.afterRate * 100).toFixed(1)}%，观察到${label}（${followups.length} 轮实施后复测）。这不是因果结论。`;
  result.limitations.push(`采用 ${followups.length} 轮完整复测的平均命中率；重复样本存在相关性，不作显著性声明。`);
  if (workflow.questions.some(question => question.exploratory)) result.limitations.push('题单包含探索题；总命中率不等于所有问题都值得争取排名，后续建议应保留问题适用范围。');
  if (followups.length !== task.runs.length) result.limitations.push('历史回放、失败/部分记录及不符合本次协议或实施版本的记录未计入比较。');
  return result;
}

export function buildStrategyMemory(task: GeoTask, projectId: string): StrategyMemory | null {
  const outcome = evaluateOutcome(task);
  const workflow = task.workflow;
  if (!workflow || !task.proposal || !task.implementation || outcome.classification === 'inconclusive' || outcome.beforeRate === null || outcome.afterRate === null || !outcome.baselineRunId) return null;
  const revision = task.implementation.proposalRevision!;
  const id = `strategy-${createHash('sha256').update(JSON.stringify([projectId, task.id, revision, workflow.protocolKey, [...outcome.followupRunIds].sort()])).digest('hex').slice(0, 24)}`;
  const latestFollowup = task.runs.filter(run => outcome.followupRunIds.includes(run.id)).sort((left, right) => time(right.completedAt!) - time(left.completedAt!))[0];
  const advice = outcome.classification === 'improved' ? '类似条件下可优先考虑这项措施，但仍需独立验证。' :
    outcome.classification === 'worse' ? '类似条件下先复查这项措施及同期变化，不直接重复推荐。' : '本次未观察到提升；先检查观察时长和实施情况，再决定是否重试。';
  return {
    id, taskId: task.id, projectId, createdAt: latestFollowup.completedAt!,
    targetAssetId: task.proposal.targetAssetId, categories: [...new Set(workflow.questions.map(question => question.category))],
    protocolKey: workflow.protocolKey, outcome: outcome.classification,
    recommendation: `${advice} 适用范围：同项目、同目标内容、相同问题类别及搜索协议。${outcome.summary}`,
    action: `${task.implementation.note}\n实施地址：${task.implementation.url}\n已确认方案的修改：${task.proposal.changes.join('；')}`,
    beforeRate: outcome.beforeRate, afterRate: outcome.afterRate, baselineRunId: outcome.baselineRunId,
    followupRunIds: outcome.followupRunIds, evidencePaths: outcome.evidencePaths,
    implementationRevision: revision, confidence: 'observational',
  };
}

export function selectStrategies(task: GeoTask, strategies: StrategyMemory[]): StrategyMemory[] {
  const workflow = task.workflow;
  if (!workflow) return [];
  const categories = new Set(workflow.questions.map(question => question.category));
  const assets = new Set(workflow.questions.flatMap(question => question.assetIds));
  if (task.proposal?.targetAssetId) assets.add(task.proposal.targetAssetId);
  const applicable = strategies.filter(strategy => strategy.taskId !== task.id &&
    strategy.protocolKey === workflow.protocolKey && assets.has(strategy.targetAssetId) &&
    strategy.categories.some(category => categories.has(category)) && strategy.evidencePaths.length > 0 &&
    strategy.followupRunIds.length > 0).sort((left, right) => time(right.createdAt) - time(left.createdAt) || right.followupRunIds.length - left.followupRunIds.length);
  const latest = new Map<string, StrategyMemory>();
  for (const strategy of applicable) {
    const key = JSON.stringify([strategy.projectId, strategy.taskId, strategy.implementationRevision]);
    if (!latest.has(key)) latest.set(key, strategy);
  }
  return [...latest.values()].slice(0, 8);
}

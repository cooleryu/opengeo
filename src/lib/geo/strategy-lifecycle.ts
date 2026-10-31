import type { GeoTask } from './types';
import type {
  StrategyHistoryEntry,
  StrategyMemory,
  StrategyValidation,
} from './workflow-types';
import { evaluateOutcome } from './learning';

const time = (value: string) => Date.parse(value);
const unique = (values: string[]) => [...new Set(values)];

/** Legacy observations remain candidates; reading them never opts a strategy into use. */
export function normalizeStrategyMemory(
  strategy: StrategyMemory,
  migratedAt = new Date().toISOString(),
): StrategyMemory {
  if (
    ['candidate', 'validated', 'active', 'reverted'].includes(
      strategy.status,
    ) &&
    Number.isInteger(strategy.version) &&
    strategy.version >= 1 &&
    Array.isArray(strategy.history)
  )
    return strategy;
  return {
    ...strategy,
    status: 'candidate',
    version: 1,
    validation: undefined,
    originalCreatedAt: strategy.createdAt,
    createdAt: migratedAt,
    history: [
      {
        version: 1,
        action: 'created',
        at: migratedAt,
        reason: '历史观测按候选保留，需新增实测验证后才能生效。',
        runIds: [...strategy.followupRunIds],
        evidencePaths: [...strategy.evidencePaths],
      },
    ],
  };
}

function transition(
  strategy: StrategyMemory,
  action: StrategyHistoryEntry['action'],
  at: string,
  reason: string,
  runIds: string[],
  evidencePaths: string[],
): StrategyMemory {
  const previousAt = strategy.history.at(-1)?.at || strategy.createdAt;
  if (
    !Number.isFinite(time(at)) ||
    !Number.isFinite(time(previousAt)) ||
    time(at) < time(previousAt)
  ) {
    throw new Error('策略操作时间无效，不能早于上一条记录。');
  }
  const version = strategy.version + 1;
  return {
    ...strategy,
    version,
    history: [
      ...strategy.history,
      {
        version,
        action,
        at,
        reason,
        runIds: [...runIds],
        evidencePaths: [...evidencePaths],
      },
    ],
  };
}

/** Validation is local: it consumes existing new observations and never starts collection. */
export function validateStrategyMemory(
  input: StrategyMemory,
  task: GeoTask,
  at = new Date().toISOString(),
): StrategyMemory {
  const strategy = normalizeStrategyMemory(input);
  if (!['candidate', 'reverted'].includes(strategy.status))
    throw new Error('只有待验证或已回退的策略可以验证。');
  if (
    task.id !== strategy.taskId ||
    task.projectId !== strategy.projectId ||
    task.workflow?.protocolKey !== strategy.protocolKey ||
    task.proposal?.targetAssetId !== strategy.targetAssetId ||
    task.workflow?.baseline?.id !== strategy.baselineRunId ||
    task.implementation?.proposalRevision !== strategy.implementationRevision
  ) {
    throw new Error(
      '策略与来源任务的项目、内容、协议、基线或实施版本不一致，不能验证。',
    );
  }
  const categories = new Set(
    task.workflow.questions.map((question) => question.category),
  );
  if (
    strategy.categories.length !== categories.size ||
    !strategy.categories.every((category) => categories.has(category))
  ) {
    throw new Error('策略的问题类别已变化，不能继续使用原比较条件。');
  }
  const usedRuns = new Set([
    ...strategy.followupRunIds,
    ...strategy.history.flatMap((entry) => entry.runIds),
  ]);
  const usedEvidence = new Set([
    ...strategy.evidencePaths,
    ...strategy.history.flatMap((entry) => entry.evidencePaths),
  ]);
  // A reverted strategy needs observations after the rollback, not evidence already available then.
  const after = Math.max(
    time(strategy.createdAt),
    ...strategy.history
      .filter((entry) => entry.action === 'reverted')
      .map((entry) => time(entry.at)),
  );
  const freshRuns = task.runs.filter(
    (run) =>
      !usedRuns.has(run.id) &&
      [
        run.at,
        run.measurementAt,
        run.completedAt || '',
        ...run.questions.map((question) => question.measurementAt),
      ].every(
        (value) =>
          Number.isFinite(time(value)) &&
          time(value) > after &&
          time(value) <= time(at),
      ) &&
      run.questions.every(
        (question) => !usedEvidence.has(question.evidencePath),
      ),
  );
  const outcome = evaluateOutcome({ ...task, runs: freshRuns });
  if (
    outcome.beforeRate !== null &&
    outcome.beforeRate !== strategy.beforeRate
  ) {
    throw new Error('来源基线与候选生成时的观测不一致，不能改写比较依据。');
  }
  const passed =
    outcome.classification === 'improved' && outcome.followupRunIds.length > 0;
  const validation: StrategyValidation = {
    at,
    classification: outcome.classification,
    beforeRate: outcome.beforeRate,
    afterRate: outcome.afterRate,
    runIds: outcome.followupRunIds,
    evidencePaths: outcome.evidencePaths,
    passed,
    summary:
      outcome.classification === 'inconclusive'
        ? '没有候选生成后新增的完整同协议实测，或实施与基线条件不满足比较要求；保持待验证。'
        : `${outcome.summary}${passed ? '新增验证观察到提升，等待人工启用。' : '新增验证未观察到提升，策略不升级。'}`,
  };
  const updated = transition(
    strategy,
    passed ? 'validated' : 'validation_failed',
    at,
    validation.summary,
    validation.runIds,
    validation.evidencePaths,
  );
  return {
    ...updated,
    status: passed ? 'validated' : strategy.status,
    validation,
  };
}

export function activateStrategyMemory(
  input: StrategyMemory,
  at = new Date().toISOString(),
): StrategyMemory {
  const strategy = normalizeStrategyMemory(input);
  const validation = strategy.validation;
  if (
    strategy.status !== 'validated' ||
    !validation?.passed ||
    validation.classification !== 'improved' ||
    !validation.runIds.length ||
    !validation.evidencePaths.length ||
    validation.beforeRate === null ||
    validation.afterRate === null ||
    validation.afterRate <= validation.beforeRate ||
    strategy.history.at(-1)?.action !== 'validated'
  )
    throw new Error('策略尚未通过新增真实观测验证，不能启用。');
  return {
    ...transition(
      strategy,
      'activated',
      at,
      '用户确认启用已验证策略；适用范围保持原项目、内容、类别和协议。',
      validation.runIds,
      validation.evidencePaths,
    ),
    status: 'active',
    recommendation: `新增验证已观察到提升并经人工启用。仅用于同项目、同目标内容、相同问题类别及协议下的措施选择。${validation.summary.replace('新增验证观察到提升，等待人工启用。', '')}`,
  };
}

export function revertStrategyMemory(
  input: StrategyMemory,
  reason: string,
  at = new Date().toISOString(),
): StrategyMemory {
  const strategy = normalizeStrategyMemory(input);
  if (strategy.status !== 'active') throw new Error('只有已启用策略可以回退。');
  if (typeof reason !== 'string' || !reason.trim())
    throw new Error('请填写回退依据。');
  return {
    ...transition(
      strategy,
      'reverted',
      at,
      reason.trim(),
      [],
      unique([
        ...strategy.evidencePaths,
        ...(strategy.validation?.evidencePaths || []),
      ]),
    ),
    status: 'reverted',
  };
}

import { observationFromResult } from './research-observation';
import { currentGeoProject } from './projects';
import { GeoError } from './store';
import { collectLive } from './monitor';
import { collectionProvider, collectionReservation, getCollectionConfig, requireCollectionKey } from './providers/config';
import { appendResearchObservation, getLatestResearch, getResearchBatch, getResearchRun, listResearchRuns, saveResearchRun, type ResearchRunRecord } from './research';
import { normalizeResearchBudget, type NormalizedResearchBudget } from './research-budget';
import { buildSearchProtocolKey, frozenQuestion } from './search-protocol';
import type { CollectionTask } from './collection-runtime';
import type { WorkflowQuestion } from './workflow-types';
import { analyzeResearchObservation } from './answer-audit';
import { attachOverviewData } from './overview-data';

export function recoverStoppedResearchRuns() {
  const projectId = currentGeoProject();
  for (const run of listResearchRuns(projectId)) {
    if (run.status !== 'running' || !run.ownerPid) continue;
    try { process.kill(run.ownerPid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      saveResearchRun(projectId, { ...run, status: run.stopRequestedAt ? 'interrupted' : run.completedCount ? 'partial' : 'failed', currentQuestionId: undefined, phase: undefined, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(), error: '采集进程已退出。已保存结果和费用预留保留，未自动重试。' });
    }
  }
}

export async function collectResearch(input: Record<string, unknown>, schedule?: { scheduleId: string; shouldContinue: () => boolean }) {
  recoverStoppedResearchRuns();
  const projectId = currentGeoProject();
  const batch = typeof input.batchId === 'string' ? getResearchBatch(projectId, input.batchId) : getLatestResearch(projectId);
  if (!batch) throw new GeoError('当前项目没有已审阅的问题。');
  const provider = collectionProvider(input.provider);
  const language = input.language;
  if (language !== 'zh' && language !== 'en') throw new GeoError('请选择中文或英文。');
  const ids = input.questionIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new GeoError('每批请选择 1—8 个不同的核心问题。');
  if (input.budgetEnabled !== undefined && typeof input.budgetEnabled !== 'boolean') throw new GeoError('费用上限开关无效。');
  // Old callers (including daily tracking) retain their existing reservation
  // semantics. Only an explicit true promises a strict spending cap.
  const budgetEnabled = input.budgetEnabled !== false;
  const budgetEnforcement = input.budgetEnabled === true ? 'strict' : budgetEnabled ? 'legacy' : 'disabled';
  let budget: NormalizedResearchBudget | undefined;
  if (budgetEnabled) {
    try { budget = normalizeResearchBudget(input.budget ?? { currency: 'CNY', amount: input.budgetLimit }); }
    catch (error) { throw new GeoError(error instanceof Error ? error.message : '预算无效。'); }
    if (!input.budget && budget.limitCny > 2) throw new GeoError('本批费用上限需大于 0 且不超过 2 元。');
  }
  const budgetLimit = budget?.limitCny ?? null;
  const id = input.requestId;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(id)) throw new GeoError('缺少本次搜索编号，请重新打开搜索窗口。');
  const questions: WorkflowQuestion[] = ids.map(id => {
    const question = batch.questions.find(question => question.id === id && question.decision === 'search_now');
    if (!question?.[language]?.trim()) throw new GeoError('所选问题尚未通过搜索审核或缺少对应语言的原文。');
    const query = question[language];
    const maximum = provider === 'deepseek' ? 128 : 2000;
    if ([...query].length > maximum) throw new GeoError(`问题 ${id} 超过当前入口的 ${maximum} 字符上限，原题未截断、未发送。`);
    return { id, query, language, category: question.category ?? (id === 'C01' || id === 'R01' ? 'brand' : 'problem'), target: 'project', assetIds: [], exploratory: false, intent: query, expectedResult: question.valueReason };
  });
  const previous = getResearchRun(projectId, id);
  if (previous) {
    if (previous.batchId !== batch.id || previous.scheduleId !== schedule?.scheduleId || previous.provider !== provider || previous.language !== language || previous.budgetLimit !== budgetLimit || (previous.budgetEnabled ?? true) !== budgetEnabled || (previous.budgetEnforcement ?? 'legacy') !== budgetEnforcement || (previous.budget && JSON.stringify(previous.budget) !== JSON.stringify(budget)) || JSON.stringify(previous.questions) !== JSON.stringify(questions.map(q => ({questionId: q.id, query: q.query})))) throw new GeoError('该搜索编号已用于其他条件，请刷新。', 409);
    // An uncertain request is never silently sent and billed for a second time.
    return { run: previous, batch: attachOverviewData(getResearchBatch(projectId, batch.id)) };
  }
  if (budgetEnforcement === 'strict' && provider !== 'deepseek') throw new GeoError('当前平台暂不能保证费用上限，请关闭上限或切换 DeepSeek。');
  requireCollectionKey(provider);
  if (schedule && !schedule.shouldContinue()) throw new GeoError('每日跟踪已暂停，未发送请求。');
  if (budgetLimit !== null && questions.length * collectionReservation(provider) > budgetLimit + 1e-9) throw new GeoError('当前费用上限不足以执行所选问题，未发送请求。');
  const now = new Date().toISOString();
  const collection = getCollectionConfig(provider);
  let record: ResearchRunRecord = {
    id, projectId, batchId: batch.id, provider, language,
    questions: questions.map(q => ({ questionId: q.id, query: q.query })),
    status: 'running', phase: 'searching', startedAt: now, updatedAt: now, spent: 0, budgetEnabled, budgetEnforcement, budgetLimit, ...(budget ? { budget } : {}), confirmedSpentCny: 0, reservedCny: 0, completedCount: 0, ownerPid: process.pid,
    ...(schedule ? { scheduleId: schedule.scheduleId } : {}),
    entryType: provider === 'deepseek' ? 'api_search' : 'api_answer',
  };
  saveResearchRun(projectId, record);
  // This is an observation job, not a user-facing improvement task.
  const task: CollectionTask = {
    id, projectId, title: '问题搜索', goal: '', status: 'investigating', createdAt: now, updatedAt: now,
    blocks: [], events: [], proposal: null, implementation: null, source: 'evidence', runs: [],
    monitor: { enabled: false, mode: 'live', timeOfDay: '', days: 1, remaining: 1, nextRunAt: null, budgetLimit, spent: 0, queryIds: ids, lastRunAt: null },
    workflow: { version: 1, collection, questionPlanId: batch.id, questionPlanRevision: 1, frozenAt: now, questions, protocolKey: buildSearchProtocolKey(questions, collection), stage: 'search', proposalRevision: 0, appliedStrategyIds: [] },
  };
  const persist = () => {
    record.updatedAt = new Date().toISOString();
    record = saveResearchRun(projectId, record);
  };
  const shouldStop = () => {
    const saved = getResearchRun(projectId, id);
    if (saved?.stopRequestedAt) record.stopRequestedAt = saved.stopRequestedAt;
    return Boolean(record.stopRequestedAt || (schedule && !schedule.shouldContinue()));
  };
  try {
    const run = await collectLive(id, id, questions.map(frozenQuestion), now, 'baseline', {
      getTask: () => shouldStop() ? { ...task, status: 'paused' } : task,
      onQuestionStart: question => {
        record.currentQuestionId = question.id;
        record.phase = 'searching';
        persist();
      },
      chargeTask: (_, cost) => {
        if (cost > 0 && shouldStop()) throw new GeoError('已请求停止，后续问题未发送。');
        const spent = Math.round((record.spent + cost) * 1000) / 1000;
        if (spent < 0 || (budgetLimit !== null && spent > budgetLimit + 1e-9)) throw new Error('已达到本批费用上限。');
        record.spent = spent;
        record.reservedCny = Math.max(0, Math.round((spent - (record.confirmedSpentCny || 0)) * 1000) / 1000);
        persist(); task.monitor.spent = spent;
      },
      onObservation: async result => {
        const observation = observationFromResult(result, id, provider);
        appendResearchObservation(projectId, batch.id, result.id, observation);
        if (provider === 'deepseek' && result.resultCount > 0) record.confirmedSpentCny = Math.round(((record.confirmedSpentCny || 0) + 0.005) * 1000) / 1000;
        record.reservedCny = Math.max(0, Math.round((record.spent - (record.confirmedSpentCny || 0)) * 1000) / 1000);
        if (budgetEnforcement === 'strict') {
          // Search is fixed-price; analysis calls have no known upper bound.
          // Preserve the observation without silently starting extra paid work.
          record.analysisStatus = 'pending_budget';
          record.analysisNote = '费用上限已开启；额外模型分析尚无可确认的费用上界，结果已保存，分析待处理。';
        }
        record.completedCount = (record.completedCount || 0) + 1; persist();
        if (budgetEnforcement !== 'strict' && !shouldStop()) {
          record.phase = 'analyzing'; persist();
          if (!shouldStop()) await analyzeResearchObservation(batch, result.id, observation, result.answer);
        }
        if (result.answer && !shouldStop()) {
          // Existing competitor identities can be checked against native citations
          // immediately; this local check does not wait for another model ranking.
          const { auditCompetitorCandidateCitations } = await import('./competitor-candidates');
          await auditCompetitorCandidateCitations(batch.id, {
            observations: [{ questionId: result.id, observation, answer: result.answer }],
          });
        }
      },
    });
    record = { ...record, completedCount: run.completedCount, error: run.error, evidencePath: `data/geo-evidence/${id}/run.json`, currentQuestionId: undefined, phase: 'finalizing' };
    persist();
    if (record.completedCount && budgetEnforcement !== 'strict' && !shouldStop()) {
      // Keep the run active until all work finishes, so progress and the project
      // lock still describe the actual work. A stop skips analyses not yet begun.
      try {
        const { analyzeCompetitorCandidates } = await import('./competitor-analysis');
        if (!shouldStop()) await analyzeCompetitorCandidates(batch.id);
      } catch { /* Original observations and collection status remain intact. */ }
    }
    shouldStop();
    record = { ...record, status: record.stopRequestedAt ? 'interrupted' : run.status, completedAt: new Date().toISOString(), currentQuestionId: undefined, phase: undefined,
      ...(record.stopRequestedAt ? { error: '已停止；已完成的搜索结果和费用记录已保留。' } : {}) };
    persist();
  } catch (error) {
    shouldStop();
    record = { ...record, status: record.stopRequestedAt ? 'interrupted' : record.completedCount ? 'partial' : 'failed', currentQuestionId: undefined, phase: undefined, completedAt: new Date().toISOString(), error: record.stopRequestedAt ? '已停止；已完成的搜索结果和费用记录已保留。' : error instanceof Error ? error.message : '搜索未完成；已保存记录与费用保留。' };
    persist();
  }
  return { run: record, batch: attachOverviewData(getResearchBatch(projectId, batch.id)) };
}

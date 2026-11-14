import { observationFromResult } from './research-observation';
import path from 'node:path';
import { currentGeoProject } from './projects';
import { dataDirectory, GeoError } from './store';
import { collectLive } from './monitor';
import { collectionProvider, collectionReservation, getCollectionConfig, requireCollectionKey } from './providers/config';
import { getLatestResearch, getResearchBatch, getResearchRun, listResearchRuns, saveResearchRun, type ResearchRunRecord } from './research';
import { normalizeResearchBudget, type NormalizedResearchBudget } from './research-budget';
import { buildSearchProtocolKey, frozenQuestion } from './search-protocol';
import type { CollectionTask } from './collection-runtime';
import type { WorkflowQuestion } from './workflow-types';
import { analyzeResearchObservation } from './answer-audit';
import { saveAnswerAudit } from './answer-audit-store';
import { attachOverviewData } from './overview-data';
import { assertResearchRunOwner, beginResearchQuestion, claimResearchRun, completeResearchQuestion, failResearchQuestion, heartbeatResearchRun,
  newResearchExecution, ResearchLeaseLostError, updateOwnedResearchRun, type ResearchOwnershipCheck } from './research-store';
import { questionFromCollectionResponse, readCollectionResponse } from './collection-response';
import { isResearchScheduleEnabled } from './research-tracking';
import type { GeoQuestion } from './types';

// Legacy jobs have no heartbeat. Bound their stale lock without guessing whether
// a provider billed them; newer jobs use the execution lease exclusively.
export const LEGACY_RESEARCH_STALE_MS = 15 * 60_000;
const processStartedAt = Date.now() - process.uptime() * 1000;

export function recoverStoppedResearchRuns(now = Date.now()) {
  const projectId = currentGeoProject();
  for (const run of listResearchRuns(projectId)) {
    if (run.status !== 'running' || run.execution) continue;
    let stale = !Number.isFinite(Date.parse(run.updatedAt)) || now - Date.parse(run.updatedAt) > LEGACY_RESEARCH_STALE_MS;
    if (run.ownerPid === process.pid && Date.parse(run.updatedAt) < processStartedAt - 1000) stale = true;
    if (run.ownerPid) {
      try { process.kill(run.ownerPid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') stale = true; }
    }
    if (!stale) continue;
    saveResearchRun(projectId, { ...run, status: run.stopRequestedAt ? 'interrupted' : run.completedCount ? 'partial' : 'failed',
      currentQuestionId: undefined, phase: undefined, updatedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString(),
      error: '旧采集过程已中断或长时间无进展。已保存结果和费用预留保留；缺少安全续跑记录，未自动重试。' });
  }
}

/** Called by the existing scheduler even when no browser is open. */
export async function recoverResearchRuns(): Promise<void> {
  recoverStoppedResearchRuns();
  const projectId = currentGeoProject();
  for (const saved of listResearchRuns(projectId)) {
    if (saved.status !== 'running' || !saved.execution) continue;
    const claimed = claimResearchRun(projectId, saved.id);
    if (claimed) await executeResearchRun(claimed, true);
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
  const record: ResearchRunRecord = {
    id, projectId, batchId: batch.id, provider, language,
    questions: questions.map(q => ({ questionId: q.id, query: q.query })),
    status: 'running', phase: 'searching', startedAt: now, updatedAt: now, spent: 0, budgetEnabled, budgetEnforcement, budgetLimit, ...(budget ? { budget } : {}), confirmedSpentCny: 0, reservedCny: 0, completedCount: 0, ownerPid: process.pid,
    ...(schedule ? { scheduleId: schedule.scheduleId } : {}),
    entryType: provider === 'deepseek' ? 'api_search' : 'api_answer',
    collection, protocolKey: buildSearchProtocolKey(questions, collection), execution: newResearchExecution(),
    questionProgress: Object.fromEntries(questions.map(question => [question.id, { status: 'pending', reservedCny: 0, confirmedCny: 0 }])),
  };
  saveResearchRun(projectId, record);
  return executeResearchRun(record, false, schedule);
}

async function executeResearchRun(initial: ResearchRunRecord, recovering: boolean,
  schedule?: { scheduleId: string; shouldContinue: () => boolean }) {
  let record = initial;
  const { id, projectId, language, budgetLimit, budgetEnforcement } = record;
  const provider = collectionProvider(record.provider);
  const batch = getResearchBatch(projectId, record.batchId);
  if (!batch || !record.execution || !record.collection || !record.questionProgress) throw new GeoError('缺少安全续跑所需的搜索条件。');
  const token = record.execution.token;
  const questions: WorkflowQuestion[] = record.questions.map(saved => {
    const question = batch.questions.find(question => question.id === saved.questionId)!;
    return { id: saved.questionId, query: saved.query, language, category: question.category ?? (saved.questionId === 'C01' || saved.questionId === 'R01' ? 'brand' : 'problem'),
      target: 'project', assetIds: [], exploratory: false, intent: saved.query, expectedResult: question.valueReason };
  });
  const task: CollectionTask = {
    id, projectId, title: '问题搜索', goal: '', status: 'investigating', createdAt: record.startedAt, updatedAt: record.updatedAt,
    blocks: [], events: [], proposal: null, implementation: null, source: 'evidence', runs: [],
    monitor: { enabled: false, mode: 'live', timeOfDay: '', days: 1, remaining: 1, nextRunAt: null, budgetLimit,
      spent: record.spent, queryIds: questions.map(question => question.id), lastRunAt: null },
    workflow: { version: 1, collection: record.collection, questionPlanId: batch.id, questionPlanRevision: 1,
      frozenAt: record.startedAt, questions, protocolKey: record.protocolKey!, stage: 'search', proposalRevision: 0, appliedStrategyIds: [] },
  };
  let leaseLost = false;
  const assertActive: ResearchOwnershipCheck = connection => {
    if (leaseLost) throw new ResearchLeaseLostError();
    const saved = assertResearchRunOwner(projectId, id, token, connection);
    if (saved.stopRequestedAt) record.stopRequestedAt = saved.stopRequestedAt;
  };
  const update = (change: (run: ResearchRunRecord) => void) => {
    record = updateOwnedResearchRun(projectId, id, token, change);
    task.monitor.spent = record.spent;
  };
  const shouldStop = () => {
    assertActive();
    return Boolean(record.stopRequestedAt || (schedule ? !schedule.shouldContinue()
      : record.scheduleId && !isResearchScheduleEnabled(projectId, record.scheduleId)));
  };
  const heartbeat = setInterval(() => {
    try { heartbeatResearchRun(projectId, id, token); }
    catch { leaseLost = true; }
  }, 10_000);
  heartbeat.unref?.();
  const commitObservation = async (result: GeoQuestion, allowAnalysis: boolean) => {
    assertActive();
    if (result.answer && !result.answer.model && record.collection?.model) result.answer.model = record.collection.model;
    const observation = observationFromResult(result, id, provider);
    record = completeResearchQuestion(projectId, id, token, result, observation);
    task.monitor.spent = record.spent;
    if (budgetEnforcement === 'strict') update(run => {
      run.analysisStatus = 'pending_budget';
      run.analysisNote = '费用上限已开启；额外模型分析尚无可确认的费用上界，结果已保存，分析待处理。';
    });
    if (allowAnalysis && budgetEnforcement !== 'strict' && !shouldStop()) {
      update(run => { run.phase = 'analyzing'; run.questionProgress![result.id].analysis = 'started'; });
      if (!shouldStop()) await analyzeResearchObservation(batch, result.id, observation, result.answer, {
        persist: audit => saveAnswerAudit(audit, assertActive),
      });
      update(run => { run.questionProgress![result.id].analysis = 'complete'; });
    }
    if (result.answer && !shouldStop()) {
      const { auditCompetitorCandidateCitations } = await import('./competitor-candidates');
      assertActive();
      await auditCompetitorCandidateCitations(batch.id, { assertActive, observations: [{ questionId: result.id, observation, answer: result.answer }] });
    }
  };
  try {
    if (recovering) update(run => {
      for (const question of Object.values(run.questionProgress!)) if (question.analysis === 'started') question.analysis = 'uncertain';
      if (run.finalAnalysis === 'started') run.finalAnalysis = 'uncertain';
      if (budgetEnforcement !== 'strict') run.analysisNote = '中断后的搜索结果继续保留；恢复过程中未自动重试付费分析。';
    });
    const run = await collectLive(id, id, questions.map(frozenQuestion), record.startedAt, 'baseline', {
      assertActive,
      getTask: () => shouldStop() ? { ...task, status: 'paused' } : task,
      chargeTask: () => { throw new Error('恢复采集须使用逐题原子费用预留。'); },
      onQuestionStart: question => update(run => { run.currentQuestionId = question.id; run.phase = 'searching'; }),
      beforeRequest: (question, reserve) => {
        if (shouldStop()) throw new GeoError('已请求停止，后续问题未发送。');
        requireCollectionKey(provider);
        record = beginResearchQuestion(projectId, id, token, question.id, reserve);
        task.monitor.spent = record.spent;
      },
      recoverQuestion: async question => {
        assertActive();
        const progress = record.questionProgress![question.id];
        if (progress.status === 'pending') return undefined;
        if (progress.status === 'complete') return { result: progress.result };
        if (progress.status !== 'sent') return { error: progress.error || '请求结果未确认，未自动重试。' };
        const directory = path.join(dataDirectory(), 'geo-evidence', id);
        let response;
        let result: GeoQuestion | undefined;
        try {
          response = readCollectionResponse(directory, question, record.protocolKey);
          if (response) result = questionFromCollectionResponse(task, id, question, response);
        } catch (error) {
          const message = error instanceof Error ? error.message : '保存的返回无法核对。';
          record = failResearchQuestion(projectId, id, token, question.id, message,
            provider === 'deepseek' && Boolean(response && (response.httpStatus < 200 || response.httpStatus >= 300)));
          task.monitor.spent = record.spent;
          return { error: message };
        }
        if (result) {
          // A complete return can be committed without another provider call.
          await commitObservation(result, false);
          return { result };
        }
        const error = '请求可能已执行，返回未完整保存；费用预留保留，未自动重试。';
        record = failResearchQuestion(projectId, id, token, question.id, error, false);
        task.monitor.spent = record.spent;
        return { error };
      },
      onQuestionFailure: (question, message, refundable) => {
        record = failResearchQuestion(projectId, id, token, question.id, message, refundable);
        task.monitor.spent = record.spent;
      },
      onObservation: result => commitObservation(result, !recovering),
    });
    update(saved => { saved.error = run.error; saved.evidencePath = `data/geo-evidence/${id}/run.json`;
      saved.currentQuestionId = undefined; saved.phase = 'finalizing'; });
    if (!recovering && record.completedCount && budgetEnforcement !== 'strict' && !shouldStop()) {
      try {
        const { analyzeCompetitorCandidates } = await import('./competitor-analysis');
        if (!shouldStop()) {
          update(saved => { saved.finalAnalysis = 'started'; });
          await analyzeCompetitorCandidates(batch.id, { assertActive });
          update(saved => { saved.finalAnalysis = 'complete'; });
        }
      } catch (error) { if (error instanceof ResearchLeaseLostError) throw error; }
    }
    const stopped = shouldStop();
    update(saved => { saved.status = stopped ? 'interrupted' : run.status; saved.completedAt = new Date().toISOString();
      saved.currentQuestionId = undefined; saved.phase = undefined;
      if (stopped) saved.error = '已停止；已完成的搜索结果和费用记录已保留。'; });
  } catch (error) {
    if (!(error instanceof ResearchLeaseLostError)) {
      try {
        const stopped = shouldStop();
        update(saved => { saved.status = stopped ? 'interrupted' : saved.completedCount ? 'partial' : 'failed';
          saved.currentQuestionId = undefined; saved.phase = undefined; saved.completedAt = new Date().toISOString();
          saved.error = stopped ? '已停止；已完成的搜索结果和费用记录已保留。'
            : error instanceof Error ? error.message : '搜索未完成；已保存记录与费用保留。'; });
      } catch (failure) { if (!(failure instanceof ResearchLeaseLostError)) throw failure; }
    }
    record = getResearchRun(projectId, id) ?? record;
  } finally { clearInterval(heartbeat); }
  return { run: record, batch: attachOverviewData(getResearchBatch(projectId, batch.id)) };
}

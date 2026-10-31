import { importTaskResearchRuns, analyzeImportedResearchRun } from './research-task-import';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GeoQuestion, GeoRun, GeoTask } from './types';
import { getSeed } from './seed';
import { claimTask, dataDirectory, GeoError, getTask, newEvent, nextDailyRun, nowISO, refreshTaskOutcome, releaseTask, updateTask } from './store';
import { buildSearchProtocolKey, DEEPSEEK_SEARCH_ENDPOINT, frozenQuestion, LEGACY_SEARCH_PARAMETERS, matchHistoricalQuestions, matchesProjectURL, matchesQuestionTarget, WORKFLOW_SEARCH_PARAMETERS } from './search-protocol';

import { collectionReservation, requireCollectionKey } from './providers/config';
import { collectAnswerRun } from './answer-monitor';
import { defaultCollectionRuntime, type CollectionRuntime } from './collection-runtime';
const taskProvider = (task: Pick<GeoTask, 'workflow'>) => task.workflow?.collection?.provider || 'deepseek';
const taskCost = (task: GeoTask) => collectionReservation(taskProvider(task));
const QUERY_COST = 0.005;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const roundCost = (n: number) => Math.round(n * 1000) / 1000;
const shanghaiDate = (at: string) => new Date(new Date(at).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const hasLiveRunToday = (task: GeoTask) => [...task.runs, ...(task.workflow?.baseline ? [task.workflow.baseline] : [])].some(run => run.mode === 'live' && shanghaiDate(run.at) === shanghaiDate(nowISO()));

export function isCurrentProjectURL(value: string): boolean {
  const seed = getSeed();
  // Keep the legacy protocol's case-insensitive project matching.
  return matchesProjectURL(value.toLowerCase(), { ...seed, project: { ...seed.project,
    siteUrl: seed.project.siteUrl.toLowerCase(), repositoryUrl: seed.project.repositoryUrl.toLowerCase() } });
}
function questionSet(task: GeoTask): GeoQuestion[] {
  if (task.workflow) {
    const questions = task.workflow.questions;
    if (!questions.length || new Set(questions.map(question => question.id)).size !== questions.length ||
        task.workflow.protocolKey !== buildSearchProtocolKey(questions, task.workflow.collection)) throw new GeoError('冻结题单或搜索协议不一致，请重新创建任务；本次未发送请求。');
    const seed = getSeed();
    if (questions.some(question => question.target === 'article' && !seed.assets.some(asset => question.assetIds.includes(asset.id) && asset.publicUrl && matchesQuestionTarget(asset.publicUrl, question, seed)))) {
      throw new GeoError('文章题缺少可验证的公开目标地址，请先补齐内容材料并重新冻结题单；本次未发送请求。');
    }
    return questions.map(frozenQuestion);
  }
  const frozen = getSeed().questions;
  const selected = frozen.filter(q => task.monitor.queryIds.includes(q.id));
  if (!selected.length || selected.length !== task.monitor.queryIds.length) throw new GeoError('固定题单不完整，请检查已有测量数据。');
  return selected;
}
function assertQueries(questions: GeoQuestion[], provider = 'deepseek') {
  const limit = provider === 'deepseek' ? 128 : 2000;
  const invalid = questions.find(question => !question.query.trim() || [...question.query].length > limit);
  if (invalid) throw new GeoError(`问题 ${invalid.id} 的问法为空或超过接口 ${limit} 个 Unicode 字符上限（当前 ${[...invalid.query].length} 个）；请回题单修改并重新冻结，本次不截断也不发送请求。`);
}
function runStamp(task: Pick<GeoTask, 'workflow' | 'implementation'>, phase: 'baseline' | 'followup'): Pick<GeoRun, 'phase' | 'protocolKey' | 'implementationRevision'> {
  return task.workflow ? { phase, protocolKey: task.workflow.protocolKey, implementationRevision: phase === 'baseline' ? 0 : task.implementation?.proposalRevision } : {};
}
function saveRunEvidence(run: GeoRun) {
  const directory = path.join(dataDirectory(), 'geo-evidence', run.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run, null, 2), { flag: 'wx' });
}

function replayRun(task: GeoTask, runId: string, questions: GeoQuestion[], startedAt: string, phase: 'baseline' | 'followup'): GeoRun {
  if (taskProvider(task) !== 'deepseek') throw new GeoError('此回答入口没有可匹配的历史记录，不能使用 DeepSeek 搜索回放替代。');
  const seed = getSeed();
  const matched = matchHistoricalQuestions(questions, seed.questions);
  // An article target needs the original full search list; top-three snippets alone cannot establish a miss.
  const completed = matched.flatMap(question => {
    const target = task.workflow?.questions.find(item => item.id === question.id);
    if (!target || target.target === 'project') return [question];
    try {
      const root = fs.realpathSync(process.env.GEO_WORKSPACE || path.join(process.cwd(), '..'));
      const file = fs.realpathSync(path.resolve(root, question.evidencePath));
      if (!file.startsWith(root + path.sep)) return [];
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(raw.results)) return [];
      const rank = raw.results.findIndex((result: { url?: string }) => matchesQuestionTarget(String(result.url || ''), target, seed));
      return [{ ...question, projectHit: rank >= 0, rank: rank >= 0 ? rank + 1 : null }];
    } catch { return []; }
  });
  const status = completed.length === questions.length ? 'completed' : 'partial';
  const hitCount = completed.length ? completed.filter(question => question.projectHit).length : null;
  const missing = questions.filter(question => !completed.some(result => result.id === question.id)).map(question => question.id);
  return {
    id: runId, at: startedAt, completedAt: nowISO(), measurementAt: completed[0]?.measurementAt || '', mode: 'replay', status,
    queryCount: questions.length, completedCount: completed.length, hitCount,
    resultCount: completed.reduce((sum, question) => sum + question.resultCount, 0), cost: 0, questions: completed,
    ...runStamp(task, phase),
    summary: `仅回放相同 ID 和原文的历史观测：${completed.length}/${questions.length} 题有对应记录${hitCount === null ? '' : `，其中 ${hitCount} 题命中目标`}。测量日期保持原样；没有产生新的实测，不能判断实施后的效果。${missing.length ? `缺少历史记录：${missing.join('、')}，不会补造结果。` : ''}`,
    ...(missing.length ? { error: '部分冻结问题没有完全对应的历史记录，未计作零命中。' } : {}),
  };
}

/** The caller owns the task lock and budget confirmation. Baselines are separate from follow-up runs. */
export async function collectBaseline(taskId: string, mode: 'live' | 'replay'): Promise<GeoRun> {
  const task = getTask(taskId);
  if (!task.workflow) throw new GeoError('新基线需要已冻结的任务题单。');
  if (task.implementation) throw new GeoError('已记录实施，不能补建或覆盖实施前基线。');
  if (task.workflow.baseline?.mode === 'live' && task.workflow.baseline.status === 'completed') throw new GeoError('已有完整真实基线，不能覆盖；请沿当前任务继续，改题需要新任务。');
  const runId = randomUUID();
  const startedAt = nowISO();
  let questions: GeoQuestion[] = [];
  let run: GeoRun;
  try {
    questions = questionSet(task);
    if (mode === 'live') {
      assertQueries(questions, taskProvider(task));
      requireCollectionKey(taskProvider(task));
      if (hasLiveRunToday(task)) throw new GeoError('今天已执行过一次真实采集，请明天再采集，避免重复计费。');
      if (task.monitor.budgetLimit - task.monitor.spent + 1e-9 < questions.length * taskCost(task)) throw new GeoError('剩余预算不足以完成本轮基线，未发送付费请求。');
      run = await collectLive(taskId, runId, questions, startedAt, 'baseline');
    } else {
      run = replayRun(task, runId, questions, startedAt, 'baseline');
      saveRunEvidence(run);
    }
  } catch (error) {
    run = { id: runId, at: startedAt, completedAt: nowISO(), measurementAt: mode === 'live' ? startedAt : '', mode, status: 'failed',
      queryCount: questions.length || task.workflow.questions.length, completedCount: 0, hitCount: null, resultCount: 0,
      cost: roundCost(getTask(taskId).monitor.spent - task.monitor.spent), questions: [], ...runStamp(task, 'baseline'),
      summary: '基线未取得完整可用结果，不能把失败当成零命中，也不能据此声称措施有效。',
      error: error instanceof Error ? error.message : '基线采集失败。' };
    const file = path.join(dataDirectory(), 'geo-evidence', run.id, 'run.json');
    if (!fs.existsSync(file)) saveRunEvidence(run);
  }
  updateTask(taskId, current => { if (current.workflow) current.workflow.baseline = run; });
  importTaskResearchRuns(getTask(taskId));
  await analyzeImportedResearchRun(getTask(taskId), run);
  return run;
}
function assertRunnable(task: GeoTask, mode: 'live' | 'replay') {
  if (!task.implementation || !['monitoring', 'paused', 'failed', 'completed'].includes(task.status)) throw new GeoError('请先确认方案与实施，再进行观察。');
  const questions = questionSet(task);
  if (mode === 'live') {
    assertQueries(questions, taskProvider(task));
    if (task.status === 'paused') throw new GeoError('任务已经暂停，请先恢复再启动真实观察。');
    if (hasLiveRunToday(task)) throw new GeoError('今天已执行过一次真实观察。为避免重复计费，下一次安排在明天；失败和部分完成的记录也会保留。');
    if (task.implementation.kind !== 'user_confirmed') throw new GeoError('演练实施不能启动付费实测。请先记录实际实施。');
    if (task.monitor.mode !== 'live') throw new GeoError('请先在监控设置中明确选择真实采集并确认费用上限。');
    requireCollectionKey(taskProvider(task));
    if (task.workflow && task.implementation.proposalRevision !== task.workflow.proposalRevision) throw new GeoError('方案版本已变化，请先确认当前方案的真实实施。');
    if (task.monitor.budgetLimit - task.monitor.spent + 1e-9 < questions.length * taskCost(task)) throw new GeoError('剩余预算不足以完成本轮观察，未发送付费请求。');
  }
}
export function startMonitor(taskId: string, mode: 'live' | 'replay', scheduled = false): void {
  const task = getTask(taskId);
  if (scheduled && mode === 'live' && hasLiveRunToday(task)) {
    updateTask(taskId, t => { t.monitor.nextRunAt = nextDailyRun(t.monitor.timeOfDay); });
    return;
  }
  assertRunnable(task, mode);
  const runId = randomUUID();
  claimTask(taskId, 'monitor', runId, mode);
  updateTask(taskId, t => {
    delete t.error;
    t.events.push(newEvent(mode === 'live' ? '开始真实观察' : '开始历史回放', mode === 'live' ? `冻结题单 ${questionSet(t).length} 题；本轮费用预留 ¥${(questionSet(t).length * taskCost(t)).toFixed(3)}，逐题保留原始返回。` : '只读取 ID 与问法完全一致的已有实测；没有对应历史的题保持未测，本轮不是新的测量。'));
    // Claim the next slot before work begins, so missed days never cause a catch-up loop.
    if (scheduled) t.monitor.nextRunAt = nextDailyRun(t.monitor.timeOfDay);
  });
  void executeMonitor(taskId, runId, mode, scheduled);
}

async function executeMonitor(taskId: string, runId: string, mode: 'live' | 'replay', scheduled: boolean) {
  const task = getTask(taskId);
  const questions = questionSet(task);
  const startedAt = nowISO();
  let run: GeoRun;
  try {
    if (mode === 'replay') {
      run = replayRun(task, runId, questions, startedAt, 'followup');
      if (task.workflow) saveRunEvidence(run);
    } else {
      run = await collectLive(taskId, runId, questions, startedAt, 'followup');
    }
    updateTask(taskId, t => {
      t.runs.push(run); t.monitor.lastRunAt = run.at;
      if (scheduled) t.monitor.remaining = Math.max(0, t.monitor.remaining - 1);
      if (run.error) t.error = run.error; else delete t.error;
      if (run.status === 'completed' && t.status === 'failed') t.status = t.monitor.enabled ? 'monitoring' : 'paused';
      if (t.monitor.enabled && t.monitor.remaining <= 0) {
        t.monitor.enabled = false; t.monitor.nextRunAt = null; t.status = 'completed';
        t.events.push(newEvent(mode === 'replay' ? '演练观察计划结束' : '观察计划已完成', mode === 'replay' ? '所有记录都只是同一次历史观测的回放，尚无实施后的效果证据。' : '计划天数已结束，请根据成功采集的可比记录决定继续观察或调整方案。', 'attention'));
      } else if (t.monitor.enabled) { t.monitor.nextRunAt = nextDailyRun(t.monitor.timeOfDay); }
      if (run.status === 'failed' && t.status !== 'paused') {
        t.status = 'failed'; t.monitor.enabled = false; t.monitor.nextRunAt = null;
      }
      t.events.push(newEvent(run.status !== 'completed' ? '观察数据不完整' : mode === 'replay' ? '历史回放已完成' : '真实观察已完成', run.summary, run.status === 'completed' ? 'success' : 'attention'));
    });
    importTaskResearchRuns(getTask(taskId));
    await analyzeImportedResearchRun(getTask(taskId), run);
    if (task.workflow) refreshTaskOutcome(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : '观察发生未知错误。';
    updateTask(taskId, t => {
      if (!t.runs.some(r => r.id === runId)) t.runs.push({ id: runId, at: startedAt, completedAt: nowISO(), measurementAt: mode === 'replay' ? questions[0]?.measurementAt || '' : startedAt, mode, status: 'failed', queryCount: questions.length, completedCount: 0, hitCount: null, resultCount: 0, cost: roundCost(t.monitor.spent - task.monitor.spent), questions: [], ...runStamp(task, 'followup'), summary: '本次未获得完整可用结果，不能判断效果。失败不计为零命中。', error: message });
      t.error = message; if (t.status !== 'paused') t.status = 'failed'; t.monitor.enabled = false; t.monitor.nextRunAt = null;
      t.events.push(newEvent('观察未完成', message, 'error'));
    });
    importTaskResearchRuns(getTask(taskId));
    if (task.workflow) refreshTaskOutcome(taskId);
  } finally { releaseTask(taskId); }
}

export async function collectLive(taskId: string, runId: string, questions: GeoQuestion[], startedAt: string,
  phase: 'baseline' | 'followup', context: CollectionRuntime = defaultCollectionRuntime): Promise<GeoRun> {
  const originalTask = context.getTask(taskId);
  assertQueries(questions, taskProvider(originalTask));
  if (taskProvider(originalTask) !== 'deepseek') return collectAnswerRun(originalTask, runId, questions, startedAt, phase, context);
  const seed = getSeed();
  const parameters = originalTask.workflow ? WORKFLOW_SEARCH_PARAMETERS : LEGACY_SEARCH_PARAMETERS;
  const stamp = runStamp(originalTask, phase);
  const evidenceDir = path.join(dataDirectory(), 'geo-evidence', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const completed: GeoQuestion[] = [];
  const errors: string[] = [];
  let cost = 0;
  let stop = false;
  for (const question of questions) {
    const current = context.getTask(taskId);
    if (originalTask.workflow && (current.workflow?.protocolKey !== stamp.protocolKey ||
        (phase === 'baseline' ? current.implementation !== null : current.implementation?.proposalRevision !== stamp.implementationRevision))) {
      errors.push('采集期间题单协议或实施版本发生变化，剩余问题未发送。'); break;
    }
    if (current.status === 'paused') { errors.push('用户暂停后，剩余问题未发送。'); break; }
    if (current.monitor.budgetLimit !== null && current.monitor.budgetLimit - current.monitor.spent + 1e-9 < QUERY_COST) { errors.push('已达费用上限，剩余问题未发送。'); break; }
    context.onQuestionStart?.(question);
    const at = nowISO();
    const safeId = /^[a-zA-Z0-9_-]{1,100}$/.test(question.id) ? question.id : createHash('sha256').update(question.id).digest('hex');
    const rawFile = path.join(evidenceDir, `${safeId}.json`);
    const payload = { query: question.query, ...parameters };
    fs.writeFileSync(path.join(evidenceDir, `${safeId}.request.json`), JSON.stringify({
      endpoint: DEEPSEEK_SEARCH_ENDPOINT, payload, at, ...stamp,
      target: originalTask.workflow?.questions.find(item => item.id === question.id) || null,
    }, null, 2), { flag: 'wx' });
    let httpStatus = 0;
    let observation: GeoQuestion | undefined;
    // Persist a reservation before the network call: a timeout or crash is not proof
    // that the provider did not execute or bill it. Refund only a known free result.
    context.chargeTask(taskId, QUERY_COST);
    cost = roundCost(cost + QUERY_COST);
    try {
      const response = await fetch(DEEPSEEK_SEARCH_ENDPOINT, {
        method: 'POST', headers: { Authorization: `Bearer ${requireCollectionKey('deepseek')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
      });
      httpStatus = response.status;
      const raw = await response.text();
      fs.writeFileSync(rawFile, raw, { flag: 'wx' });
      if (!response.ok) {
        context.chargeTask(taskId, -QUERY_COST); cost = roundCost(cost - QUERY_COST);
        stop = [401, 403, 429].includes(response.status); throw new Error(`HTTP ${response.status}`);
      }
      let parsed: { results?: unknown };
      try { parsed = JSON.parse(raw); } catch {
        // A successful but unreadable response may have been billed; reserve its cost conservatively.
        throw new Error('返回格式无法解析，按可能计费预留费用，原始响应已保存');
      }
      if (!Array.isArray(parsed.results)) {
        throw new Error('返回缺少 results，按可能计费预留费用，不能记作零命中');
      }
      if (parsed.results.some(result => !result || typeof result !== 'object' || typeof (result as { url?: unknown }).url !== 'string')) throw new Error('搜索结果条目缺少有效 URL，保留原始返回，不计作零命中');
      const results = parsed.results as { url: string; title?: string }[];
      if (!results.length) { context.chargeTask(taskId, -QUERY_COST); cost = roundCost(cost - QUERY_COST); }
      const target = originalTask.workflow?.questions.find(item => item.id === question.id);
      const firstHit = results.findIndex(result => originalTask.workflow ? matchesQuestionTarget(result.url, target, seed) : isCurrentProjectURL(result.url));
      const topSources = results.slice(0, 3).map((result, index) => {
        const url = String(result.url || '');
        let domain = ''; try { domain = new URL(url).hostname; } catch { /* Retain malformed links only as raw evidence. */ }
        return { position: index + 1, title: String(result.title || domain || '未提供标题'), url, domain, isHomonym: /2609\.38260/i.test(`${url} ${result.title || ''}`) };
      });
      observation = { ...question, measurementAt: at, provider: 'DeepSeek Search API', resultCount: results.length, projectHit: firstHit >= 0, rank: firstHit >= 0 ? firstHit + 1 : null, aiCited: null, topSources, evidencePath: `data/geo-evidence/${runId}/${safeId}.json` };
      completed.push(observation);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : '请求失败'}${httpStatus === 0 ? '；请求结果未知，费用按上限保留，不自动重试' : ''}`;
      if (httpStatus === 0) stop = true;
      errors.push(`${question.id}: ${message}`);
      fs.writeFileSync(path.join(evidenceDir, `${safeId}.failure.json`), JSON.stringify({ queryId: question.id, query: question.query, at, httpStatus, error: message }, null, 2), { flag: 'wx' });
    }
    // Persistence failures must propagate rather than be treated as provider failures.
    if (observation) await context.onObservation?.(observation);
    if (stop) break;
    await sleep(250);
  }
  const hitCount = completed.length ? completed.filter(q => q.projectHit).length : null;
  const status = completed.length === questions.length ? 'completed' : completed.length ? 'partial' : 'failed';
  const summary = status === 'completed'
    ? originalTask.workflow
      ? `本次 DeepSeek ${phase === 'baseline' ? '实施前基线' : '实施后复测'} ${hitCount}/${questions.length} 题命中各自目标。返回的摘要/正文已原样保存，保存不代表全文已阅读；是否可比由题单、参数和实施版本校验，AI 引用仍未测。`
      : `本次 DeepSeek 真实观察 ${hitCount}/${questions.length} 题命中。与 2026-10-18 的同题同参数基线比较；单次变化不能证明改进的因果效果，AI 引用仍未测。`
    : `本次仅 ${completed.length}/${questions.length} 题取得有效结果${hitCount === null ? '' : `，这些题中 ${hitCount} 题命中`}；其余问题未测得，不计作零。数据不足，暂不判断整体效果。`;
  const run: GeoRun = { id: runId, at: startedAt, completedAt: nowISO(), measurementAt: startedAt, mode: 'live', status, queryCount: questions.length, completedCount: completed.length, hitCount, resultCount: completed.reduce((sum, q) => sum + q.resultCount, 0), cost, summary, questions: completed, ...stamp, ...(errors.length ? { error: errors.join('；') } : {}) };
  fs.writeFileSync(path.join(evidenceDir, 'run.json'), JSON.stringify(run, null, 2), { flag: 'wx' });
  return run;
}

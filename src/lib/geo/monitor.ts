import { importTaskResearchRuns } from './research-task-import';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GeoQuestion, GeoRun, GeoTask } from './types';
import { getSeed } from './seed';
import { claimTask, dataDirectory, GeoError, getTask, newEvent, nextDailyRun, nowISO, refreshTaskOutcome, releaseTask, updateTask } from './store';
import { evidenceLocation } from './projects';
import { buildSearchProtocolKey, matchHistoricalQuestions, matchesProjectURL, matchesQuestionTarget } from './search-protocol';
import { defaultCollectionRuntime, type CollectionRuntime } from './collection-runtime';

const roundCost = (n: number) => Math.round(n * 1000) / 1000;

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
    return questions.map(question => ({
      id: question.id,
      query: question.query,
      language: question.language,
      tier: question.category,
      matchingAssetIds: [...question.assetIds],
      measurementAt: '',
      provider: task.workflow?.collection?.label || 'ChatGPT',
      resultCount: 0,
      projectHit: false,
      rank: null,
      aiCited: null,
      topSources: [],
      evidencePath: '',
    }));
  }
  const frozen = getSeed().questions;
  const selected = frozen.filter(q => task.monitor.queryIds.includes(q.id));
  if (!selected.length || selected.length !== task.monitor.queryIds.length) throw new GeoError('固定题单不完整，请检查已有测量数据。');
  return selected;
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
  const seed = getSeed();
  const matched = matchHistoricalQuestions(questions, seed.questions);
  // An article target needs the original full search list; top-three snippets alone cannot establish a miss.
  const completed = matched.flatMap(question => {
    const target = task.workflow?.questions.find(item => item.id === question.id);
    if (!target || target.target === 'project') return [question];
    try {
      const { root: rawRoot, target: rawTarget } = evidenceLocation(question.evidencePath);
      const root = fs.realpathSync(rawRoot);
      const file = fs.realpathSync(rawTarget);
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
  if (mode === 'live') {
    throw new GeoError('旧版 API 实时搜索已下线，请使用 ChatGPT / Google 浏览器采集获取最新回答。');
  }
  const runId = randomUUID();
  const startedAt = nowISO();
  let questions: GeoQuestion[] = [];
  let run: GeoRun;
  try {
    questions = questionSet(task);
    run = replayRun(task, runId, questions, startedAt, 'baseline');
    saveRunEvidence(run);
  } catch (error) {
    run = { id: runId, at: startedAt, completedAt: nowISO(), measurementAt: '', mode, status: 'failed',
      queryCount: questions.length || task.workflow.questions.length, completedCount: 0, hitCount: null, resultCount: 0,
      cost: roundCost(getTask(taskId).monitor.spent - task.monitor.spent), questions: [], ...runStamp(task, 'baseline'),
      summary: '基线未取得完整可用结果，不能把失败当成零命中，也不能据此声称措施有效。',
      error: error instanceof Error ? error.message : '基线采集失败。' };
    const file = path.join(dataDirectory(), 'geo-evidence', run.id, 'run.json');
    if (!fs.existsSync(file)) saveRunEvidence(run);
  }
  updateTask(taskId, current => { if (current.workflow) current.workflow.baseline = run; });
  importTaskResearchRuns(getTask(taskId));
  return run;
}

function assertRunnable(task: GeoTask, mode: 'live' | 'replay') {
  if (!task.implementation || !['monitoring', 'paused', 'failed', 'completed'].includes(task.status)) throw new GeoError('请先确认方案与实施，再进行观察。');
  questionSet(task);
  if (mode === 'live') {
    throw new GeoError('旧版 API 实时搜索已下线，请使用 ChatGPT / Google 浏览器采集获取最新回答。');
  }
}

export function startMonitor(taskId: string, mode: 'live' | 'replay', scheduled = false): void {
  const task = getTask(taskId);
  assertRunnable(task, mode);
  const runId = randomUUID();
  claimTask(taskId, 'monitor', runId, mode);
  updateTask(taskId, t => {
    delete t.error;
    t.events.push(newEvent('开始历史回放', '只读取 ID 与问法完全一致的已有实测；没有对应历史的题保持未测，本轮不是新的测量。'));
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
    if (mode === 'live') {
      throw new GeoError('旧版 API 实时搜索已下线，请使用 ChatGPT / Google 浏览器采集获取最新回答。');
    }
    run = replayRun(task, runId, questions, startedAt, 'followup');
    if (task.workflow) saveRunEvidence(run);
    updateTask(taskId, t => {
      t.runs.push(run); t.monitor.lastRunAt = run.at;
      if (scheduled) t.monitor.remaining = Math.max(0, t.monitor.remaining - 1);
      if (run.error) t.error = run.error; else delete t.error;
      if (run.status === 'completed' && t.status === 'failed') t.status = t.monitor.enabled ? 'monitoring' : 'paused';
      if (t.monitor.enabled && t.monitor.remaining <= 0) {
        t.monitor.enabled = false; t.monitor.nextRunAt = null; t.status = 'completed';
        t.events.push(newEvent('演练观察计划结束', '所有记录都只是同一次历史观测的回放，尚无实施后的效果证据。', 'attention'));
      } else if (t.monitor.enabled) { t.monitor.nextRunAt = nextDailyRun(t.monitor.timeOfDay); }
      if (run.status === 'failed' && t.status !== 'paused') {
        t.status = 'failed'; t.monitor.enabled = false; t.monitor.nextRunAt = null;
      }
      t.events.push(newEvent(run.status !== 'completed' ? '观察数据不完整' : '历史回放已完成', run.summary, run.status === 'completed' ? 'success' : 'attention'));
    });
    importTaskResearchRuns(getTask(taskId));
    if (task.workflow) refreshTaskOutcome(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : '观察发生未知错误。';
    updateTask(taskId, t => {
      if (!t.runs.some(r => r.id === runId)) t.runs.push({ id: runId, at: startedAt, completedAt: nowISO(), measurementAt: questions[0]?.measurementAt || '', mode, status: 'failed', queryCount: questions.length, completedCount: 0, hitCount: null, resultCount: 0, cost: roundCost(t.monitor.spent - task.monitor.spent), questions: [], ...runStamp(task, 'followup'), summary: '本次未获得完整可用结果，不能判断效果。失败不计为零命中。', error: message });
      t.error = message; if (t.status !== 'paused') t.status = 'failed'; t.monitor.enabled = false; t.monitor.nextRunAt = null;
      t.events.push(newEvent('观察未完成', message, 'error'));
    });
    importTaskResearchRuns(getTask(taskId));
    if (task.workflow) refreshTaskOutcome(taskId);
  } finally { releaseTask(taskId); }
}

export async function collectLive(_taskId: string, _runId: string, _questions: GeoQuestion[], _startedAt: string,
  _phase: 'baseline' | 'followup', _context: CollectionRuntime = defaultCollectionRuntime): Promise<GeoRun> {
  throw new GeoError('旧版 API 实时搜索已下线，请使用 ChatGPT / Google 浏览器采集获取最新回答。');
}

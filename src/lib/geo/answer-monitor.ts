import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GeoQuestion, GeoRun } from './types';
import { getSeed } from './seed';
import { dataDirectory, nowISO } from './store';
import { matchesQuestionTarget } from './search-protocol';
import { collectionReservation, requireCollectionKey } from './providers/config';
import { buildDoubaoRequest, parseDoubaoAnswer } from './providers/doubao';
import { buildQwenRequest, parseQwenAnswer } from './providers/qwen';
import { defaultCollectionRuntime, type CollectionRuntime, type CollectionTask } from './collection-runtime';

/** Answer observations use native target citations, never a search-list position. */
export async function collectAnswerRun(task: CollectionTask, id: string, questions: GeoQuestion[], at: string,
  phase: 'baseline' | 'followup', context: CollectionRuntime = defaultCollectionRuntime): Promise<GeoRun> {
  const collection = task.workflow!.collection!;
  const reserve = collectionReservation(collection.provider);
  const directory = path.join(dataDirectory(), 'geo-evidence', id);
  fs.mkdirSync(directory, { recursive: true });
  const completed: GeoQuestion[] = [];
  const errors: string[] = [];
  const seed = getSeed();
  let cost = 0;
  const stamp = { phase, protocolKey: task.workflow!.protocolKey,
    implementationRevision: phase === 'baseline' ? 0 : task.implementation?.proposalRevision };
  for (const question of questions) {
    const current = context.getTask(task.id);
    if (current.status === 'paused' || current.workflow?.protocolKey !== stamp.protocolKey ||
      (phase === 'baseline' ? current.implementation !== null : current.implementation?.proposalRevision !== stamp.implementationRevision)) {
      errors.push('任务状态、入口或实施版本发生变化，剩余问题未发送。'); break;
    }
    if (current.monitor.budgetLimit !== null && current.monitor.budgetLimit - current.monitor.spent + 1e-9 < reserve) {
      errors.push('剩余预算不足以预留下一题费用，已停止。'); break;
    }
    context.onQuestionStart?.(question);
    const measuredAt = nowISO();
    const safeId = /^[a-zA-Z0-9_-]{1,100}$/.test(question.id) ? question.id : createHash('sha256').update(question.id).digest('hex');
    const evidencePath = `data/geo-evidence/${id}/${safeId}.json`;
    const key = requireCollectionKey(collection.provider);
    const request = collection.provider === 'doubao' ? buildDoubaoRequest(question.query, collection, key)
      : buildQwenRequest(question.query, collection, key);
    fs.writeFileSync(path.join(directory, `${safeId}.request.json`), JSON.stringify({
      at: measuredAt, endpoint: request.url, payload: request.body, collection, ...stamp,
      target: task.workflow!.questions.find(item => item.id === question.id),
    }, null, 2), { flag: 'wx' });
    context.chargeTask(task.id, reserve);
    cost = Math.round((cost + reserve) * 1000) / 1000;
    let httpStatus = 0;
    let observation: GeoQuestion | undefined;
    try {
      const response = await fetch(request.url, { method: 'POST', headers: request.headers,
        body: JSON.stringify(request.body), signal: AbortSignal.timeout(90000) });
      httpStatus = response.status;
      const raw = await response.text();
      fs.writeFileSync(path.join(directory, `${safeId}.json`), raw, { flag: 'wx' });
      if (!response.ok) throw new Error(`HTTP ${httpStatus}；请核对该服务的密钥、模型权限及余额，原始错误已留存。`);
      const answer = collection.provider === 'doubao' ? parseDoubaoAnswer(JSON.parse(raw)) : parseQwenAnswer(JSON.parse(raw));
      if (!answer.searchPerformed) throw new Error('没有取得有效联网搜索证据；回答已原样保存，不能计作联网回答或零引用。');
      const target = task.workflow!.questions.find(item => item.id === question.id);
      const cited = answer.citations.some(source => matchesQuestionTarget(source.url, target, seed));
      observation = { ...question, providerId: collection.provider, provider: collection.label,
        measurementAt: measuredAt, answer, resultCount: answer.sources.length, projectHit: cited,
        rank: null, aiCited: cited, evidencePath,
        topSources: answer.sources.slice(0, 3).map((source, index) => ({ position: index + 1, title: source.title,
          url: source.url, domain: new URL(source.url).hostname, isHomonym: /2609\.38260/i.test(`${source.url} ${source.title}`) })),
      };
      completed.push(observation);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : '联网回答失败'} 费用仅按预留记录，未核对实际账单；不自动重试。`;
      errors.push(`${question.id}: ${message}`);
      fs.writeFileSync(path.join(directory, `${safeId}.failure.json`), JSON.stringify({ at: measuredAt, httpStatus, error: message }, null, 2), { flag: 'wx' });
      // Stop on an unknown result or account-level problem; never retry a billed call implicitly.
      if (httpStatus === 0 || [401, 402, 403, 429].includes(httpStatus)) break;
    }
    // Persistence failures must propagate rather than be treated as provider failures.
    if (observation) await context.onObservation?.(observation);
  }
  const hitCount = completed.length ? completed.filter(question => question.projectHit).length : null;
  const status = completed.length === questions.length ? 'completed' : completed.length ? 'partial' : 'failed';
  const run: GeoRun = { id, at, completedAt: nowISO(), measurementAt: at, mode: 'live', status,
    queryCount: questions.length, completedCount: completed.length, hitCount, cost, costEstimated: true,
    resultCount: completed.reduce((sum, question) => sum + question.resultCount, 0), questions: completed, ...stamp,
    summary: `${collection.label}取得 ${completed.length}/${questions.length} 道完整联网回答${hitCount === null ? '' : `，其中 ${hitCount} 道通过原生引用指向目标`}。搜索来源与引用分开保存；仅代表此 API 与本次问题，不代表消费者 App。¥${cost.toFixed(2)} 为费用预留，实际以供应商账单为准。`,
    ...(errors.length ? { error: errors.join('；') } : {}),
  };
  fs.writeFileSync(path.join(directory, 'run.json'), JSON.stringify(run, null, 2), { flag: 'wx' });
  return run;
}

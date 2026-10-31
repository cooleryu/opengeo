import { randomUUID } from 'node:crypto';
import type { AssetGovernanceInput, AssetGovernanceRecord, GeoTask } from './types';
import type { ResearchBatch } from './research-types';

export function resolveAssetGap(input: Pick<AssetGovernanceInput, 'batchId' | 'questionId' | 'gapId'>, batch: ResearchBatch | null, projectId: string) {
  if (!batch || batch.projectId !== projectId || batch.id !== input.batchId) throw new Error('材料缺口的研究批次已变化，请刷新后重选。');
  const question = [...batch.questions, ...batch.deferredQuestions].find(q => q.id === input.questionId);
  const index = question?.gaps.findIndex((_, i) => `${projectId}:${batch.id}:${question.id}:gap:${i}` === input.gapId) ?? -1;
  if (!question || index < 0) throw new Error('没有找到当前项目中的这条原始缺口。');
  return { question, gap: question.gaps[index] };
}

export function updateAssetGovernance(input: AssetGovernanceInput, batch: ResearchBatch | null, projectId: string, tasks: GeoTask[], previous?: AssetGovernanceRecord, at = new Date().toISOString()): AssetGovernanceRecord {
  const { gap } = resolveAssetGap(input, batch, projectId);
  if (previous && (previous.projectId !== projectId || previous.gapId !== input.gapId)) throw new Error('材料处理记录不属于当前缺口。');
  if (input.status !== undefined && !['open', 'investigating', 'resolved'].includes(input.status)) throw new Error('无效的核查状态。');
  if (input.taskIds !== undefined && (!Array.isArray(input.taskIds) || input.taskIds.length > 20 || input.taskIds.some(id => typeof id !== 'string' || !tasks.some(t => t.id === id && t.projectId === projectId && (!t.researchContext || (t.researchContext.batchId === input.batchId && t.researchContext.questionId === input.questionId)))))) throw new Error('只能关联当前项目、对应问题的已有任务。');
  const evidence = [...(previous?.evidence || [])];
  if (input.evidence) {
    const { note, url } = input.evidence;
    if (typeof note !== 'string' || !note.trim() || note.length > 5000) throw new Error('请填写补充依据，不超过5000字。');
    if (url) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('依据链接须为有效网页地址。'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('依据链接须为不含登录信息的网页地址。');
    }
    evidence.push({ id: randomUUID(), note: note.trim(), ...(url?.trim() ? { url: url.trim() } : {}), at });
  }
  if (input.resolution !== undefined && (typeof input.resolution !== 'string' || input.resolution.length > 5000)) throw new Error('核查结论不能超过5000字。');
  const status = input.status || previous?.status || 'open';
  const resolution = input.resolution?.trim() ?? previous?.resolution;
  if (status === 'resolved' && (!evidence.length || !resolution)) throw new Error('登记已补齐前，请保存补充依据和具体核查结论。');
  return {
    id: previous?.id || input.gapId,
    projectId, batchId: input.batchId, questionId: input.questionId, gapId: input.gapId, gap,
    status, taskIds: [...new Set([...(previous?.taskIds || []), ...(input.taskIds || [])])],
    evidence, resolution, updatedAt: at,
    history: [...(previous?.history || []), { at, status, ...(resolution ? { resolution } : {}) }],
  };
}

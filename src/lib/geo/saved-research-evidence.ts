import { extractAnswerContent } from './answer-content';
import type { ResearchObservation } from './research-types';

export interface SavedResearchEvidence {
  available: boolean;
  evidencePath: string;
  evidencePaths: string[];
  answerText: string | null;
  results: Record<string, unknown>[];
  captureNotes: string;
  boundary: string;
  error?: string;
}

/** Read saved primary material only. A report/summary or a list of URLs is not answer content. */
export function readSavedResearchEvidence(
  observation: ResearchObservation,
  read: (file: string) => string | null,
): SavedResearchEvidence {
  const evidencePath = observation.evidencePath;
  const base = { available: false, evidencePath, evidencePaths: [] as string[], answerText: null,
    results: [] as Record<string, unknown>[], captureNotes: '', boundary: '' };
  if (!observation.query.trim() || !observation.recordedAt.trim() || !observation.conditions.trim())
    return { ...base, error: '已保存观测缺少原问题、时间或采集条件。' };
  const raw = read(evidencePath);
  if (!raw?.trim()) return { ...base, error: '已保存观测的原始证据不存在或不可读取。' };

  if (observation.engine === 'chatgpt' && (!observation.entryType || observation.entryType === 'web_answer')) {
    const answerPath = observation.answerPath || evidencePath;
    const answerRaw = answerPath === evidencePath ? raw : read(answerPath);
    const answerText = answerRaw ? extractAnswerContent(answerRaw) : null;
    // Existing manual captures label their original question explicitly. Never infer it from a summary.
    const capturedQuery = /^-\s*(?:Question|原问题)\s*:\s*(.+)$/imu.exec(raw)?.[1]?.trim();
    if (!answerText || capturedQuery !== observation.query)
      return { ...base, error: !answerText ? '保存记录没有可识别的回答正文；观测摘要不能代替原文。' : '回答记录中的原问题与任务不一致，不能用于本题方案。' };
    const heading = /^#{1,6}\s+(?:Answer text|Rendered answer|平台回答转录)\s*$/imu.exec(answerRaw!);
    const captureNotes = [heading ? answerRaw!.slice(0, heading.index) : '',
      ...answerRaw!.split('\n').filter(line => /^Capture(?: note)?:/iu.test(line))].filter(Boolean).join('\n').slice(0, 6000);
    return { ...base, available: true, evidencePath: answerPath,
      evidencePaths: [...new Set([evidencePath, answerPath])], answerText, captureNotes,
      boundary: '历史 ChatGPT 网页人工保存的可见回答正文；完整性、临时聊天可复现性与隐藏引用按原采集说明保留未知。不是新 API 回答或新搜索基线；所列来源未重新读取正文。' };
  }

  if (observation.engine === 'deepseek' && (!observation.entryType || observation.entryType === 'api_search')) {
    let parsed: { results?: unknown };
    try { parsed = JSON.parse(raw); } catch { return { ...base, error: '保存的搜索原始 JSON 无法解析。' }; }
    if (!parsed || !Array.isArray(parsed.results)) return { ...base, error: '搜索原始记录缺少结果列表。' };
    const requestPath = evidencePath.replace(/\.json$/u, '.request.json');
    const requestRaw = requestPath !== evidencePath ? read(requestPath) : null;
    let requestQuery: unknown;
    try { requestQuery = requestRaw ? JSON.parse(requestRaw)?.payload?.query : undefined; } catch { /* Reject below. */ }
    if (requestQuery !== observation.query)
      return { ...base, error: '搜索原始请求缺失或问法不一致，无法把保存结果绑定到本题。' };
    const results = parsed.results.filter((value): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value)));
    if (results.length !== parsed.results.length || !results.some(row =>
      ['content', 'snippet', 'summary'].some(field => typeof row[field] === 'string' && row[field].trim())))
      return { ...base, error: '搜索记录没有可供内容比较的正文或片段；不能仅凭来源链接生成改稿。' };
    return { ...base, available: true, evidencePaths: [evidencePath, requestPath], results,
      boundary: '历史 DeepSeek Search API 原始结果；仅比较返回的正文、摘要或片段，未独立读取来源全文，不是 AI 回答引用或新搜索。' };
  }
  return { ...base, error: '本入口的保存记录尚未支持原文核验；本轮仅支持 ChatGPT 网页回答和 DeepSeek Search API 原始记录。' };
}

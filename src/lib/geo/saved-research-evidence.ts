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

  // Browser ingestion now saves JSON, while early manual captures used Markdown.
  // Bind to the original request before exposing the answer; never use summary text.
  if ((observation.engine === 'chatgpt' || observation.engine === 'google') && /^\s*\{/.test(raw)) {
    let record: Record<string, unknown>;
    try { record = JSON.parse(raw); } catch { return { ...base, error: '浏览器原始记录无法解析。' }; }
    const input = record.version === 1 && record.input && typeof record.input === 'object' && !Array.isArray(record.input)
      ? record.input as Record<string, unknown> : null;
    const captured = input || (record.schemaVersion === 1 ? record : null);
    const inputConditions = input && input.conditions && typeof input.conditions === 'object'
      ? JSON.stringify({ ...input.conditions, originalURL: input.pageUrl, answerComplete: input.answerComplete,
        citationsComplete: input.citationsComplete, citationSource: input.citationSource }) : null;
    if (!captured || captured.engine !== observation.engine || captured.query !== observation.query
      || (input ? captured.recordedAt : captured.capturedAt) !== observation.recordedAt
      || (input && (captured.language !== observation.language || captured.entryType !== 'web_answer'
        || observation.id !== `browser:${captured.captureId}` || inputConditions !== observation.conditions))
      || (observation.entryType && observation.entryType !== 'web_answer')
      || (!input && (captured.conditions !== observation.conditions
        || (observation.engine === 'google' && captured.overviewStatus !== 'generated'))))
      return { ...base, error: '浏览器记录的原问题、平台或采集条件与任务不一致。' };
    const answerText = input && typeof captured.answerText === 'string'
      ? captured.answerText.trim() : extractAnswerContent(raw);
    if (!answerText) return { ...base, error: '浏览器记录没有回答正文，摘要或搜索链接不能代替回答。' };
    const answerPath = observation.answerPath || evidencePath;
    if (answerPath !== evidencePath && read(answerPath)?.trim() !== answerText)
      return { ...base, error: '回答文件与原始采集正文不一致。' };
    const platform = observation.engine === 'google' ? 'Google AI Overview' : 'ChatGPT 网页';
    return { ...base, available: true, answerText,
      evidencePaths: [...new Set([evidencePath, answerPath])],
      captureNotes: JSON.stringify({ conditions: captured.conditions,
        answerComplete: captured.answerComplete ?? 'unknown',
        citationsComplete: captured.citationsComplete ?? 'unknown', citationCoverage: captured.citationCoverage ?? 'unknown' }),
      boundary: `已保存的 ${platform} 原始回答，按原问题、平台和采集时间核对。${captured.answerComplete === true ? '采集时标记正文完整。' : '正文完整性未确认，不能据未读部分断言缺失。'}引用完整性沿用原采集记录；来源全文未重新读取，不是新搜索或新基线。` };
  }

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

  return { ...base, error: '本入口的保存记录尚未支持原文核验；仅支持 ChatGPT 网页回答与 Google AI Overview 原始记录。' };
}

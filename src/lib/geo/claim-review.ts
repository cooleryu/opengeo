import { randomUUID } from 'node:crypto';
import { readRegisteredEvidence } from './diagnosis';
import type { ResearchBatch } from './research-types';
import type { ClaimReviewRecord } from './types';

const whitespace = (value: string) => value.replace(/\s+/gu, ' ').trim();

function requiredText(value: unknown, label: string, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${label}须为非空文字，且不超过 ${max} 字。`);
  }
  return value.trim();
}

/** Extract answer content, never the observation summary, query, or citation titles. */
function answerText(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const content = (value: unknown, depth = 0): string[] => {
      if (depth > 12) return [];
      if (typeof value === 'string') return [value];
      if (Array.isArray(value))
        return value.flatMap((item) => content(item, depth + 1));
      if (!value || typeof value !== 'object') return [];
      const object = value as Record<string, unknown>;
      if ('role' in object && object.role !== 'assistant') return [];
      const keys = [
        'answer_text',
        'answerText',
        'rendered_answer',
        'renderedAnswer',
        'answer',
        'text',
        'content',
        'parts',
        'message',
        'choices',
        'output',
      ];
      return keys.flatMap((key) =>
        key in object ? content(object[key], depth + 1) : [],
      );
    };
    return content(parsed);
  } catch {
    if (/^\s*[\[{]/.test(raw)) return [];
    const section =
      /^##\s+(?:Answer text|Rendered answer|平台回答转录)\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/im.exec(
        raw,
      );
    if (section) return [section[1]];
    // A standalone text answer may have no wrapper; an unrecognized report is not an answer.
    return /^#{1,6}\s/m.test(raw) ? [] : [raw];
  }
}

export function buildClaimReview(
  input: unknown,
  batch: ResearchBatch | null,
  projectId: string,
): ClaimReviewRecord {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('人工核查记录格式无效。');
  const value = input as Record<string, unknown>;
  const suppliedProject = requiredText(value.projectId, '项目', 128);
  const batchId = requiredText(value.batchId, '批次', 200);
  const questionId = requiredText(value.questionId, '问题', 200);
  if (
    !batch ||
    batch.projectId !== projectId ||
    suppliedProject !== projectId ||
    batch.id !== batchId
  ) {
    throw new Error('项目或调查批次不匹配，请刷新后从原观测记录核查。');
  }
  const question = [...batch.questions, ...batch.deferredQuestions].find(
    (item) => item.id === questionId,
  );
  if (
    !question ||
    !Number.isInteger(value.observationIndex) ||
    Number(value.observationIndex) < 0
  ) {
    throw new Error('没有找到对应的问题或观测记录。');
  }
  const observationIndex = value.observationIndex as number;
  const observation = question.observations[observationIndex];
  if (
    !observation ||
    value.engine !== observation.engine ||
    value.language !== observation.language
  ) {
    throw new Error('观测序号、平台或语言不匹配，请从原观测记录核查。');
  }
  if (observation.engine !== 'chatgpt' || !observation.answerPath) {
    throw new Error('仅可核查已有完整回答原文的 ChatGPT 观测。');
  }
  const quote = requiredText(value.quote, '回答原话', 8000);
  const raw = readRegisteredEvidence(observation.answerPath);
  if (
    raw === null ||
    !answerText(raw).some((text) =>
      whitespace(text).includes(whitespace(quote)),
    )
  ) {
    throw new Error(
      '回答原话未在已保存的回答正文中找到。请直接摘录原文，不能用摘要或改写替代。',
    );
  }
  const fact = requiredText(value.fact, '项目事实', 6000);
  const scope = requiredText(value.scope, '适用边界', 4000);
  const evidenceUrl = requiredText(value.evidenceUrl, '核查依据链接', 2048);
  try {
    const url = new URL(evidenceUrl);
    if (
      /\s/u.test(evidenceUrl) ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    throw new Error('核查依据须为不含账号密码的 http 或 https 链接。');
  }
  if (typeof value.conclusion !== 'string' ||
    !['supported', 'contradicted', 'uncertain'].includes(value.conclusion))
    throw new Error('请选择有效的人工核查结论。');
  return {
    id: randomUUID(),
    projectId,
    batchId,
    questionId,
    observationIndex,
    engine: observation.engine,
    language: observation.language,
    quote,
    fact,
    evidenceUrl,
    conclusion: value.conclusion as ClaimReviewRecord['conclusion'],
    scope,
    reviewedAt: new Date().toISOString(),
    reviewer: 'user',
  };
}

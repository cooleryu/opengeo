import { z } from 'zod';
import type { GenerateObjectInput } from '@/lib/models/types';

type StructuredModel = { generateObject<T>(input: GenerateObjectInput): Promise<unknown> };

function isStructureError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof z.ZodError
    // These wrappers are thrown only by the existing providers' JSON/schema parse blocks.
    || (error instanceof Error && /^Error parsing response from (?:DeepSeek|OpenAI):/u.test(error.message));
}

/** One additional request for the entire planning/review operation, only for invalid JSON/schema. */
export function withOneImprovementStructureRetry(model: StructuredModel): StructuredModel {
  let retryAvailable = true;
  return {
    async generateObject<T>(input: GenerateObjectInput): Promise<T> {
      try {
        return input.schema.parse(await model.generateObject(input)) as T;
      } catch (error) {
        if (!retryAvailable || !isStructureError(error)) throw error;
        retryAvailable = false;
        // The provider does not expose rejected raw output. Regenerate from the original evidence;
        // do not guess missing content or inject the failed writer's output into an independent review.
        const retry: GenerateObjectInput = {
          ...input,
          messages: [...input.messages, { role: 'system', content:
            '上一次返回未通过 JSON 语法或字段校验。这是本次操作唯一一次格式重试。请依据原输入重新生成完整 JSON 对象，严格满足本阶段 schema；不要 Markdown、解释文字或额外字段。字符串内的英文双引号、反斜线和换行必须按 JSON 规则转义，不要把正文直接拼接为 JSON。所有必填字段、数组和数值类型保持正确。仅修复输出格式，不省略原始证据、不改变目标、不降低审核和证据门槛。' }],
          options: { ...input.options, temperature: 0 },
        };
        // No recursive call: a second invalid result is rejected and consumes no third request.
        return input.schema.parse(await model.generateObject(retry)) as T;
      }
    },
  };
}

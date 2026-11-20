import type { GeoState } from '@/lib/geo/types';
import type { QuestionGenerationProgress } from '@/lib/geo/question-types';

export async function readQuestionGenerationStream(
  response: Response,
  onProgress: (progress: QuestionGenerationProgress) => void,
  lang: 'en' | 'zh' = 'zh',
): Promise<GeoState> {
  const isEn = lang === 'en';
  if (!response.ok || !response.body) {
    const failure = await response.json().catch(() => ({}));
    const err = new Error(
      failure.error ||
        (isEn
          ? 'Question generation did not start. Please try again.'
          : '生成未开始，请重试。'),
    ) as Error & { code?: string };
    if (typeof failure.code === 'string') err.code = failure.code;
    throw err;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let result: GeoState | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') {
      const err = new Error(
        event.error ||
          (isEn
            ? 'Question generation did not finish. Please try again.'
            : '生成未完成，请重试。'),
      ) as Error & { code?: string };
      if (typeof event.code === 'string') err.code = event.code;
      throw err;
    }
    if (event.type === 'progress') onProgress(event.progress);
    if (event.type === 'result') result = event.state;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) break;
    }
    consume(pending);
    if (!result) {
      throw new Error(
        isEn
          ? 'Connection interrupted before the saved result arrived. Reload the page and retry.'
          : '连接已中断，尚未收到保存结果。请重新打开页面查看后再重试。',
      );
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

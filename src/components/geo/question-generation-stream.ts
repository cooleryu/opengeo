import type { GeoState } from '@/lib/geo/types';
import type { QuestionGenerationProgress } from '@/lib/geo/question-types';

export async function readQuestionGenerationStream(
  response: Response,
  onProgress: (progress: QuestionGenerationProgress) => void,
): Promise<GeoState> {
  if (!response.ok || !response.body) {
    const failure = await response.json().catch(() => ({}));
    throw new Error(failure.error || '生成未开始，请重试。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let result: GeoState | undefined;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') throw new Error(event.error || '生成未完成，请重试。');
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
    if (!result) throw new Error('连接已中断，尚未收到保存结果。请重新打开页面查看后再重试。');
    return result;
  } finally {
    reader.releaseLock();
  }
}

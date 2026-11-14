import test from 'node:test';
import assert from 'node:assert/strict';
import { readQuestionGenerationStream } from './question-generation-stream';

function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(controller) {
        // Chunk across both event and Chinese UTF-8 boundaries.
        for (let i = 0; i < bytes.length; i += 7)
          controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    }),
  );
}

test('progress is delivered before the saved result across split chunks', async () => {
  const progress: string[] = [];
  const result = await readQuestionGenerationStream(
    response(
      [
        JSON.stringify({
          type: 'progress',
          progress: { stage: 'generating', message: '生成中' },
        }),
        JSON.stringify({
          type: 'progress',
          progress: { stage: 'reviewing', message: '审核中' },
        }),
        JSON.stringify({
          type: 'result',
          state: { questionPlan: { id: 'saved-plan' } },
        }),
      ].join('\n'),
    ),
    (event) => progress.push(event.message),
  );
  assert.deepEqual(progress, ['生成中', '审核中']);
  assert.equal(result.questionPlan.id, 'saved-plan');
});

test('failed or incomplete streams never imply saved questions', async () => {
  await assert.rejects(
    readQuestionGenerationStream(
      response(JSON.stringify({ type: 'error', error: '依据未通过' })),
      () => {},
    ),
    /依据未通过/,
  );
  await assert.rejects(
    readQuestionGenerationStream(
      response(
        JSON.stringify({
          type: 'progress',
          progress: { stage: 'saving', message: '保存中' },
        }),
      ),
      () => {},
    ),
    /尚未收到保存结果/,
  );
});

test('request activity and completed checkpoints reach the UI before a later failure', async () => {
  const observed: unknown[] = [];
  const checkpoints = {
    stage: 'planning',
    message: '已保存选题方向',
    checkpoint: {
      key: 'directions',
      title: '两个选题方向',
      items: ['用户如何找到相关产品', '已有文章能回答哪些问题'],
      completedAt: '2026-11-03T10:00:00.000Z',
    },
  };
  const activity = {
    stage: 'generating',
    message: '正在生成第一批问题',
    request: {
      phase: 'receiving',
      elapsedMs: 2500,
      eventCount: 3,
      outputCharacters: 42,
      lastEventAt: '2026-11-03T10:00:02.500Z',
      requestId: 'request-1',
    },
  };
  await assert.rejects(
    readQuestionGenerationStream(
      response(
        [
          JSON.stringify({ type: 'progress', progress: checkpoints }),
          JSON.stringify({ type: 'progress', progress: activity }),
          JSON.stringify({ type: 'error', error: '后续步骤未完成' }),
        ].join('\n'),
      ),
      (event) => observed.push(event),
    ),
    /后续步骤未完成/,
  );
  assert.deepEqual(observed, [checkpoints, activity]);
});

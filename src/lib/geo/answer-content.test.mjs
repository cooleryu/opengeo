import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractAnswerContent } from './answer-content.ts';

test('keeps answer tables, nested headings and citations but excludes collection metadata', () => {
  const answer = '正文 [1](https://example.com)\n\n### 引用来源\n| 来源 |\n| --- |\n| Example |\n\n#### 细节\n完整结尾。';
  assert.equal(extractAnswerContent(`# Report\n## Question\nquestion\n## Answer text\n\n${answer}\n\nCapture note: collected\n\n## Inline sources\nmetadata`), answer);
  assert.equal(extractAnswerContent('## 平台回答转录\n回答\n# Next report\nmetadata'), '回答');
});

test('headings and capture labels inside fenced code do not truncate the answer', () => {
  const answer = '~~~md\n## More\nCapture note: code example\n~~~\n\n### Conclusion\nEnd.';
  assert.equal(extractAnswerContent(`## Rendered answer\n${answer}\n\nCapture: metadata`), answer);
});

test('only explicit JSON answer fields are supported', () => {
  for (const key of ['answer_text', 'answerText', 'rendered_answer', 'renderedAnswer']) {
    assert.equal(extractAnswerContent(JSON.stringify({ [key]: 'Full answer\n\n### Sources\n[source](https://example.com)' })), 'Full answer\n\n### Sources\n[source](https://example.com)');
  }
  for (const raw of ['{"query":"question","summary":"summary"}', '{"results":[{"content":"web result"}]}', '# Report\ncollection notes', 'unmarked text', '{invalid']) {
    assert.equal(extractAnswerContent(raw), null);
  }
});

test('standalone provider answers require trusted caller opt-in and keep full headings', () => {
  const answer = '# Answer\n\n## Sources\n[source](https://example.com)';
  assert.equal(extractAnswerContent(answer), null);
  assert.equal(extractAnswerContent(answer, { standalone: true }), answer);
  assert.equal(extractAnswerContent('## Answer text\n\nCapture note: empty'), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { foldUnchanged, readableDiff, readableText, tokenize, wordDiff, type DisplaySegment } from './word-diff';

const join = (segments: DisplaySegment[], op: 'equal' | 'add' | 'del') =>
  segments
    .filter((s) => s.op === op)
    .map((s) => ('text' in s ? s.text : ''))
    .join('|');

test('word diff marks only the words that changed', () => {
  const segments = wordDiff('The quick brown fox jumps.', 'The quick red fox leaps.');
  assert.deepEqual(
    segments.map((s) => [s.op, s.text]),
    [
      ['equal', 'The quick '],
      ['del', 'brown'],
      ['add', 'red'],
      ['equal', ' fox '],
      ['del', 'jumps'],
      ['add', 'leaps'],
      ['equal', '.'],
    ],
  );
});

test('rebuilding either side from the segments returns the original text', () => {
  const before = 'OpenGEO is a local-first workbench: it captures answers,<br>\nand shows who got named.';
  const after = 'OpenGEO is a local-first workbench. It captures answers, counts mentions, and shows who got named.';
  const segments = wordDiff(before, after);
  assert.equal(segments.filter((s) => s.op !== 'add').map((s) => s.text).join(''), before);
  assert.equal(segments.filter((s) => s.op !== 'del').map((s) => s.text).join(''), after);
});

test('a one-word unchanged gap between two changes reads as one change', () => {
  const segments = wordDiff('alpha of gamma', 'one of two');
  assert.deepEqual(
    segments.map((s) => s.op),
    ['del', 'add'],
  );
  assert.equal(join(segments, 'del'), 'alpha of gamma');
  assert.equal(join(segments, 'add'), 'one of two');
});

test('Chinese is compared per character', () => {
  assert.deepEqual(tokenize('先改 README'), ['先', '改', ' ', 'README']);
  assert.deepEqual(tokenize('local-first Node.js'), ['local-first', ' ', 'Node.js']);
  const segments = wordDiff('我们支持谷歌', '我们支持 ChatGPT 和谷歌');
  assert.equal(join(segments, 'add'), ' ChatGPT 和');
  assert.equal(segments.filter((s) => s.op === 'del').length, 0);
});

test('long unchanged stretches fold to the words around each change', () => {
  const words = (n: number, w: string) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
  const before = `${words(30, 'a')} old ${words(30, 'b')}`;
  const after = `${words(30, 'a')} new ${words(30, 'b')}`;
  const folded = foldUnchanged(wordDiff(before, after), 4);
  assert.deepEqual(
    folded.map((s) => s.op),
    ['fold', 'equal', 'del', 'add', 'equal', 'fold'],
  );
  const lead = folded[1] as { text: string };
  assert.equal(lead.text.trim(), 'a26 a27 a28 a29');
  const tail = folded[4] as { text: string };
  assert.equal(tail.text.trim(), 'b0 b1 b2 b3');
});

test('identical text is never folded away', () => {
  const folded = foldUnchanged(wordDiff('same words here', 'same words here'));
  assert.deepEqual(folded, [{ op: 'equal', text: 'same words here' }]);
});

test('readable text drops Markdown markup but keeps the words a reader sees', () => {
  const md = '## Setup\n\n**Run** [the app](https://x.dev) locally,<br>then `npm start`.\n\n| Area | Yes |\n| --- | --- |\n| Cost | Free |';
  assert.equal(readableText(md), 'Setup\nRun the app locally, then npm start.\nArea · Yes\nCost · Free');
  assert.equal(readableText('One line\nwrapped here.\n\nNext paragraph.'), 'One line wrapped here.\nNext paragraph.');
});

test('a formatting-only edit still shows a change', () => {
  const segments = readableDiff('Use **OpenGEO** today', 'Use OpenGEO today');
  assert.ok(segments.some((s) => s.op === 'del'));
});

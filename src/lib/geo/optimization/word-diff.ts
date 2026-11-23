/**
 * Word-level diff for showing a page edit as readable prose: added words, removed words, and
 * long unchanged stretches folded into "…". Pure and dependency-free so the board can run it
 * in the browser. Chinese is diffed per character; everything else per word.
 */

export type DiffOp = 'equal' | 'add' | 'del';
export interface DiffSegment {
  op: DiffOp;
  text: string;
}
export type DisplaySegment = DiffSegment | { op: 'fold' };

const TOKEN_RE = /\p{Script=Han}|[\p{L}\p{N}_]+(?:[-'’.][\p{L}\p{N}_]+)*|\s+|[^\s\p{L}\p{N}_]/gu;
/** Above this many cells the LCS table gets slow; the middle is then shown as one replacement. */
const MAX_CELLS = 4_000_000;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

const isSpace = (token: string) => /^\s+$/.test(token);
const isWord = (token: string) => /[\p{L}\p{N}]/u.test(token);
const wordCount = (tokens: string[]) => tokens.filter((t) => !isSpace(t)).length;

function lcsOps(a: string[], b: string[]): Array<{ op: DiffOp; token: string }> {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_CELLS) {
    return [...a.map((token) => ({ op: 'del' as const, token })), ...b.map((token) => ({ op: 'add' as const, token }))];
  }
  // dp[i][j] = LCS length of a[i:] and b[j:], stored row-major.
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = a[i] === b[j] ? dp[(i + 1) * width + j + 1] + 1 : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const ops: Array<{ op: DiffOp; token: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: 'equal', token: a[i] });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ op: 'del', token: a[i] });
      i += 1;
    } else {
      ops.push({ op: 'add', token: b[j] });
      j += 1;
    }
  }
  for (; i < n; i += 1) ops.push({ op: 'del', token: a[i] });
  for (; j < m; j += 1) ops.push({ op: 'add', token: b[j] });
  return ops;
}

interface Block {
  equal?: string[];
  del: string[];
  add: string[];
}

/** Group token ops into alternating equal / change blocks, removed text before added text. */
function toBlocks(ops: Array<{ op: DiffOp; token: string }>): Block[] {
  const blocks: Block[] = [];
  for (const { op, token } of ops) {
    const last = blocks[blocks.length - 1];
    if (op === 'equal') {
      if (last?.equal) last.equal.push(token);
      else blocks.push({ equal: [token], del: [], add: [] });
    } else if (last && !last.equal) {
      last[op].push(token);
    } else {
      blocks.push({ del: op === 'del' ? [token] : [], add: op === 'add' ? [token] : [] });
    }
  }
  return blocks;
}

/** A tiny unchanged gap ("a", "of", ", ") between two changes reads better as part of one change. */
function absorbSmallGaps(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let k = 0; k < blocks.length; k += 1) {
    const block = blocks[k];
    const prev = out[out.length - 1];
    const next = blocks[k + 1];
    const small = block.equal && wordCount(block.equal) <= 1 && block.equal.join('').trim().length <= 2;
    if (small && prev && !prev.equal && next && !next.equal) {
      prev.del.push(...(block.equal as string[]), ...next.del);
      prev.add.push(...(block.equal as string[]), ...next.add);
      k += 1;
      continue;
    }
    out.push(block.equal ? { equal: [...block.equal], del: [], add: [] } : { del: [...block.del], add: [...block.add] });
  }
  return out;
}

export function wordDiff(before: string, after: string): DiffSegment[] {
  const a = tokenize(before);
  const b = tokenize(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = [
    ...a.slice(0, start).map((token) => ({ op: 'equal' as const, token })),
    ...lcsOps(a.slice(start, endA), b.slice(start, endB)),
    ...a.slice(endA).map((token) => ({ op: 'equal' as const, token })),
  ];
  const segments: DiffSegment[] = [];
  for (const block of absorbSmallGaps(toBlocks(ops))) {
    if (block.equal) segments.push({ op: 'equal', text: block.equal.join('') });
    else {
      if (block.del.length) segments.push({ op: 'del', text: block.del.join('') });
      if (block.add.length) segments.push({ op: 'add', text: block.add.join('') });
    }
  }
  return segments;
}

/** Keep `context` words around each change; fold the rest of every unchanged stretch into "…". */
export function foldUnchanged(segments: DiffSegment[], context = 6): DisplaySegment[] {
  if (!segments.some((s) => s.op !== 'equal')) return segments;
  const out: DisplaySegment[] = [];
  segments.forEach((segment, index) => {
    if (segment.op !== 'equal') {
      out.push(segment);
      return;
    }
    const tokens = tokenize(segment.text);
    // Context is counted in real words, so a kept stretch never starts or ends on punctuation.
    const words = tokens.map((t, i) => (isWord(t) ? i : -1)).filter((i) => i >= 0);
    const hasBefore = index > 0;
    const hasAfter = index < segments.length - 1;
    const keepHead = hasBefore ? context : 0;
    const keepTail = hasAfter ? context : 0;
    // Only fold when we actually save at least 6 words, so short openings aren't replaced by "…".
    if (words.length <= keepHead + keepTail + 5) {
      out.push(segment);
      return;
    }
    if (keepHead) out.push({ op: 'equal', text: tokens.slice(0, words[keepHead - 1] + 1).join('') });
    out.push({ op: 'fold' });
    if (keepTail) out.push({ op: 'equal', text: ` ${tokens.slice(words[words.length - keepTail]).join('')}` });
  });
  return out;
}

/**
 * Markdown/HTML source → the words a reader sees, one paragraph per line. Links keep their text,
 * wrapped lines join into their paragraph (as Markdown renders them), table rows stay one per line.
 */
export function readableText(source: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(paragraph.join(' '));
    paragraph = [];
  };
  const lines = source
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .split('\n');
  for (const raw of lines) {
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw)) continue;
    const row = raw.match(/^\s*\|(.*)\|\s*$/);
    if (row) {
      flush();
      blocks.push(
        row[1]
          .split('|')
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(' · '),
      );
      continue;
    }
    const isHeading = /^\s{0,3}#{1,6}\s+/.test(raw);
    const line = raw
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (!line || isHeading) flush();
    if (line) paragraph.push(line);
    if (isHeading) flush();
  }
  flush();
  return blocks.join('\n');
}

/** The diff a person reads; falls back to the raw source when an edit only changes formatting. */
export function readableDiff(before: string, after: string, context = 6): DisplaySegment[] {
  const a = readableText(before);
  const b = readableText(after);
  return foldUnchanged(a === b ? wordDiff(before, after) : wordDiff(a, b), context);
}

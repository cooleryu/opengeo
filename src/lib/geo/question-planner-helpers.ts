import type { GeoAsset, GeoSeed } from './types';
import type { QuestionCandidate } from './question-types';

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'at', 'as',
  'it', 'its', 'that', 'this', 'these', 'those', 'from', 'your', 'you',
  'our', 'we', 'they', 'their', 'can', 'not', 'but', 'all', 'any', 'has',
  'have', 'had', 'will', 'into', 'than', 'then',
]);

const PUNCT_NORMALIZATION: Record<string, string> = {
  '\u201c': '"',
  '\u201d': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u2014': '-',
  '\u2013': '-',
  '\uff0c': ',',
  '\u3002': '.',
  '\uff1a': ':',
  '\uff1b': ';',
  '\uff08': '(',
  '\uff09': ')',
  '\uff1f': '?',
  '\uff01': '!',
};

interface NormalizedSpanMap {
  text: string;
  starts: number[];
  ends: number[];
}

function normalizeWithMap(source: string): NormalizedSpanMap {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  let atLineStart = true;

  const pushSpace = (start: number, end: number) => {
    if (chars.length === 0 || chars[chars.length - 1] === ' ') return;
    chars.push(' ');
    starts.push(start);
    ends.push(end);
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n' || ch === '\r') {
      pushSpace(i, i + 1);
      atLineStart = true;
      i++;
      continue;
    }

    if (atLineStart) {
      // Skip leading indentation and markdown list/heading/blockquote prefixes.
      let j = i;
      while (j < source.length && (source[j] === ' ' || source[j] === '\t')) j++;
      if (j < source.length) {
        const rest = source.slice(j);
        const headingOrQuote = /^(?:#{1,6}|>+)\s+/.exec(rest);
        const bullet = /^(?:[-*+]|\d+\.)\s+/.exec(rest);
        const prefix = headingOrQuote || bullet;
        if (prefix) {
          pushSpace(i, j + prefix[0].length);
          i = j + prefix[0].length;
          atLineStart = false;
          continue;
        }
      }
      atLineStart = false;
      if (j > i) {
        pushSpace(i, j);
        i = j;
        continue;
      }
    }

    // Markdown inline link [label](url): keep label characters mapped to their real offsets.
    if (ch === '[') {
      const closeBracket = source.indexOf(']', i + 1);
      if (closeBracket > i + 1 && source[closeBracket + 1] === '(') {
        const closeParen = source.indexOf(')', closeBracket + 2);
        const label = source.slice(i + 1, closeBracket);
        const url = closeParen > closeBracket + 2 ? source.slice(closeBracket + 2, closeParen) : '';
        if (closeParen > closeBracket + 2 && !label.includes('\n') && !url.includes('\n') && !url.includes(' ')) {
          for (let k = i + 1; k < closeBracket; k++) {
            const inner = source[k];
            if (inner === '*' || inner === '_' || inner === '`' || inner === '~') continue;
            if (/\s/.test(inner)) {
              pushSpace(k, k + 1);
              continue;
            }
            const mapped = (PUNCT_NORMALIZATION[inner] ?? inner).normalize('NFKC').toLowerCase();
            for (const part of mapped) {
              chars.push(part);
              starts.push(k);
              ends.push(k + 1);
            }
          }
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Skip inline markdown emphasis/code delimiters.
    if (ch === '*' || ch === '_' || ch === '`' || ch === '~') {
      i++;
      continue;
    }

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < source.length && source[j] !== '\n' && source[j] !== '\r' && /\s/.test(source[j])) j++;
      pushSpace(i, j);
      i = j;
      continue;
    }

    const mapped = (PUNCT_NORMALIZATION[ch] ?? ch).normalize('NFKC').toLowerCase();
    for (const part of mapped) {
      chars.push(part);
      starts.push(i);
      ends.push(i + 1);
    }
    i++;
  }

  while (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop();
    starts.pop();
    ends.pop();
  }

  return { text: chars.join(''), starts, ends };
}

function stripOuterWrapper(text: string): string {
  return text
    .trim()
    .replace(/^["'\u201c\u2018\u300c\u300e]+|["'\u201d\u2019\u300d\u300f]+$/g, '')
    .replace(/^(?:\.\.\.|\u2026)+|(?:\.\.\.|\u2026)+$/g, '')
    .trim();
}

function extractMeaningfulTokens(text: string): Set<string> {
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .normalize('NFKC')
    .toLowerCase();
  const tokens = new Set<string>();
  for (const word of cleaned.match(/[a-z0-9]{2,}/g) ?? []) {
    if (!ENGLISH_STOP_WORDS.has(word)) tokens.add(word);
  }
  for (const run of cleaned.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

interface TextSpan {
  start: number;
  end: number;
  text: string;
}

function trimSpan(source: string, rawStart: number, rawEnd: number): TextSpan | null {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(source[start])) start++;
  while (end > start && /\s/.test(source[end - 1])) end--;
  if (end <= start) return null;
  return { start, end, text: source.slice(start, end) };
}

function extractCandidateSpans(source: string, minLength: number, maxLength: number): TextSpan[] {
  const spans: TextSpan[] = [];
  const seen = new Set<string>();
  const add = (rawStart: number, rawEnd: number) => {
    const span = trimSpan(source, rawStart, rawEnd);
    if (!span || span.text.length < minLength || span.text.length > maxLength) return;
    const key = `${span.start}:${span.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    spans.push(span);
  };

  let lineStart = 0;
  while (lineStart <= source.length) {
    const nextNewline = source.indexOf('\n', lineStart);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    add(lineStart, lineEnd);

    // Split long lines into individual sentences and adjacent 2-sentence windows.
    const line = source.slice(lineStart, lineEnd);
    const sentenceSpans: TextSpan[] = [];
    const boundaryRe = /[.!?\u3002\uff01\uff1f]+(?:\s+|$)/g;
    let segStart = 0;
    let match: RegExpExecArray | null;
    while ((match = boundaryRe.exec(line)) !== null) {
      const segEnd = match.index + match[0].length;
      const span = trimSpan(source, lineStart + segStart, lineStart + segEnd);
      if (span) {
        sentenceSpans.push(span);
        add(span.start, span.end);
      }
      segStart = segEnd;
    }
    if (segStart < line.length) {
      const tail = trimSpan(source, lineStart + segStart, lineEnd);
      if (tail) {
        sentenceSpans.push(tail);
        add(tail.start, tail.end);
      }
    }
    for (let i = 0; i + 1 < sentenceSpans.length; i++) {
      add(sentenceSpans[i].start, sentenceSpans[i + 1].end);
    }

    if (nextNewline === -1) break;
    lineStart = nextNewline + 1;
  }

  return spans;
}

/**
 * Resolves a model-supplied evidence quote back to an exact verbatim substring
 * from one of the supplied source texts (markdown / summary / provided quotes).
 *
 * Returns null if the quote does not reliably match any supplied text (e.g.
 * fabricated or unseen text), so downstream repair/rejection remains strict.
 */
export function resolveEvidenceQuote(
  quote: string,
  sources: readonly string[],
  options: { minLength?: number; maxLength?: number } = {},
): string | null {
  const minLength = options.minLength ?? 12;
  const maxLength = options.maxLength ?? 700;
  const nonEmptySources = sources.filter(Boolean);
  if (!quote || !nonEmptySources.length) return null;

  // Tier 1: Exact verbatim substring.
  if (nonEmptySources.some(source => source.includes(quote))) return quote;
  const trimmed = quote.trim();
  if (trimmed.length >= minLength && trimmed.length <= maxLength && nonEmptySources.some(source => source.includes(trimmed))) {
    return trimmed;
  }

  // Tier 2: Normalized verbatim span snap (ignores markdown formatting, whitespace/newlines, smart quotes, case).
  const candidateQueries = [trimmed, stripOuterWrapper(trimmed)].filter(
    (item, idx, arr) => Boolean(item) && arr.indexOf(item) === idx,
  );
  const normalizedMaps = nonEmptySources.map(source => ({ source, map: normalizeWithMap(source) }));
  for (const query of candidateQueries) {
    const normQuery = normalizeWithMap(query).text;
    if (normQuery.length < 10) continue;
    for (const { source, map } of normalizedMaps) {
      const pos = map.text.indexOf(normQuery);
      if (pos < 0) continue;
      const origStart = map.starts[pos];
      const origEnd = map.ends[pos + normQuery.length - 1];
      const snapped = source.slice(origStart, origEnd).trim();
      if (snapped.length >= minLength && snapped.length <= maxLength && source.includes(snapped)) {
        return snapped;
      }
    }
  }

  // Tier 3: High-confidence sentence/passage token overlap snap for mild model paraphrasing.
  const quoteTokens = extractMeaningfulTokens(stripOuterWrapper(trimmed) || trimmed);
  if (quoteTokens.size < 3) return null;
  const minRecall = quoteTokens.size >= 4 ? 0.55 : 0.66;
  const minMatched = quoteTokens.size >= 4 ? 3 : 2;

  let best: { text: string; score: number; length: number } | null = null;
  for (const source of nonEmptySources) {
    for (const span of extractCandidateSpans(source, minLength, maxLength)) {
      const spanTokens = extractMeaningfulTokens(span.text);
      if (spanTokens.size === 0) continue;
      let matched = 0;
      for (const token of quoteTokens) {
        if (spanTokens.has(token)) matched++;
      }
      if (matched < minMatched) continue;
      const recall = matched / quoteTokens.size;
      if (recall < minRecall) continue;
      const precision = matched / spanTokens.size;
      const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
      const score = recall * 0.72 + f1 * 0.28;
      if (
        !best ||
        score > best.score + 0.005 ||
        (Math.abs(score - best.score) <= 0.005 && span.text.length < best.length)
      ) {
        best = { text: span.text, score, length: span.text.length };
      }
    }
  }

  return best && nonEmptySources.some(source => source.includes(best.text)) ? best.text : null;
}

export interface EvidenceMaterialSlice {
  id: string;
  markdown: string;
  summary: string;
}

export interface EvidenceQuoteCandidate {
  evidence: Array<{ assetId: string; quote: string }>;
}

/**
 * Deterministically snaps slightly drifted evidence quotes (formatting, whitespace,
 * markdown syntax, or mild paraphrasing) back to exact verbatim substrings of the
 * supplied excerpts before invoking model-based quote repair.
 */
export function snapCandidateEvidenceQuotes(
  candidates: QuestionCandidate[],
  scope: 'draft' | 'review',
  materials: readonly EvidenceMaterialSlice[],
  providedCandidates: readonly EvidenceQuoteCandidate[] = [],
): QuestionCandidate[] {
  const byAsset = new Map(materials.map(item => [item.id, item]));
  const extraByAsset = new Map<string, string[]>();
  for (const candidate of providedCandidates) {
    for (const item of candidate.evidence) {
      const list = extraByAsset.get(item.assetId) ?? [];
      list.push(item.quote);
      extraByAsset.set(item.assetId, list);
    }
  }
  const cloned = structuredClone(candidates);
  let changed = false;
  for (const candidate of cloned) {
    const list = scope === 'draft' ? candidate.evidence : candidate.review.assessment?.evidence ?? [];
    for (const item of list) {
      const asset = byAsset.get(item.assetId);
      if (!asset) continue;
      const extras = extraByAsset.get(item.assetId) ?? [];
      if (asset.markdown.includes(item.quote) || asset.summary.includes(item.quote) || extras.some(q => q.includes(item.quote))) {
        continue;
      }
      const snapped = resolveEvidenceQuote(item.quote, [asset.markdown, asset.summary, ...extras]);
      if (snapped) {
        item.quote = snapped;
        changed = true;
      }
    }
  }
  return changed ? cloned : candidates;
}

export function resolveRepairQuote(
  quote: string,
  assetId: string,
  materials: readonly EvidenceMaterialSlice[],
  providedCandidateEvidence: readonly { assetId: string; quote: string }[],
): string {
  const asset = materials.find(item => item.id === assetId);
  const sources = [
    ...(asset ? [asset.markdown, asset.summary] : []),
    ...providedCandidateEvidence.filter(item => item.assetId === assetId).map(item => item.quote),
  ];
  return resolveEvidenceQuote(quote, sources) ?? quote;
}

export function trimUtf16Safe(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(maxChars - 1, 1);
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return `${value.slice(0, end).trimEnd()}\u2026`;
}

export interface SetReviewNeed {
  id: string;
  title: string;
  audience: string;
  trigger: string;
  importance: 'high' | 'medium' | 'low';
  assetIds: string[];
}

export interface SetReviewAdvantage {
  description: string;
  assetIds: string[];
}

export interface SetReviewContextInput {
  seed: GeoSeed;
  positioning: string;
  understanding?: {
    summary?: string;
    audience?: string;
    userCorrections?: Array<{ id: string; feedback: string }>;
  } | null;
  needs: readonly SetReviewNeed[];
  selectionAdvantages: readonly SetReviewAdvantage[];
  candidates: readonly QuestionCandidate[];
  round: 0 | 1;
  system: string;
  maxInputBytes: number;
  resolveOwnership: (asset: GeoAsset, seed: GeoSeed) => object;
}

/**
 * Builds a distilled, focused payload for final set review so it stays well
 * within the UTF-8 input budget without dumping duplicated research records,
 * raw markdown bodies, or verbose multi-paragraph per-question explanations.
 */
export function buildSetReviewContext(input: SetReviewContextInput): Record<string, unknown> {
  const { seed, positioning, understanding, needs, selectionAdvantages, candidates, round, system, maxInputBytes, resolveOwnership } = input;
  const systemBytes = Buffer.byteLength(system, 'utf8');
  const fits = (ctx: Record<string, unknown>) =>
    systemBytes + Buffer.byteLength(JSON.stringify(ctx), 'utf8') <= maxInputBytes;

  const baseProject = (descLimit: number) => ({
    id: seed.project.id,
    name: seed.project.name,
    owner: seed.project.owner,
    description: trimUtf16Safe(seed.project.description, descLimit),
    siteUrl: seed.project.siteUrl,
    repositoryUrl: seed.project.repositoryUrl,
    ...(seed.project.targetLanguage ? { targetLanguage: seed.project.targetLanguage } : {}),
  });

  const compactUnderstanding = understanding
    ? {
        ...(understanding.summary ? { summary: trimUtf16Safe(understanding.summary, 360) } : {}),
        ...(understanding.audience ? { audience: trimUtf16Safe(understanding.audience, 200) } : {}),
        ...(understanding.userCorrections?.length
          ? {
              userCorrections: understanding.userCorrections.slice(-3).map(item => ({
                id: item.id,
                feedback: trimUtf16Safe(item.feedback, 180),
              })),
            }
          : {}),
      }
    : null;

  const formatCandidate = (
    candidate: QuestionCandidate,
    tier: 'concise' | 'compact' | 'minimal',
  ) => {
    const intentLimit = tier === 'concise' ? 120 : tier === 'compact' ? 85 : 60;
    const reasonLimit = tier === 'concise' ? 140 : tier === 'compact' ? 85 : 60;
    const assessment = candidate.review.assessment;
    return {
      id: candidate.id,
      query: candidate.query,
      category: candidate.category,
      intent: trimUtf16Safe(candidate.intent, intentLimit),
      review: {
        decision: candidate.review.decision,
        priority: candidate.review.priority,
        status: candidate.review.status,
        reason: trimUtf16Safe(candidate.review.reason, reasonLimit),
        ...(assessment
          ? {
              assessment:
                tier === 'concise'
                  ? {
                      worthPursuing: {
                        verdict: assessment.worthPursuing.verdict,
                        demandBasis: assessment.worthPursuing.demandBasis,
                        reason: trimUtf16Safe(assessment.worthPursuing.reason, 110),
                      },
                      currentSupport: {
                        level: assessment.currentSupport.level,
                        reason: trimUtf16Safe(assessment.currentSupport.reason, 95),
                      },
                      gaps: assessment.gaps.slice(0, 2).map(gap => ({
                        kind: gap.kind,
                        description: trimUtf16Safe(gap.description, 80),
                      })),
                    }
                  : {
                      worthPursuing: {
                        verdict: assessment.worthPursuing.verdict,
                        demandBasis: assessment.worthPursuing.demandBasis,
                      },
                      currentSupport: {
                        level: assessment.currentSupport.level,
                      },
                    },
            }
          : {}),
      },
    };
  };

  // Level 0: Distilled normal view (typically ~14-26 KB even on rich repositories).
  const level0: Record<string, unknown> = {
    project: baseProject(240),
    positioning: trimUtf16Safe(positioning, 420),
    ...(compactUnderstanding && Object.keys(compactUnderstanding).length > 0
      ? { projectUnderstanding: compactUnderstanding }
      : {}),
    materials: seed.assets.map(asset => {
      const resolved = resolveOwnership(asset, seed) as { ownership?: unknown };
      return {
        id: asset.id,
        title: trimUtf16Safe(asset.title, 80),
        status: asset.status,
        ...(resolved.ownership ? { ownership: resolved.ownership } : {}),
        summary: trimUtf16Safe(asset.summary, 110),
      };
    }),
    needs,
    selectionAdvantages,
    maxSelected: 8,
    refinementRound: round,
    candidates: candidates.map(c => formatCandidate(c, 'concise')),
  };
  if (fits(level0)) return level0;

  // Level 1: Compact view for projects with large need maps or many historical candidates.
  const level1: Record<string, unknown> = {
    project: baseProject(200),
    positioning: trimUtf16Safe(positioning, 320),
    materials: seed.assets.map(asset => ({
      id: asset.id,
      title: trimUtf16Safe(asset.title, 80),
      status: asset.status,
    })),
    needs: needs.map(need => ({
      ...need,
      title: trimUtf16Safe(need.title, 80),
      audience: trimUtf16Safe(need.audience, 100),
      trigger: trimUtf16Safe(need.trigger, 140),
    })),
    selectionAdvantages: selectionAdvantages.map(adv => ({
      ...adv,
      description: trimUtf16Safe(adv.description, 160),
    })),
    maxSelected: 8,
    refinementRound: round,
    candidates: candidates.map(c => formatCandidate(c, 'compact')),
  };
  if (fits(level1)) return level1;

  // Level 2: Ultra-compact view, prioritizing eligible & active candidates if a legacy project has dozens of excluded items.
  const activeCandidates = candidates.filter(
    c => !c.supersededByCandidateId && c.review.decision !== 'exclude',
  );
  const candidatePool = activeCandidates.length > 0 ? activeCandidates : candidates;
  const level2: Record<string, unknown> = {
    project: baseProject(140),
    positioning: trimUtf16Safe(positioning, 220),
    materials: seed.assets.map(asset => ({
      id: asset.id,
      title: trimUtf16Safe(asset.title, 60),
    })),
    needs: needs.map(need => ({
      id: need.id,
      title: trimUtf16Safe(need.title, 60),
      audience: trimUtf16Safe(need.audience, 70),
      trigger: trimUtf16Safe(need.trigger, 90),
      importance: need.importance,
      assetIds: need.assetIds,
    })),
    selectionAdvantages: selectionAdvantages.slice(0, 6).map(adv => ({
      description: trimUtf16Safe(adv.description, 110),
      assetIds: adv.assetIds,
    })),
    maxSelected: 8,
    refinementRound: round,
    candidates: candidatePool.map(c => formatCandidate(c, 'minimal')),
  };
  if (fits(level2)) return level2;

  throw new Error('Set review input exceeds the 48 KB budget even after compaction.');
}

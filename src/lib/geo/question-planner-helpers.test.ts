import { seedData } from './test-fixtures';
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAssetOwnership } from './asset-ownership';
import { buildInitialQuestionPlan, generateQuestionPlan } from './question-planner';
import { buildSetReviewContext, resolveEvidenceQuote } from './question-planner-helpers';
import type { GeoSeed } from './types';
import type { QuestionCandidate } from './question-types';

const seedFixture = seedData as unknown as GeoSeed;

test('resolveEvidenceQuote snaps markdown formatting, link stripping, whitespace and mild paraphrasing back to exact verbatim source text', () => {
  const readme = [
    '# OpenGEO',
    '- **Local-first**: runs on [Next.js](https://nextjs.org) with `SQLite` \u2014 no cloud account needed.',
    'OpenGEO tracks how ChatGPT, Perplexity, and Google AI Overviews cite your product and generates actionable fixes locally.',
    'Keep source passages with their original links\nacross every saved audit run.',
  ].join('\n');

  // Exact match
  const exact = 'OpenGEO tracks how ChatGPT, Perplexity, and Google AI Overviews cite your product and generates actionable fixes locally.';
  assert.equal(resolveEvidenceQuote(exact, [readme]), exact);

  // Markdown bold, backticks, inline link, em-dash, and list bullet stripped
  const strippedMd = 'Local-first: runs on Next.js with SQLite - no cloud account needed.';
  const snappedMd = resolveEvidenceQuote(strippedMd, [readme]);
  assert.ok(snappedMd && readme.includes(snappedMd), `Expected exact substring, got: ${snappedMd}`);
  assert.match(snappedMd!, /Next\.js/);

  // Newline collapsed to space
  const collapsed = 'Keep source passages with their original links across every saved audit run.';
  const snappedNewline = resolveEvidenceQuote(collapsed, [readme]);
  assert.ok(snappedNewline && readme.includes(snappedNewline));
  assert.match(snappedNewline!, /original links\nacross/);

  // Mild DeepSeek-style paraphrase (synonyms + omitted tail)
  const paraphrased = 'OpenGEO monitors how ChatGPT, Perplexity, and Google AI Overviews cite your product and creates actionable fixes.';
  const snappedParaphrase = resolveEvidenceQuote(paraphrased, [readme]);
  assert.equal(snappedParaphrase, exact);

  // Fabricated or unrelated text must NOT snap
  assert.equal(resolveEvidenceQuote('This product offers enterprise SSO and multi-region Kubernetes failover.', [readme]), null);
  assert.equal(resolveEvidenceQuote('UNSEEN_SOURCE_SENTINEL is real source text beyond the supplied excerpt.', [readme]), null);
});

test('generateQuestionPlan snaps drifted formatting and paraphrased quotes without extra repair calls while keeping saved quotes verbatim', async () => {
  const seed: GeoSeed = structuredClone(seedFixture);
  const asset = seed.assets[0];
  const exactLine = 'Local-first analyzer tracks how ChatGPT, Perplexity, and Google AI Overviews cite your product and generates actionable page fixes.';
  asset.markdown = `# Overview\n- **Highlights**: ${exactLine}\n\n${asset.markdown}`;
  asset.summary = 'Overview summary for local-first citation analysis.';

  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const planned = {
    needs: [{ id: 'need-1', title: 'Track AI citations', audience: 'Indie founders', trigger: 'Checking how AI assistants cite their product', importance: 'high', assetIds: [asset.id] }],
    selectionAdvantages: [{ description: 'Runs locally with real evidence', assetIds: [asset.id] }],
    directions: [{ title: 'AI citation tracking', audience: 'Indie founders', trigger: 'Checking how AI assistants cite their product', assetIds: [asset.id], needIds: ['need-1'] }],
  };

  const result = await generateQuestionPlan(seed, 'Local-first tool for checking AI citations.', {
    model: {
      async generateObject(input) {
        calls.push({ messages: input.messages.map(m => ({ role: m.role, content: String(m.content) })) });
        const context = JSON.parse(String(input.messages[1].content));
        if (context.maxSelected) {
          return {
            selectedIds: ['model-1'],
            coverage: [{ needId: 'need-1', candidateIds: ['model-1'], status: 'covered', reason: 'Covers tracking AI citations.' }],
            missingAdditionalNeeds: [],
            duplicates: [],
            reason: 'Selected the core discovery question.',
          } as never;
        }
        if (context.direction) {
          return {
            candidates: [{
              query: 'How can indie founders track how ChatGPT and Perplexity cite their product?',
              category: 'problem',
              intent: 'Find tools that track AI citations across major answer engines.',
              target: 'project',
              assetIds: [asset.id],
              // Slightly paraphrased + stripped markdown formatting (would previously fail exact .includes!)
              evidence: [{
                assetId: asset.id,
                quote: 'Local-first analyzer monitors how ChatGPT, Perplexity, and Google AI Overviews cite your product and creates actionable fixes.',
              }],
              rationale: 'Direct buyer intent matching core functionality.',
              expectedResult: 'Surfaces citation-tracking tools.',
            }],
          } as never;
        }
        if (context.candidates) {
          return {
            reviews: [{
              id: 'model-1',
              decision: 'include',
              priority: 'high',
              reason: 'Clear buyer demand supported by the product documentation.',
              concerns: [],
              assessment: {
                worthPursuing: { verdict: 'yes', reason: 'Strong buyer problem.', demandBasis: 'inferred', basis: 'Founders actively check AI answers.' },
                currentSupport: { level: 'supported', reason: 'Documented directly in overview.' },
                // Stripped markdown bold & leading bullet
                evidence: [{
                  assetId: asset.id,
                  quote: `Highlights: ${exactLine}`,
                }],
                gaps: [],
              },
            }],
          } as never;
        }
        return planned as never;
      },
    },
  });

  // Zero repair calls needed: only directions + draft + review + set-review = 4 calls!
  assert.equal(calls.length, 4);
  const candidate = result.candidates.find(c => c.id === 'model-1')!;
  assert.ok(asset.markdown.includes(candidate.evidence[0].quote), 'Draft quote must be saved as exact verbatim substring');
  assert.ok(asset.markdown.includes(candidate.review.assessment!.evidence[0].quote), 'Review quote must be saved as exact verbatim substring');
});

test('buildSetReviewContext distills heavy repositories and large candidate sets well inside the 48 KB budget', () => {
  const baseSeed = structuredClone(seedFixture);
  const heavyAssets = Array.from({ length: 12 }, (_, idx) => ({
    ...baseSeed.assets[0],
    id: `asset-${idx + 1}`,
    title: `Repository documentation page ${idx + 1} with comprehensive architecture and setup instructions`,
    summary: `Detailed summary ${idx + 1}: `.repeat(45),
    markdown: `Full documentation body ${idx + 1}\n`.repeat(500),
  }));
  const heavySeed: GeoSeed = { ...baseSeed, assets: heavyAssets };
  const basePlan = buildInitialQuestionPlan(heavySeed);
  const baseCandidate = basePlan.candidates[0];

  const needs = Array.from({ length: 16 }, (_, idx) => ({
    id: `need-${idx + 1}`,
    title: `Core buyer need ${idx + 1}`,
    audience: 'Engineering leaders evaluating open-source GEO tools',
    trigger: 'Need to measure and improve how ChatGPT and Perplexity recommend their developer tool',
    importance: 'high' as const,
    assetIds: [`asset-${(idx % 12) + 1}`],
  }));
  const advantages = Array.from({ length: 6 }, (_, idx) => ({
    description: `Differentiating product advantage ${idx + 1} backed by public documentation and reproducible local audits.`,
    assetIds: [`asset-${idx + 1}`],
  }));
  const candidates: QuestionCandidate[] = Array.from({ length: 18 }, (_, idx) => ({
    ...structuredClone(baseCandidate),
    id: `model-${idx + 1}`,
    origin: 'model',
    query: `How do developer teams measure AI recommendation share for open-source tool scenario ${idx + 1}?`,
    intent: `Comprehensive buyer intent description for scenario ${idx + 1}. `.repeat(8),
    review: {
      decision: 'include',
      priority: 'high',
      status: 'reviewed',
      source: 'model',
      reviewedAt: '2026-11-20T00:00:00.000Z',
      reason: `Detailed independent review explanation for scenario ${idx + 1}. `.repeat(12),
      concerns: [],
      assessment: {
        worthPursuing: {
          verdict: 'yes',
          reason: `Long worth-pursuing analysis for scenario ${idx + 1}. `.repeat(10),
          demandBasis: 'inferred',
          basis: `Detailed demand basis text for scenario ${idx + 1}. `.repeat(10),
        },
        currentSupport: {
          level: 'supported',
          reason: `Detailed support explanation for scenario ${idx + 1}. `.repeat(10),
        },
        evidence: [],
        gaps: Array.from({ length: 4 }, (_, g) => ({
          kind: 'content' as const,
          description: `Gap detail ${g + 1} for scenario ${idx + 1}. `.repeat(5),
        })),
      },
    },
  }));

  const system = 'S'.repeat(6500);
  const maxBytes = 48 * 1024;
  const ctx = buildSetReviewContext({
    seed: heavySeed,
    positioning: 'Open-source local GEO visibility platform for developer tools.',
    understanding: { summary: 'A'.repeat(2000), audience: 'B'.repeat(1000) },
    needs,
    selectionAdvantages: advantages,
    candidates,
    round: 0,
    system,
    maxInputBytes: maxBytes,
    resolveOwnership: resolveAssetOwnership,
  });

  const totalBytes = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(JSON.stringify(ctx), 'utf8');
  assert.ok(totalBytes <= maxBytes, `Expected <= ${maxBytes}, got ${totalBytes}`);
  assert.ok(totalBytes < 36 * 1024, `Expected focused distilled payload (<36 KB), got ${totalBytes}`);
  assert.equal((ctx.candidates as unknown[]).length, 18);
  assert.equal((ctx.needs as unknown[]).length, 16);
  assert.equal((ctx.materials as unknown[]).length, 12);

  // Stress test with 45 candidates (including excluded legacy entries) -> progressive compaction still fits!
  const stressCandidates: QuestionCandidate[] = Array.from({ length: 45 }, (_, idx) => ({
    ...structuredClone(candidates[idx % candidates.length]),
    id: `stress-${idx + 1}`,
    review: {
      ...structuredClone(candidates[idx % candidates.length].review),
      decision: idx >= 20 ? 'exclude' : 'include',
    },
  }));
  const stressCtx = buildSetReviewContext({
    seed: heavySeed,
    positioning: 'Open-source local GEO visibility platform for developer tools.',
    understanding: null,
    needs,
    selectionAdvantages: advantages,
    candidates: stressCandidates,
    round: 1,
    system,
    maxInputBytes: maxBytes,
    resolveOwnership: resolveAssetOwnership,
  });
  const stressBytes = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(JSON.stringify(stressCtx), 'utf8');
  assert.ok(stressBytes <= maxBytes, `Stress set-review exceeded budget: ${stressBytes}`);
});

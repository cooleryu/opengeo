import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedData } from './test-fixtures';
import type { GeoStructuredModel } from './connection-settings';
import type { DemandSignalCollectionResult } from './demand-signals';
import { generateMarketQuestionPlan } from './market-question-planner';
import type { QuestionGenerationCheckpoint, QuestionGenerationProgress } from './question-types';
import type { GeoSeed } from './types';

const baseSeed = seedData as unknown as GeoSeed;
type ModelInput = Parameters<GeoStructuredModel['generateObject']>[0];

function makeTestSeed(): GeoSeed {
  const cloned = structuredClone(baseSeed);
  cloned.project.targetLanguage = 'en';
  cloned.questions = [];
  return cloned;
}

const mockSignals: DemandSignalCollectionResult = {
  trackUsed: 'dataforseo',
  discoveredCompetitors: ['tryprofound.com'],
  selfCorrected: false,
  costUsd: 0.03,
  warnings: [],
  signals: [
    {
      id: 'sig-1',
      source: 'dataforseo_overview',
      sources: ['google_autocomplete', 'dataforseo_overview'],
      keyword: 'best ai visibility tools',
      searchVolume: 590,
      cpc: 53.51,
      kd: 9,
      intent: 'commercial',
      tacticHint: 'direct-content',
      score: 145,
    },
    {
      id: 'sig-2',
      source: 'dataforseo_ranked',
      sources: ['dataforseo_ranked'],
      keyword: 'otterly ai alternatives',
      searchVolume: 110,
      cpc: 43.88,
      kd: 12,
      intent: 'commercial',
      competitorDomain: 'otterly.ai',
      competitorRank: 1,
      tacticHint: 'competitor-intercept',
      score: 132,
    },
    {
      id: 'sig-3',
      source: 'google_autocomplete',
      sources: ['google_autocomplete'],
      keyword: 'how to get cited by chatgpt',
      tacticHint: 'direct-content',
      score: 70,
    },
  ],
};

test('market planner runs 5-layer loop in exactly 3 LLM calls, strips invented signalIds, allows blank-gap questions, and keeps L5 jargon-free', async () => {
  const seed = makeTestSeed();
  const calls: ModelInput[] = [];
  const progressEvents: QuestionGenerationProgress[] = [];

  const model: GeoStructuredModel = {
    async generateObject(input) {
      calls.push(input);
      if (calls.length === 1) {
        return {
          personas: ['Indie SaaS founder checking AI citations'],
          categorySeeds: ['ai visibility tools', 'geo tools'],
          painVerbs: ['get cited by chatgpt'],
          competitors: [{ name: 'Otterly AI', domain: 'otterly.ai' }],
          includeHn: true,
        };
      }
      if (calls.length === 2) {
        return {
          candidates: [
            {
              query: 'What are the best AI visibility tools for indie SaaS teams?',
              category: 'comparison',
              intent: 'Founder evaluating tools that track brand mentions across AI answers.',
              target: 'project',
              signalIds: ['sig-1', 'sig-999-fabricated'],
              tactic: 'direct-content',
              fanoutQueries: ['best ai visibility tools 2026', 'ai visibility tools pricing', 'free chatgpt tracker'],
              rationale: 'Core buying question for teams comparing AI search visibility platforms (sig-1).',
              expectedResult: 'A clear comparison listing practical visibility tools.',
            },
            {
              query: 'What are the best alternatives to Otterly AI?',
              category: 'comparison',
              intent: 'Buyer comparing alternatives to an incumbent tracker.',
              target: 'project',
              signalIds: ['sig-2'],
              tactic: 'competitor-intercept',
              fanoutQueries: ['otterly ai pricing', 'otterly ai alternatives', 'open source ai visibility tool'],
              rationale: 'Captures buyers actively evaluating alternatives to a known competitor.',
              expectedResult: 'Alternatives compared by pricing, local control, and citation evidence.',
            },
            {
              query: 'How can I get my website cited by ChatGPT?',
              category: 'problem',
              intent: 'Site owner looking for actionable steps to win citations in ChatGPT.',
              target: 'article',
              signalIds: ['sig-3'],
              tactic: 'direct-content',
              fanoutQueries: ['how to get cited by chatgpt', 'chatgpt citation factors'],
              rationale: 'High-frequency practical question directly aligned with content optimization.',
              expectedResult: 'Step-by-step guidance on improving citation visibility.',
            },
            {
              query: `How does ${seed.project.name} compare to Otterly AI?`,
              category: 'comparison', // Non-brand identity leak! Hard guard must exclude it.
              intent: 'Leaked brand name inside a non-brand comparison.',
              target: 'project',
              signalIds: ['sig-2'],
              tactic: 'competitor-intercept',
              fanoutQueries: ['otterly ai comparison'],
              rationale: 'Should be automatically excluded by identity leakage guard.',
              expectedResult: 'Comparison result.',
            },
          ],
        };
      }
      // Verify L5 receives plainSignalSummary and NEVER raw KD/CPC/volume numbers
      const l5Payload = String(input.messages[1].content);
      assert.ok(!l5Payload.includes('53.51'), 'L5 must not receive raw CPC numbers');
      assert.ok(!l5Payload.includes('searchVolume'), 'L5 must not receive raw searchVolume fields');
      assert.ok(!l5Payload.includes('keyword_difficulty'), 'L5 must not receive raw KD fields');

      return {
        reviews: [
          {
            id: 'model-1',
            decision: 'include',
            priority: 'high',
            reason: 'Directly matches active buyer evaluation in this category.',
            concerns: [],
            assetIds: [],
            worthVerdict: 'yes',
            worthReason: 'High-intent shortlist question for target founders.',
            demandBasis: 'public-observation',
            demandBasisReason: 'Observed from real search behavior around AI visibility tools.',
            supportLevel: 'missing',
            supportReason: 'Current pages do not yet offer a clear category comparison.',
            gaps: [{ kind: 'content', description: 'Publish a dedicated comparison guide.' }],
          },
          {
            id: 'model-2',
            decision: 'include',
            priority: 'high',
            reason: 'High-intent competitor alternative query with a clear content gap.',
            concerns: [],
            assetIds: [],
            worthVerdict: 'yes',
            worthReason: 'Directly intercepts buyers comparing alternatives.',
            demandBasis: 'public-observation',
            demandBasisReason: 'Observed from competitor demand around Otterly AI alternatives.',
            supportLevel: 'missing',
            supportReason: 'No dedicated alternatives page exists yet.',
            gaps: [{ kind: 'content', description: 'Create an honest alternatives comparison page.' }],
          },
          {
            id: 'model-3',
            decision: 'include',
            priority: 'medium',
            reason: 'Common practical problem question for prospective users.',
            concerns: [],
            assetIds: [seed.assets[0].id],
            worthVerdict: 'yes',
            worthReason: 'Strong top-of-funnel entry point for site owners.',
            demandBasis: 'public-observation',
            demandBasisReason: 'Observed in real search autocomplete suggestions.',
            supportLevel: 'partial',
            supportReason: 'Existing documentation covers part of the workflow.',
            gaps: [{ kind: 'content', description: 'Add a concrete step-by-step guide.' }],
          },
          {
            id: 'model-4',
            decision: 'include',
            priority: 'high',
            reason: 'Model tried to approve leaked query; hard guard should still exclude it.',
            concerns: [],
            assetIds: [],
            worthVerdict: 'yes',
            worthReason: 'Competitor comparison.',
            demandBasis: 'public-observation',
            demandBasisReason: 'Observed competitor interest.',
            supportLevel: 'missing',
            supportReason: 'Missing comparison.',
            gaps: [{ kind: 'content', description: 'Add comparison.' }],
          },
        ],
        selectedIds: ['model-1', 'model-2', 'model-4'],
        summary: 'Focused on high-intent comparison and practical problem questions grounded in real external demand.',
      };
    },
  };

  const plan = await generateMarketQuestionPlan(seed, 'Open-source local AI search visibility workbench.', {
    model,
    collectSignals: async () => mockSignals,
    onProgress: event => progressEvents.push(event),
  });

  // Exactly 3 LLM calls total (L1 + L3/L4 + L5)
  assert.equal(calls.length, 3);

  // Check candidate 1: fabricated signal ID stripped, real signal hydrated, internal ID scrubbed from rationale, blank-gap allowed!
  const q1 = plan.candidates.find(c => c.id === 'model-1')!;
  assert.equal(q1.demandStatus, 'search-backed');
  assert.equal(q1.demandSignals?.length, 1);
  assert.equal(q1.demandSignals?.[0].id, 'sig-1');
  assert.equal(q1.demandSignals?.[0].searchVolume, 590);
  assert.ok(!q1.rationale.includes('sig-1'), 'internal sig-N must be scrubbed from user-facing rationale');
  assert.equal(q1.evidence.length, 0, 'blank gap must NOT force fake README quotes');
  assert.equal(q1.review.decision, 'include');
  assert.equal(q1.selected, true);

  // Check candidate 3: autocomplete-only signal gets public-observed
  const q3 = plan.candidates.find(c => c.id === 'model-3')!;
  assert.equal(q3.demandStatus, 'public-observed');
  assert.equal(q3.selected, true, 'backfilled cleanly after model-4 was excluded by identity guard');

  // Check candidate 4: non-brand identity leak excluded despite model saying include
  const q4 = plan.candidates.find(c => c.id === 'model-4')!;
  assert.equal(q4.review.decision, 'exclude');
  assert.equal(q4.selected, false);

  // Verify 0 brand questions is completely valid (no rigid 75/25 lock!)
  assert.equal(plan.candidates.filter(c => c.selected && c.category === 'brand').length, 0);
  assert.equal(plan.candidates.filter(c => c.selected).length, 3);

  // Verify checkpoints were emitted for resume
  const keys = progressEvents.filter(e => e.checkpoint).map(e => e.checkpoint!.key);
  assert.deepEqual(keys, ['market-model', 'market-signals', 'market-drafts', 'market-review']);
});

test('market planner resumes from saved checkpoints without repeating L1, L2, or L3/L4 calls', async () => {
  const seed = makeTestSeed();
  const capturedCheckpoints: QuestionGenerationCheckpoint[] = [];
  let signalCalls = 0;

  // First run fails at L5 (3rd call)
  let firstRunCalls = 0;
  const failingModel: GeoStructuredModel = {
    async generateObject() {
      firstRunCalls++;
      if (firstRunCalls === 1) {
        return {
          personas: ['Developer'],
          categorySeeds: ['ai visibility tools'],
          painVerbs: ['get cited by chatgpt'],
          competitors: [],
          includeHn: false,
        };
      }
      if (firstRunCalls === 2) {
        return {
          candidates: [{
            query: 'What are the best AI visibility tools?',
            category: 'comparison',
            intent: 'Compare AI visibility tools.',
            target: 'project',
            signalIds: ['sig-1'],
            tactic: 'direct-content',
            fanoutQueries: ['best ai visibility tools'],
            rationale: 'Core comparison topic.',
            expectedResult: 'List of visibility tools.',
          }],
        };
      }
      throw new Error('Simulated transient L5 outage');
    },
  };

  await assert.rejects(
    generateMarketQuestionPlan(seed, 'Local AI search visibility tool.', {
      model: failingModel,
      collectSignals: async () => { signalCalls++; return mockSignals; },
      onProgress: event => {
        if (event.checkpoint) capturedCheckpoints.push({ ...event.checkpoint, completedAt: new Date().toISOString() });
      },
    }),
    /Simulated transient L5 outage/,
  );
  assert.equal(signalCalls, 1);
  assert.deepEqual(capturedCheckpoints.map(c => c.key), ['market-model', 'market-signals', 'market-drafts']);

  // Resumed run should make ONLY 1 LLM call (L5) and 0 L2 signal collection calls!
  let resumedModelCalls = 0;
  const resumedModel: GeoStructuredModel = {
    async generateObject() {
      resumedModelCalls++;
      return {
        reviews: [{
          id: 'model-1',
          decision: 'include',
          priority: 'high',
          reason: 'Directly matches buyer comparison demand.',
          concerns: [],
          assetIds: [],
          worthVerdict: 'yes',
          worthReason: 'Strong commercial discovery demand.',
          demandBasis: 'public-observation',
          demandBasisReason: 'Backed by external search demand.',
          supportLevel: 'missing',
          supportReason: 'No comparison page yet.',
          gaps: [{ kind: 'content', description: 'Write a comparison page.' }],
        }],
        selectedIds: ['model-1'],
        summary: 'Resumed and finalized cleanly.',
      };
    },
  };

  const resumedPlan = await generateMarketQuestionPlan(seed, 'Local AI search visibility tool.', {
    model: resumedModel,
    resume: capturedCheckpoints,
    collectSignals: async () => { signalCalls++; return mockSignals; },
  });

  assert.equal(signalCalls, 1, 'L2 signal collection must NOT re-run on resume');
  assert.equal(resumedModelCalls, 1, 'Only L5 review should run on resume');
  assert.equal(resumedPlan.candidates.filter(c => c.selected).length, 1);
});

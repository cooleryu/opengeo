import './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLatestResearch } from './research';
import { getCollectionConfig } from './providers/config';
import {
  freezeResearchTaskContext,
  resolveResearchTaskContext,
} from './research-task-context';
import {
  buildSearchProtocolKey,
  frozenQuestion,
  matchHistoricalQuestions,
} from './search-protocol';
import type { GeoTask, ResearchTaskContext } from './types';
import type { CompetitorCandidates, CompetitorRow } from './competitor-types';
import { getSeed } from './seed';
import { buildResearchGapReview, buildTaskDiagnosisContext } from './planner';

const batch = getLatestResearch('sample-project')!;
const context: ResearchTaskContext = {
  batchId: batch.id,
  questionId: 'C02',
  language: 'zh',
  engine: 'chatgpt',
};
const collection = getCollectionConfig('deepseek');
const freeze = (input = context) =>
  freezeResearchTaskContext(
    input,
    batch,
    'sample-project',
    collection,
    '2026-10-26T00:00:00Z',
  );

test('research identity resolves server-owned original query and matching evidence only', () => {
  const resolved = resolveResearchTaskContext(
    { ...context, query: 'forged query', evidencePath: '/private/forged' },
    batch,
    'sample-project',
  );
  assert.equal(resolved.context.batchId, context.batchId);
  assert.equal(resolved.context.questionId, context.questionId);
  assert.equal(
    resolved.context.snapshot?.question.zh,
    batch.questions.find((item) => item.id === 'C02')!.zh,
  );
  assert.equal(resolved.context.purpose, 'improve_answer');
  assert.equal(
    resolved.question.query,
    batch.questions.find((item) => item.id === 'C02')!.zh,
  );
  assert.ok(resolved.observations.length > 0);
  assert.ok(
    resolved.observations.every(
      (item) => item.engine === 'chatgpt' && item.language === 'zh',
    ),
  );
  assert.ok(
    resolved.observations.every(
      (item) => item.evidencePath !== '/private/forged',
    ),
  );
  const original = batch.questions.find((item) => item.id === 'C02')!
    .observations[0].summary;
  resolved.observations[0].summary = 'changed copy';
  assert.equal(
    batch.questions.find((item) => item.id === 'C02')!.observations[0].summary,
    original,
  );
});

test('invalid project, batch, question, language and engine cannot create task context', () => {
  assert.throws(
    () => resolveResearchTaskContext(context, batch, 'sample-project-two'),
    /当前项目/,
  );
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, batchId: 'old-batch' },
        batch,
        'sample-project',
      ),
    /批次/,
  );
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, questionId: 'R02' },
        batch,
        'sample-project',
      ),
    /审核/,
  );
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, language: 'fr' },
        batch,
        'sample-project',
      ),
    /中文或英文/,
  );
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, engine: 'invalid-engine' },
        batch,
        'sample-project',
      ),
    /入口无效/,
  );
  assert.throws(
    () => resolveResearchTaskContext(null, batch, 'sample-project'),
    /格式/,
  );
});

test('deferred, unreviewed and unobserved questions stay outside executable context', () => {
  const replay = getLatestResearch('sample-project-two')!;
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, batchId: replay.id, questionId: 'R06' },
        replay,
        replay.projectId,
      ),
    /审核/,
  );
  const changed = structuredClone(batch);
  changed.questions.find((item) => item.id === 'C02')!.decision =
    'keep_and_fill';
  assert.throws(
    () => resolveResearchTaskContext(context, changed, 'sample-project'),
    /审核/,
  );
  changed.questions.find((item) => item.id === 'C02')!.decision = 'search_now';
  changed.questions.find((item) => item.id === 'C02')!.observations = [];
  assert.throws(
    () => resolveResearchTaskContext(context, changed, 'sample-project'),
    /尚无/,
  );
});

test('freeze contains exactly the selected language of one reviewed question and no baseline', () => {
  const chinese = freeze();
  const english = freeze({ ...context, language: 'en', engine: 'google' });
  const original = batch.questions.find((item) => item.id === 'C02')!;
  assert.equal(chinese.questions.length, 1);
  assert.equal(english.questions.length, 1);
  assert.equal(chinese.questions[0].query, original.zh);
  assert.equal(english.questions[0].query, original.en);
  assert.equal(chinese.questions[0].language, 'zh-CN');
  assert.equal(english.questions[0].language, 'en');
  assert.notEqual(chinese.questions[0].id, english.questions[0].id);
  assert.notEqual(chinese.protocolKey, english.protocolKey);
  assert.equal(
    chinese.protocolKey,
    buildSearchProtocolKey(chinese.questions, collection),
  );
  assert.equal(chinese.baseline, undefined);
  assert.equal(chinese.diagnosis, undefined);
  assert.equal(chinese.collection!.provider, 'deepseek');
});

test('reference engine does not substitute a consumer observation for the new API protocol', () => {
  const fromChatGPT = freeze();
  const fromGoogle = freeze({ ...context, engine: 'google' });
  assert.equal(fromChatGPT.protocolKey, fromGoogle.protocolKey);
  const question = frozenQuestion(fromChatGPT.questions[0]);
  const oldRecord = {
    ...question,
    id: context.questionId,
    evidencePath: 'old-personal-chatgpt.json',
    projectHit: true,
  };
  assert.deepEqual(matchHistoricalQuestions([question], [oldRecord]), []);
  assert.equal(question.measurementAt, '');
  assert.equal(question.evidencePath, '');
});

test('long English original is rejected for DeepSeek without truncation and fits an answer provider', () => {
  const replay = getLatestResearch('sample-project-two')!;
  const input: ResearchTaskContext = {
    batchId: replay.id,
    questionId: 'R02',
    language: 'en',
    engine: 'chatgpt',
  };
  const original = replay.questions.find((item) => item.id === 'R02')!.en;
  assert.throws(
    () =>
      freezeResearchTaskContext(
        input,
        replay,
        replay.projectId,
        collection,
        '',
      ),
    /128 字符上限/,
  );
  const workflow = freezeResearchTaskContext(
    input,
    replay,
    replay.projectId,
    getCollectionConfig('qwen'),
    '2026-10-26T00:00:00Z',
  );
  assert.equal(workflow.questions[0].query, original);
  assert.equal(workflow.collection!.provider, 'qwen');
  assert.equal(workflow.baseline, undefined);
  const preview = freezeResearchTaskContext(
    input,
    replay,
    replay.projectId,
    collection,
    '2026-10-26T00:00:00Z',
    'replay',
  );
  assert.equal(preview.questions[0].query, original);
  assert.equal(preview.baseline, undefined);
});

test('selected source, gap and target must come from the same server-owned question and project', () => {
  const seed = getSeed();
  const changed = structuredClone(batch);
  changed.questions.find((item) => item.id === 'C02')!.gaps = [
    '证据：需要一次真实重复试验',
  ];
  const sourceUrl = changed.questions
    .find((item) => item.id === 'C02')!
    .observations.find(
      (item) => item.language === 'zh' && item.engine === 'chatgpt',
    )!.sources[0].url;
  const gapId = `${batch.projectId}:${batch.id}:C02:gap:0`;
  const target = seed.assets.find(
    (asset) => asset.id === 'guide-zh-CN',
  )!;
  const resolved = resolveResearchTaskContext(
    {
      ...context,
      sourceUrl,
      gapId,
      targetAssetId: target.id,
      snapshot: { question: { zh: 'forged' } },
      targetUrl: 'https://forged.invalid',
    },
    changed,
    batch.projectId,
    seed.assets,
  );
  assert.equal(resolved.context.gap, '证据：需要一次真实重复试验');
  assert.equal(resolved.context.targetUrl, target.publicUrl);
  assert.deepEqual(resolved.question.assetIds, [target.id]);
  assert.equal(
    resolved.context.snapshot?.targetAsset?.markdown,
    target.markdown,
  );
  assert.notEqual(resolved.context.snapshot?.question.zh, 'forged');
  for (const invalid of [
    { sourceUrl: 'https://forged.invalid' },
    { targetAssetId: 'other-project' },
    { gap: 'invented gap' },
    { gapId: `${batch.projectId}:${batch.id}:C03:gap:0` },
    { purpose: 'investigate_gap' },
  ])
    assert.throws(() =>
      resolveResearchTaskContext(
        { ...context, ...invalid },
        changed,
        batch.projectId,
        seed.assets,
      ),
    );
});

test('saved context freezes both original wordings and selected evidence when the current batch changes', () => {
  const seed = getSeed();
  const saved = resolveResearchTaskContext(
    context,
    batch,
    batch.projectId,
    seed.assets,
  ).context;
  const changed = structuredClone(batch);
  changed.id = 'next-batch';
  changed.questions.find((item) => item.id === 'C02')!.zh = 'new wording';
  const workflow = freezeResearchTaskContext(
    saved,
    changed,
    batch.projectId,
    collection,
    '2026-10-26',
  );
  assert.equal(workflow.questions[0].query, saved.snapshot!.question.zh);
  assert.equal(
    saved.snapshot!.question.en,
    batch.questions.find((item) => item.id === 'C02')!.en,
  );
  assert.ok(workflow.questions[0].assetIds.length > 0);
  assert.equal(workflow.baseline, undefined);
  assert.throws(
    () =>
      freezeResearchTaskContext(
        saved,
        changed,
        'sample-project-two',
        collection,
        '',
      ),
    /当前项目/,
  );
  const priorSummary = saved.snapshot!.observations[0].summary;
  changed.questions.find((item) => item.id === 'C02')!.observations[0].summary =
    'changed';
  assert.equal(saved.snapshot!.observations[0].summary, priorSummary);
});

test('keep-and-fill creates a local gap task but cannot authorize collection or drafting', () => {
  const replay = getLatestResearch('sample-project-two')!;
  const input = {
    batchId: replay.id,
    questionId: 'R06',
    language: 'zh',
    engine: 'chatgpt',
    purpose: 'investigate_gap',
    gapId: `${replay.projectId}:${replay.id}:R06:gap:0`,
  };
  const resolved = resolveResearchTaskContext(input, replay, replay.projectId);
  assert.equal(resolved.context.snapshot!.question.decision, 'keep_and_fill');
  assert.equal(resolved.question.exploratory, true);
  assert.deepEqual(resolved.observations, []);
  assert.throws(
    () =>
      freezeResearchTaskContext(
        resolved.context,
        replay,
        replay.projectId,
        collection,
        '',
      ),
    /尚未通过搜索审核/,
  );
  assert.throws(
    () =>
      freezeResearchTaskContext(
        resolved.context,
        replay,
        replay.projectId,
        collection,
        '',
        'replay',
      ),
    /尚未通过搜索审核/,
  );
});

test('planning uses original need, selected source, gap and frozen target without promoting reference records to baseline', async () => {
  const seed = getSeed();
  const changed = structuredClone(batch);
  changed.questions.find((item) => item.id === 'C02')!.gaps = [
    '证据：需要一次真实重复试验',
  ];
  const target = seed.assets.find(
    (asset) => asset.id === 'guide-zh-CN',
  )!;
  const sourceUrl = changed.questions.find((item) => item.id === 'C02')!
    .observations[0].sources[0].url;
  const research = resolveResearchTaskContext(
    {
      ...context,
      sourceUrl,
      gap: '证据：需要一次真实重复试验',
      targetAssetId: target.id,
    },
    changed,
    batch.projectId,
    seed.assets,
  ).context;
  const task = {
    id: 'research-test',
    goal: 'generic goal',
    researchContext: research,
    workflow: freezeResearchTaskContext(
      research,
      changed,
      batch.projectId,
      collection,
      '',
    ),
    proposal: null,
  } as GeoTask;
  const alteredSeed = structuredClone(seed);
  alteredSeed.assets.find((asset) => asset.id === target.id)!.markdown =
    'changed after task creation';
  const planning = buildTaskDiagnosisContext(task, alteredSeed);
  assert.ok(planning.goal.includes(research.snapshot!.question.zh));
  assert.equal(planning.research?.selectedSourceUrl, sourceUrl);
  assert.equal(planning.research?.selectedGap, research.gap);
  assert.deepEqual(planning.allowedTargetAssetIds, [target.id]);
  assert.notEqual(
    planning.materials.find((asset) => asset.id === target.id)!.markdown,
    'changed after task creation',
  );
  assert.equal(planning.baseline, null);
  assert.equal(planning.evidenceReady, false);
  const gapTask = {
    ...task,
    researchContext: { ...research, purpose: 'investigate_gap' as const },
  };
  const review = buildResearchGapReview(gapTask, alteredSeed);
  assert.equal(review.source, 'local');
  assert.ok(review.findings[0].observation.includes(research.gap!));
  assert.match(review.limitations.join(' '), /未调用模型/);
});

function selectedCompetitorFixture(): CompetitorCandidates {
  const row: CompetitorRow = {
    id: 'row-1',
    questionId: context.questionId,
    question: 'Original question',
    query: 'Original question',
    observationIndex: 0,
    engine: context.engine,
    entryType: 'web_answer',
    language: context.language,
    recordedAt: '2026-10-28T00:00:00Z',
    conditions: 'saved conditions',
    evidencePath: 'evidence/reference.json',
    answerAvailable: true,
    sourcesAvailable: true,
    ownMention: { status: 'not_seen', names: [], excerpts: [] },
    targetMention: {
      status: 'matched',
      names: ['Reference'],
      excerpts: ['Reference has a usage example.'],
    },
    sources: [],
  };
  const candidate: NonNullable<CompetitorCandidates['selectedCandidate']> = {
    id: 'candidate-reference',
    name: 'Reference',
    aliases: ['Reference Tool'],
    officialUrls: ['https://example.com/reference'],
    description: 'Reference tool',
    reason: 'Observed in the answer',
    saved: true,
    questions: [
      {
        evidenceId: 'e1',
        batchId: batch.id,
        questionId: context.questionId,
        question: 'Original question',
        engine: context.engine,
        language: context.language,
        recordedAt: row.recordedAt,
        evidencePath: row.evidencePath,
        observationIndex: 0,
        sourceUrl: 'https://example.com/reference',
        excerpt: 'Reference has a usage example.',
      },
    ],
    analysis: {
      status: 'ready',
      description: 'Reference tool',
      reason: 'Same need',
      strengths: ['Usage example'],
      opportunities: [
        {
          questionId: context.questionId,
          title: 'Add an example',
          observed: 'Reference has a usage example.',
          hypothesis: 'An example may answer the original need better.',
          action: 'Add a verified example',
          evidenceIds: ['e1'],
        },
      ],
      limitations: ['Not a causal effect'],
      evidenceIds: ['e1'],
      quotes: [{ evidenceId: 'e1', quote: 'Reference has a usage example.' }],
      version: '1',
    },
  };
  return {
    projectId: batch.projectId,
    batch: { id: batch.id, date: batch.date },
    target: {
      name: candidate.name,
      aliases: candidate.aliases,
      officialUrls: candidate.officialUrls,
      updatedAt: row.recordedAt,
    },
    candidates: [candidate],
    selectedCandidate: candidate,
    analysis: { status: 'ready', summary: 'Ready' },
    selection: {
      id: 'selection-1',
      projectId: batch.projectId,
      batchId: batch.id,
      candidateId: candidate.id,
      selectedAt: row.recordedAt,
      baseline: {
        batch: { id: batch.id, date: batch.date },
        rows: [row, { ...row, id: 'other-language', language: 'en' }],
      },
    },
  };
}

test('competitor task takes target, learning evidence and scoped baseline only from the current server selection', () => {
  const competitors = selectedCompetitorFixture();
  const resolved = resolveResearchTaskContext(
    {
      ...context,
      projectId: batch.projectId,
      candidateId: 'candidate-reference',
      target: { name: 'Forged' },
      snapshot: {
        competitorReference: { name: 'Forged', baseline: { rows: [] } },
      },
    },
    batch,
    batch.projectId,
    [],
    competitors,
  ).context;
  const reference = resolved.snapshot!.competitorReference!;
  assert.equal(reference.name, 'Reference');
  assert.equal(reference.selectionId, 'selection-1');
  assert.equal(reference.baseline.rows.length, 1);
  assert.equal(reference.baseline.rows[0].targetMention.status, 'matched');
  assert.equal(reference.evidence[0].evidenceId, 'e1');
  assert.equal(reference.opportunities[0].action, 'Add a verified example');
  assert.equal(reference.quotes?.[0].quote, 'Reference has a usage example.');
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, candidateId: 'candidate-reference' },
        batch,
        batch.projectId,
      ),
    /所选参照/,
  );
  assert.throws(
    () =>
      resolveResearchTaskContext(
        { ...context, candidateId: 'forged-candidate' },
        batch,
        batch.projectId,
        [],
        competitors,
      ),
    /所选参照/,
  );
  assert.throws(
    () =>
      resolveResearchTaskContext(
        {
          ...context,
          projectId: 'wrong-project',
          candidateId: 'candidate-reference',
        },
        batch,
        batch.projectId,
        [],
        competitors,
      ),
    /当前项目/,
  );
});

test('saved competitor task keeps its target and baseline when selection and later records change', () => {
  const competitors = selectedCompetitorFixture();
  const saved = resolveResearchTaskContext(
    { ...context, candidateId: 'candidate-reference' },
    batch,
    batch.projectId,
    [],
    competitors,
  ).context;
  competitors.selection!.candidateId = 'candidate-other';
  competitors.selection!.baseline.rows[0].ownMention.status = 'matched';
  competitors.selectedCandidate!.name = 'Other';
  competitors.selectedCandidate!.analysis!.opportunities[0].action =
    'Changed advice';
  const workflow = freezeResearchTaskContext(
    saved,
    batch,
    batch.projectId,
    collection,
    '2026-10-29T00:00:00Z',
  );
  const task = {
    id: 'reference-task',
    goal: 'Improve',
    researchContext: saved,
    workflow,
    proposal: null,
  } as GeoTask;
  const planning = buildTaskDiagnosisContext(task, getSeed());
  assert.equal(saved.snapshot!.competitorReference!.name, 'Reference');
  assert.equal(
    saved.snapshot!.competitorReference!.baseline.rows[0].ownMention.status,
    'not_seen',
  );
  assert.equal(
    planning.research!.competitorReference!.opportunities[0].action,
    'Add a verified example',
  );
  assert.equal(planning.research!.acceptanceGoals.length, 2);
  assert.match(planning.goal, /自身比保存基线改善/);
  assert.match(planning.research!.acceptanceGoals[1], /待复测/);
  assert.equal(workflow.baseline, undefined);
});

test('ordinary research tasks do not acquire the project competitor or accept client snapshots', () => {
  const saved = resolveResearchTaskContext(
    { ...context, snapshot: { competitorReference: { name: 'Forged' } } },
    batch,
    batch.projectId,
    [],
    selectedCompetitorFixture(),
  ).context;
  assert.equal(saved.candidateId, undefined);
  assert.equal(saved.snapshot!.competitorReference, undefined);
  const task = {
    id: 'ordinary-task',
    goal: 'Improve',
    researchContext: saved,
    proposal: null,
  } as GeoTask;
  const planning = buildTaskDiagnosisContext(task, getSeed());
  assert.equal(planning.research!.competitorReference, null);
  assert.deepEqual(planning.research!.acceptanceGoals, []);
});

test('competitor opportunities require evidence from the exact batch, question, language and engine', () => {
  const input = { ...context, candidateId: 'candidate-reference' };
  const reject = (change: (value: CompetitorCandidates) => void) => {
    const competitors = selectedCompetitorFixture();
    change(competitors);
    assert.throws(
      () =>
        resolveResearchTaskContext(
          input,
          batch,
          batch.projectId,
          [],
          competitors,
        ),
      /语言与入口的改进依据/,
    );
  };
  reject((value) => {
    value.selectedCandidate!.questions[0].batchId = 'old-batch';
  });
  reject((value) => {
    value.selectedCandidate!.questions[0].questionId = 'other-question';
  });
  reject((value) => {
    value.selectedCandidate!.questions[0].language = 'en';
  });
  reject((value) => {
    value.selectedCandidate!.questions[0].engine = 'google';
  });
  reject((value) => {
    value.selectedCandidate!.analysis!.opportunities[0].evidenceIds = [];
  });
  reject((value) => {
    value.selectedCandidate!.analysis!.opportunities[0].evidenceIds.push(
      'missing-evidence',
    );
  });
});

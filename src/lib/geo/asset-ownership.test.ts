import { initialResearch, seeds } from './test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerateObjectInput } from '@/lib/models/types';
import { editableAssetIssue, resolveAssetOwnership } from './asset-ownership';
import { buildProjectOptimization, freezeProjectOptimization } from './project-optimization';
import { prepareOptimizationMaterials, readDeliveryMaterial, selectProjectDelivery } from './project-optimization-delivery';
import { resolveResearchTaskContext } from './research-task-context';
import { buildIndependentReviewInput, buildTaskDiagnosisContext, prepareSavedResearchWorkflow } from './planner';
import { localDiagnosis, validateProposal } from './diagnosis';
import { researchDocumentAsset } from './project-research-assets';
import type { GeoAsset, GeoProposal, GeoTask } from './types';

const seed = structuredClone(seeds[0]);
const batch = structuredClone(initialResearch.find(item => item.projectId === seed.project.id)!);
const baseAsset = seed.assets.find(item => item.id === 'guide-zh-CN')!;
const asset = (patch: Partial<GeoAsset> = {}): GeoAsset => ({ ...baseAsset, ...patch });
const scope = (candidate: GeoAsset) => ({ ...seed, assets: [...seed.assets.filter(item => item.id !== candidate.id), candidate] });

test('missing/unknown ownership resolves own repo, raw README and scoped site without changing saved metadata', () => {
  for (const ownership of [undefined, 'unknown', 'owned'] as const) {
    for (const publicUrl of ['https://github.com/example/sample-project/blob/main/README.md',
      'https://raw.githubusercontent.com/example/sample-project/main/README.md', 'https://example.com/sample-project/docs/guide']) {
      const candidate = asset({ ownership, publicUrl, sourcePath: 'data/geo-evidence/old/readme.md' });
      const before = structuredClone(candidate);
      assert.equal(resolveAssetOwnership(candidate, scope(candidate)).ownership, 'owned');
      assert.equal(editableAssetIssue(candidate, scope(candidate)), null);
      assert.deepEqual(candidate, before);
    }
  }
});

test('explicit external, another repository/account and sibling site paths cannot become editable by claiming owned', () => {
  const declaredExternal = asset({ ownership: 'external' });
  assert.equal(resolveAssetOwnership(declaredExternal, scope(declaredExternal)).ownership, 'external');
  for (const publicUrl of ['https://github.com/example/other/blob/main/README.md',
    'https://github.com/other/sample-project/blob/main/README.md',
    'https://raw.githubusercontent.com/example/other/main/README.md',
    'https://example.com/sample-project-two/article', 'https://example.com/sample-project-evil/article']) {
    const candidate = asset({ publicUrl });
    assert.equal(resolveAssetOwnership(candidate, scope(candidate)).ownership, 'external', publicUrl);
    assert.match(editableAssetIssue(candidate, scope(candidate))!, /外部参考/);
  }
});

test('only registered original paths restore local legacy assets; evidence copies and cross-project material do not', () => {
  const article = seed.assets.find(item => item.id === 'sample-article')!;
  assert.equal(resolveAssetOwnership(article, seed).ownership, 'owned');
  assert.equal(resolveAssetOwnership({ ...article, sourcePath: 'data/geo-evidence/read-again.md' }, seed).ownership, 'owned');
  assert.equal(resolveAssetOwnership(article, seeds[1]).ownership, 'external');
  const cached = asset({ publicUrl: 'https://external.example/reference', sourcePath: 'data/geo-evidence/source.md', ownership: 'unknown' });
  assert.equal(resolveAssetOwnership(cached, scope(cached)).ownership, 'external');
  const unregistered = asset({ publicUrl: 'https://external.example/reference', sourcePath: 'original/unregistered.md', ownership: 'owned' });
  assert.equal(resolveAssetOwnership(unregistered, seed).ownership, 'external');
  const external = asset({ ownership: 'external' });
  assert.equal(resolveAssetOwnership({ ...external, ownership: 'owned' }, scope(external)).ownership, 'external');
  const declared = asset({ publicUrl: 'https://additional.example/official', sourcePath: 'data/geo-evidence/official.md', ownership: 'owned' });
  assert.equal(resolveAssetOwnership(declared, scope(declared)).ownership, 'owned');
  assert.equal(resolveAssetOwnership({ ...declared, sourcePath: 'data/geo-evidence/new-read.md' }, scope(declared)).ownership, 'owned');
  assert.equal(resolveAssetOwnership(declared, seed).ownership, 'external');
});

test('legacy research README is exposed as owned without rewriting its raw unknown record', () => {
  const document = { id: 'old-readme', title: 'README', url: 'https://raw.githubusercontent.com/example/sample-project/main/README.md',
    sourcePath: 'data/geo-evidence/old/readme.md', markdown: '# Saved original', readAt: '2026-10-01', type: 'documentation',
    origin: 'linked' as const, ownership: 'unknown' as const };
  const before = structuredClone(document);
  const material = researchDocumentAsset(seed.project.id, document, seed.project);
  assert.equal(material.ownership, 'owned');
  assert.equal(material.status, 'published');
  assert.deepEqual(document, before);
});

const question = batch.questions.find(item => item.id === 'C02')!;
const frozen = (candidate: GeoAsset) => freezeProjectOptimization({ ...batch, questions: [question] }, scope(candidate), 'focus', batch.id,
  () => `- Question: ${question.zh}\n## Answer text\nRecord inputs before comparing results.`);
const candidate = { summary: '完善原问题的操作步骤', limitations: [], actions: [{ id: 'A1', title: '补充步骤', priority: 1,
  questionIds: ['C02'], assetIds: [baseAsset.id], observed: '原回答给出了比较步骤', hypothesis: '补充步骤可能帮助回答',
  change: '明确输入与比较条件。', rationale: '保留原需求并补齐步骤。',
  evidence: [{ evidenceId: 'C02:observation:0', quote: 'Record inputs' }, { evidenceId: baseAsset.id, quote: 'Record inputs' }],
  verification: '按原题、语言和条件复测。', limitations: [] }] };
const assessment = { issues: [], actions: [{ actionId: 'A1', scores: { evidence: 95, relevance: 95, actionability: 95, verifiability: 95 },
  preservesGoal: 'pass', evidenceGrounded: 'pass', issues: [] }] };

test('whole-project writer and independent reviewer retain references but cannot approve external edits with high scores', async () => {
  const external = asset({ ownership: 'external' });
  const calls: GenerateObjectInput[] = [];
  const result = await buildProjectOptimization({ ...frozen(external), maxRounds: 1 }, { loadModel: async () => ({
    generateObject: async input => { calls.push(input); return calls.length === 1 ? candidate : assessment; },
  }) });
  assert.equal(result.review?.passed, false);
  assert.equal(result.actions[0].status, 'blocked');
  assert.ok(result.review?.actions[0].issues.some(issue => issue.includes('外部参考')));
  for (const call of calls) {
    const supplied = JSON.parse(String(call.messages[1].content)).context.assets.find((item: GeoAsset) => item.id === external.id);
    assert.equal(supplied.ownership, 'external');
    assert.equal(supplied.editable, false);
    assert.match(supplied.markdown, /Record inputs/);
  }
  assert.equal(result.snapshot.assets.find(item => item.id === external.id)?.ownership, 'external');
});

test('normal legacy owned plan passes, while delivery rechecks external and cross-project targets before reads', async () => {
  let count = 0;
  const plan = await buildProjectOptimization({ ...frozen(baseAsset), maxRounds: 1 }, { loadModel: async () => ({
    generateObject: async () => ++count === 1 ? candidate : assessment,
  }) });
  assert.equal(plan.review?.passed, true);
  assert.equal(selectProjectDelivery(plan, seed).asset.id, baseAsset.id);
  assert.throws(() => selectProjectDelivery(plan, seeds[1]), /当前项目/);
  const externalScope = scope(asset({ ownership: 'external' }));
  assert.throws(() => selectProjectDelivery(plan, externalScope), /外部参考/);
  await assert.rejects(readDeliveryMaterial(asset({ ownership: 'external' }), seed), /外部参考/);
  const externalPlan = frozen(asset({ ownership: 'external', publicUrl: 'https://github.com/other/project/blob/main/README.md' }));
  let reads = 0;
  await prepareOptimizationMaterials(externalPlan, async value => { reads += 1; return { asset: value, readAt: '2026-11-11' }; });
  assert.equal(reads, 0);
});

test('single-question creation, diagnosis, candidate validation and independent review share ownership checks', () => {
  const external = asset({ ownership: 'external' });
  const input = { batchId: batch.id, questionId: question.id, language: 'zh', engine: 'chatgpt', targetAssetId: external.id };
  assert.throws(() => resolveResearchTaskContext(input, batch, seed.project.id, scope(external).assets), /外部参考/);
  const sourceUrl = question.observations.find(item => item.language === 'zh' && item.engine === 'chatgpt')!.sources[0].url;
  const resolved = resolveResearchTaskContext({ ...input, targetAssetId: undefined, sourceUrl }, batch, seed.project.id, scope(external).assets);
  assert.equal(resolved.context.sourceUrl, sourceUrl);
  assert.equal(resolved.context.snapshot?.candidateAssetIds.includes(external.id), false);
  const researchContext = resolveResearchTaskContext(input, batch, seed.project.id, seed.assets).context;
  const task = { id: 'ownership-single', projectId: seed.project.id, goal: '完善原题', researchContext, implementation: null, runs: [] } as unknown as GeoTask;
  task.workflow = prepareSavedResearchWorkflow(task, seed);
  const context = buildTaskDiagnosisContext(task, scope(external));
  assert.equal(context.allowedTargetAssetIds.includes(external.id), false);
  const material = context.materials.find(item => item.id === external.id)!;
  assert.equal(material.ownership, 'external');
  assert.equal(material.editable, false);
  const wrongProject = buildTaskDiagnosisContext({ ...task, projectId: seeds[1].project.id }, seed);
  assert.equal(wrongProject.evidenceReady, false);
  assert.deepEqual(wrongProject.allowedTargetAssetIds, []);
  const proposal: GeoProposal = { id: 'P1', title: '改进', status: 'draft', rationale: '补充步骤', limitations: [],
    targetAssetId: external.id, targetUrl: external.publicUrl!, before: 'Record inputs before comparing results.',
    after: 'Record inputs and conditions before comparing results.', changes: ['明确条件'], evidencePaths: [], successCriteria: ['原题复测'] };
  const issues = validateProposal(proposal, scope(external), context);
  assert.ok(issues.some(issue => issue.detail.includes('外部参考')));
  const review = buildIndependentReviewInput(context, localDiagnosis(context), proposal, issues);
  assert.match(JSON.stringify(review), /外部参考/);
});

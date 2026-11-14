import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GeoAsset, GeoQuestion, GeoSeed } from './types';
import type { ResearchBatch, ResearchObservation, ResearchQuestion, ResearchSource } from './research-types';
import type { LegacyAnswerAudit } from './project-data';

// Synthetic records only. Tests must not depend on the developer's local projects.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-fixtures-'));
const localDirectory = path.join(root, 'local-projects');
fs.mkdirSync(localDirectory);
process.env.GEO_LOCAL_PROJECTS_DIR = localDirectory;
process.env.GEO_WORKSPACE = root;
process.env.DATA_DIR = root;
process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const reviewPath = 'fixtures/review.json';
const date = '2026-10-24';
const projectIds = ['sample-project', 'sample-project-two'];
const primaryAssets = ['troubleshooting-zh-CN', 'troubleshooting-en', 'comparison-zh-CN', 'comparison-en',
  'workflow-zh-CN', 'workflow-en', 'guide-zh-CN', 'guide-en', 'sample-study', 'site-home', 'sample-article', 'sample-quote'];
const secondaryAssets = ['sample-readme', 'sample-implementation'];
const competitorSources: ResearchSource[] = ['AlphaKit', 'BetaKit', 'GammaKit'].map(name => ({
  title: `GitHub - sample/${name}: Example tool`, url: `https://github.com/sample/${name}`, kind: 'other',
}));

function makeAsset(id: string, projectId: string): GeoAsset {
  const markdown = `# Synthetic ${id}\n\n## Scope\nThis fixture documents a sample workflow, its inputs, conditions and recorded results.\n\n## Steps\nRecord inputs before comparing results. This is a synthetic example, not a claim about an actual product.`;
  const asset = {
    id, title: `Synthetic ${id}`, type: 'documentation', language: id.endsWith('-en') ? 'en' : 'zh-CN',
    status: 'published', publishedAt: date, publicUrl: id === 'sample-article' ? 'https://social.example/@sample/article-1' : id === 'sample-implementation'
      ? `https://raw.githubusercontent.com/example/${projectId}/main/docs/implementation.md`
      : `https://example.com/${projectId}/${id}.html`,
    sourcePath: `fixtures/${projectId}/${id}.md`, summary: 'Synthetic documentation about recording inputs and checking results.',
    markdown, evidencePaths: [], reviewedCoverage: [] as unknown[],
  };
  const questionIds = id.startsWith('guide-') ? ['C02', 'C03', 'C04', 'C08']
    : id.startsWith('troubleshooting-') ? ['C05'] : id.startsWith('workflow-') ? ['C06']
      : id === 'sample-readme' ? ['R01', 'R02', 'R03', 'R04', 'R05']
        : id === 'sample-implementation' ? ['R02', 'R03', 'R04', 'R06'] : [];
  if (questionIds.length) asset.reviewedCoverage = [{ batchId: `${projectId}-${date}-live-search`, reviewPath,
    questionIds, source: 'Synthetic reviewed source', candidate: id.endsWith('-en') }];
  return asset;
}

function makeSeed(projectId: string, index: number): GeoSeed {
  const assets = (index ? secondaryAssets : primaryAssets).map(id => makeAsset(id, projectId));
  const questions: GeoQuestion[] = index ? [] : Array.from({ length: 14 }, (_, i) => {
    const brand = i < 4;
    const number = brand ? i + 1 : ((i - 4) % 5) + 1;
    const english = i >= 9;
    return { id: brand ? `l1-0${number}` : `l2-${english ? 'en' : 'zh'}0${number}`, tier: brand ? 'L1' : 'L2',
      language: english ? 'en' : 'zh-CN', query: brand ? `SampleProject official entry ${number}`
        : english ? `How can a sample workflow verify recorded result ${number}?` : `如何核对示例流程中第 ${number} 种记录结果？`,
      matchingAssetIds: [brand ? 'site-home' : 'guide-zh-CN'], resultCount: 0, projectHit: false,
      rank: null, aiCited: null, measurementAt: date, provider: 'Synthetic fixture', topSources: [], evidencePath: 'fixtures/history.json' };
  });
  const seed = {
    project: { id: projectId, name: index ? 'SampleProjectTwo' : 'SampleProject', description: 'A synthetic project for testing recorded workflows and evidence.',
      owner: 'example', identityExclusion: { url: 'https://research.example/papers/homonym', authors: ['Alice Writer', 'Bob Researcher'], reason: 'A synthetic unrelated namesake.' }, siteUrl: `https://example.com/${projectId}/`, repositoryUrl: `https://github.com/example/${projectId}`, asOf: date },
    assets, questions, observations: [], findings: [], gaps: [],
    proposal: { id: `${projectId}-proposal`, title: 'Synthetic proposal', status: 'unreviewed', rationale: 'Fixture only',
      targetAssetId: assets[0].id, targetUrl: assets[0].publicUrl!, before: assets[0].markdown, after: assets[0].markdown,
      changes: [], evidencePaths: [], successCriteria: [], limitations: ['Synthetic fixture only.'] },
    monitoringPlan: { queryIds: questions.map(q => q.id) }, boundaries: ['Synthetic fixture only.'],
    initialQuestionPlan: index ? undefined : {
      additions: [
        { id: 'positioning-01', query: '哪些工具能记录示例流程的输入和结果？', category: 'positioning', target: 'project', ids: ['site-home'], intent: '寻找能够记录流程证据的工具。' },
        { id: 'problem-01', query: '如何确认中断的示例流程可以继续？', category: 'problem', target: 'article', ids: ['workflow-zh-CN'], intent: '寻找中断后重新检查条件的方法。' },
        { id: 'content-01', query: '如何比较示例流程的两次结果记录？', category: 'content', target: 'article', ids: ['sample-study'], intent: '找到可核对的结果比较方法。' },
        { id: 'boundary-01', query: '开始示例流程前需要核对哪些输入？', category: 'boundary', target: 'article', ids: ['guide-zh-CN'], intent: '了解开始流程时需要核对的条件。' },
      ],
      reviews: Object.fromEntries(['l2-zh02', 'l2-en02', 'l2-zh04', 'l2-en04'].map(id => [id, {
        category: id.endsWith('02') ? 'comparison' : 'content', selected: false, decision: 'explore', reason: '合成样例只提供方法，尚未验证实际效果。',
      }])),
    },
  };
  return seed as GeoSeed;
}

export const seeds = projectIds.map(makeSeed);
export const seedData = seeds[0];

function makeQuestion(id: string, projectId: string, deferred = false): ResearchQuestion {
  const question: ResearchQuestion = { id, zh: `如何核对示例流程 ${id} 的输入与结果？`,
    en: ['R01', 'R02'].includes(id) ? 'How can a documented example workflow help a team preserve its original requirements and compare observed results without changing the intended task?' : `How can I verify inputs and results for sample workflow ${id}?`,
    decision: deferred ? 'keep_and_fill' : 'search_now', valueReason: 'Synthetic requirement for testing.', evidenceBasis: 'inferred: synthetic fixture',
    answerability: 'Synthetic documentation offers partial support.', gaps: ['证据：需要核对示例条件。'],
    decisionReason: 'Keep the original synthetic requirement.', reviewPath, observations: [],
    diagnosis: { observed: 'Synthetic observation', hypothesis: 'Not an actual finding', nextStep: 'Verify fixture behavior' } };
  if (deferred) return question;
  for (const [engine, language] of [['chatgpt', 'zh'], ['chatgpt', 'en'], ['google', 'zh'], ['google', 'en']] as const) {
    const recordedAt = `${date}T${engine === 'chatgpt' ? '08' : '09'}:${language === 'zh' ? '00' : '01'}:00Z`;
    const evidencePath = `fixtures/${projectId}/${id}-${engine}-${language}.md`;
    const sources = structuredClone(competitorSources);
    if (id === 'C01' || id === 'R01') sources.unshift({ title: 'SampleProject', url: `https://github.com/example/${projectId}`, kind: 'official' });
    if (engine === 'google') sources.forEach((source, index) => { source.position = index + 1; });
    if (id === 'R04' && engine === 'google' && language === 'en') {
      while (sources.length < 8) sources.push({ title: `Synthetic result ${sources.length}`, url: `https://result${sources.length}.example/`, kind: 'other', position: sources.length + 1 });
      sources.push({ title: 'Overview-only reference', url: 'https://www.reddit.com/r/LoLeventVoDs/', kind: 'other' });
    }
    const observation: ResearchObservation = { engine, language, query: question[language], recordedAt,
      status: id.endsWith('01') ? 'found' : 'not_observed', summary: 'Synthetic saved observation.', conditions: 'Offline synthetic fixture; no external measurement.',
      sources, evidencePath, ...(engine === 'chatgpt' ? { answerPath: evidencePath, entryType: 'web_answer' as const } : {}) };
    question.observations.push(observation);
    const body = `Synthetic workflow check: record the input and verify the result. Compare AlphaKit, BetaKit and GammaKit. ${id.endsWith('01') ? 'SampleProject is an example project.' : ''}`;
    const target = path.join(root, evidencePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `# Synthetic saved response\n- Question: ${question[language]}\n\n## Answer text\n${body}\n\n## Body citations\n${sources.map(source => `- ${source.title} — ${source.url}`).join('\n')}\n`);
  }
  return question;
}

export const initialResearch: ResearchBatch[] = projectIds.map((projectId, index) => ({
  id: `${projectId}-${date}-live-search`, date, projectId, productSummary: 'Synthetic project description.',
  contributionSummary: 'Synthetic documentation.', scopeNote: 'Offline fixtures only.', reportPath: 'fixtures/report.md', sourceAuditPath: 'fixtures/audit.md', reviewPath,
  questions: Array.from({ length: index ? 5 : 8 }, (_, i) => makeQuestion(`${index ? 'R' : 'C'}0${i + 1}`, projectId)),
  deferredQuestions: index ? [makeQuestion('R06', projectId, true)] : [], nextStep: 'No external actions.',
}));

export const legacyAudit: LegacyAnswerAudit = { reviewedAt: '2026-10-25T00:00:00Z', scope: { limits: 'Synthetic review fixture only.' },
  records: initialResearch.flatMap(batch => batch.questions.flatMap((question, index) => question.observations.filter(o => o.engine === 'chatgpt').map(o => ({
    projectId: batch.projectId, batchId: batch.id, questionId: question.id, engine: o.engine, language: o.language,
    recordedAt: o.recordedAt, evidencePath: o.evidencePath, answerComplete: true, citationCoverage: index === 0 ? 'partial' as const : 'complete' as const,
    mention: index === 0 ? 'yes' as const : 'no' as const,
    citation: index === 0 ? 'yes' as const : o.language === 'zh' && index > 1 ? 'unknown' as const : 'no' as const,
    mentionEvidence: 'Synthetic answer review.', citationEvidence: 'Synthetic citation review.',
    officialUrls: index === 0 ? [`https://github.com/example/${batch.projectId}`] : [], limitations: ['Offline fixture.'],
  })))) };

for (const seed of seeds) fs.writeFileSync(path.join(localDirectory, `${seed.project.id}.json`), JSON.stringify(seed));
fs.writeFileSync(path.join(localDirectory, 'research.json'), JSON.stringify(initialResearch));
fs.writeFileSync(path.join(localDirectory, 'answer-audit.json'), JSON.stringify(legacyAudit));
fs.writeFileSync(path.join(localDirectory, 'projects.json'), JSON.stringify({ defaultProjectId: projectIds[0],
  projects: projectIds.map(id => ({ id, seedFile: `${id}.json` })), researchFile: 'research.json',
  answerAudit: { file: 'answer-audit.json', source: 'synthetic-fixture-audit' } }));

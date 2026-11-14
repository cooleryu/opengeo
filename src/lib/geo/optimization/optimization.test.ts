import '../test-fixtures';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { LLMTransport } from '../../agent-hub';
import { readAgentMeta, readAgentText } from '../agent-files';
import { ensureProjectRelationalData, withProjectDb } from '../db';
import { loadProjectSeed } from '../project-data';
import { deliverableWriterAgent } from './agents';
import {
  buildExternalMarkdown,
  buildExternalRichHtml,
  extractArticleTitle,
} from './external-export';
import {
  applyOptimizationDeliverables,
  buildOptimizationRunViewModel,
  OptimizationStateError,
  publishRepoDeliverablesToGitHub,
  runOptimizationRetest,
  startOptimizationRun,
  updateDeliverableRecord,
} from './index';

const previousDataDir = process.env.DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-optimization-'));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('runs full single-track lifecycle including reviewing -> veto -> drafting revision -> awaiting_approval -> apply -> retest', async () => {
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);
  const ownedSiteUrl = loadProjectSeed(projectId).project.siteUrl;

  const activeQuestion = withProjectDb(projectId, (db, id) =>
    db
      .prepare("SELECT id, query_zh FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order LIMIT 1")
      .get(id) as { id: string; query_zh: string },
  );

  const observedStatuses: string[] = [];
  let reviewCalls = 0;
  let writerCalls = 0;

  const scriptedTransport: LLMTransport = {
    provider: 'test',
    async complete(req) {
      const sys = req.messages[0]?.content ?? '';
      let content = '{}';

      if (sys.includes('策略官')) {
        content = JSON.stringify({
          summary: '站在想推广自己产品的读者视角，优先写一篇手把手排查与改稿的实操指南，帮读者看清现状并自然带出工具。',
          deliverables: [
            {
              priority: 1,
              kind: 'new_content',
              format: 'rich_markdown',
              title: '如何排查品牌在 AI 搜索中的真实曝光与引用',
              targetAssetId: null,
              destination: '技术博客 / 社区专栏',
              audienceAndGoal: '面向独立开发者与产品团队，讲清真实搜索核对方法并自然引入产品。',
              questionIds: [activeQuestion.id],
              writingBrief: '结合真实搜索盲区与结构化对比表讲透核对步骤。',
            },
          ],
        });
      } else if (sys.includes('技术产品主笔')) {
        writerCalls += 1;
        content = JSON.stringify({
          title: '如何排查品牌在 AI 搜索中的真实曝光与引用',
          afterContent: [
            '# 如何排查品牌在 AI 搜索中的真实曝光与引用',
            '',
            '很多人用自己登录过的聊天账号搜产品名，看到被顺嘴提了一句就以为有自然曝光，换陌生视角一测才发现真实推荐为零。',
            '',
            '| 排查方式 | 能否区分提及与原生引用 | 能否按原问题复测对比 |',
            '| --- | --- | --- |',
            '| 手工零散提问 | 依赖人工肉眼翻找 | 缺少统一留档 |',
            '| 结构化留档核对 | 分开统计提及与自有引用 | 支持同条件前后对比 |',
            '',
            '```mermaid',
            'flowchart LR',
            '  A["真实提问留档"] --> B["语义核对提及与引用"] --> C["针对缺口改稿复测"]',
            '```',
            '',
            writerCalls === 1 ? '初稿版本段落。' : '修订后更精炼、无任何冗余公文腔的成稿段落。',
          ].join('\n'),
          mediaManifest: [
            { type: 'table', pathOrTitle: '排查方式能力对照表', caption: '客观对比手工排查与结构化留档核对' },
            { type: 'mermaid', pathOrTitle: '闭环流程图', caption: '从真实提问留档到复测的完整闭环' },
          ],
        });
      } else if (sys.includes('成稿守门人')) {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          content = JSON.stringify({
            verdict: 'veto',
            summary: '可读性红线需微调：结尾段落略显生硬，请精炼收尾表述。',
            checks: {
              authenticity: { passed: true, note: '无虚构功能与假案例。' },
              compliance: { passed: true, note: '对比表格客观克制。' },
              readability: { passed: false, note: '结尾可更精炼自然。' },
            },
            revisionInstructions: ['将结尾段落精炼为自然直白的读者表达。'],
          });
        } else {
          content = JSON.stringify({
            verdict: 'pass',
            summary: '真实性、合规边界与人类可读性三条红线全部通过。',
            checks: {
              authenticity: { passed: true, note: '事实完全准确。' },
              compliance: { passed: true, note: '边界清晰合规。' },
              readability: { passed: true, note: '开篇直击痛点，图表清晰。' },
            },
            revisionInstructions: [],
          });
        }
      } else if (sys.includes('阅卷官')) {
        content = JSON.stringify({
          identity: 'matched',
          mention: 'yes',
          citation: 'yes',
          mentionQuote: 'Example Project 提供了逐条核对 AI 搜索回答与引用的能力',
          mentionEvidence: '回答明确识别并介绍了目标项目。',
          citationEvidence: '原生引用包含项目官网地址。',
          officialUrls: [ownedSiteUrl],
        });
      }

      return { message: { role: 'assistant', content }, model: 'mock-v4-pro', latencyMs: 5 };
    },
  };

  const run = await startOptimizationRun(projectId, {
    mode: 'focus',
    targetLanguage: 'zh',
    transport: scriptedTransport,
    onProgress: (_step, status) => observedStatuses.push(status),
  });

  // Confirm it went planning -> drafting -> reviewing -> drafting (revision 1) -> reviewing -> awaiting_approval
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(writerCalls, 2);
  assert.equal(reviewCalls, 2);
  assert.ok(observedStatuses.includes('planning'));
  assert.ok(observedStatuses.includes('drafting'));
  assert.ok(observedStatuses.includes('reviewing'));
  assert.equal(run.deliverables.length, 1);
  assert.equal(run.deliverables[0].status, 'ready');
  assert.equal(run.deliverables[0].review?.verdict, 'pass');
  assert.equal(run.deliverables[0].review?.revisionRound, 1);

  // Guardrail: cannot run retest BEFORE user explicitly confirms/applies deliverable
  await assert.rejects(
    () =>
      runOptimizationRetest(projectId, run.id, {
        transport: scriptedTransport,
        capturedAnswers: [{ questionId: activeQuestion.id, engine: 'chatgpt', answerText: 'test' }],
      }),
    OptimizationStateError,
  );

  // User confirms external publish -> transitions to awaiting_retest
  const appliedRun = applyOptimizationDeliverables(projectId, run.id, [
    {
      deliverableId: run.deliverables[0].id,
      action: 'apply',
      publishedUrl: 'https://blog.example.org/ai-search-guide',
      note: '已发布至技术专栏',
    },
  ]);
  assert.equal(appliedRun.status, 'awaiting_retest');
  assert.equal(appliedRun.deliverables[0].status, 'applied');

  // Same-question retest -> transitions through remeasuring -> completed and computes before/after comparison
  const completedRun = await runOptimizationRetest(projectId, run.id, {
    transport: scriptedTransport,
    capturedAnswers: [
      {
        questionId: activeQuestion.id,
        engine: 'chatgpt',
        answerText: '在排查工具中，Example Project 提供了逐条核对 AI 搜索回答与引用的能力。',
        citationSource: 'native',
        citationsComplete: true,
        citations: [{ title: 'Example Docs', url: ownedSiteUrl }],
      },
    ],
  });

  assert.equal(completedRun.status, 'completed');
  const vm = buildOptimizationRunViewModel(projectId, completedRun.id);
  assert.equal(vm.primaryAction.kind, 'view_result');
  assert.equal(vm.retestComparison?.comparedCount, 1);
  assert.equal(vm.retestComparison?.afterMentionYes, 1);
  assert.equal(vm.retestComparison?.afterCitationYes, 1);
});

test('supports deep multi-deliverable partial adoption and immediate retest before deciding remaining pieces', async () => {
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);
  const ownedSiteUrl = loadProjectSeed(projectId).project.siteUrl;

  const activeQuestions = withProjectDb(projectId, (db, id) =>
    db
      .prepare("SELECT id, query_zh FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order LIMIT 2")
      .all(id) as Array<{ id: string; query_zh: string }>,
  );

  let writerCount = 0;
  const multiTransport: LLMTransport = {
    provider: 'test',
    async complete(req) {
      const sys = req.messages[0]?.content ?? '';
      let content = '{}';

      if (sys.includes('策略官')) {
        content = JSON.stringify({
          summary: '你的产品在多道客户问题里尚未被提到，建议先从工作方式说明和实战文章两处补齐公开内容，可逐篇按需采用。',
          deliverables: [
            {
              priority: 1,
              kind: 'new_content',
              format: 'rich_markdown',
              title: '工作方式与常见方案选型说明',
              targetAssetId: null,
              destination: 'docs/how-it-works.md',
              audienceAndGoal: '帮团队看懂不同跟踪方式的差别，面向评估工具的产品负责人。',
              questionIds: [activeQuestions[0].id],
              writingBrief: '用平实大白话讲清完整排查与复测闭环，并附上客观克制的方案对比表。',
            },
            {
              priority: 2,
              kind: 'new_content',
              format: 'rich_markdown',
              title: '初次排查品牌 AI 搜索表现的四步方法',
              targetAssetId: null,
              destination: 'docs/blog/first-audit-guide.md',
              audienceAndGoal: '给想要提升曝光的团队一套可直接上手的步骤，面向首次尝试的用户。',
              questionIds: [activeQuestions[1]?.id ?? activeQuestions[0].id],
              writingBrief: '站在读者推广自身产品的视角写出四步实操流程与可照抄检查表。',
            },
          ],
        });
      } else if (sys.includes('技术产品主笔')) {
        writerCount += 1;
        const isGuide = writerCount === 1;
        content = JSON.stringify({
          title: isGuide ? '工作方式与常见方案选型说明' : '初次排查品牌 AI 搜索表现的四步方法',
          afterContent: [
            `# ${isGuide ? '工作方式与常见方案选型说明' : '初次排查品牌 AI 搜索表现的四步方法'}`,
            '',
            '先用客户真实问题检查各平台回答与参考链接，再决定怎么改写公开页面。',
            '',
            '相比只看一眼综合分或自己零散记录，把完整回答原文、参考网页以及竞品表现放在一起对照，才能一眼看清到底是别人完全没提到你，还是只提了名字却没附上官网链接。',
            '',
            '| 方式 | 数据透明度 | 适用场景 |',
            '| --- | --- | --- |',
            '| 手工记录 | 原文需手动整理 | 偶尔抽查 |',
            '| 本地开源工作台 | 保存完整回答与引用 | 持续跟踪与改稿复测 |',
            '',
            '```mermaid',
            'flowchart LR',
            '  A["选定客户真问题"] --> B["查清回答与引用"] --> C["按需发布并复测"]',
            '```',
          ].join('\n'),
          mediaManifest: [
            { type: 'table', pathOrTitle: '方案对比表', caption: '客观对比不同排查方式' },
            { type: 'mermaid', pathOrTitle: '流程图', caption: '完整闭环示意图' },
          ],
        });
      } else if (sys.includes('成稿守门人')) {
        content = JSON.stringify({
          verdict: 'pass',
          summary: '三条红线全部通过。',
          checks: {
            authenticity: { passed: true, note: '事实准确。' },
            compliance: { passed: true, note: '表述客观克制。' },
            readability: { passed: true, note: '读者视角清晰。' },
          },
          revisionInstructions: [],
        });
      } else if (sys.includes('阅卷官')) {
        content = JSON.stringify({
          identity: 'matched',
          mention: 'yes',
          citation: 'yes',
          mentionQuote: 'Example Project 支持完整问答记录核对',
          mentionEvidence: '明确提及目标品牌。',
          citationEvidence: '引用了官网网址。',
          officialUrls: [ownedSiteUrl],
        });
      }

      return { message: { role: 'assistant', content }, model: 'mock-flash', latencyMs: 5 };
    },
  };

  const run = await startOptimizationRun(projectId, { targetLanguage: 'zh', transport: multiTransport });
  assert.equal(run.mode, 'deep');
  assert.equal(run.status, 'awaiting_approval', run.errorMessage ?? undefined);
  assert.equal(run.deliverables.length, 2);

  // Adopt ONLY Piece 1 while leaving Piece 2 untouched in 'ready'
  const partialRun = applyOptimizationDeliverables(projectId, run.id, [
    {
      deliverableId: run.deliverables[0].id,
      action: 'apply',
      writeLocalFile: false,
      publishedUrl: 'https://example.org/how-it-works',
    },
  ]);
  assert.equal(partialRun.status, 'awaiting_approval');
  assert.equal(partialRun.deliverables[0].status, 'applied');
  assert.equal(partialRun.deliverables[1].status, 'ready');

  // Immediately run retest on Piece 1 without being forced to adopt/skip Piece 2 first
  const retestedPartial = await runOptimizationRetest(projectId, run.id, {
    transport: multiTransport,
    capturedAnswers: [
      {
        questionId: activeQuestions[0].id,
        engine: 'chatgpt',
        answerText: 'Example Project 支持完整问答记录核对。',
        citationSource: 'native',
        citationsComplete: true,
        citations: [{ title: 'How It Works', url: ownedSiteUrl }],
      },
    ],
  });
  assert.equal(retestedPartial.status, 'completed');

  // User can still decide to skip Piece 2 afterwards
  const finalRun = applyOptimizationDeliverables(projectId, run.id, [
    { deliverableId: run.deliverables[1].id, action: 'skip' },
  ]);
  assert.equal(finalRun.status, 'awaiting_retest');
  assert.equal(finalRun.deliverables[1].status, 'skipped');
});

test('loads modular YAML skill metadata and routes writer archetypes per deliverable role', () => {
  const meta = readAgentMeta('improvement-planning', 'open-source-repo/readme.md');
  assert.equal(meta.tab, '改进与追踪');
  assert.equal(meta.scenario, 'open-source-repo');
  assert.equal(meta.role, 'writer');

  const body = readAgentText('improvement-planning', 'open-source-repo/readme.md');
  assert.ok(!body.startsWith('---'));
  assert.ok(body.includes('OpenGEO 适合你吗'));

  const readmePrompt = deliverableWriterAgent.buildPrompt(
    {
      deliverable: {
        priority: 1,
        kind: 'update_asset',
        format: 'rich_markdown',
        title: 'OpenGEO 主页介绍改写',
        targetAssetId: 'sample-project-asset-1',
        destination: 'README.md',
        audienceAndGoal: '帮访客看清产品定位。面向仓库新访客。',
        questionIds: ['q1'],
        writingBrief: '改写门面。',
      },
      targetQuestions: [{ id: 'q1', queryZh: 'Sample Project 是什么', queryEn: 'What is Sample Project' }],
      beforeContent: '# Sample',
    },
    { projectId: 'sample-project' },
  );
  assert.ok(readmePrompt.system.includes('开源代码仓库 GitHub README 门面改写'));

  const quickstartPrompt = deliverableWriterAgent.buildPrompt(
    {
      deliverable: {
        priority: 2,
        kind: 'new_content',
        format: 'rich_markdown',
        title: '快速上手',
        targetAssetId: null,
        destination: 'docs/getting-started.md',
        audienceAndGoal: '带新手走通三步。',
        questionIds: ['q1'],
        writingBrief: '写快速上手。',
      },
      targetQuestions: [{ id: 'q1', queryZh: 'Sample Project 怎么用', queryEn: 'How to use Sample Project' }],
      beforeContent: '',
    },
    { projectId: 'sample-project' },
  );
  assert.ok(quickstartPrompt.system.includes('快速上手文档（`docs/getting-started.md`）'));

  const articlePrompt = deliverableWriterAgent.buildPrompt(
    {
      deliverable: {
        priority: 3,
        kind: 'new_content',
        format: 'rich_markdown',
        title: '实操文章',
        targetAssetId: null,
        destination: 'docs/blog/guide.md',
        audienceAndGoal: '给外部潜客实操指南。',
        questionIds: ['q1'],
        writingBrief: '写公开获客文章。',
      },
      targetQuestions: [{ id: 'q1', queryZh: '怎么做曝光', queryEn: 'How to get visibility' }],
      beforeContent: '',
    },
    { projectId: 'sample-project' },
  );
  assert.ok(articlePrompt.system.includes('对外公开获客实操长文'));

  const hallucinationErr = deliverableWriterAgent.validate?.(
    {
      title: '快速上手',
      afterContent: [
        '# 快速上手',
        '',
        '### 第一次要准备几道题？',
        '准备 10~15 道题，包含一个对比表：',
        '',
        '| 列1 | 列2 |',
        '| --- | --- |',
        '| A | B |',
      ].join('\n'),
      mediaManifest: [{ type: 'table', pathOrTitle: '对比表', caption: '说明' }],
    },
    {
      deliverable: {
        priority: 2,
        kind: 'new_content',
        format: 'rich_markdown',
        title: '快速上手',
        targetAssetId: null,
        destination: 'docs/getting-started.md',
        audienceAndGoal: '带新手走通三步。',
        questionIds: ['q1'],
        writingBrief: '写快速上手。',
      },
      targetQuestions: [{ id: 'q1', queryZh: '怎么用', queryEn: 'How to use' }],
      beforeContent: '',
    },
    { projectId: 'sample-project' },
  );
  assert.ok(hallucinationErr && hallucinationErr.includes('最多 8 道核心监测问题'));
});

test('publishes adopted bilingual repo deliverables to a bare git remote and cleans up legacy README.en.md', async () => {
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);

  const activeQuestion = withProjectDb(projectId, (db, id) =>
    db
      .prepare("SELECT id FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order LIMIT 1")
      .get(id) as { id: string },
  );

  const bareDir = path.join(tempDir, 'remote.git');
  const seedRepoDir = path.join(tempDir, 'seed-clone');
  const verifyCloneDir = path.join(tempDir, 'verify-clone');
  execFileSync('git', ['init', '--bare', '-b', 'main', bareDir]);
  execFileSync('git', ['clone', bareDir, seedRepoDir]);
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: seedRepoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seedRepoDir });
  fs.writeFileSync(path.join(seedRepoDir, 'README.md'), '# Old\n', 'utf8');
  fs.writeFileSync(path.join(seedRepoDir, 'README.en.md'), '# Old English\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: seedRepoDir });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: seedRepoDir });
  execFileSync('git', ['push', 'origin', 'main'], { cwd: seedRepoDir });

  const mockTransport: LLMTransport = {
    provider: 'test',
    async complete(req) {
      const sys = req.messages[0]?.content ?? '';
      let content = '{}';
      if (sys.includes('策略官')) {
        content = JSON.stringify({
          summary: '补充开源仓库英文默认主页与中文配套页面，便于海外与国内用户及 AI 检索识别。',
          deliverables: [
            {
              priority: 1,
              kind: 'new_content',
              format: 'rich_markdown',
              title: 'Quick Start Documentation',
              targetAssetId: null,
              destination: 'docs/getting-started.md',
              audienceAndGoal: '面向新访客的快速上手与选型指南，帮助评估 AI 搜索可见性工作台。',
              questionIds: [activeQuestion.id],
              writingBrief: '用清晰简练的步骤说明产品定位、提问核对与对照表用法，避免堆砌命令行劝退新手。',
            },
          ],
        });
      } else if (sys.includes('技术产品主笔')) {
        content = JSON.stringify({
          title: 'Quick Start Documentation',
          afterContent: [
            '# Quick Start Documentation',
            '',
            'Understand how the product checks AI search answers and citations across multiple engines without black-box scores.',
            '',
            'Start by preparing up to 8 core customer questions, inspect every cited link and answer verbatim, and update only the documentation pages where gaps actually exist.',
            '',
            '| Step | Action | Output |',
            '| --- | --- | --- |',
            '| 1 | Add URL | Up to 8 core questions |',
            '| 2 | Review Answers | Verbatim quotes & citations |',
            '| 3 | Publish Docs | Re-test after indexing |',
          ].join('\n'),
          mediaManifest: [{ type: 'table', pathOrTitle: 'Steps', caption: 'Quick overview' }],
        });
      } else if (sys.includes('成稿守门人')) {
        content = JSON.stringify({
          verdict: 'pass',
          summary: 'Passed all three checks.',
          checks: {
            authenticity: { passed: true, note: 'Accurate.' },
            compliance: { passed: true, note: 'Objective.' },
            readability: { passed: true, note: 'Clear.' },
          },
          revisionInstructions: [],
        });
      }
      return { message: { role: 'assistant', content }, model: 'mock-flash', latencyMs: 5 };
    },
  };

  const run = await startOptimizationRun(projectId, { transport: mockTransport });
  assert.equal(run.status, 'awaiting_approval', run.errorMessage ?? undefined);

  const delivId = run.deliverables[0].id;
  applyOptimizationDeliverables(projectId, run.id, [
    { deliverableId: delivId, action: 'apply', writeLocalFile: false },
  ]);

  updateDeliverableRecord(projectId, delivId, {
    destination: 'README.md',
    afterContent: '# English Homepage\n',
    companionFiles: [
      {
        path: 'README.zh-CN.md',
        label: '简体中文',
        lang: 'zh-CN',
        content: '# 简体中文首页\n',
        deletePaths: ['README.en.md'],
      },
    ],
  });

  const updated = publishRepoDeliverablesToGitHub(projectId, run.id, {
    remoteUrlOverride: bareDir,
    branchOverride: 'main',
  });

  const rec = updated.deliverables[0].appliedRecord;
  assert.equal(rec?.mode, 'github_pushed');
  assert.equal(rec?.branch, 'main');
  assert.ok(rec?.commitHash && rec.commitHash.length >= 6);
  assert.deepEqual(rec?.pushedPaths, ['README.md', 'README.zh-CN.md']);

  execFileSync('git', ['clone', '--branch', 'main', bareDir, verifyCloneDir]);
  assert.equal(fs.readFileSync(path.join(verifyCloneDir, 'README.md'), 'utf8'), '# English Homepage\n');
  assert.equal(fs.readFileSync(path.join(verifyCloneDir, 'README.zh-CN.md'), 'utf8'), '# 简体中文首页\n');
  assert.equal(fs.existsSync(path.join(verifyCloneDir, 'README.en.md')), false);
});

test('persists referenceWinners on deliverables and blocks Chinese screenshots or AI-slop in English drafts', async () => {
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);

  const activeQuestion = withProjectDb(projectId, (db, id) =>
    db
      .prepare("SELECT id FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order LIMIT 1")
      .get(id) as { id: string },
  );

  // Unit-check English deliverable validator directly
  const baseWriterInput = {
    deliverable: {
      priority: 1,
      kind: 'new_content' as const,
      format: 'rich_markdown' as const,
      title: 'How to Check AI Citations',
      targetAssetId: null,
      destination: 'docs/blog/ai-citations.md',
      audienceAndGoal: 'Developers shipping AI coding tools.',
      questionIds: [activeQuestion.id],
      writingBrief: 'Lead with competitor replacement anxiety and comparison table.',
    },
    targetQuestions: [{ id: activeQuestion.id, queryZh: '', queryEn: 'How to check AI citations?' }],
    beforeContent: '',
    targetLanguage: 'en' as const,
  };

  assert.match(
    deliverableWriterAgent.validate?.(
      {
        title: 'How to Check AI Citations',
        afterContent:
          'When buyers ask ChatGPT, rivals show up.\n\n![Overview](docs/images/overview.png)\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n' +
          'x'.repeat(200),
        mediaManifest: [{ type: 'table', pathOrTitle: 'Comparison', caption: 'Tool table' }],
      },
      baseWriterInput,
      { projectId },
    ) ?? '',
    /中文界面截图/,
  );

  assert.match(
    deliverableWriterAgent.validate?.(
      {
        title: 'How to Check AI Citations',
        afterContent:
          'Let us delve into why this game-changer matters.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n' +
          'x'.repeat(200),
        mediaManifest: [{ type: 'table', pathOrTitle: 'Comparison', caption: 'Tool table' }],
      },
      baseWriterInput,
      { projectId },
    ) ?? '',
    /AI-slop/,
  );

  const mockTransport: LLMTransport = {
    provider: 'test',
    async complete(req) {
      const sys = req.messages[0]?.content ?? '';
      if (sys.includes('策略官')) {
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              summary: 'Focus on AI citation blind spots with an external English guide.',
              deliverables: [baseWriterInput.deliverable],
            }),
          },
          model: 'mock-flash',
          latencyMs: 5,
        };
      }
      if (sys.includes('技术产品主笔')) {
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              title: 'How to Audit ChatGPT & Google AI Citations Before Rivals Take Your Spot',
              afterContent: [
                '# How to Audit ChatGPT & Google AI Citations',
                '',
                'When developers ask ChatGPT for tool recommendations, it usually picks two or three rivals and links directly to their guides.',
                'Meanwhile, your repo sits invisible while competitors answer buyer questions in your category every day.',
                'Here is a practical three-step checklist to inspect AI answers, find cited competitor pages, and close the gap.',
                '',
                '| Approach | Separates Mention vs Citation | Reproducible Retest |',
                '| --- | --- | --- |',
                '| Manual ad-hoc prompts | Manual reading only | Hard to repeat |',
                '| OpenGEO local audit | Distinct mention & URL checks | Saved prompt batch |',
              ].join('\n'),
              mediaManifest: [
                { type: 'table', pathOrTitle: 'Audit Comparison', caption: 'Manual prompts vs OpenGEO local audit' },
              ],
            }),
          },
          model: 'mock-flash',
          latencyMs: 5,
        };
      }
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            verdict: 'pass',
            summary: 'All three checks passed.',
            checks: {
              authenticity: { passed: true, note: 'Accurate.' },
              compliance: { passed: true, note: 'Objective.' },
              readability: { passed: true, note: 'Clear English prose.' },
            },
            revisionInstructions: [],
          }),
        },
        model: 'mock-flash',
        latencyMs: 5,
      };
    },
  };

  const run = await startOptimizationRun(projectId, {
    mode: 'focus',
    transport: mockTransport,
    probeWinners: async () => [
      {
        url: 'https://peec.ai/pricing',
        domain: 'peec.ai',
        title: 'Peec AI Pricing',
        citedEngines: ['chatgpt'],
        citedQuestionCount: 2,
        probeStatus: 'full_read',
        headings: ['Which plan fits small teams?'],
        openingParagraphs: ['Track your brand citations across ChatGPT and Google AI answers.'],
        localSnippet: 'Peec AI tracks brand visibility across AI search.',
        probedAt: new Date().toISOString(),
      },
    ],
  });

  assert.equal(run.status, 'awaiting_approval', run.errorMessage ?? undefined);
  assert.equal(run.deliverables[0].referenceWinners?.length, 1);
  assert.equal(run.deliverables[0].referenceWinners?.[0].domain, 'peec.ai');
});

test('extractCenteredHeroBlock preserves README logo and publishRepoDeliverablesToGitHub copies missing local assets', async () => {
  // Verify extractCenteredHeroBlock from DeliverableArticleView preserves <img src="docs/images/opengeo-logo.png">
  const ts = await import('typescript');
  const { createRequire } = await import('node:module');
  const vm = await import('node:vm');
  const componentPath = path.join(process.cwd(), 'src/components/geo/DeliverableArticleView.tsx');
  const transpiled = ts.default.transpileModule(fs.readFileSync(componentPath, 'utf8'), {
    compilerOptions: {
      module: ts.default.ModuleKind.CommonJS,
      jsx: ts.default.JsxEmit.React,
      target: ts.default.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const localMod: { exports: Record<string, unknown> } = { exports: {} };
  const realReq = createRequire(componentPath);
  const customReq = (specifier: string) => {
    if (specifier.endsWith('.css')) return {};
    if (specifier === './UiLanguageContext') return { useUiLanguage: () => ({ uiLanguage: 'zh', t: (k: string) => k }) };
    if (specifier.startsWith('@/')) {
      return realReq(path.join(process.cwd(), 'src', `${specifier.slice(2)}.ts`));
    }
    return realReq(specifier);
  };
  vm.runInNewContext(
    `(function(exports, require, module, __filename, __dirname) {\n${transpiled.outputText}\n})`,
    { process, console, Buffer, URL, URLSearchParams, Intl },
  )(localMod.exports, customReq, localMod, componentPath, path.dirname(componentPath));

  const extractCenteredHeroBlock = localMod.exports.extractCenteredHeroBlock as (md: string) => {
    hero: { logo?: { src: string; alt: string; width?: number; height?: number }; title: string; tagline: string } | null;
    restMarkdown: string;
  };
  const extracted = extractCenteredHeroBlock([
    '<div align="center">',
    '<p align="center"><img src="docs/images/opengeo-logo.png" width="80" height="80" alt="OpenGEO" /></p>',
    '# OpenGEO',
    '### Local-first AI search visibility workbench.',
    '</div>',
    '',
    'Body paragraph.',
  ].join('\n'));
  assert.deepEqual(
    extracted.hero?.logo ? { ...extracted.hero.logo } : null,
    {
      src: 'docs/images/opengeo-logo.png',
      alt: 'OpenGEO',
      width: 80,
      height: 80,
    },
  );
  assert.equal(extracted.hero?.title, 'OpenGEO');
  assert.equal(extracted.restMarkdown, 'Body paragraph.');

  // Verify publishRepoDeliverablesToGitHub copies missing referenced local logo + bilingual README
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-gh-assets-'));
  try {
    const bareDir = path.join(gitRoot, 'remote.git');
    const seedDir = path.join(gitRoot, 'seed');
    const localAssetsDir = path.join(gitRoot, 'local-assets');
    const verifyDir = path.join(gitRoot, 'verify');

    execFileSync('git', ['init', '--bare', bareDir]);
    execFileSync('git', ['clone', bareDir, seedDir]);
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: seedDir });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: seedDir });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: seedDir });
    fs.mkdirSync(path.join(seedDir, 'docs/images'), { recursive: true });
    fs.mkdirSync(path.join(seedDir, 'docs/API'), { recursive: true });
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# Old\n', 'utf8');
    fs.writeFileSync(path.join(seedDir, 'docs/images/overview.png'), Buffer.from('old-png'));
    fs.writeFileSync(path.join(seedDir, 'docs/API/SEARCH.md'), '# Remote API Search\n', 'utf8');
    execFileSync('git', ['add', 'README.md', 'docs/images/overview.png', 'docs/API/SEARCH.md'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: seedDir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedDir });

    // Local workspace holds new docs/images/opengeo-logo.png + README.zh-CN.md absent on origin/main,
    // an updated docs/images/overview.png that should replace the stale remote PNG,
    // and an uncommitted docs/API/SEARCH.md edit that must NOT overwrite the remote Markdown file.
    fs.mkdirSync(path.join(localAssetsDir, 'docs/images'), { recursive: true });
    fs.mkdirSync(path.join(localAssetsDir, 'docs/API'), { recursive: true });
    fs.writeFileSync(path.join(localAssetsDir, 'docs/images/opengeo-logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(localAssetsDir, 'docs/images/overview.png'), Buffer.from('new-png'));
    fs.writeFileSync(path.join(localAssetsDir, 'docs/API/SEARCH.md'), '# Modified Local API Search\n', 'utf8');
    fs.writeFileSync(
      path.join(localAssetsDir, 'README.zh-CN.md'),
      [
        '<p align="center"><img src="docs/images/opengeo-logo.png" width="80" height="80" alt="OpenGEO" /></p>',
        '# OpenGEO 中文',
        '![概览](docs/images/overview.png)',
        '详见 [检索协议](docs/API/SEARCH.md)',
        '',
      ].join('\n'),
      'utf8',
    );

    const mockTransport: LLMTransport = {
      provider: 'test',
      async complete(req) {
        const sys = req.messages[0]?.content ?? '';
        if (sys.includes('策略官')) {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: 'Improve README with brand logo.',
                deliverables: [
                  {
                    priority: 1,
                    kind: 'new_content',
                    format: 'rich_markdown',
                    title: 'Update README with Logo',
                    targetAssetId: null,
                    destination: 'README.md',
                    audienceAndGoal: 'Clarify positioning.',
                    questionIds: [
                      withProjectDb(projectId, (db, id) =>
                        (db.prepare("SELECT id FROM opengeo_questions WHERE project_id = ? AND status = 'active' LIMIT 1").get(id) as { id: string }).id,
                      ),
                    ],
                    writingBrief: 'Keep logo and zh-CN link.',
                  },
                ],
              }),
            },
            model: 'mock-flash',
            latencyMs: 5,
          };
        }
        if (sys.includes('技术产品主笔')) {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                title: 'Update README with Logo',
                afterContent: [
                  '<div align="center">',
                  '<img src="docs/images/opengeo-logo.png" width="80" height="80" alt="OpenGEO" />',
                  '# OpenGEO',
                  '### See how AI search answers for your product — then turn the gaps into better content.',
                  '</div>',
                  '',
                  '[简体中文](README.zh-CN.md)',
                  '',
                  'Run real customer buyer questions locally in ChatGPT and Google AI Overviews, inspect verbatim answers and cited sources separately, and improve the pages that miss your repository.',
                  '',
                  '| Tool | Local Browser Capture | Mention vs Citation |',
                  '| --- | --- | --- |',
                  '| Cloud monitor | Scheduled prompts | Combined score |',
                  '| OpenGEO | Real user browser | Separate mention and URL audit |',
                ].join('\n'),
                mediaManifest: [
                  { type: 'table', pathOrTitle: 'Tool Comparison', caption: 'Cloud monitor vs OpenGEO' },
                ],
              }),
            },
            model: 'mock-flash',
            latencyMs: 5,
          };
        }
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              verdict: 'pass',
              summary: 'Passed.',
              checks: {
                authenticity: { passed: true, note: 'Accurate.' },
                compliance: { passed: true, note: 'Objective.' },
                readability: { passed: true, note: 'Clear prose.' },
              },
              revisionInstructions: [],
            }),
          },
          model: 'mock-flash',
          latencyMs: 5,
        };
      },
    };

    const run = await startOptimizationRun(projectId, { mode: 'focus', targetLanguage: 'en', transport: mockTransport });
    assert.equal(run.status, 'awaiting_approval', run.errorMessage ?? undefined);
    const delivId = run.deliverables[0].id;
    applyOptimizationDeliverables(projectId, run.id, [{ deliverableId: delivId, action: 'apply', writeLocalFile: false }]);
    const pushed = publishRepoDeliverablesToGitHub(projectId, run.id, {
      remoteUrlOverride: bareDir,
      branchOverride: 'main',
      localAssetRootOverride: localAssetsDir,
    });
    const pushedPaths = pushed.deliverables[0].appliedRecord?.pushedPaths ?? [];
    assert.ok(pushedPaths.includes('README.md'));
    assert.ok(pushedPaths.includes('docs/images/opengeo-logo.png'));
    assert.ok(pushedPaths.includes('docs/images/overview.png'));
    assert.ok(pushedPaths.includes('README.zh-CN.md'));
    assert.ok(!pushedPaths.includes('docs/API/SEARCH.md'));

    execFileSync('git', ['clone', '--branch', 'main', bareDir, verifyDir]);
    assert.equal(fs.existsSync(path.join(verifyDir, 'docs/images/opengeo-logo.png')), true);
    assert.equal(fs.existsSync(path.join(verifyDir, 'README.zh-CN.md')), true);
    assert.equal(fs.readFileSync(path.join(verifyDir, 'docs/images/overview.png'), 'utf8'), 'new-png');
    assert.equal(fs.readFileSync(path.join(verifyDir, 'docs/API/SEARCH.md'), 'utf8'), '# Remote API Search\n');
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

test('validates English UI screenshots cleanly, generates Chinese companions with reviewOnly boundaries, and skips reviewOnly companions on GitHub push', async () => {
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);

  const activeQuestion = withProjectDb(projectId, (db, id) =>
    db
      .prepare("SELECT id FROM opengeo_questions WHERE project_id = ? AND status = 'active' ORDER BY sort_order LIMIT 1")
      .get(id) as { id: string },
  );

  // 1. Validate deliverableWriterAgent accepts overview-en.png and rejects overview.png in EN drafts
  const enWriterInput = {
    deliverable: {
      priority: 1,
      kind: 'update_asset' as const,
      format: 'rich_markdown' as const,
      title: 'Update README with live English UI screenshot',
      targetAssetId: null,
      destination: 'README.md',
      audienceAndGoal: 'Developers evaluating local-first AI search visibility tools.',
      questionIds: [activeQuestion.id],
      writingBrief: 'Open with clear positioning, embed overview-en.png, and include a tool comparison table.',
    },
    targetQuestions: [{ id: activeQuestion.id, queryZh: '', queryEn: 'How to audit AI search citations locally?' }],
    beforeContent: '',
    targetLanguage: 'en' as const,
  };

  assert.match(
    deliverableWriterAgent.validate?.(
      {
        title: 'Update README with live English UI screenshot',
        afterContent:
          'When users ask ChatGPT for local GEO tools, rivals win.\n\n![Overview](docs/images/overview.png)\n\n| Tool | Capture |\n| --- | --- |\n| Cloud | Scheduled |\n| OpenGEO | Local browser |\n' +
          'OpenGEO captures verbatim ChatGPT and Google AI Overview answers inside your browser session so maintainers can spot missing pages cleanly.',
        mediaManifest: [{ type: 'table', pathOrTitle: 'Comparison', caption: 'Tool comparison' }],
      },
      enWriterInput,
      { projectId },
    ) ?? '',
    /中文界面截图/,
  );

  assert.equal(
    deliverableWriterAgent.validate?.(
      {
        title: 'Update README with live English UI screenshot',
        afterContent:
          'When users ask ChatGPT for local GEO tools, rivals win.\n\n![Overview](docs/images/overview-en.png)\n\n| Tool | Capture |\n| --- | --- |\n| Cloud | Scheduled |\n| OpenGEO | Local browser |\n' +
          'OpenGEO captures verbatim ChatGPT and Google AI Overview answers inside your browser session so maintainers can spot missing pages cleanly.',
        mediaManifest: [
          { type: 'screenshot', pathOrTitle: 'docs/images/overview-en.png', caption: 'English Overview screen' },
          { type: 'table', pathOrTitle: 'Comparison', caption: 'Tool comparison' },
        ],
      },
      enWriterInput,
      { projectId },
    ),
    null,
  );

  // 2. Verify startOptimizationRun(..., { includeChineseCompanion: true }) attaches reviewOnly flags
  //    and publishRepoDeliverablesToGitHub pushes README.zh-CN.md but skips docs/blog/post.zh-CN.md
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-gh-zh-companion-'));
  try {
    const bareDir = path.join(gitRoot, 'remote.git');
    const seedDir = path.join(gitRoot, 'seed');
    const localAssetsDir = path.join(gitRoot, 'local-assets');
    const verifyDir = path.join(gitRoot, 'verify');

    execFileSync('git', ['init', '--bare', bareDir]);
    execFileSync('git', ['clone', bareDir, seedDir]);
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: seedDir });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: seedDir });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: seedDir });
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# Initial README\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: seedDir });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedDir });

    fs.mkdirSync(path.join(localAssetsDir, 'docs/images'), { recursive: true });
    fs.writeFileSync(path.join(localAssetsDir, 'docs/images/overview-en.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(localAssetsDir, 'docs/images/overview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    let companionCalls = 0;
    const mockTransport: LLMTransport = {
      provider: 'test',
      async complete(req) {
        const sys = req.messages[0]?.content ?? '';
        const usr = req.messages[1]?.content ?? '';
        if (sys.includes('策略官')) {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: 'Improve README and publish an external audit guide.',
                deliverables: [
                  {
                    priority: 1,
                    kind: 'new_content',
                    format: 'rich_markdown',
                    title: 'Update README with English overview',
                    targetAssetId: null,
                    destination: 'README.md',
                    audienceAndGoal: 'Developers comparing open-source GEO workbenches.',
                    questionIds: [activeQuestion.id],
                    writingBrief: 'Rewrite README front page with overview-en.png.',
                  },
                  {
                    priority: 2,
                    kind: 'new_content',
                    format: 'rich_markdown',
                    title: 'How to Audit AI Citations for Indie SaaS',
                    targetAssetId: null,
                    destination: 'docs/blog/post.md',
                    audienceAndGoal: 'Indie founders publishing practical audit workflows.',
                    questionIds: [activeQuestion.id],
                    writingBrief: 'Write external audit post with ../images/overview-en.png.',
                  },
                ],
              }),
            },
            model: 'mock-flash',
            latencyMs: 5,
          };
        }
        if (sys.includes('双语产品编辑')) {
          companionCalls += 1;
          const isBlog = usr.includes('docs/blog/post.zh-CN.md');
          const imgPath = isBlog ? '../images/overview.png' : 'docs/images/overview.png';
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                content: isBlog
                  ? `# 独立产品的 AI 搜索引用审计实操指南\n\n当潜在客户向 ChatGPT 提问时，模型只会从读得懂的页面里选引用来源。\n\n![OpenGEO 概览截图](${imgPath})\n\n把真实问法放进本地工作台对照前后记录，再逐篇改写缺失的关键页面。`
                  : `# OpenGEO 中文首页\n\n[English](README.md)\n\n开源、本地运行的 AI 搜索可见性工作台，在你自己的浏览器会话里保存真实回答与引用来源。\n\n![OpenGEO 概览页](${imgPath})`,
              }),
            },
            model: 'mock-flash',
            latencyMs: 5,
          };
        }
        if (sys.includes('技术产品主笔')) {
          const isBlog = usr.includes('docs/blog/post.md');
          const imgPath = isBlog ? '../images/overview-en.png' : 'docs/images/overview-en.png';
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                title: isBlog ? 'How to Audit AI Citations for Indie SaaS' : 'Update README with English overview',
                afterContent: [
                  isBlog ? '# How to Audit AI Citations for Indie SaaS' : '# OpenGEO',
                  '',
                  isBlog
                    ? 'When potential buyers ask ChatGPT for local AI visibility tools, only legible documentation gets cited.'
                    : '[简体中文](README.zh-CN.md)\n\nOpenGEO captures real ChatGPT and Google AI Overview answers inside your own browser session and audits citations locally.',
                  '',
                  `![Overview](${imgPath})`,
                  '',
                  '| Tool | Capture Method | Data Location |',
                  '| --- | --- | --- |',
                  '| Hosted monitor | Scheduled cloud queries | Vendor servers |',
                  '| OpenGEO | Real user browser session | Local disk on your machine |',
                ].join('\n'),
                mediaManifest: [
                  { type: 'screenshot', pathOrTitle: imgPath, caption: 'Live Overview screen' },
                  { type: 'table', pathOrTitle: 'Comparison', caption: 'Hosted vs OpenGEO' },
                ],
              }),
            },
            model: 'mock-flash',
            latencyMs: 5,
          };
        }
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              verdict: 'pass',
              summary: 'All checks passed.',
              checks: {
                authenticity: { passed: true, note: 'Accurate.' },
                compliance: { passed: true, note: 'Objective.' },
                readability: { passed: true, note: 'Clear prose.' },
              },
              revisionInstructions: [],
            }),
          },
          model: 'mock-flash',
          latencyMs: 5,
        };
      },
    };

    const run = await startOptimizationRun(projectId, {
      mode: 'deep',
      targetLanguage: 'en',
      includeChineseCompanion: true,
      transport: mockTransport,
    });

    assert.equal(run.status, 'awaiting_approval', run.errorMessage ?? undefined);
    assert.equal(companionCalls, 2);

    const readmeDeliv = run.deliverables.find((d) => d.destination === 'README.md');
    const blogDeliv = run.deliverables.find((d) => d.destination === 'docs/blog/post.md');
    assert.ok(readmeDeliv);
    assert.ok(blogDeliv);
    assert.equal(readmeDeliv.companionFiles?.[0]?.path, 'README.zh-CN.md');
    assert.equal(readmeDeliv.companionFiles?.[0]?.reviewOnly, false);
    assert.equal(blogDeliv.companionFiles?.[0]?.path, 'docs/blog/post.zh-CN.md');
    assert.equal(blogDeliv.companionFiles?.[0]?.reviewOnly, true);

    applyOptimizationDeliverables(projectId, run.id, [
      { deliverableId: readmeDeliv.id, action: 'apply', writeLocalFile: false },
      { deliverableId: blogDeliv.id, action: 'apply', writeLocalFile: false },
    ]);

    const pushed = publishRepoDeliverablesToGitHub(projectId, run.id, {
      remoteUrlOverride: bareDir,
      branchOverride: 'main',
      localAssetRootOverride: localAssetsDir,
    });

    const pushedReadmePaths = pushed.deliverables.find((d) => d.id === readmeDeliv.id)?.appliedRecord?.pushedPaths ?? [];
    assert.ok(pushedReadmePaths.includes('README.md'));
    assert.ok(pushedReadmePaths.includes('README.zh-CN.md'));
    assert.ok(!pushedReadmePaths.includes('docs/blog/post.zh-CN.md'));

    execFileSync('git', ['clone', '--branch', 'main', bareDir, verifyDir]);
    assert.equal(fs.existsSync(path.join(verifyDir, 'README.zh-CN.md')), true);
    assert.equal(fs.existsSync(path.join(verifyDir, 'docs/blog/post.zh-CN.md')), false);
  } finally {
    fs.rmSync(gitRoot, { recursive: true, force: true });
  }
});

test('exports external articles with public GitHub raw image URLs, step cards for Mermaid, and clean Rich HTML', () => {
  const sampleEn = [
    '# Why ChatGPT Recommends Your Competitor and Not You',
    '',
    'Intro paragraph referencing [Getting Started](../getting-started.md) and `../images/ignored-in-code.png`.',
    '',
    '![OpenGEO overview baseline](../images/overview-en.png)',
    '',
    '*Our baseline in OpenGEO before rewriting docs.*',
    '',
    '## How the audit works',
    '',
    '```mermaid',
    'flowchart LR',
    '    A["Ask the exact question a buyer types"] --> B["Save the full answer"]',
    '    B --> C["Compare before and after"]',
    '```',
    '',
    '| Tool | Best for |',
    '| --- | --- |',
    '| **OpenGEO** | Local captures |',
    '',
    'Open source at **https://github.com/cooleryu/opengeo**.',
  ].join('\n');

  const sampleZh = [
    '# 为什么 ChatGPT 推荐了竞品却从不提你？',
    '',
    '正文段落 [上手文档](../getting-started.zh-CN.md)。',
    '',
    '![基线截图](../images/overview.png)',
    '',
    '*基线截图说明*',
  ].join('\n');

  assert.equal(
    extractArticleTitle(sampleEn, 'Fallback Title'),
    'Why ChatGPT Recommends Your Competitor and Not You',
  );
  assert.equal(
    extractArticleTitle(sampleZh, 'Fallback Title'),
    '为什么 ChatGPT 推荐了竞品却从不提你？',
  );

  const exportOpts = {
    markdown: sampleEn,
    destination: 'docs/blog/ai-citation-audit-for-indie-products.md',
    repositoryUrl: 'https://github.com/cooleryu/opengeo',
    branch: 'main',
  };
  const externalMd = buildExternalMarkdown(exportOpts);
  assert.ok(!externalMd.startsWith('# Why ChatGPT Recommends'));
  assert.ok(externalMd.includes('https://raw.githubusercontent.com/cooleryu/opengeo/main/docs/images/overview-en.png'));
  assert.ok(externalMd.includes('https://github.com/cooleryu/opengeo/blob/main/docs/getting-started.md'));
  assert.ok(externalMd.includes('`../images/ignored-in-code.png`'));
  assert.ok(externalMd.includes('```mermaid'));
  assert.ok(externalMd.includes('flowchart LR'));
  assert.ok(externalMd.includes('| **OpenGEO** | Local captures |'));
  assert.ok(externalMd.includes('**[https://github.com/cooleryu/opengeo](https://github.com/cooleryu/opengeo)**'));

  const stepCardMd = buildExternalMarkdown({ ...exportOpts, convertMermaidToSteps: true });
  assert.ok(!stepCardMd.includes('flowchart LR'));
  assert.ok(stepCardMd.includes('> **Workflow Overview**'));
  assert.ok(stepCardMd.includes('> 1. **Ask the exact question a buyer types**'));

  const richHtml = buildExternalRichHtml(exportOpts);
  assert.ok(richHtml.includes('<h2>How the audit works</h2>'));
  assert.ok(
    richHtml.includes(
      '<figure><img src="https://raw.githubusercontent.com/cooleryu/opengeo/main/docs/images/overview-en.png" alt="OpenGEO overview baseline" /><figcaption><em>Our baseline in OpenGEO before rewriting docs.</em></figcaption></figure>',
    ),
  );
  assert.ok(richHtml.includes('<blockquote><p><strong>Workflow Overview</strong></p>\n<ol>'));
  assert.ok(richHtml.includes('<table><thead><tr><th>Tool</th><th>Best for</th></tr></thead><tbody><tr><td><strong>OpenGEO</strong></td><td>Local captures</td></tr></tbody></table>'));
});

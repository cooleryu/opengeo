import '../test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createModelTransport } from '../../agent-hub';
import { isAllowedWorkspaceInspectionPath } from '../agents/project-tools';
import { projectDataDirectory, withGeoProject } from '../projects';
import {
  answerSignalMapperAgent,
  answerSignalReducerAgent,
  applyPageFindingBatch,
  applySurgicalPatchToContent,
  buildEngineAnswerShards,
  buildLiveWebChangeBrief,
  computeCompactUnifiedDiff,
  extractStructuredMarkdownFromHtml,
  markPageAuditFindingsLive,
  parsePageSections,
  readLatestPageAudit,
  type AnswerShardItem,
  type PageAuditRecord,
} from './page-audit';

test('parsePageSections splits Markdown cleanly by H2 while ignoring headings inside fenced code blocks', () => {
  const md = [
    '# OpenGEO',
    '',
    'Track AI visibility locally.',
    '',
    '```md',
    '## Not A Real Heading',
    '```',
    '',
    '## Quick Start',
    'Run `npm run dev`.',
    '',
    '## FAQ',
    'MIT licensed.',
  ].join('\n');

  const sections = parsePageSections(md, false);
  assert.equal(sections.length, 3);
  assert.equal(sections[0].id, 'S0');
  assert.match(sections[0].heading, /OpenGEO/);
  assert.equal(sections[0].startLine, 1);
  assert.equal(sections[0].endLine, 8);
  assert.equal(sections[1].id, 'S1');
  assert.equal(sections[1].heading, 'Quick Start');
  assert.equal(sections[1].startLine, 9);
  assert.equal(sections[2].id, 'S2');
  assert.equal(sections[2].heading, 'FAQ');
});

test('buildEngineAnswerShards separates ChatGPT and Google into balanced parallel shards', () => {
  const mk = (engine: 'chatgpt' | 'google', idx: number): AnswerShardItem => ({
    questionId: `Q${idx}`,
    engine,
    query: `prompt ${idx}`,
    mention: 'no',
    citation: 'no',
    answerText: `Full answer text for ${engine} #${idx}`,
    sources: [{ title: 'Example', url: 'https://example.com' }],
  });

  const items: AnswerShardItem[] = [
    ...Array.from({ length: 8 }, (_, i) => mk('chatgpt', i + 1)),
    ...Array.from({ length: 6 }, (_, i) => mk('google', i + 1)),
  ];

  const shards = buildEngineAnswerShards(items, {
    maxPerShard: 4,
    uiLanguage: 'zh',
    projectName: 'OpenGEO',
  });

  assert.equal(shards.length, 4);
  assert.equal(shards[0].engine, 'chatgpt');
  assert.equal(shards[0].items.length, 4);
  assert.equal(shards[1].engine, 'chatgpt');
  assert.equal(shards[1].items.length, 4);
  assert.equal(shards[2].engine, 'google');
  assert.equal(shards[2].items.length, 3);
  assert.equal(shards[3].engine, 'google');
  assert.equal(shards[3].items.length, 3);
});

test('applySurgicalPatchToContent safely replaces or inserts without disturbing surrounding sections', () => {
  const original = [
    '# OpenGEO',
    '',
    'A local tool.',
    '',
    '## Quick Start',
    'Run `npm run dev` locally.',
  ].join('\n');

  const replaced = applySurgicalPatchToContent(original, {
    insertionMode: 'replace',
    beforeExcerpt: 'A local tool.',
    afterExcerpt: 'OpenGEO is an open-source, local-first AI search visibility workbench.',
  });
  assert.match(replaced.patchedContent, /local-first AI search visibility workbench\./);
  assert.match(replaced.patchedContent, /## Quick Start\nRun `npm run dev` locally\./);

  const inserted = applySurgicalPatchToContent(original, {
    insertionMode: 'insert_after',
    beforeExcerpt: 'A local tool.',
    afterExcerpt: 'It compares ChatGPT and Google AI answers with zero SaaS fees.',
  });
  assert.match(
    inserted.patchedContent,
    /A local tool\.\n\nIt compares ChatGPT and Google AI answers with zero SaaS fees\./,
  );

  const diff = computeCompactUnifiedDiff('A local tool.', 'OpenGEO is an open-source tool.', 3);
  assert.match(diff, /@@ -3,1 \+3,1 @@/);
  assert.match(diff, /- A local tool\./);
  assert.match(diff, /\+ OpenGEO is an open-source tool\./);
});

test('AgentHub registers all 4 page-audit strategies and runs Map-Reduce cleanly', async () => {
  const { defaultAgentHub } = await import('../../agent-hub');
  assert.ok(defaultAgentHub.get('answer-signal-mapper'));
  assert.ok(defaultAgentHub.get('answer-signal-reducer'));
  assert.ok(defaultAgentHub.get('page-section-auditor'));
  assert.ok(defaultAgentHub.get('section-surgical-patcher'));

  const transport = createModelTransport({
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    apiKey: 'synthetic-key',
    models: ['deepseek-chat'],
    fetchImpl: async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      if (sys.includes('只负责阅读')) {
        const userPayload = JSON.parse(body.messages.filter((m) => m.role === 'user').at(-1)!.content) as { engine: 'chatgpt' | 'google' };
        return new Response(
          JSON.stringify({
            model: 'deepseek-chat',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    engine: userPayload.engine,
                    categoryLabels: ['open-source AI visibility tracker'],
                    competitorAngles: [{ competitor: 'Elmo', praisedFor: 'self-hosted tracking' }],
                    buyerCriteria: ['local run without subscription'],
                    projectPerception: '未提及目标项目',
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  dominantCategory: '开源本地 AI 搜索可见度工具',
                  platformDifferences: {
                    chatgpt: '偏好开源 GitHub 工具与 Awesome 榜单',
                    google: '偏好 Reddit 讨论帖与工具对比文',
                  },
                  topCompetitorAngles: [
                    { dimension: '本地零月费运行', competitors: ['Elmo'], engines: ['chatgpt', 'google'] },
                  ],
                  mustAnswerCriteria: ['支持哪些 AI 平台', '如何零订阅本地运行'],
                  summary: '两大引擎均未提及本项目，竞品凭开源对比表占据推荐位。',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    },
  });

  const mr = await defaultAgentHub.mapReduce({
    mapSpec: answerSignalMapperAgent,
    mapInputs: [
      {
        engine: 'chatgpt',
        shardIndex: 1,
        shardTotal: 1,
        uiLanguage: 'zh',
        projectName: 'opengeo',
        items: [
          {
            questionId: 'Q1',
            engine: 'chatgpt',
            query: 'open source GEO tools',
            mention: 'no',
            citation: 'no',
            answerText: 'Elmo is an open-source self-hosted AI visibility tracker.',
            sources: [],
          },
        ],
      },
      {
        engine: 'google',
        shardIndex: 1,
        shardTotal: 1,
        uiLanguage: 'zh',
        projectName: 'opengeo',
        items: [
          {
            questionId: 'Q1',
            engine: 'google',
            query: 'open source GEO tools',
            mention: 'no',
            citation: 'no',
            answerText: 'Developers discuss GEO trackers on Reddit.',
            sources: [],
          },
        ],
      },
    ],
    reduceSpec: answerSignalReducerAgent,
    buildReduceInput: (shards) => ({ projectName: 'opengeo', uiLanguage: 'zh' as const, shards }),
    concurrency: 2,
    projectId: 'sample-project',
    transport,
  });

  assert.equal(mr.mapped.length, 2);
  assert.match(mr.output.platformDifferences.chatgpt, /GitHub/);
  assert.match(mr.output.platformDifferences.google, /Reddit/);
});

test('extractStructuredMarkdownFromHtml turns arbitrary SaaS HTML into clean section-chunkable Markdown', () => {
  const html = `
    <!doctype html>
    <html>
      <head><title>Acme Invoice SaaS</title><style>.x{color:red}</style></head>
      <body>
        <nav><a href="/login">Sign in</a></nav>
        <main>
          <h1>Automated invoicing for small agencies</h1>
          <p>Acme Invoice helps design and engineering studios send recurring bills and reconcile Stripe payouts automatically.</p>
          <h2>How we compare</h2>
          <table>
            <tr><th>Capability</th><th>Manual spreadsheets</th><th>Acme Invoice</th></tr>
            <tr><td>Recurring billing</td><td>Error prone</td><td>Automated Stripe sync</td></tr>
          </table>
          <h2>Pricing</h2>
          <ul>
            <li>Starter plan: Free for up to 5 active clients.</li>
            <li>Studio plan: $29/month flat for unlimited seats.</li>
          </ul>
        </main>
        <footer>Copyright Acme</footer>
      </body>
    </html>
  `;

  const md = extractStructuredMarkdownFromHtml(html, 'https://acme-invoice.example/');
  assert.match(md, /^# Automated invoicing for small agencies/m);
  assert.match(md, /## How we compare/);
  assert.match(md, /\| Capability \| Manual spreadsheets \| Acme Invoice \|/);
  assert.match(md, /## Pricing/);
  assert.equal(md.includes('Sign in'), false);
  assert.equal(md.includes('Copyright Acme'), false);

  const sections = parsePageSections(md, true);
  assert.equal(sections.length, 3);
  assert.equal(sections[1].heading, 'How we compare');
  assert.equal(sections[2].heading, 'Pricing');
});

test('buildLiveWebChangeBrief exports ready-to-paste CMS Markdown for pure website targets', () => {
  const audit: PageAuditRecord = {
    id: 'pa-saas-1',
    projectId: 'p-saas',
    targetAssetId: '__site_home__',
    targetLabel: 'acme-invoice.example',
    targetUrl: 'https://acme-invoice.example/',
    localFilePath: null,
    targetKind: 'live_web',
    targetLanguage: 'en',
    uiLanguage: 'en',
    shardStats: { totalAnswers: 10, chatgptAnswers: 5, googleAnswers: 5, shardCount: 4 },
    signalSheet: {
      dominantCategory: 'Agency invoicing software',
      platformDifferences: { chatgpt: 'Prefers flat pricing clarity', google: 'Prefers comparison tables' },
      topCompetitorAngles: [],
      mustAnswerCriteria: ['Pricing', 'Stripe sync'],
      summary: 'Summary',
    },
    findings: [
      {
        id: 'f-1',
        category: 'missing_definition',
        impact: 'high',
        sectionId: 'S0',
        sectionHeading: 'Opening / Hero',
        startLine: 1,
        endLine: 5,
        sectionExcerpt: 'Automated invoicing for small agencies',
        anchorQuote: 'Automated invoicing for small agencies',
        title: 'Add clear pricing & audience definition in Hero',
        whyAiMissed: 'AI answers prefer a quotable 2-sentence definition with pricing model.',
        citedEngines: ['chatgpt', 'google'],
        codebaseFact: 'Pricing section lists Free starter + $29/mo flat Studio plan.',
        suggestedDirection: 'Add 2 sentences under H1.',
        status: 'open',
        patchPreview: {
          insertionMode: 'insert_after',
          beforeExcerpt: 'Automated invoicing for small agencies',
          afterExcerpt: 'Acme Invoice starts free for up to 5 clients and costs $29/month flat for studios.',
          plainSummary: 'Clarified flat pricing right under H1.',
          unifiedDiff: '@@ -1 +1 @@',
          generatedAt: new Date().toISOString(),
          model: 'test',
        },
      },
    ],
    progress: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const brief = buildLiveWebChangeBrief(audit, ['f-1']);
  assert.match(brief, /# acme-invoice\.example — Page Update Brief/);
  assert.match(brief, /Insert right after the matched block/);
  assert.match(brief, /\$29\/month flat for studios/);
});

test('isAllowedWorkspaceInspectionPath enforces strict allowlist and blocks secrets under data/', () => {
  // Allowed source & metadata files
  assert.equal(isAllowedWorkspaceInspectionPath('package.json'), true);
  assert.equal(isAllowedWorkspaceInspectionPath('LICENSE'), true);
  assert.equal(isAllowedWorkspaceInspectionPath('README.md'), true);
  assert.equal(isAllowedWorkspaceInspectionPath('README.zh-CN.md'), true);
  assert.equal(isAllowedWorkspaceInspectionPath('docs/quickstart.md'), true);
  assert.equal(isAllowedWorkspaceInspectionPath('src/lib/geo/types.ts'), true);

  // Blocked secrets, config, traversal, and binary files
  assert.equal(isAllowedWorkspaceInspectionPath('data/geo-settings.json'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('data/chatgpt-private/connection.json'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('./data/geo-settings.json'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('.env'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('.env.local'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('../package.json'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('docs/../data/geo-settings.json'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('src/.secret.ts'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('next.config.mjs'), false);
  assert.equal(isAllowedWorkspaceInspectionPath('docs/diagram.png'), false);
});

test('applyPageFindingBatch never overwrites stored snapshots and markPageAuditFindingsLive logs real liveUrl', () => {
  const projectId = 'sample-project';
  const nowIso = new Date().toISOString();
  const auditFile = withGeoProject(projectId, () => path.join(projectDataDirectory(), 'page-audit.json'));
  const snapshotPath = path.join(process.env.GEO_WORKSPACE!, 'fixtures', projectId, 'site-home.md');
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const originalSnapshot = '# SampleProject\n\nOriginal stored evidence snapshot.\n';
  fs.writeFileSync(snapshotPath, originalSnapshot, 'utf8');

  const storedAudit: PageAuditRecord = {
    id: 'pa-no-local',
    projectId,
    targetAssetId: 'site-home',
    targetLabel: 'SampleProject Home',
    targetUrl: 'https://example.com/sample-project/',
    localFilePath: null,
    targetKind: 'live_web',
    targetLanguage: 'en',
    uiLanguage: 'en',
    shardStats: { totalAnswers: 4, chatgptAnswers: 2, googleAnswers: 2, shardCount: 2 },
    signalSheet: {
      dominantCategory: 'Workflow tool',
      platformDifferences: { chatgpt: 'Direct', google: 'Concise' },
      topCompetitorAngles: [],
      mustAnswerCriteria: ['Clarity'],
      summary: 'Summary',
    },
    findings: [
      {
        id: 'f-no-local-1',
        category: 'missing_definition',
        impact: 'high',
        sectionId: 'S0',
        sectionHeading: 'Opening / Hero',
        startLine: 1,
        endLine: 3,
        sectionExcerpt: originalSnapshot,
        anchorQuote: 'Original stored evidence snapshot.',
        title: 'Clarify hero sentence',
        whyAiMissed: 'Needs direct category statement.',
        citedEngines: ['chatgpt'],
        codebaseFact: 'Verified from page text.',
        suggestedDirection: 'Clarify opening.',
        status: 'open',
        patchPreview: {
          insertionMode: 'replace',
          beforeExcerpt: 'Original stored evidence snapshot.',
          afterExcerpt: 'Updated definition paragraph.',
          plainSummary: 'Updated opening',
          unifiedDiff: '@@ -1 +1 @@',
          generatedAt: nowIso,
        },
      },
    ],
    progress: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  fs.writeFileSync(auditFile, JSON.stringify({ version: 1, latest: storedAudit }, null, 2), 'utf8');

  // Must refuse to overwrite stored evidence snapshots when no writable local repo file exists
  assert.throws(
    () => applyPageFindingBatch(projectId, ['f-no-local-1']),
    /没有可写的本地仓库文件/,
  );
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), originalSnapshot);

  // markPageAuditFindingsLive requires a real http(s) URL
  assert.throws(
    () => markPageAuditFindingsLive(projectId, ['f-no-local-1'], { liveUrl: '' }),
    /有效的线上公开链接/,
  );
  assert.throws(
    () => markPageAuditFindingsLive(projectId, ['f-no-local-1'], { liveUrl: 'javascript:alert(1)' }),
    /http:\/\/ 或 https:\/\//,
  );

  // With a valid live URL, records shippedRecord & closes loop without touching snapshot
  const marked = markPageAuditFindingsLive(projectId, ['f-no-local-1'], {
    liveUrl: 'https://example.com/sample-project/',
  });
  assert.equal(marked.shippedRecord.liveUrl, 'https://example.com/sample-project/');
  assert.deepEqual(marked.shippedRecord.findingIds, ['f-no-local-1']);
  assert.equal(marked.audit.findings[0].status, 'applied');
  assert.equal(marked.audit.shippedRecords?.length, 1);
  assert.equal(fs.readFileSync(snapshotPath, 'utf8'), originalSnapshot);
  assert.equal(readLatestPageAudit(projectId)?.shippedRecords?.[0]?.liveUrl, 'https://example.com/sample-project/');
});

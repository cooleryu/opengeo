import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectInspectionTools } from '../agents/project-tools';
import { ensureProjectRelationalData, withProjectDb } from '../db';
import { createProjectOnboarding } from '../project-onboarding-store';
import type { PublicSourceRuntime } from '../project-public-source';
import { withGeoProject } from '../projects';
import { deliverableWriterAgent, optimizationStrategistAgent } from './agents';
import {
  classifyCitedChannel,
  formatWriterTargetQuestions,
  loadActiveQuestionsWithPlanMeta,
  normalizeUrlMeta,
  pickUnifiedEntityKey,
} from './citation-classifier';
import {
  buildOptimizationStrategicBrief,
  buildOutreachDraftPayload,
  formatCitationLandscapeForContext,
} from './citation-landscape';
import { selectAndProbeReferenceWinners } from './reference-winners';

const originalDataDir = process.env.OPENGEO_DATA_DIR;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-citation-landscape-test-'));
process.env.OPENGEO_DATA_DIR = testDataDir;

test.after(() => {
  if (originalDataDir === undefined) delete process.env.OPENGEO_DATA_DIR;
  else process.env.OPENGEO_DATA_DIR = originalDataDir;
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test('classifyCitedChannel separates all 5 channel types across GEO and non-GEO industries', () => {
  const roots = new Set(['peec.ai', 'tryprofound.com', 'captivateiq.com']);

  // Open self-serve channels (video, community, directories, awesome lists)
  assert.equal(classifyCitedChannel('https://www.youtube.com/watch?v=abc123', 'YouTube · Demo', roots), 'open_channel');
  assert.equal(classifyCitedChannel('https://www.reddit.com/r/sales/comments/123/best_commission_tool/', 'Reddit', roots), 'open_channel');
  assert.equal(classifyCitedChannel('https://www.g2.com/products/captivateiq/competitors/alternatives', 'G2', roots), 'open_channel');
  assert.equal(classifyCitedChannel('https://github.com/deeflect/awesome-geo', 'Awesome GEO', roots), 'open_channel');
  assert.equal(classifyCitedChannel('https://mcpmarket.com/server/open-geo', 'Open Geo', roots), 'open_channel');

  // Direct competitor open-source repos
  assert.equal(classifyCitedChannel('https://github.com/elmohq/elmo', 'GitHub repository', roots), 'direct_competitor_repo');
  assert.equal(classifyCitedChannel('https://github.com/AI2HU/gego', 'Gego', roots), 'direct_competitor_repo');

  // High-authority editorial / mega-platform sources
  assert.equal(classifyCitedChannel('https://www.semrush.com/blog/how-to-track-your-chatgpt-visibility/', 'Semrush', roots), 'authority_editorial');
  assert.equal(classifyCitedChannel('https://en.wikipedia.org/wiki/Sales_commission', 'Wikipedia', roots), 'authority_editorial');
  assert.equal(classifyCitedChannel('https://blog.hubspot.com/sales/commission-software', 'HubSpot', roots), 'authority_editorial');
  assert.equal(classifyCitedChannel('https://zapier.com/blog/best-ai-visibility-tool/', 'Zapier', roots), 'authority_editorial');

  // Direct commercial competitor sites (even on deep product/feature pages when domain is in roots)
  assert.equal(classifyCitedChannel('https://peec.ai/', 'Peec AI', roots), 'direct_competitor_site');
  assert.equal(classifyCitedChannel('https://www.tryprofound.com/features/answer-engine-insights/competitors', 'Profound', roots), 'direct_competitor_site');
  assert.equal(classifyCitedChannel('https://www.captivateiq.com/pricing', 'CaptivateIQ Pricing', roots), 'direct_competitor_site');

  // Independent third-party roundups & comparison blogs
  assert.equal(classifyCitedChannel('https://www.sitepoint.com/best-profound-ai-alternatives/', 'Profound AI Alternatives', roots), 'third_party_roundup');
  assert.equal(classifyCitedChannel('https://www.ansvisor.com/blog/open-source-aeo-geo-tools-for-ai-visibility', 'ansvisor.com', roots), 'third_party_roundup');
  assert.equal(classifyCitedChannel('https://www.selecthub.com/sales-commission/best-commission-software/', 'Best Commission Software', roots), 'third_party_roundup');
  assert.equal(classifyCitedChannel('https://senso.ai/prompts-content/how-to-track-llm-mentions-of-my-brand', 'senso.ai', roots), 'third_party_roundup');
});

test('normalizeUrlMeta preserves YouTube video IDs and pickUnifiedEntityKey merges vendor domain variants safely', () => {
  const yt = normalizeUrlMeta('https://www.youtube.com/watch?v=OGfXxYe-FKA&t=30');
  assert.equal(yt?.url, 'https://www.youtube.com/watch?v=OGfXxYe-FKA');

  const stems = new Set(['profound', 'peec', 'getapp']);
  assert.equal(pickUnifiedEntityKey('tryprofound.com', 'direct_competitor_site', null, stems).key, 'site:profound');
  assert.equal(pickUnifiedEntityKey('profound.io', 'direct_competitor_site', null, stems).key, 'site:profound');
  // Must NOT falsely collapse unrelated domain when stripped stem is absent
  assert.equal(pickUnifiedEntityKey('getapp.com', 'direct_competitor_site', null, stems).key, 'site:getapp');
});

test('buildOptimizationStrategicBrief, list_project_questions, strategist/writer prompts, reference-winners, and outreach payload share unified active-batch intelligence', async () => {
  const created = createProjectOnboarding({
    kind: 'repository',
    url: 'https://github.com/acme/acmetrack',
    targetLanguage: 'en',
    uiLanguage: 'en',
    notes: 'Local-first telemetry tracker for small engineering teams.',
  });
  const projectId = created.project.id;

  withGeoProject(projectId, () => {
    withProjectDb(projectId, (db, id) => {
      ensureProjectRelationalData(id, db);
      const now = '2026-11-22T00:00:00.000Z';
      const older = '2026-11-01T00:00:00.000Z';

      // Clear default seeded questions so assertions verify our controlled fixture cleanly
      db.prepare('DELETE FROM opengeo_answer_audits WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM opengeo_observations WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM opengeo_questions WHERE project_id = ?').run(id);

      // Insert active questions + one archived legacy question
      const insertQ = db.prepare(
        `INSERT INTO opengeo_questions (id, project_id, status, decision, category, query_zh, query_en, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'search_now', ?, ?, ?, ?, ?, ?)`,
      );
      insertQ.run('q-brand', id, 'active', 'brand', 'AcmeTrack 是什么？', 'What is AcmeTrack?', 1, now, now);
      insertQ.run('q-comp', id, 'active', 'comparison', 'AcmeTrack 竞品替代？', 'What are the best alternatives to BigVendor?', 2, now, now);
      insertQ.run('q-arch', id, 'archived', 'problem', '旧问题', 'Archived old question', 3, older, older);

      // Persist Phase 1 question plan with tactic, fanoutQueries, and raw demandSignals
      db.exec(
        'CREATE TABLE IF NOT EXISTS geo_question_plans (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)',
      );
      db.prepare(
        'INSERT INTO geo_question_plans (project_id, plan_id, revision, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        id,
        `${id}-plan`,
        1,
        JSON.stringify({
          candidates: [
            {
              id: 'q-brand',
              tactic: 'brand-check',
              demandStatus: 'unverified',
              fanoutQueries: ['acmetrack github', 'acmetrack features'],
            },
            {
              id: 'q-comp',
              tactic: 'competitor-intercept',
              demandStatus: 'search-backed',
              fanoutQueries: ['bigvendor pricing', 'open source bigvendor alternatives', 'bigvendor vs rival'],
              demandSignals: [{ keyword: 'bigvendor alternatives', searchVolume: 640, cpc: 32.5, kd: 11 }],
            },
          ],
        }),
        now,
      );

      const insertObs = db.prepare(
        `INSERT INTO opengeo_observations
          (id, project_id, batch_id, question_id, engine, language, entry_type, query_text, recorded_at, collected_at, status, summary, conditions_text, sources_json, evidence_path, answer_path, created_at)
         VALUES (?, ?, 'batch-1', ?, ?, 'en', 'web_answer', ?, ?, ?, 'not_observed', ?, 'test', ?, '', NULL, ?)`,
      );
      const insertAudit = db.prepare(
        `INSERT INTO opengeo_answer_audits
          (project_id, observation_id, is_current, mention, citation, mention_evidence, citation_evidence, answer_complete, audited_at)
         VALUES (?, ?, 1, 'no', 'no', ?, 'No owned URL', 1, ?)`,
      );

      // Stale older observation for q-comp (should be deduplicated out!)
      insertObs.run(
        'obs-comp-old',
        id,
        'q-comp',
        'google',
        'What are the best alternatives to BigVendor?',
        older,
        older,
        'Old answer citing stale site',
        JSON.stringify([{ title: 'Stale Old Site', url: 'https://staleoldsite.example/post' }]),
        older,
      );
      insertAudit.run(id, 'obs-comp-old', 'Old stale evidence', older);

      // Fresh latest observation for q-comp on Google & ChatGPT
      insertObs.run(
        'obs-comp-google',
        id,
        'q-comp',
        'google',
        'What are the best alternatives to BigVendor?',
        now,
        now,
        'Compares BigVendor alternatives using Reddit and indie roundups',
        JSON.stringify([
          { title: 'BigVendor Alternatives Guide', url: 'https://indiecompare.io/blog/bigvendor-alternatives' },
          { title: 'Reddit · r/devops', url: 'https://www.reddit.com/r/devops/comments/abc/bigvendor_alternatives/' },
          { title: 'Semrush Guide', url: 'https://www.semrush.com/blog/monitoring-guide/' },
          { title: 'YouTube Demo', url: 'https://www.youtube.com/watch?v=demo123' },
        ]),
        now,
      );
      insertAudit.run(id, 'obs-comp-google', 'Lists RivalX and BigVendor', now);

      insertObs.run(
        'obs-comp-chatgpt',
        id,
        'q-comp',
        'chatgpt',
        'What are the best alternatives to BigVendor?',
        now,
        now,
        'Recommends BigVendor and open-source RivalRepo',
        JSON.stringify([
          { title: 'Visit BigVendor', url: 'https://trybigvendor.com/' },
          { title: 'Website', url: 'https://bigvendor.io/' },
          { title: 'GitHub repository', url: 'https://github.com/rivalorg/rival-tracker' },
        ]),
        now,
      );
      insertAudit.run(id, 'obs-comp-chatgpt', 'Recommends BigVendor and rivalorg/rival-tracker', now);

      // Fresh observation for q-brand showing homonym confusion
      insertObs.run(
        'obs-brand-google',
        id,
        'q-brand',
        'google',
        'What is AcmeTrack?',
        now,
        now,
        'Describes another project named AcmeTrack Logistics',
        JSON.stringify([{ title: 'AcmeTrack Logistics Directory', url: 'https://www.g2.com/products/acmetrack-logistics' }]),
        now,
      );
      insertAudit.run(id, 'obs-brand-google', 'Describes another project with the same name', now);

      // Archived question observation (must NOT pollute brief or reference winners!)
      insertObs.run(
        'obs-archived',
        id,
        'q-arch',
        'google',
        'Archived old question',
        older,
        older,
        'Archived observation',
        JSON.stringify([{ title: 'Ghost Archived Page', url: 'https://ghost-archived.example/guide' }]),
        older,
      );
    });

    const brief = buildOptimizationStrategicBrief(projectId, { targetLanguage: 'en' });
    assert.equal(brief.coverage.totalQuestions, 2);
    assert.equal(brief.coverage.measuredAnswers, 3);
    assert.equal(brief.coverage.brand.homonymRisk, true);
    assert.ok(brief.citationLandscape.openChannel.some((c) => c.label === 'youtube.com'));
    assert.ok(brief.citationLandscape.openChannel.some((c) => c.label === 'reddit.com'));
    assert.ok(brief.citationLandscape.authorityEditorial.some((c) => c.label === 'semrush.com'));
    assert.ok(brief.citationLandscape.thirdPartyRoundups.some((c) => c.label === 'indiecompare.io'));
    assert.ok(brief.citationLandscape.directCompetitorRepos.some((c) => c.label === 'rivalorg/rival-tracker'));
    // Unifies trybigvendor.com + bigvendor.io into a single direct competitor entity
    const bigVendor = brief.citationLandscape.directCompetitorSites.find((c) => c.label === 'bigvendor');
    assert.ok(bigVendor);
    assert.equal(bigVendor.domains.length, 2);
    // Archived and stale-older sources must NOT appear
    const allLabels = JSON.stringify(brief.citationLandscape);
    assert.equal(allLabels.includes('ghost-archived.example'), false);
    assert.equal(allLabels.includes('staleoldsite.example'), false);

    // Phase 1 metadata joined cleanly without raw SEO numbers
    const compRow = brief.questionMatrix.find((q) => q.questionId === 'q-comp');
    assert.equal(compRow?.tactic, 'competitor-intercept');
    assert.equal(compRow?.demandStrength, 'strong');
    assert.equal(compRow?.ownedContentWedge, 'competitor_comparison');
    assert.deepEqual(compRow?.fanoutQueries, [
      'bigvendor pricing',
      'open source bigvendor alternatives',
      'bigvendor vs rival',
    ]);
    assert.equal(JSON.stringify(brief).includes('32.5'), false);

    // Context formatter groups by channel
    const ctxLines = formatCitationLandscapeForContext(brief).join('\n');
    assert.ok(ctxLines.includes('### Direct Competitors'));
    assert.ok(ctxLines.includes('### High-Authority Editorial Sources Cited'));
    assert.ok(ctxLines.includes('### Open Community, Video & Directory Channels Cited'));

    // list_project_questions returns deduplicated latest obs with citedSources & fanoutQueries
    const tools = createProjectInspectionTools({ targetLanguage: 'en' });
    const listTool = tools.find((t) => t.name === 'list_project_questions')!;
    const listed = listTool.execute({}, { projectId }) as Array<{
      questionId: string;
      tactic?: string;
      fanoutQueries?: string[];
      observations: Array<{ engine: string; citedSources: Array<{ domain: string; channel: string }> }>;
    }>;
    const compListed = listed.find((q) => q.questionId === 'q-comp')!;
    assert.equal(compListed.tactic, 'competitor-intercept');
    assert.equal(compListed.fanoutQueries?.length, 3);
    assert.equal(compListed.observations.length, 2); // deduplicated (no obs-comp-old!)
    const googleObs = compListed.observations.find((o) => o.engine === 'google')!;
    assert.ok(googleObs.citedSources.some((s) => s.domain === 'semrush.com' && s.channel === 'authority_editorial'));

    // Strategist prompt receives strategicBrief; Writer prompt receives subQuestionsToCover
    const stratPrompt = optimizationStrategistAgent.buildPrompt(
      { mode: 'deep', targetLanguage: 'en', uiLanguage: 'en' },
      { projectId },
    );
    assert.ok(stratPrompt.user.includes('"strategicBrief"'));
    assert.ok(stratPrompt.user.includes('"authorityEditorial"'));
    assert.ok(stratPrompt.user.includes('bigvendor pricing'));

    const enrichedQs = loadActiveQuestionsWithPlanMeta(projectId);
    const formattedWriterQs = formatWriterTargetQuestions(enrichedQs, 'en');
    const writerPrompt = deliverableWriterAgent.buildPrompt(
      {
        deliverable: {
          priority: 1,
          kind: 'new_content',
          format: 'rich_markdown',
          title: 'BigVendor Alternatives for Local Engineering Teams',
          targetAssetId: null,
          destination: 'docs/blog/bigvendor-alternatives.md',
          audienceAndGoal: 'Compare BigVendor with local-first open-source options.',
          questionIds: ['q-comp'],
          writingBrief: 'Compare pricing, deployment, and data ownership.',
        },
        targetQuestions: enrichedQs.filter((q) => q.id === 'q-comp'),
        beforeContent: '',
        targetLanguage: 'en',
      },
      { projectId },
    );
    assert.ok(Array.isArray(formattedWriterQs));
    assert.ok(writerPrompt.user.includes('"subQuestionsToCover"'));
    assert.ok(writerPrompt.user.includes('open source bigvendor alternatives'));

    // Outreach draft payload attaches exact buyer prompt & AI answer context for the cited Reddit thread
    const outreachPayload = buildOutreachDraftPayload(
      projectId,
      {
        title: 'Reddit · r/devops',
        targetUrl: 'https://www.reddit.com/r/devops/comments/abc/bigvendor_alternatives/',
      },
      {
        name: 'AcmeTrack',
        description: 'Local-first telemetry tracker.',
        repositoryUrl: 'https://github.com/acme/acmetrack',
        siteUrl: 'https://acmetrack.dev',
      },
      '# AcmeTrack Fact Sheet',
    );
    assert.ok(outreachPayload.buyerPromptsCitingThisThread?.[0]?.includes('What are the best alternatives to BigVendor?'));
    assert.ok(outreachPayload.aiAnswerExcerpts?.[0]?.includes('Lists RivalX and BigVendor'));
  });

  // selectAndProbeReferenceWinners ignores archived questions and stale older observations
  const runtime: PublicSourceRuntime = {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({
      status: 404,
      headers: {},
      body: '',
    }),
  };
  const winners = await withGeoProject(projectId, () =>
    selectAndProbeReferenceWinners(projectId, {
      targetQuestionIds: ['q-comp'],
      targetLanguage: 'en',
      deliverableRole: 'article',
      maxWinners: 5,
      runtime,
    }),
  );
  const winnerDomains = winners.map((w) => w.domain);
  assert.equal(winnerDomains.includes('ghost-archived.example'), false);
  assert.equal(winnerDomains.includes('staleoldsite.example'), false);
  assert.ok(winnerDomains.includes('indiecompare.io'));
});

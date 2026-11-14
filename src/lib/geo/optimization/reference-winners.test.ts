import '../test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { ensureProjectRelationalData, withProjectDb } from '../db';
import { loadProjectSeed } from '../project-data';
import type { PublicSourceRuntime } from '../project-public-source';
import {
  extractWinnerStructureFromHtml,
  selectAndProbeReferenceWinners,
} from './reference-winners';

const previousDataDir = process.env.DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-winners-'));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('extractWinnerStructureFromHtml extracts title, H2 skeleton, and opening 3 paragraphs cleanly', () => {
  const html = `<!doctype html>
  <html>
    <head><title>How AI Citation Monitoring Works - Competitor</title></head>
    <body>
      <article>
        <h1>How AI Citation Monitoring Works</h1>
        <p>When buyers ask ChatGPT for recommendations, brand mentions alone do not bring traffic unless your documentation URLs are cited.</p>
        <h2>What is the difference between AI mention and URL citation?</h2>
        <p>A mention names your product in prose, while a citation attaches a clickable reference card back to your site or docs.</p>
        <h2>How do teams audit ChatGPT and Google AI answers?</h2>
        <p>Effective teams store raw prompts, response text, and cited links together so changes before and after a rewrite stay verifiable.</p>
        <p>Extra fourth paragraph that should not overflow the top three opening paragraphs.</p>
      </article>
    </body>
  </html>`;

  const parsed = extractWinnerStructureFromHtml(html, 'https://competitor.example/guide');
  assert.ok(parsed);
  assert.match(parsed.title, /How AI Citation Monitoring Works/);
  assert.deepEqual(parsed.headings, [
    'What is the difference between AI mention and URL citation?',
    'How do teams audit ChatGPT and Google AI answers?',
  ]);
  assert.equal(parsed.openingParagraphs.length, 3);
});

test('extractWinnerStructureFromHtml rejects Cloudflare / anti-bot shells without retrying', () => {
  const cfShell = `<!doctype html><html><head><title>Just a moment...</title></head><body><p>Please verify you are human to continue.</p></body></html>`;
  assert.equal(extractWinnerStructureFromHtml(cfShell, 'https://blocked.example/post'), null);
});

test('selectAndProbeReferenceWinners filters owned URLs, deduplicates utm params, falls back on 403, and promotes next open winner', async () => {
  const projectId = 'sample-project';
  ensureProjectRelationalData(projectId);
  const seed = loadProjectSeed(projectId);
  const ownedSiteUrl = (seed?.project.siteUrl || 'https://example.com/example-project').replace(
    /\/+$/,
    '',
  );
  const ownedHostname = new URL(ownedSiteUrl).hostname;

  const qRow = withProjectDb(projectId, (db, id) =>
    db
      .prepare(
        "SELECT id FROM opengeo_questions WHERE project_id = ? AND status = 'active' AND COALESCE(category, '') != 'brand' ORDER BY sort_order LIMIT 1",
      )
      .get(id) as { id: string },
  );

  // Inject controlled observations into SQLite for deterministic ranking, noise filtering, and 403 fallback verification
  withProjectDb(projectId, (db, id) => {
    const now = new Date().toISOString();
    db.prepare("UPDATE opengeo_observations SET sources_json = '[]' WHERE project_id = ?").run(id);
    db.prepare(
      "INSERT OR REPLACE INTO opengeo_questions (project_id, id, status, decision, category, sort_order, query_zh, query_en, created_at, updated_at) VALUES (?, 'q-brand-test', 'active', 'search_now', 'brand', 999, '品牌测试', 'What is BrandTest?', ?, ?)",
    ).run(id, now, now);
    const insertObs = db.prepare(`
      INSERT INTO opengeo_observations (
        project_id, id, batch_id, question_id, optimization_run_id, run_id,
        engine, language, entry_type, overview_status, query_text, status,
        summary, answer_path, evidence_path, sources_json, conditions_text, recorded_at, collected_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?, 'en', 'web_answer', NULL, ?, 'found', ?, NULL, '', ?, 'test', ?, ?, ?)
    `);
    insertObs.run(
      id,
      'obs-win-1',
      'batch-1',
      qRow.id,
      'chatgpt',
      'how to audit ai citations',
      'BlockedLeader is frequently cited for citation tracking workflows.',
      JSON.stringify([
        {
          title: 'Example Owned Page',
          url: `${ownedSiteUrl}/docs?utm_source=chatgpt.com`,
          kind: 'other',
        },
        {
          title: 'BlockedLeader Guide',
          url: 'https://blockedleader.example/ai-citations?utm_source=chatgpt.com',
          snippet: 'BlockedLeader explains how teams benchmark brand mentions against competitors.',
          kind: 'other',
        },
        {
          title: 'OpenDocs Deep Dive',
          url: 'https://opendocs.example/geo-playbook',
          snippet: 'OpenDocs walks through three concrete steps to earn AI citations.',
          kind: 'other',
        },
      ]),
      now,
      now,
      now,
    );
    insertObs.run(
      id,
      'obs-win-2',
      'batch-1',
      qRow.id,
      'google',
      'how to audit ai citations',
      'BlockedLeader and SecondOpen appear in Google AI answers.',
      JSON.stringify([
        {
          title: 'BlockedLeader Guide',
          url: 'https://blockedleader.example/ai-citations',
          kind: 'other',
        },
        {
          title: 'SecondOpen Tutorial',
          url: 'https://secondopen.example/checklist',
          snippet: 'SecondOpen shares a structured checklist for AI search answers.',
          kind: 'other',
        },
        {
          title: 'Google Goto Wrapper',
          url: 'https://www.google.com/goto?url=OPAQUE',
          kind: 'other',
        },
        {
          title: 'Google Privacy',
          url: 'https://policies.google.com/privacy',
          kind: 'other',
        },
      ]),
      now,
      now,
      now,
    );
    insertObs.run(
      id,
      'obs-win-brand',
      'batch-1',
      'q-brand-test',
      'chatgpt',
      'What is BrandTest?',
      'Unrelated homonym entry on brand query.',
      JSON.stringify([
        {
          title: 'Unrelated Homonym',
          url: 'https://homonym.example/unrelated',
          snippet: 'Unrelated homonym project page.',
          kind: 'other',
        },
      ]),
      now,
      now,
      now,
    );
  });

  const probedHosts: string[] = [];
  const runtime: PublicSourceRuntime = {
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
    request: async (url) => {
      probedHosts.push(url.hostname);
      if (url.hostname === 'blockedleader.example') {
        return { status: 403, headers: { 'content-type': 'text/html' }, body: '' };
      }
      if (url.hostname === 'opendocs.example') {
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: `<!doctype html><html><head><title>OpenDocs GEO Playbook</title></head><body><article><h1>OpenDocs GEO Playbook</h1><p>OpenDocs demonstrates how comparison tables help AI search engines verify your claims immediately.</p><h2>Why do AI engines skip homepage slogans?</h2><p>Generic marketing slogans lack concrete workflows, benchmarks, and verifiable specifications for retrieval.</p></article></body></html>`,
        };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: `<!doctype html><html><head><title>SecondOpen Checklist</title></head><body><article><h1>SecondOpen Checklist</h1><p>This checklist covers five structural changes that improve answer citations across ChatGPT and Google.</p><h2>How should headings be phrased?</h2><p>Frame section headings around the exact questions buyers ask before deploying software.</p></article></body></html>`,
      };
    },
  };

  const winners = await selectAndProbeReferenceWinners(projectId, {
    targetQuestionIds: [qRow.id],
    targetLanguage: 'en',
    maxWinners: 3,
    timeoutMs: 1000,
    runtime,
  });

  // Never probes ownedHostname, brand homonyms, Google goto/policy noise, or retries blockedleader.example
  assert.ok(!probedHosts.includes(ownedHostname));
  assert.ok(!probedHosts.includes('homonym.example'));
  assert.ok(!probedHosts.includes('www.google.com'));
  assert.ok(!probedHosts.includes('policies.google.com'));
  assert.equal(probedHosts.filter((h) => h === 'blockedleader.example').length, 1);

  assert.equal(winners.length, 3);
  const full = winners.filter((w) => w.probeStatus === 'full_read');
  const fallback = winners.filter((w) => w.probeStatus === 'local_fallback');
  assert.equal(full.length, 2);
  assert.equal(fallback.length, 1);

  assert.equal(fallback[0].domain, 'blockedleader.example');
  assert.match(fallback[0].localSnippet, /BlockedLeader explains/);
  assert.ok(full.some((w) => w.domain === 'opendocs.example' && w.headings.length === 1));
  assert.ok(full.some((w) => w.domain === 'secondopen.example' && w.headings.length === 1));
});

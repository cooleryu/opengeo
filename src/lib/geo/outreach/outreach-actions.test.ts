import '../test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { DEFAULT_PROJECT_ID } from '../projects';
import type { ResearchBatch } from '../research-types';
import {
  buildDefaultShowHnDraft,
  parseAwesomeInsertion,
  sanitizeAwesomePrDraft,
} from './outreach-actions';
import {
  getOutreachRecord,
  readOutreachRecords,
  upsertOutreachRecord,
} from './outreach-store';

let temporaryDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.DATA_DIR;
  temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-outreach-test-'));
  process.env.DATA_DIR = temporaryDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  fs.rmSync(temporaryDir, { recursive: true, force: true });
});

test('outreach store persists records per project cleanly with atomic writes', () => {
  assert.deepEqual(readOutreachRecords(DEFAULT_PROJECT_ID), []);

  const saved = upsertOutreachRecord(DEFAULT_PROJECT_ID, {
    id: 'awesome:deeflect/awesome-geo',
    kind: 'awesome_pr',
    title: 'deeflect/awesome-geo',
    subtitle: 'AI cited list',
    targetUrl: 'https://github.com/deeflect/awesome-geo',
    status: 'prepared',
    awesomePrDraft: {
      upstreamOwner: 'deeflect',
      upstreamRepo: 'awesome-geo',
      defaultBranch: 'main',
      sectionHeading: 'Open-Source Tools',
      insertedLine: '- [OpenGEO](https://github.com/cooleryu/opengeo) - Local-first GEO audit tool.',
      contextSnippet: '+ - [OpenGEO](https://github.com/cooleryu/opengeo) - Local-first GEO audit tool.',
      prTitle: 'Add OpenGEO under Open-Source Tools',
      prBody: 'Adding OpenGEO.',
    },
    updatedAt: new Date().toISOString(),
  });

  assert.equal(saved.status, 'prepared');
  const loaded = getOutreachRecord(DEFAULT_PROJECT_ID, 'awesome:deeflect/awesome-geo');
  assert.equal(loaded?.awesomePrDraft?.sectionHeading, 'Open-Source Tools');

  const completed = upsertOutreachRecord(DEFAULT_PROJECT_ID, {
    ...saved,
    status: 'completed',
    resultUrl: 'https://github.com/deeflect/awesome-geo/pull/12',
    completedAt: new Date().toISOString(),
  });
  assert.equal(readOutreachRecords(DEFAULT_PROJECT_ID).length, 1);
  assert.equal(completed.resultUrl, 'https://github.com/deeflect/awesome-geo/pull/12');
});

test('parseAwesomeInsertion picks matching section, preserves bullet formatting, and builds diff snippet', () => {
  const readme = [
    '# Awesome GEO',
    '',
    'Curated Generative Engine Optimization resources.',
    '',
    '## Table of Contents',
    '- [Tools](#open-source-tools)',
    '',
    '## Articles',
    '- [Intro to GEO](https://example.com/intro) - Background article.',
    '',
    '## Open-Source Tools',
    '* **[Elmo](https://github.com/elmohq/elmo)** — Self-hosted AI visibility platform.',
    '* **[Gego](https://github.com/AI2HU/gego)** — Open-source tracker.',
    '',
    '## Contributing',
    'PRs welcome.',
  ].join('\n');

  const result = parseAwesomeInsertion(readme, {
    name: 'OpenGEO',
    repositoryUrl: 'https://github.com/cooleryu/opengeo',
    siteUrl: '',
    description: 'Local-first AI search visibility & citation audit workbench.',
  });

  assert.equal(result.sectionHeading, 'Open-Source Tools');
  assert.equal(
    result.insertedLine,
    '* **[OpenGEO](https://github.com/cooleryu/opengeo)** — Local-first AI search visibility & citation audit workbench.',
  );
  assert.ok(result.contextSnippet.includes(`+ ${result.insertedLine}`));

  const lines = result.updatedReadme.split('\n');
  const gegoIdx = lines.findIndex((l) => l.includes('AI2HU/gego'));
  const opengeoIdx = lines.findIndex((l) => l.includes('cooleryu/opengeo'));
  const contribIdx = lines.findIndex((l) => l.includes('## Contributing'));
  assert.ok(opengeoIdx === gegoIdx + 1);
  assert.ok(opengeoIdx < contribIdx);
});

test('parseAwesomeInsertion inserts properly formatted Markdown table rows when target section uses a table', () => {
  const readme = [
    '# Awesome GEO',
    '',
    '### GEO Monitoring & Tracking',
    '',
    '| Repository | Stars | Type | Language | Description |',
    '|------------|-------|------|----------|-------------|',
    '| [Elmo](https://github.com/elmohq/elmo) | ⭐ 593 | 🔧 Tool | TypeScript | Self-hosted AI visibility platform. |',
    '',
    '### Structured Data',
    '| Repository | Stars | Type | Language | Description |',
  ].join('\n');

  const result = parseAwesomeInsertion(readme, {
    name: 'OpenGEO',
    repositoryUrl: 'https://github.com/cooleryu/opengeo',
    siteUrl: '',
    description: 'Local-first AI search visibility & GEO workbench.',
  }, {
    sectionHeading: 'GEO Monitoring & Tracking',
    stars: 0,
    language: 'TypeScript',
  });

  assert.equal(result.sectionHeading, 'GEO Monitoring & Tracking');
  assert.equal(
    result.insertedLine,
    '| [OpenGEO](https://github.com/cooleryu/opengeo) | - | 🔧 Tool | TypeScript | Local-first AI search visibility & GEO workbench. |',
  );
  const lines = result.updatedReadme.split('\n');
  const elmoIdx = lines.findIndex((l) => l.includes('elmohq/elmo'));
  const opengeoIdx = lines.findIndex((l) => l.includes('cooleryu/opengeo'));
  assert.equal(opengeoIdx, elmoIdx + 1);
});

test('parseAwesomeInsertion falls back to English description when project description contains CJK', () => {
  const readme = [
    '## Tools',
    '- [Elmo](https://github.com/elmohq/elmo) - Open-source tracker.',
  ].join('\n');

  const result = parseAwesomeInsertion(readme, {
    name: 'OpenGEO',
    repositoryUrl: 'https://github.com/cooleryu/opengeo',
    siteUrl: '',
    description: '本地 AI 搜索可见性与 GEO 审计工作台',
  });

  assert.equal(/[\u3400-\u9fff]/.test(result.insertedLine), false);
  assert.ok(result.insertedLine.includes('Open-source, local-first AI search visibility & GEO workbench.'));
});

test('parseAwesomeInsertion rejects duplicate repository links', () => {
  const readme = [
    '## Tools',
    '- [OpenGEO](https://github.com/cooleryu/opengeo) - Already listed.',
  ].join('\n');

  assert.throws(
    () =>
      parseAwesomeInsertion(readme, {
        name: 'OpenGEO',
        repositoryUrl: 'https://github.com/cooleryu/opengeo',
        siteUrl: '',
        description: 'Local workbench',
      }),
    /已经包含你的项目链接/,
  );
});

test('sanitizeAwesomePrDraft strips zero-star badge placeholders from persisted drafts', () => {
  const cleaned = sanitizeAwesomePrDraft({
    upstreamOwner: 'deeflect',
    upstreamRepo: 'awesome-geo',
    defaultBranch: 'main',
    sectionHeading: 'GEO Monitoring & Tracking',
    insertedLine: '| [OpenGEO](https://github.com/cooleryu/opengeo) | ⭐ 0 | 🔧 Tool | TypeScript | Local tool. |',
    contextSnippet: '+ | [OpenGEO](https://github.com/cooleryu/opengeo) | ⭐ 0 | 🔧 Tool | TypeScript | Local tool. |',
    prTitle: 'Add OpenGEO',
    prBody: 'Adding OpenGEO.',
  });
  assert.equal(
    cleaned.insertedLine,
    '| [OpenGEO](https://github.com/cooleryu/opengeo) | - | 🔧 Tool | TypeScript | Local tool. |',
  );
  assert.equal(
    cleaned.contextSnippet,
    '+ | [OpenGEO](https://github.com/cooleryu/opengeo) | - | 🔧 Tool | TypeScript | Local tool. |',
  );
});

test('buildDefaultShowHnDraft grounds claims strictly in actual project and batch measurements', () => {
  const genericDraft = buildDefaultShowHnDraft(
    {
      name: 'AcmeDB',
      description: 'Embedded vector index in Rust',
      repositoryUrl: 'https://github.com/acme/acmedb',
      siteUrl: '',
      targetLanguage: 'en',
    },
    null,
  );
  assert.match(genericDraft.draftTitle, /^Show HN: AcmeDB/);
  assert.equal(/homonym|awesome/i.test(genericDraft.draftBody), false);

  const batchWithAwesome: ResearchBatch = {
    id: 'batch-1',
    date: '2026-11-18',
    projectId: 'default',
    productSummary: '',
    contributionSummary: '',
    scopeNote: '',
    reportPath: '',
    sourceAuditPath: '',
    reviewPath: '',
    deferredQuestions: [],
    nextStep: '',
    questions: [
      {
        id: 'Q1',
        category: 'problem',
        zh: '向量库对比',
        en: 'Best embedded vector DB',
        decision: 'search_now',
        valueReason: 'test',
        evidenceBasis: 'test',
        answerability: 'test',
        gaps: [],
        decisionReason: 'test',
        reviewPath: '',
        diagnosis: { observed: '', hypothesis: '', nextStep: '' },
        observations: [
          {
            id: 'obs-1',
            entryType: 'web_answer',
            engine: 'chatgpt',
            language: 'en',
            query: 'Best embedded vector DB',
            recordedAt: '2026-11-18T00:00:00Z',
            status: 'found',
            summary: '',
            conditions: '',
            sources: [
              {
                title: 'awesome-rust-ai',
                url: 'https://github.com/example/awesome-rust-ai',
                kind: 'other',
              },
            ],
            evidencePath: '',
          },
        ],
      },
    ],
    answerAudits: [
      {
        projectId: 'default',
        batchId: 'batch-1',
        questionId: 'Q1',
        engine: 'chatgpt',
        language: 'en',
        recordedAt: '2026-11-18T00:00:00Z',
        mention: 'no',
        citation: 'no',
        mentionEvidence: 'Missed',
        citationEvidence: 'None',
        officialUrls: [],
        evidencePath: '',
        answerComplete: true,
      },
    ],
  };

  const measuredDraft = buildDefaultShowHnDraft(
    {
      name: 'AcmeDB',
      description: 'Embedded vector index in Rust',
      repositoryUrl: 'https://github.com/acme/acmedb',
      siteUrl: '',
      targetLanguage: 'en',
    },
    batchWithAwesome,
  );
  assert.match(measuredDraft.draftBody, /AcmeDB in 0\/1 answers/);
  assert.match(measuredDraft.draftBody, /GitHub list example\/awesome-rust-ai/);
  assert.equal(/homonym|same-named/i.test(measuredDraft.draftBody), false);
});

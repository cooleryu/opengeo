import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildCompetitorComparison,
  extractCompetitorAnswer,
  matchCompetitorNames,
  matchesOfficialUrl,
  normalizeCompetitorTarget,
  readCompetitorTarget,
  saveCompetitorTarget,
} from './competitors';
import { withGeoProject } from './projects';
import { getLatestResearch } from './research';
import { getSeed } from './seed';

test('mentions use only a readable answer section, not the query or research metadata', () => {
  assert.equal(
    extractCompetitorAnswer(
      '# Report\n- Target: Acme\n\n## Question\nAcme?\n\n## Rendered answer\nAnother product.\n\n## Inline sources\nAcme',
    ),
    'Another product.',
  );
  assert.equal(
    extractCompetitorAnswer('{"query":"Acme","summary":"Acme"}'),
    null,
  );
  assert.equal(
    extractCompetitorAnswer('{"answer_text":"Acme is discussed."}'),
    'Acme is discussed.',
  );
  assert.equal(extractCompetitorAnswer('# Report\nAcme'), null);
  assert.equal(matchCompetitorNames(null, ['Acme']).status, 'unknown');
  assert.equal(
    matchCompetitorNames('AcmeCloud is different.', ['Acme']).status,
    'not_seen',
  );
  assert.deepEqual(
    matchCompetitorNames('Try ACME and Example Brand.', [
      'Acme',
      'Example Brand',
    ]).names,
    ['Acme', 'Example Brand'],
  );
});

test('answer source appendices and capture notes do not count as body mentions', () => {
  const raw =
    '# Report\n## Answer text\nAnother product.\n\n### 引用来源\n| 来源 | 说明 |\n| Acme | 来源标题 |\n\n### 后续建议\nTry Example Brand.\n\nCapture note: Acme';
  const answer = extractCompetitorAnswer(raw);
  assert.equal(matchCompetitorNames(answer, ['Acme']).status, 'not_seen');
  assert.equal(
    matchCompetitorNames(answer, ['Example Brand']).status,
    'matched',
  );
  assert.equal(
    matchCompetitorNames(
      extractCompetitorAnswer(
        JSON.stringify({
          answer_text: 'Another product.\n\n### 主要引用来源\nAcme',
        }),
      ),
      ['Acme'],
    ).status,
    'not_seen',
  );
  assert.equal(
    extractCompetitorAnswer('## Answer text\n### 引用来源\nAcme'),
    null,
  );
});

test('link destinations and reference definitions do not count as body mentions', () => {
  const answer =
    'See [documentation](https://acme.example/docs "Acme") or https://example.com/Acme.\n[Acme]: https://example.com';
  assert.equal(matchCompetitorNames(answer, ['Acme']).status, 'not_seen');
  assert.equal(
    matchCompetitorNames('Try [Acme](https://example.com).', ['Acme']).status,
    'matched',
  );
});

test('Google comparison excludes overview and other page links from organic results', () => {
  withGeoProject('sample-project-two', () => {
    const project = getSeed().project;
    const batch = getLatestResearch(project.id)!;
    const before = JSON.stringify(batch);
    const target = normalizeCompetitorTarget({
      name: 'LoLeventVoDs',
      aliases: [],
      officialUrls: ['https://www.reddit.com/r/LoLeventVoDs/'],
    });
    const comparison = buildCompetitorComparison(
      project,
      batch,
      target,
      () => null,
    );
    const google = comparison.rows.find(
      (row) =>
        row.questionId === 'R04' &&
        row.language === 'en' &&
        row.engine === 'google',
    )!;
    assert.equal(google.sources.length, 8);
    assert.equal(
      google.sources.some((source) => source.target),
      false,
    );
    assert.equal(google.sourcesAvailable, true);
    assert.equal(google.targetMention.status, 'unknown');
    const chatgpt = comparison.rows.find(
      (row) =>
        row.questionId === 'R04' &&
        row.language === 'en' &&
        row.engine === 'chatgpt',
    )!;
    const original = batch.questions.find((question) => question.id === 'R04')!
      .observations[chatgpt.observationIndex];
    assert.equal(chatgpt.sources.length, original.sources.length);
    assert.equal(JSON.stringify(batch), before);
  });
});

test('official entry matching preserves shared-host path boundaries and excludes misleading hosts', () => {
  assert.equal(
    matchesOfficialUrl(
      'https://github.com/acme/tool/docs?tracking=1',
      'https://github.com/acme/tool',
    ),
    true,
  );
  assert.equal(
    matchesOfficialUrl(
      'https://github.com/acme/toolbox',
      'https://github.com/acme/tool',
    ),
    false,
  );
  assert.equal(
    matchesOfficialUrl(
      'https://github.com/other/tool',
      'https://github.com/acme/tool',
    ),
    false,
  );
  assert.equal(
    matchesOfficialUrl(
      'https://github.com.example.org/acme/tool',
      'https://github.com/acme/tool',
    ),
    false,
  );
  assert.equal(
    matchesOfficialUrl('https://example.com/Docs', 'https://example.com/docs'),
    false,
  );
  assert.equal(
    matchesOfficialUrl('javascript:alert(1)', 'https://example.com'),
    false,
  );
});

test('target settings are validated, persistent, and isolated per project', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opengeo-competitor-'),
  );
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    const input = {
      name: 'Example',
      aliases: ['Example', 'Example Tool'],
      officialUrls: ['https://example.com/tool?utm_source=test'],
    };
    withGeoProject('sample-project', () => {
      assert.equal(readCompetitorTarget(), null);
      saveCompetitorTarget(input);
      assert.equal(readCompetitorTarget()!.name, 'Example');
      assert.deepEqual(readCompetitorTarget()!.aliases, ['Example Tool']);
      assert.deepEqual(readCompetitorTarget()!.officialUrls, [
        'https://example.com/tool',
      ]);
    });
    withGeoProject('sample-project-two', () => {
      assert.equal(readCompetitorTarget(), null);
      saveCompetitorTarget({ ...input, name: 'Second Project' });
      assert.equal(readCompetitorTarget()!.name, 'Second Project');
    });
    withGeoProject('sample-project', () => {
      assert.equal(readCompetitorTarget()!.name, 'Example');
      saveCompetitorTarget(null);
      assert.equal(readCompetitorTarget(), null);
    });
    assert.throws(() =>
      normalizeCompetitorTarget({
        ...input,
        officialUrls: ['https://user:password@example.com'],
      }),
    );
    assert.throws(() => normalizeCompetitorTarget({ ...input, name: '' }));
    assert.throws(() =>
      normalizeCompetitorTarget({ ...input, officialUrls: [] }),
    );
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('both identities share each exact observation; unread answers stay unknown and Google stays separate', () => {
  withGeoProject('sample-project', () => {
    const project = getSeed().project;
    const batch = getLatestResearch(project.id)!;
    const before = JSON.stringify(batch);
    const target = normalizeCompetitorTarget({
      name: 'Example',
      aliases: [],
      officialUrls: ['https://example.com'],
    });
    let reads = 0;
    const comparison = buildCompetitorComparison(project, batch, target, () => {
      reads++;
      return null;
    });
    const observations = batch.questions.flatMap(
      (question) => question.observations,
    );
    assert.equal(comparison.rows.length, observations.length);
    assert.equal(
      reads,
      observations.filter(
        (item) =>
          item.engine !== 'google' &&
          item.entryType !== 'api_search' &&
          item.entryType !== 'web_search' &&
          Boolean(item.answerPath || item.entryType === 'api_answer'),
      ).length,
    );
    for (const row of comparison.rows) {
      const original = batch.questions.find(
        (question) => question.id === row.questionId,
      )!.observations[row.observationIndex];
      assert.equal(row.conditions, original.conditions);
      assert.equal(row.query, original.query);
      assert.equal(row.ownMention.status, 'unknown');
      assert.equal(row.targetMention.status, 'unknown');
      assert.equal(row.answerAvailable, false);
    }
    const readable = buildCompetitorComparison(
      project,
      batch,
      target,
      () => '## Answer text\nExample is discussed.',
    );
    for (const row of readable.rows.filter(
      (item) => item.entryType === 'api_search',
    )) {
      assert.equal(row.answerAvailable, false);
      assert.equal(row.targetMention.status, 'unknown');
      assert.equal(row.ownMention.status, 'unknown');
    }
    assert.equal(
      readable.rows.filter(
        (row) =>
          row.engine === 'chatgpt' && row.targetMention.status === 'matched',
      ).length,
      16,
    );
    assert.equal(
      readable.rows.filter(
        (row) =>
          row.engine === 'google' && row.targetMention.status !== 'unknown',
      ).length,
      0,
    );
    assert.equal(JSON.stringify(batch), before);
    assert.equal(
      buildCompetitorComparison(
        project,
        getLatestResearch('sample-project-two'),
        target,
      ).rows.length,
      0,
    );
    assert.equal(
      buildCompetitorComparison(project, batch, null).rows.length,
      0,
    );
  });
});

import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  discoverCompetitorCandidates,
  getCompetitorCandidates,
  readSavedCompetitorCandidates,
  updateCompetitorCandidate,
} from './competitor-candidates';
import {
  buildCompetitorComparison,
  normalizeCompetitorTarget,
  matchCompetitorIdentity,
  matchesOfficialUrl,
  readCompetitorObservationAnswer,
  readCompetitorTarget,
} from './competitors';
import { getSeed } from './seed';
import { getLatestResearch } from './research';
import { projectDataDirectory, withGeoProject } from './projects';
import type {
  ResearchBatch,
  ResearchObservation,
  ResearchSource,
} from './research-types';

const observation = (
  overrides: Partial<ResearchObservation> = {},
): ResearchObservation => ({
  engine: 'chatgpt',
  language: 'en',
  query: 'Which tools help?',
  recordedAt: '2026-10-29T01:00:00Z',
  status: 'not_observed',
  summary: '',
  conditions: 'same conditions',
  sources: [],
  evidencePath: 'answer.md',
  answerPath: 'answer.md',
  ...overrides,
});
const batch = (observations: ResearchObservation[]): ResearchBatch => ({
  id: 'test-batch',
  date: '2026-10-29',
  projectId: 'sample-project',
  productSummary: '',
  contributionSummary: '',
  scopeNote: '',
  reportPath: '',
  sourceAuditPath: '',
  reviewPath: '',
  questions: [
    {
      id: 'Q1',
      zh: '有哪些工具？',
      en: 'Which tools help?',
      decision: 'search_now',
      valueReason: '',
      evidenceBasis: '',
      answerability: '',
      gaps: [],
      decisionReason: '',
      reviewPath: '',
      observations,
      diagnosis: { observed: '', hypothesis: '', nextStep: '' },
    },
  ],
  deferredQuestions: [],
  nextStep: '',
});
const source = (
  url: string,
  title: string,
  kind: ResearchSource['kind'] = 'other',
): ResearchSource => ({ url, title, kind });

test('discovery excludes publishing sources, discussions, collections and own identity, preserving separate repositories', () => {
  withGeoProject('sample-project', () => {
    const project = getSeed().project;
    const b = batch([
      observation({
        sources: [
          source(
            'https://github.com/acme/Tool',
            'GitHub - acme/Tool: A useful tool',
          ),
          source('https://github.com/other/Tool', 'GitHub - other/Tool'),
          source('https://github.com/example/sample-project', 'SampleProject'),
          source('https://github.com/ruanyf/weekly/issues/12', 'Tool launch'),
          source('https://github.com/acme/awesome-tools', 'Awesome tools'),
          source('https://github.com/acme/issues-only/issues/1', 'An issue'),
          source('https://medium.com/', 'Medium'),
          source('https://media.example/articles/tool', 'Tool'),
          source('https://tool.example/', 'Tool'),
          source('https://random.example/', 'An article about Tool'),
          source(
            'https://github.com/acme/self',
            'Self submission',
            'self_submission',
          ),
        ],
      }),
    ]);
    const before = JSON.stringify(b);
    const candidates = discoverCompetitorCandidates(
      project,
      b,
      () => '## Answer text\nTry Tool.',
    );
    assert.equal(candidates.length, 3);
    assert.equal(new Set(candidates.map((candidate) => candidate.id)).size, 3);
    assert.equal(
      candidates.filter((candidate) => candidate.name === 'Tool').length,
      3,
    );
    assert.ok(
      candidates.every((candidate) => candidate.reason.includes('仍待确认')),
    );
    assert.ok(
      candidates.every((candidate) => candidate.questions[0].batchId === b.id),
    );
    assert.equal(JSON.stringify(b), before);
    assert.deepEqual(
      discoverCompetitorCandidates(project, {
        ...b,
        projectId: 'sample-project-two',
      }),
      [],
    );
    const second = discoverCompetitorCandidates(
      { ...project, id: 'sample-project-two' },
      { ...b, projectId: 'sample-project-two' },
      () => null,
    );
    assert.notEqual(second[0].id, candidates[0].id);
  });
});

test('Google discovery excludes unpositioned overview links', () => {
  const candidates = discoverCompetitorCandidates(
    getSeed().project,
    batch([
      observation({
        engine: 'google',
        sources: [source('https://github.com/acme/tool', 'Tool')],
      }),
    ]),
    () => null,
  );
  assert.deepEqual(candidates, []);
});

test('a concrete identity discovered in one question connects readable mentions in other questions without extra reads', () => {
  const b = batch([
    observation({
      answerPath: 'q1.md',
      sources: [
        source('https://github.com/acme/tool', 'Tool'),
        source('https://github.com/acme/other', 'Other'),
      ],
    }),
  ]);
  for (const [id, overrides] of [
    ['Q2', { answerPath: 'q2.md' }],
    ['Q3', { answerPath: 'q3.md', summary: 'Tool is recommended.' }],
    ['Q4', { answerPath: 'q4.md' }],
    ['Q5', { answerPath: 'q5.md' }],
  ] as [string, Partial<ResearchObservation>][]) {
    b.questions.push({
      ...b.questions[0],
      id,
      observations: [observation(overrides)],
    });
  }
  b.questions[4].category = 'brand';
  const reads: string[] = [];
  const candidates = discoverCompetitorCandidates(
    getSeed().project,
    b,
    (file) => {
      reads.push(file);
      if (file === 'q1.md' || file === 'q2.md' || file === 'q5.md')
        return '## Answer text\nUse Tool for the task.';
      if (file === 'q4.md')
        return '## Answer text\nUse [Tool](https://github.com/unrelated/tool).';
      return null;
    },
  );
  assert.equal(candidates.length, 2);
  const tool = candidates.find((candidate) => candidate.name === 'Tool')!;
  assert.deepEqual(
    tool.questions.map((item) => item.questionId),
    ['Q1', 'Q2'],
  );
  assert.equal(tool.questions[0].sourceUrl, 'https://github.com/acme/tool');
  assert.equal(tool.questions[1].sourceUrl, '');
  assert.equal(tool.questions[1].answerPath, 'q2.md');
  assert.match(tool.questions[1].excerpt, /Use Tool/);
  assert.deepEqual(reads.sort(), ['q1.md', 'q2.md', 'q3.md', 'q4.md']);
});

test('own-brand navigation cannot introduce homonyms; readable product titles provide useful repository aliases', () => {
  const b = batch([
    observation({
      sources: [source('https://github.com/acme/LLM-and-Law', 'LLM and Law')],
    }),
  ]);
  b.questions[0].zh = 'SampleProject 是什么，官方仓库在哪里？';
  assert.deepEqual(discoverCompetitorCandidates(getSeed().project, b), []);
  b.questions[0].zh =
    '无剧透回放（Spoiler-Free Replays）是什么，官方仓库在哪里？';
  assert.deepEqual(
    discoverCompetitorCandidates(
      {
        ...getSeed().project,
        name: '回放工具',
        repositoryUrl: 'https://github.com/acme/sample-project-two',
      },
      b,
    ),
    [],
  );
  b.questions[0].zh = '有什么评估工具？';
  b.questions[0].observations[0].sources = [
    source('https://github.com/UKGovernmentBEIS/inspect_ai', 'Inspect AI'),
  ];
  const candidate = discoverCompetitorCandidates(
    getSeed().project,
    b,
    () => '## Answer text\nUse Inspect AI.',
  )[0];
  assert.equal(candidate.name, 'Inspect AI');
  assert.ok(candidate.aliases.includes('inspect_ai'));
  assert.match(candidate.questions[0].excerpt, /Use Inspect AI/);
});

test('repository URL casing preserves official attribution and explicit different identities do not create a positive mention', () => {
  assert.equal(
    matchesOfficialUrl(
      'https://github.com/hkust-nlp/LOCA-bench',
      'https://github.com/hkust-nlp/loca-bench',
    ),
    true,
  );
  assert.equal(
    matchesOfficialUrl(
      'https://github.com/acme/tool/blob/main/Docs',
      'https://github.com/acme/tool/blob/main/docs',
    ),
    false,
  );
  assert.equal(
    matchCompetitorIdentity(
      'Try [Tool](https://github.com/other/Tool).',
      ['Tool'],
      ['https://github.com/acme/tool'],
    ).status,
    'unknown',
  );
  assert.equal(
    matchCompetitorIdentity(
      'Try [Tool](https://github.com/acme/Tool).',
      ['Tool'],
      ['https://github.com/acme/tool'],
    ).status,
    'matched',
  );
  assert.equal(
    matchCompetitorIdentity(
      'Try [Tool](https://github.com/other/Tool) and [Tool](https://github.com/acme/Tool).',
      ['Tool'],
      ['https://github.com/acme/tool'],
    ).status,
    'matched',
  );
});

test('comparison includes all observed questions and non-matches while unread and search-only records remain unknown', () => {
  const b = batch([
    observation({
      answerPath: 'match.md',
      collectedAt: '2026-10-29T02:00:00Z',
    }),
    observation({
      engine: 'qwen',
      entryType: 'api_answer',
      answerPath: 'negative.answer.md',
    }),
    observation({
      engine: 'doubao',
      entryType: 'api_answer',
      answerPath: 'missing.answer.md',
    }),
    observation({
      engine: 'deepseek',
      entryType: 'api_search',
      answerPath: 'match.md',
    }),
  ]);
  b.questions.push({
    ...b.questions[0],
    id: 'Q2',
    observations: [observation({ answerPath: 'negative.md' })],
  });
  const target = normalizeCompetitorTarget({
    name: 'Tool',
    aliases: [],
    officialUrls: ['https://github.com/acme/tool'],
  });
  const comparison = buildCompetitorComparison(
    getSeed().project,
    b,
    target,
    (file) =>
      file === 'match.md'
        ? '## Answer text\nTry Tool.'
        : file === 'negative.answer.md'
          ? 'Another product.'
          : file === 'negative.md'
            ? '## Answer text\nAnother product.'
            : null,
  );
  assert.equal(comparison.rows.length, 5);
  assert.deepEqual(
    comparison.rows.map((row) => row.targetMention.status),
    ['matched', 'not_seen', 'unknown', 'unknown', 'not_seen'],
  );
  assert.equal(comparison.rows[1].entryType, 'api_answer');
  assert.equal(comparison.rows[0].collectedAt, '2026-10-29T02:00:00Z');
});

test('provider answer JSON is readable but query and search results cannot become answer mentions', () => {
  const qwen = JSON.stringify({
    output: {
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Try Tool.' },
        },
      ],
      search_info: { search_results: [] },
    },
  });
  assert.equal(
    readCompetitorObservationAnswer(
      observation({
        engine: 'qwen',
        entryType: 'api_answer',
        answerPath: 'qwen.json',
      }),
      () => qwen,
    ),
    'Try Tool.',
  );
  const doubao = JSON.stringify({
    status: 'completed',
    output: [
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Try Tool.', annotations: [] }],
      },
    ],
  });
  assert.equal(
    readCompetitorObservationAnswer(
      observation({
        engine: 'doubao',
        entryType: 'api_answer',
        answerPath: 'doubao.json',
      }),
      () => doubao,
    ),
    'Try Tool.',
  );
  assert.equal(
    readCompetitorObservationAnswer(
      observation({
        engine: 'qwen',
        entryType: 'api_answer',
        answerPath: 'query.json',
      }),
      () => '{"query":"Tool","results":[]}',
    ),
    null,
  );
});

test('exact observation identity audits override same-name text and incomplete audits remain unknown', () => {
  const b = batch([observation()]);
  const project = getSeed().project;
  const target = normalizeCompetitorTarget({
    name: 'Tool',
    aliases: [],
    officialUrls: ['https://tool.example'],
  });
  b.answerAudits = [
    {
      projectId: b.projectId,
      batchId: b.id,
      questionId: 'Q1',
      engine: 'chatgpt',
      language: 'en',
      recordedAt: b.questions[0].observations[0].recordedAt,
      evidencePath: 'answer.md',
      answerComplete: true,
      mention: 'no',
      citation: 'unknown',
      mentionEvidence: 'This is the unrelated paper.',
      citationEvidence: '',
      officialUrls: [],
    },
  ];
  const compare = () =>
    buildCompetitorComparison(
      project,
      b,
      target,
      () => '## Answer text\nSampleProject is a paper. Try Tool.',
    );
  assert.equal(compare().rows[0].ownMention.status, 'not_seen');
  assert.equal(compare().rows[0].targetMention.status, 'matched');
  b.answerAudits[0].answerComplete = false;
  assert.equal(compare().rows[0].ownMention.status, 'unknown');
  assert.equal(compare().rows[0].targetMention.status, 'unknown');
  b.answerAudits[0].answerComplete = true;
  b.answerAudits[0].mention = 'yes';
  b.answerAudits[0].recordedAt = 'different time';
  assert.equal(compare().rows[0].ownMention.status, 'unknown');
  assert.equal(compare().rows[0].targetMention.status, 'unknown');
});

test('preview never saves Target; following and selection persist separately with project and batch boundaries', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opengeo-candidates-'),
  );
  const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = temporary;
  try {
    let selectedId = '';
    withGeoProject('sample-project', () => {
      const list = getCompetitorCandidates();
      assert.equal(list.candidates.length, 0);
      assert.equal(list.analysis.status, 'pending');
      const first = discoverCompetitorCandidates(getSeed().project, getLatestResearch('sample-project'))[0];
      assert.ok(first);
      selectedId = first.id;
      const preview = getCompetitorCandidates(list.batch!.id, selectedId);
      assert.ok(
        preview.comparison!.rows.length > first.questions.length,
      );
      assert.equal(readCompetitorTarget(), null);
      assert.equal(
        fs.existsSync(
          path.join(projectDataDirectory(), 'competitor-candidates.json'),
        ),
        false,
      );
      updateCompetitorCandidate('save', selectedId, list.batch!.id);
      assert.equal(readSavedCompetitorCandidates()[0].id, selectedId);
      assert.equal(readCompetitorTarget(), null);
      assert.equal(
        getCompetitorCandidates(undefined, selectedId).previewCandidate!.saved,
        true,
      );
      updateCompetitorCandidate('select', selectedId);
      assert.equal(readCompetitorTarget()!.name, first.name);
      updateCompetitorCandidate('unsave', selectedId);
      assert.equal(readSavedCompetitorCandidates().length, 0);
      assert.equal(readCompetitorTarget()!.name, first.name);
      assert.throws(
        () => getCompetitorCandidates('other-project-batch'),
        /当前项目的研究批次/,
      );
      assert.throws(
        () =>
          updateCompetitorCandidate(
            'save',
            'candidate-000000000000000000000000',
          ),
        /当前项目的候选/,
      );
    });
    withGeoProject('sample-project-two', () => {
      assert.equal(readSavedCompetitorCandidates().length, 0);
      assert.equal(readCompetitorTarget(), null);
      assert.throws(
        () => updateCompetitorCandidate('select', selectedId),
        /当前项目的候选/,
      );
    });
  } finally {
    if (previous === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

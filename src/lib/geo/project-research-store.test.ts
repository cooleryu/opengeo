import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Database from 'better-sqlite3';
import { appendProjectResearch, readLatestProjectResearch, readProjectResearchHistory } from './project-research-store';
import type { ProjectResearchSnapshot } from './project-research-types';

let temporary: string;
beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-project-research-')); });
afterEach(() => { fs.rmSync(temporary, { recursive: true, force: true }); });

function snapshot(projectId = 'project-a', runId = 'run-1'): ProjectResearchSnapshot {
  return {
    version: 1, projectId, runId, createdAt: '2026-11-11T00:00:00Z', status: 'completed',
    documents: [{ id: 'source-1', title: 'Project documentation', url: 'https://example.com/docs',
      markdown: '# Project\n\nThe project preserves source evidence.', readAt: '2026-11-11T00:00:00Z',
      type: 'website', origin: 'linked', sourcePath: 'sources/document.md' }],
    relations: [{ id: 'relation-1', kind: 'capability', statement: 'Preserves source evidence.',
      audience: 'Project users', basis: 'source', evidence: [{ sourceId: 'source-1', quote: 'preserves source evidence' }] }],
    limitations: [],
  };
}

test('research isolates projects, keeps immutable history and partial runs, and reads without creating storage', () => {
  const directory = path.join(temporary, 'data');
  assert.equal(readLatestProjectResearch(directory, 'project-a'), null);
  assert.deepEqual(readProjectResearchHistory(directory, 'project-a'), []);
  assert.equal(fs.existsSync(directory), false);

  fs.mkdirSync(directory);
  const existingDb = new Database(path.join(directory, 'db.sqlite'));
  existingDb.exec('CREATE TABLE existing_project_data (value TEXT); INSERT INTO existing_project_data VALUES (\'preserved\')');
  existingDb.close();
  assert.equal(readLatestProjectResearch(directory, 'project-a'), null);
  assert.deepEqual(readProjectResearchHistory(directory, 'project-a'), []);
  const inspectedDb = new Database(path.join(directory, 'db.sqlite'));
  assert.deepEqual(inspectedDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [{ name: 'existing_project_data' }]);
  inspectedDb.close();

  const first = snapshot();
  const otherProject = snapshot('project-b');
  otherProject.documents[0].markdown += '\nSeparate project.';
  otherProject.documents[0].ownership = 'external';
  otherProject.documents.push({ ...otherProject.documents[0], id: 'source-2', ownership: 'unknown' });
  otherProject.searches = [
    { query: 'project user needs', requestedAt: '2026-11-11T00:00:01Z', status: 'completed',
      confirmedCostCny: 0.005, reservedCostCny: 0, results: [{ title: 'A relevant source', url: 'https://example.org/source' }] },
    { query: 'additional source', requestedAt: '2026-11-11T00:00:02Z', status: 'pending',
      confirmedCostCny: null, reservedCostCny: 0.005, results: [] },
    { query: 'unavailable source', requestedAt: '2026-11-11T00:00:03Z', status: 'failed',
      confirmedCostCny: 0, reservedCostCny: 0, results: [] },
  ];
  appendProjectResearch(directory, first);
  // Older databases remain readable without altering their schema on a read.
  const legacyDb = new Database(path.join(directory, 'db.sqlite'));
  legacyDb.exec('ALTER TABLE geo_project_research_runs DROP COLUMN searches; ALTER TABLE geo_project_research_sources DROP COLUMN ownership');
  assert.deepEqual(readLatestProjectResearch(directory, 'project-a'), first);
  assert.deepEqual(readProjectResearchHistory(directory, 'project-a'), [first]);
  assert.equal((legacyDb.pragma('table_info(geo_project_research_runs)') as { name: string }[]).some(column => column.name === 'searches'), false);
  assert.equal((legacyDb.pragma('table_info(geo_project_research_sources)') as { name: string }[]).some(column => column.name === 'ownership'), false);
  legacyDb.close();
  appendProjectResearch(directory, otherProject);
  appendProjectResearch(directory, structuredClone(otherProject));
  assert.throws(() => appendProjectResearch(directory, { ...otherProject, searches: [] }), /不能覆盖/);
  assert.throws(() => appendProjectResearch(directory, { ...otherProject,
    documents: otherProject.documents.map(document => ({ ...document, ownership: 'owned' })) }), /不能覆盖/);
  appendProjectResearch(directory, structuredClone(first));
  // Object property insertion order does not change a run's content.
  appendProjectResearch(directory, { ...first, documents: first.documents.map(({ id, ...document }) => ({ ...document, id })) });
  assert.throws(() => appendProjectResearch(directory, { ...first, limitations: ['Changed payload'] }), /不能覆盖/);
  const partial = { ...snapshot('project-a', 'run-2'), status: 'partial' as const,
    searches: [], limitations: ['A linked page could not be read.'] };
  partial.documents[0].ownership = 'owned';
  appendProjectResearch(directory, partial);
  assert.deepEqual(readLatestProjectResearch(directory, 'project-a'), partial);
  assert.deepEqual(readLatestProjectResearch(directory, 'project-b'), otherProject);
  assert.equal(readLatestProjectResearch(directory, 'unknown-project'), null);
  assert.deepEqual(readProjectResearchHistory(directory, 'project-a'), [partial, first]);
  assert.deepEqual(readProjectResearchHistory(directory, 'project-b'), [otherProject]);
  const db = new Database(path.join(directory, 'db.sqlite'));
  try {
    assert.deepEqual(db.prepare('SELECT value FROM existing_project_data').get(), { value: 'preserved' });
    assert.deepEqual(db.prepare('SELECT markdown FROM geo_project_research_sources WHERE project_id = ? AND run_id = ?')
      .get(first.projectId, first.runId), { markdown: first.documents[0].markdown });
  } finally { db.close(); }
});

test('invalid source references and quotes are rejected, and a failed relation insert rolls back the complete run', () => {
  const first = snapshot();
  appendProjectResearch(temporary, first);
  const missingSource = snapshot('project-a', 'missing-source');
  missingSource.relations[0].evidence[0].sourceId = 'source-from-another-run';
  assert.throws(() => appendProjectResearch(temporary, missingSource), /来源必须属于本次/);
  const invalidQuote = snapshot('project-a', 'invalid-quote');
  invalidQuote.relations[0].evidence[0].quote = 'Preserves source evidence';
  assert.throws(() => appendProjectResearch(temporary, invalidQuote), /逐字存在/);
  const duplicateSource = snapshot('project-a', 'duplicate-source');
  duplicateSource.documents.push({ ...duplicateSource.documents[0] });
  assert.throws(() => appendProjectResearch(temporary, duplicateSource), /文档编号必须唯一/);

  const db = new Database(path.join(temporary, 'db.sqlite'));
  try {
    db.exec(`CREATE TRIGGER fail_relation_insert BEFORE INSERT ON geo_project_research_relations
      WHEN NEW.run_id = 'failed-insert' BEGIN SELECT RAISE(ABORT, 'simulated relation failure'); END;`);
    assert.throws(() => appendProjectResearch(temporary, snapshot('project-a', 'failed-insert')), /simulated relation failure/);
    for (const table of ['geo_project_research_runs', 'geo_project_research_sources', 'geo_project_research_relations']) {
      assert.deepEqual(db.prepare(`SELECT count(*) AS count FROM ${table}`).get(), { count: 1 });
    }
  } finally { db.close(); }
  assert.deepEqual(readProjectResearchHistory(temporary, 'project-a'), [first]);
  assert.deepEqual(readLatestProjectResearch(temporary, 'project-a'), first);
});

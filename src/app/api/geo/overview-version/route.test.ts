import '@/lib/geo/test-fixtures';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { GET } from './route';

test('overview notices task-only phase changes without searches or model calls', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-progress-version-'));
  const previousDirectory = process.env.DATA_DIR;
  const originalFetch = globalThis.fetch;
  process.env.DATA_DIR = directory;
  globalThis.fetch = async () => { throw new Error('No network allowed'); };
  fs.mkdirSync(path.join(directory, 'data'));
  const db = new Database(path.join(directory, 'data/db.sqlite'));
  db.exec('CREATE TABLE geo_tasks (id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const write = (phase: string) => db.prepare('INSERT OR REPLACE INTO geo_tasks VALUES (?, ?, ?)')
    .run('task-1', JSON.stringify({ status: 'investigating', projectOptimization: { phase } }), 'same-timestamp');
  const version = async (project = 'sample-project') => {
    const response = GET(new NextRequest(`http://localhost/api/geo/overview-version?project=${project}`));
    assert.equal(response.status, 200);
    return (await response.json()).version as string;
  };
  try {
    const empty = await version();
    const otherProject = await version('sample-project-two');
    write('planning');
    const planning = await version();
    assert.notEqual(planning, empty);
    assert.equal(await version(), planning);
    write('reviewing');
    assert.notEqual(await version(), planning, 'a stage change must be visible even within one timestamp');
    assert.equal(await version('sample-project-two'), otherProject, 'task updates stay in their project');
    db.prepare('DELETE FROM geo_tasks WHERE id=?').run('task-1');
    assert.equal(await version(), empty);
  } finally {
    db.close();
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDirectory;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

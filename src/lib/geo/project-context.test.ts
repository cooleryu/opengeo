import './test-fixtures';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import {
  getProjectContextPath,
  projectContextExists,
  readProjectContext,
  writeProjectContext,
} from './project-context';
import { resolveGeoProject } from './projects';

const previousDataDir = process.env.DATA_DIR;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengeo-context-'));
  process.env.DATA_DIR = tempDir;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('readProjectContext synthesizes without creating files, and writeProjectContext persists maintainer edits', () => {
  const projectId = resolveGeoProject('sample-project');
  assert.equal(projectContextExists(projectId), false);

  const initial = readProjectContext(projectId);
  assert.equal(initial.source, 'synthesized');
  assert.match(initial.markdown, /Project Fact Sheet/);
  assert.equal(fs.existsSync(getProjectContextPath(projectId)), false);
  assert.equal(fs.existsSync(path.join(tempDir, 'data', 'db.sqlite')), false);

  const custom = '# SampleProject\n\n- Core audience: Solo indie developers\n';
  const savedPath = writeProjectContext(projectId, custom);
  assert.equal(fs.existsSync(savedPath), true);
  assert.equal(projectContextExists(projectId), true);

  const reread = readProjectContext(projectId);
  assert.equal(reread.source, 'file');
  assert.equal(reread.markdown, custom);
});

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const files = [
  ...fs.globSync('scripts/**/*.test.mjs'),
  ...fs.globSync('src/**/*.test.mjs'),
  ...fs.globSync('src/**/*.test.ts'),
]
  .map((file) => file.split(path.sep).join('/'))
  .sort();

if (files.length === 0) {
  console.error('No test files matched.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', './scripts/ts-loader.mjs', '--test', ...files],
  { stdio: 'inherit' },
);
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

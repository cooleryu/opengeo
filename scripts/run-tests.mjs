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

const cjsOnlyFiles = files.filter((file) => file === 'src/lib/geo/question-planner.test.ts');
const esmFiles = files.filter((file) => file !== 'src/lib/geo/question-planner.test.ts');

for (const [groupFiles, cjsMode] of [
  [esmFiles, false],
  [cjsOnlyFiles, true],
]) {
  if (groupFiles.length === 0) continue;
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-loader.mjs', '--test', ...groupFiles],
    {
      stdio: 'inherit',
      env: cjsMode ? { ...process.env, OPENGEO_TS_CJS: '1' } : process.env,
    },
  );
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

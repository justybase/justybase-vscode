#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { checkChangedCoverage, scopeLcovReport } from './quality-gate.mjs';
import { createChangedDiff } from './quality-changed-diff.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'quality', 'quality-baseline.json'), 'utf8'));

function optionValue(prefix) {
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
}

function configuredReports() {
  const explicit = process.argv
    .filter(value => value.startsWith('--lcov-file='))
    .map(value => value.slice('--lcov-file='.length));
  const defaults = [
    'coverage/lcov.info',
    'packages/ui-core/coverage/lcov.info',
    'packages/ui-react/coverage/lcov.info',
    'apps/web/coverage/lcov.info',
    'apps/electron/coverage/lcov.info',
    'coverage/media/lcov.info',
  ];
  return [...new Set(explicit.length > 0 ? explicit : defaults)]
    .map(file => path.resolve(root, file))
    .filter(file => fs.existsSync(file));
}

try {
  const configuredBase = process.env.QUALITY_BASE_SHA ?? optionValue('--base=') ?? 'origin/master';
  const reports = configuredReports();
  if (reports.length === 0) throw new Error('Missing all configured LCOV reports. Run the root and UI coverage suites first.');
  const result = checkChangedCoverage({
    diff: createChangedDiff({ root, configuredBase }),
    lcov: reports.map(file => scopeLcovReport(fs.readFileSync(file, 'utf8'), file)),
    baseline,
  });
  console.log(JSON.stringify({ base: configuredBase, ...result }, null, 2));
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(failure);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

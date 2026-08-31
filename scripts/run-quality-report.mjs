#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { prepareQualityArtifacts } from './prepare-quality-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'artifacts', 'quality');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const maxBuffer = 64 * 1024 * 1024;

function outputText(value) {
  if (typeof value === 'string') return value;
  return value ? value.toString('utf8') : '';
}

function runCollector({ command, args, stdoutFile, stderrFile, combinedFile }) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
    maxBuffer,
  });
  const stdout = outputText(result.stdout);
  const stderr = outputText(result.stderr);

  if (combinedFile) fs.writeFileSync(path.join(artifactRoot, combinedFile), `${stdout}${stderr}`, 'utf8');
  if (stdoutFile) fs.writeFileSync(path.join(artifactRoot, stdoutFile), stdout, 'utf8');
  if (stderrFile) fs.writeFileSync(path.join(artifactRoot, stderrFile), stderr, 'utf8');

  return {
    exitCode: result.status,
    signal: result.signal ?? null,
    error: result.error?.message ?? null,
  };
}

prepareQualityArtifacts();

const commandStatuses = {
  testCoverage: runCollector({
    command: npmCommand,
    args: [
      'run',
      'test:coverage',
      '--',
      '--json',
      `--outputFile=${path.join(artifactRoot, 'jest-results.json')}`,
    ],
    combinedFile: 'jest.log',
  }),
  lint: runCollector({
    command: process.execPath,
    args: [
      path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js'),
      'media',
      'apps',
      'packages',
      'extensions',
      '--ext',
      '.ts,.tsx',
      '--format',
      'json',
    ],
    stdoutFile: 'lint.json',
    stderrFile: 'lint.log',
  }),
  audit: runCollector({
    command: npmCommand,
    args: ['audit', '--audit-level=high', '--json'],
    stdoutFile: 'audit.json',
    stderrFile: 'audit.log',
  }),
  docs: runCollector({
    command: npmCommand,
    args: ['run', 'docs:check'],
    combinedFile: 'docs.log',
  }),
  commit: runCollector({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    stdoutFile: 'commit.txt',
    stderrFile: 'commit.log',
  }),
  gitStatus: runCollector({
    command: 'git',
    args: ['status', '--short'],
    stdoutFile: 'git-status.txt',
    stderrFile: 'git-status.log',
  }),
};

fs.writeFileSync(
  path.join(artifactRoot, 'command-status.json'),
  `${JSON.stringify(commandStatuses, null, 2)}\n`,
  'utf8',
);

const reportResult = spawnSync(process.execPath, [path.join(root, 'scripts', 'quality-report.mjs')], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
const collectorFailed = Object.values(commandStatuses).some(
  status => status.exitCode !== 0 || status.signal !== null || status.error !== null,
);

if (reportResult.error) console.error(`Quality report failed to start: ${reportResult.error.message}`);
process.exitCode = reportResult.status === 0 && !collectorFailed ? 0 : 1;

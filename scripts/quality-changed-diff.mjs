#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export function createChangedDiff({ root = process.cwd(), configuredBase = process.env.QUALITY_BASE_SHA ?? 'origin/master' } = {}) {
  const git = (args, allowFailure = false) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    } catch (error) {
      if (allowFailure) return '';
      throw error;
    }
  };

  let diff;
  try {
    diff = git(['diff', '--unified=0', '--no-ext-diff', configuredBase, '--']);
  } catch (error) {
    if (process.env.QUALITY_BASE_SHA || process.env.CI === 'true') throw error;
    diff = git(['diff', '--unified=0', '--no-ext-diff', 'HEAD', '--']);
  }

  const untracked = git(['ls-files', '--others', '--exclude-standard', '--'], true)
    .split(/\r?\n/u)
    .map(value => value.trim())
    .filter(value => /\.(?:ts|tsx|mts|cts)$/u.test(value));

  for (const file of untracked) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const contents = fs.readFileSync(absolute, 'utf8');
    const lines = contents.split(/\r\n|\r|\n/u);
    const lineCount = contents.length === 0
      ? 0
      : lines[lines.length - 1] === ''
        ? lines.length - 1
        : lines.length;
    if (lineCount <= 0) continue;
    if (!diff.endsWith('\n') && diff.length > 0) diff += '\n';
    diff += `+++ b/${file}\n@@ -0,0 +1,${lineCount} @@\n`;
  }
  return diff;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(createChangedDiff());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

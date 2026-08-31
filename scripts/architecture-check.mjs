#!/usr/bin/env node

/**
 * Cheap dependency-boundary guard for the shared packages. TypeScript's module
 * graph is intentionally broad in this repository because sql-core reuses
 * parser implementation files from src/. These checks protect the stronger
 * invariant: platform-neutral packages must never import VS Code.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const boundaries = [
  'packages/contracts/src',
  'packages/sql-core/src',
  'packages/database-runtime/src',
];
const forbidden = /(?:from\s*['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)|import\s+['"]vscode['"])/u;

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesIn(absolute);
    return /\.(?:ts|tsx|mts|cts)$/u.test(entry.name) ? [absolute] : [];
  });
}

const violations = [];
for (const relativeDirectory of boundaries) {
  for (const file of filesIn(path.join(root, relativeDirectory))) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (forbidden.test(line)) violations.push(`${path.relative(root, file)}:${index + 1}`);
    });
  }
}

if (violations.length > 0) {
  console.error('Architecture boundary violations (shared packages must not import vscode):');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Architecture boundaries passed (${boundaries.length} shared package roots checked).`);

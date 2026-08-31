#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const baselinePath = path.join(root, 'quality', 'quality-baseline.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function relativePath(file) {
  return normalizePath(path.relative(root, file));
}

export function lintSummary(results) {
  const byArea = {};
  const byRule = {};
  let warnings = 0;
  let errors = 0;
  for (const result of results) {
    warnings += result.warningCount ?? 0;
    errors += result.errorCount ?? 0;
    const area = relativePath(result.filePath).split('/')[0] ?? 'other';
    byArea[area] = (byArea[area] ?? 0) + (result.warningCount ?? 0);
    for (const message of result.messages ?? []) {
      if (message.severity === 1) byRule[message.ruleId ?? 'unknown'] = (byRule[message.ruleId ?? 'unknown'] ?? 0) + 1;
    }
  }
  return { warnings, errors, byArea, byRule };
}

export function assertLintRatchet(summary, baseline) {
  const failures = [];
  if (summary.errors > 0) failures.push(`ESLint reported ${summary.errors} error(s).`);
  if (summary.warnings > baseline.lint.total) {
    failures.push(`ESLint warnings increased: ${summary.warnings} > ${baseline.lint.total}.`);
  }
  for (const [area, limit] of Object.entries(baseline.lint.areas)) {
    const actual = summary.byArea[area] ?? 0;
    if (actual > limit) failures.push(`ESLint warnings increased in ${area}: ${actual} > ${limit}.`);
  }
  return failures;
}

export function parseLcov(source) {
  const records = new Map();
  let current;
  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith('SF:')) {
      current = { lines: new Map(), branches: new Map() };
      records.set(normalizePath(line.slice(3)), current);
    } else if (current && line.startsWith('DA:')) {
      const [lineNumber, hitCount] = line.slice(3).split(',').map(Number);
      if (Number.isFinite(lineNumber) && Number.isFinite(hitCount)) current.lines.set(lineNumber, hitCount);
    } else if (current && line.startsWith('BRDA:')) {
      const [lineNumber, block, branch, taken] = line.slice(5).split(',');
      const key = `${lineNumber}:${block}:${branch}`;
      const hit = taken !== '-' && Number(taken) > 0;
      const parsedLine = Number(lineNumber);
      if (Number.isFinite(parsedLine)) current.branches.set(key, { line: parsedLine, hit });
    } else if (line === 'end_of_record') {
      current = undefined;
    }
  }
  return records;
}

function findLcovRecord(records, file) {
  const wanted = relativePath(file);
  for (const [source, record] of records) {
    const normalized = normalizePath(source);
    if (normalized === wanted || normalized.endsWith(`/${wanted}`) || path.basename(normalized) === path.basename(wanted)) return record;
  }
  return undefined;
}

export function parseChangedLines(diff) {
  const changed = new Map();
  let file;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      changed.set(file, new Set());
      continue;
    }
    if (!file || !line.startsWith('@@ ')) continue;
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const target = changed.get(file);
    if (!target || count === 0) continue;
    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) target.add(lineNumber);
  }
  return changed;
}

export function isHighRiskPath(file, roots) {
  const normalized = normalizePath(file);
  return roots.some(prefix => normalized === prefix || normalized.startsWith(prefix));
}

export function checkChangedCoverage({ diff, lcov, baseline }) {
  const changed = parseChangedLines(diff);
  const records = parseLcov(lcov);
  const failures = [];
  const files = [];
  for (const [file, lines] of changed) {
    if (!isHighRiskPath(file, baseline.changedHighRiskCoverage.roots)) continue;
    const record = findLcovRecord(records, path.join(root, file));
    if (!record) {
      failures.push(`${file}: no LCOV record was produced for changed high-risk code.`);
      continue;
    }
    const executable = [...lines].filter(line => record.lines.has(line));
    const covered = executable.filter(line => (record.lines.get(line) ?? 0) > 0);
    const linePercent = executable.length === 0 ? 100 : (covered.length / executable.length) * 100;
    const branches = [...record.branches.values()].filter(branch => lines.has(branch.line));
    const branchPercent = branches.length === 0 ? 100 : (branches.filter(branch => branch.hit).length / branches.length) * 100;
    const result = { file, executableLines: executable.length, coveredLines: covered.length, linePercent, branches: branches.length, coveredBranches: branches.filter(branch => branch.hit).length, branchPercent };
    files.push(result);
    if (linePercent < baseline.changedHighRiskCoverage.lines) failures.push(`${file}: changed line coverage ${linePercent.toFixed(2)}% < ${baseline.changedHighRiskCoverage.lines}%.`);
    if (branchPercent < baseline.changedHighRiskCoverage.branches) failures.push(`${file}: changed branch coverage ${branchPercent.toFixed(2)}% < ${baseline.changedHighRiskCoverage.branches}%.`);
  }
  return { failures, files };
}

async function readInput(file) {
  if (file) return fs.readFileSync(path.resolve(file), 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const command = process.argv[2];
  const baseline = readJson(baselinePath);
  if (command === 'lint') {
    const parsed = JSON.parse(await readInput(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : undefined));
    const summary = lintSummary(parsed);
    const failures = assertLintRatchet(summary, baseline);
    console.log(JSON.stringify(summary, null, 2));
    if (failures.length > 0) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    }
    return;
  }
  if (command === 'changed-coverage') {
    const baseOption = process.argv.find(value => value.startsWith('--base='));
    const baseIndex = process.argv.indexOf('--base');
    const base = process.env.QUALITY_BASE_SHA || baseOption?.slice('--base='.length) || (baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined) || 'unspecified';
    const lcovPath = path.join(root, 'coverage', 'lcov.info');
    if (!fs.existsSync(lcovPath)) throw new Error(`Missing ${relativePath(lcovPath)}. Run npm run test:coverage first.`);
    const diffFile = process.argv.find(value => value.startsWith('--diff-file='))?.slice('--diff-file='.length);
    const result = checkChangedCoverage({ diff: await readInput(diffFile), lcov: fs.readFileSync(lcovPath, 'utf8'), baseline });
    console.log(JSON.stringify({ base, ...result }, null, 2));
    if (result.failures.length > 0) {
      for (const failure of result.failures) console.error(failure);
      process.exitCode = 1;
    }
    return;
  }
  console.error('Usage: quality-gate.mjs lint [eslint-json-file] | changed-coverage [--diff-file=file]');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

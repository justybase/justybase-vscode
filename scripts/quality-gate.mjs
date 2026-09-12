#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const baselinePath = path.join(root, 'quality', 'quality-baseline.json');
const workspaceAreas = new Set(['src', 'media', 'apps', 'packages', 'extensions', 'Benchmark', 'scripts']);
const coverageFileExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const ignoredCoverageFilePattern = /(?:\.(?:test|spec)|(?:^|\/)(?:jest\.)?setup)\.[cm]?[jt]sx?$/u;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function relativePath(file) {
  const normalizedFile = normalizePath(file);
  const normalizedRoot = normalizePath(root).replace(/\/$/u, '');
  if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  // ESLint fixtures and some CI reporters can provide an absolute path rooted
  // outside this checkout. Recover the workspace-relative portion so area
  // aggregation remains stable across machines and runner directories.
  const segments = normalizedFile.split('/');
  const areaIndex = segments.findIndex(segment => workspaceAreas.has(segment));
  if (areaIndex >= 0) return segments.slice(areaIndex).join('/');
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
      const normalizedSource = normalizePath(line.slice(3));
      const sourceRecords = records.get(normalizedSource) ?? [];
      sourceRecords.push(current);
      records.set(normalizedSource, sourceRecords);
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

/** Merge package/app LCOV reports while preserving duplicate-source coverage. */
export function mergeLcovReports(sources) {
  const merged = new Map();
  for (const source of sources) {
    const records = parseLcov(source);
    for (const [file, fileRecords] of records) {
      const existing = merged.get(file) ?? [];
      existing.push(...fileRecords);
      merged.set(file, existing);
    }
  }
  return merged;
}

function findLcovRecords(records, file) {
  const wanted = relativePath(file);
  const exactMatches = [];

  for (const [source, sourceRecords] of records) {
    const normalized = normalizePath(source);
    if (normalized === wanted || normalized.endsWith(`/${wanted}`)) exactMatches.push(...sourceRecords);
  }

  if (exactMatches.length > 0) return exactMatches;

  const basenameMatches = [...records]
    .filter(([source]) => path.basename(normalizePath(source)) === path.basename(wanted));
  return basenameMatches.length === 1
    ? basenameMatches[0][1]
    : [];
}

function mergeLcovRecords(records) {
  const merged = { lines: new Map(), branches: new Map() };
  for (const record of records) {
    for (const [line, hitCount] of record.lines) {
      if (!merged.lines.has(line) || (merged.lines.get(line) ?? 0) < hitCount) {
        merged.lines.set(line, hitCount);
      }
    }
    for (const [key, branch] of record.branches) {
      const existing = merged.branches.get(key);
      if (!existing || (!existing.hit && branch.hit)) merged.branches.set(key, branch);
    }
  }
  return merged;
}

export function resolveLcovFiles(files) {
  const resolved = [...new Set(files)].map(file => path.resolve(root, file));
  const missing = resolved.filter(file => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Missing configured LCOV report(s): ${missing.map(file => path.relative(root, file)).join(', ')}`);
  }
  return resolved;
}

function isIstanbulIgnoredFile(file) {
  try {
    return /^\s*\/\*\s*istanbul\s+ignore\s+file\b/mu.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/** Type-only source files are declarations after TypeScript erases them. */
function isTypeOnlySource(file) {
  try {
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText
      .replace(/^"use strict";\s*/u, '')
      .replace(/^Object\.defineProperty\(exports, "__esModule", \{ value: true \}\);\s*/u, '');
    return output.trim().length === 0;
  } catch {
    return false;
  }
}

function isTypeDeclarationLine(file, lineNumber) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    let declarationLine = false;
    const visit = node => {
      const startLine = ts.getLineAndCharacterOfPosition(sourceFile, node.getStart(sourceFile)).line + 1;
      const endLine = ts.getLineAndCharacterOfPosition(sourceFile, node.end).line + 1;
      if (
        lineNumber >= startLine
        && lineNumber <= endLine
        && (
          ts.isInterfaceDeclaration(node)
          || ts.isTypeAliasDeclaration(node)
          || ts.isTypeLiteralNode(node)
          || ts.isMappedTypeNode(node)
        )
      ) {
        declarationLine = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return declarationLine;
  } catch {
    return false;
  }
}

function isLikelyNonExecutableLine(file, lineNumber) {
  if (isTypeDeclarationLine(file, lineNumber)) return true;
  try {
    const sourceLine = fs.readFileSync(file, 'utf8').split(/\r\n|\r|\n/u)[lineNumber - 1] ?? '';
    const trimmed = sourceLine.trim();
    return trimmed.length === 0
      || /^(?:\/\/|\/\*|\*|\*\/)/u.test(trimmed)
      || /^(?:export\s+)?(?:declare\s+)?(?:interface|type)\b/u.test(trimmed)
      || /^import\s+type\b/u.test(trimmed)
      || /^[{}()[\],;]+$/u.test(trimmed);
  } catch {
    return false;
  }
}

export function parseChangedLines(diff) {
  const changed = new Map();
  let file;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith('+++ b/')) {
      file = normalizePath(line.slice(6));
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

export function scopeLcovReport(source, reportPath) {
  const report = relativePath(reportPath);
  const reportDirectory = normalizePath(path.posix.dirname(report));
  const scope = reportDirectory === 'coverage'
    ? ''
    : reportDirectory.startsWith('coverage/')
      ? reportDirectory.slice('coverage/'.length)
      : reportDirectory.endsWith('/coverage')
        ? reportDirectory.slice(0, -'/coverage'.length)
        : '';
  if (!scope) return source;
  return source.split(/\r?\n/u).map(line => {
    if (!line.startsWith('SF:')) return line;
    const file = line.slice(3);
    if (file.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(file) || file.startsWith(`${scope}/`)) return line;
    return `SF:${scope}/${file}`;
  }).join('\n');
}

export function isHighRiskPath(file, roots) {
  const normalized = normalizePath(file);
  return roots.some(prefix => normalized === prefix || normalized.startsWith(prefix));
}

export function checkChangedCoverage({ diff, lcov, baseline }) {
  const changed = parseChangedLines(diff);
  const records = Array.isArray(lcov) ? mergeLcovReports(lcov) : parseLcov(lcov);
  const failures = [];
  const files = [];
  for (const [file, lines] of changed) {
    if (!isHighRiskPath(file, baseline.changedHighRiskCoverage.roots)) continue;
    if (!coverageFileExtensions.has(path.extname(file)) || file.endsWith('.d.ts') || ignoredCoverageFilePattern.test(file)) continue;
    if (isIstanbulIgnoredFile(path.join(root, file))) continue;
    const matchingRecords = findLcovRecords(records, path.join(root, file));
    if (matchingRecords.length === 0 && isTypeOnlySource(path.join(root, file))) continue;
    if (matchingRecords.length === 0) {
      failures.push(`${file}: no LCOV record was produced for changed high-risk code.`);
      continue;
    }
    const record = mergeLcovRecords(matchingRecords);
    const missingExecutable = [...lines].filter(line => !record.lines.has(line) && !isLikelyNonExecutableLine(path.join(root, file), line));
    const executable = [...lines].filter(line => record.lines.has(line) || missingExecutable.includes(line));
    const covered = executable.filter(line => (record.lines.get(line) ?? 0) > 0);
    const linePercent = executable.length === 0 ? 100 : (covered.length / executable.length) * 100;
    const branches = [...record.branches.values()].filter(branch => lines.has(branch.line));
    const branchPercent = branches.length === 0 ? 100 : (branches.filter(branch => branch.hit).length / branches.length) * 100;
    const result = { file, executableLines: executable.length, coveredLines: covered.length, linePercent, branches: branches.length, coveredBranches: branches.filter(branch => branch.hit).length, branchPercent };
    files.push(result);
    if (missingExecutable.length > 0) failures.push(`${file}: changed executable line(s) missing from LCOV: ${missingExecutable.join(', ')}.`);
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
    const explicitLcovFiles = process.argv
      .filter(value => value.startsWith('--lcov-file='))
      .map(value => value.slice('--lcov-file='.length));
    const defaultLcovFiles = [
      'coverage/lcov.info',
      'packages/ui-core/coverage/lcov.info',
      'packages/ui-react/coverage/lcov.info',
      'apps/web/coverage/lcov.info',
      'apps/electron/coverage/lcov.info',
      'coverage/media/lcov.info',
    ];
    const lcovFiles = resolveLcovFiles(explicitLcovFiles.length > 0 ? explicitLcovFiles : defaultLcovFiles);
    const diffFile = process.argv.find(value => value.startsWith('--diff-file='))?.slice('--diff-file='.length);
    const result = checkChangedCoverage({
      diff: await readInput(diffFile),
      lcov: lcovFiles.map(file => scopeLcovReport(fs.readFileSync(file, 'utf8'), file)),
      baseline,
    });
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

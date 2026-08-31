#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { assertLintRatchet, lintSummary, sha256 } from './quality-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = path.join(root, 'artifacts', 'quality');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'quality', 'quality-baseline.json'), 'utf8'));

function readJsonIfPresent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function readTextIfPresent(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function relative(file) { return path.relative(root, file).replaceAll('\\', '/'); }

function countLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/u).length - 1;
}

function sourceFiles(directory) {
  const output = [];
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...sourceFiles(file));
    else if (/\.tsx?$/u.test(entry.name) && !/(?:\.d\.ts|\.test\.|\/__tests__\/)/u.test(file)) output.push(file);
  }
  return output;
}

function filesWithSuffix(directory, suffix) {
  const output = [];
  if (!fs.existsSync(directory)) return output;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesWithSuffix(file, suffix));
    else if (entry.name.endsWith(suffix)) output.push(file);
  }
  return output;
}

function documentationSummary(log = '') {
  const roadmap = readTextIfPresent(path.join(root, 'docs', 'PROJECT_QUALITY_ROADMAP.md'));
  const audited = roadmap.match(/^Last audited:\s*(\d{4}-\d{2}-\d{2})\s*$/mu)?.[1] ?? null;
  const age = audited ? Math.max(0, Math.floor((Date.now() - Date.parse(`${audited}T00:00:00Z`)) / 86_400_000)) : null;
  const builtPages = log.match(/Documentation site built:\s*(\d+) pages?/iu)?.[1];
  let pages = builtPages === undefined ? 0 : Number(builtPages);
  if (builtPages === undefined && fs.existsSync(path.join(root, '_site'))) {
    pages = filesWithSuffix(path.join(root, '_site'), '.html').length;
  }
  const checkStatus = /docs:check passed/iu.test(log)
    ? 'pass'
    : log.trim().length > 0
      ? 'fail'
      : fs.existsSync(path.join(root, '_site')) ? 'pass' : 'missing';
  return { checkStatus, generatedPages: pages, roadmapLastAudited: audited, roadmapAgeDays: age };
}

export function buildReport({ commit = 'unknown', base = null, dirty = false, jest, coverage, lint, audit, docs, log = '' } = {}) {
  const testData = jest ?? {};
  const lintData = lint ?? { results: [] };
  const lintResult = lintData.results ? lintSummary(lintData.results) : lintData;
  const auditMetadata = audit?.metadata?.vulnerabilities;
  const vulnerabilities = auditMetadata ?? { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const auditStatus = audit === undefined
    ? 'missing'
    : auditMetadata && (Number(vulnerabilities.high) > 0 || Number(vulnerabilities.critical) > 0)
      ? 'fail'
      : auditMetadata ? 'pass' : 'missing';
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository: { commit, base, dirty },
    tests: {
      suites: { total: testData.numTotalTestSuites ?? 0, passed: testData.numPassedTestSuites ?? 0, failed: testData.numFailedTestSuites ?? 0 },
      tests: { total: testData.numTotalTests ?? 0, passed: testData.numPassedTests ?? 0, failed: testData.numFailedTests ?? 0 },
      skipped: (testData.numPendingTests ?? 0) + (testData.numTodoTests ?? 0),
      snapshots: { added: testData.snapshot?.added ?? 0, failed: testData.snapshot?.filesRemoved ?? 0, obsolete: testData.snapshot?.unchecked ?? 0 },
      naturalExit: !/force[d -]?exit|did not exit gracefully|worker process has failed to exit/iu.test(log),
    },
    coverage: {
      statements: Number(coverage?.total?.statements?.pct ?? 0),
      branches: Number(coverage?.total?.branches?.pct ?? 0),
      functions: Number(coverage?.total?.functions?.pct ?? 0),
      lines: Number(coverage?.total?.lines?.pct ?? 0),
    },
    lint: lintResult,
    modules: {
      lineLimit: baseline.largeModuleLineLimit,
      overLimit: sourceFiles(path.join(root, 'src')).map(file => ({ path: relative(file), lines: countLines(file) })).filter(item => item.lines > baseline.largeModuleLineLimit).sort((a, b) => b.lines - a.lines),
    },
    dependencies: {
      auditStatus,
      vulnerabilities,
    },
    documentation: docs ?? documentationSummary(),
    ci: {
      node: process.version,
      npmUserAgent: process.env.npm_config_user_agent ?? 'unknown',
      lockfileSha256: sha256(path.join(root, 'package-lock.json')),
      workflowSha256: Object.fromEntries(fs.readdirSync(path.join(root, '.github', 'workflows')).filter(file => file.endsWith('.yml')).sort().map(file => [file, sha256(path.join(root, '.github', 'workflows', file))])),
    },
  };
  return report;
}

function markdown(report) {
  const c = report.coverage;
  return [
    '# Quality report',
    '',
    `Commit: \`${report.repository.commit}\``,
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    `| Jest suites | ${report.tests.suites.passed}/${report.tests.suites.total} passed |`,
    `| Jest tests | ${report.tests.tests.passed}/${report.tests.tests.total} passed |`,
    `| Skipped/todo | ${report.tests.skipped} |`,
    `| Natural Jest exit | ${report.tests.naturalExit ? 'yes' : 'no'} |`,
    `| Coverage | statements ${c.statements}%, branches ${c.branches}%, functions ${c.functions}%, lines ${c.lines}% |`,
    `| Extended lint | ${report.lint.warnings} warnings, ${report.lint.errors} errors |`,
    `| Modules over ${report.modules.lineLimit} lines | ${report.modules.overLimit.length} |`,
    `| Dependency audit | ${report.dependencies.auditStatus} |`,
    `| Documentation | ${report.documentation.checkStatus}, ${report.documentation.generatedPages} generated pages |`,
    '',
  ].join('\n');
}

function main() {
  const report = buildReport({
    commit: readTextIfPresent(path.join(artifactRoot, 'commit.txt')).trim() || 'unknown',
    base: process.env.QUALITY_BASE_SHA ?? null,
    dirty: readTextIfPresent(path.join(artifactRoot, 'git-status.txt')).trim().length > 0,
    jest: readJsonIfPresent(path.join(artifactRoot, 'jest-results.json')),
    coverage: readJsonIfPresent(path.join(root, 'coverage', 'coverage-summary.json')),
    lint: { results: readJsonIfPresent(path.join(artifactRoot, 'lint.json')) ?? [] },
    audit: readJsonIfPresent(path.join(artifactRoot, 'audit.json')),
    docs: documentationSummary(readTextIfPresent(path.join(artifactRoot, 'docs.log'))),
    log: readTextIfPresent(path.join(artifactRoot, 'jest.log')),
  });
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'quality-report.v1.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(artifactRoot, 'quality-report.v1.md'), markdown(report), 'utf8');
  console.log(markdown(report));
  const coverageFailures = Object.entries(baseline.coverage)
    .filter(([metric, floor]) => report.coverage[metric] < floor)
    .map(([metric, floor]) => `${metric} coverage ${report.coverage[metric]}% < ${floor}%.`);
  const lintFailures = assertLintRatchet(report.lint, baseline);
  const failures = [
    ...coverageFailures,
    ...lintFailures,
    ...(report.tests.naturalExit ? [] : ['Jest did not terminate naturally.']),
    ...(report.tests.suites.failed > 0 || report.tests.tests.failed > 0 ? ['Jest reported failed tests.'] : []),
    ...(report.dependencies.auditStatus === 'fail' ? ['Dependency audit reported high/critical vulnerabilities or failed.'] : []),
    ...(report.documentation.checkStatus !== 'pass' ? ['Documentation check did not pass.'] : []),
  ];
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

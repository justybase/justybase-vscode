import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLintRatchet, checkChangedCoverage, lintSummary, parseChangedLines, parseLcov } from './quality-gate.mjs';
import { buildReport } from './quality-report.mjs';

const lintBaseline = { lint: { total: 3, areas: { media: 2, apps: 1 } } };

test('aggregates lint warnings by workspace area and rule', () => {
  const summary = lintSummary([
    { filePath: '/home/dusko/source/justybase-vscode/media/a.ts', warningCount: 2, errorCount: 0, messages: [{ severity: 1, ruleId: 'prefer-const' }, { severity: 1, ruleId: 'no-var' }] },
    { filePath: '/home/dusko/source/justybase-vscode/apps/a.ts', warningCount: 1, errorCount: 0, messages: [{ severity: 1, ruleId: 'prefer-const' }] },
  ]);
  assert.deepEqual(summary.byArea, { media: 2, apps: 1 });
  assert.deepEqual(summary.byRule, { 'prefer-const': 2, 'no-var': 1 });
  assert.deepEqual(assertLintRatchet(summary, lintBaseline), []);
  assert.match(assertLintRatchet({ ...summary, warnings: 4 }, lintBaseline)[0], /increased/);
});

test('parses added diff lines including one-line hunks', () => {
  const changed = parseChangedLines('+++ b/src/core/queryCancellation.ts\n@@ -4,0 +5,2 @@\n+++ b/src/state/resultSetIdentity.ts\n@@ -1 +2 @@\n');
  assert.deepEqual([...changed.get('src/core/queryCancellation.ts')], [5, 6]);
  assert.deepEqual([...changed.get('src/state/resultSetIdentity.ts')], [2]);
});

test('checks line and branch coverage only on changed executable lines', () => {
  const diff = '+++ b/src/core/queryCancellation.ts\n@@ -1 +1,3 @@\n';
  const lcov = [
    'SF:src/core/queryCancellation.ts',
    'DA:1,1', 'DA:2,0', 'DA:3,1',
    'BRDA:2,0,0,1', 'BRDA:2,0,1,-',
    'end_of_record',
  ].join('\n');
  const result = checkChangedCoverage({ diff, lcov, baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/core/'] } } });
  assert.equal(result.files[0].executableLines, 3);
  assert.equal(result.files[0].coveredLines, 2);
  assert.equal(result.files[0].branches, 2);
  assert.equal(result.failures.length, 2);
});

test('does not require branch coverage where changed lines have no branches', () => {
  const records = parseLcov('SF:src/state/a.ts\nDA:2,1\nend_of_record\n');
  assert.equal(records.size, 1);
  const result = checkChangedCoverage({
    diff: '+++ b/src/state/a.ts\n@@ -1 +2 @@\n',
    lcov: 'SF:src/state/a.ts\nDA:2,1\nend_of_record\n',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/state/'] } },
  });
  assert.deepEqual(result.failures, []);
});

test('rejects changed high-risk files missing from coverage', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/migration/migrationService.ts\n@@ -1 +1 @@\n',
    lcov: '',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/migration/'] } },
  });
  assert.match(result.failures[0], /no LCOV record/);
});

test('builds a schema-compatible report and evaluates audit/docs status', () => {
  const report = buildReport({
    commit: 'abc123',
    base: 'base123',
    jest: {
      numTotalTestSuites: 2,
      numPassedTestSuites: 2,
      numFailedTestSuites: 0,
      numTotalTests: 4,
      numPassedTests: 4,
      numFailedTests: 0,
      numPendingTests: 1,
      snapshot: { added: 0, filesRemoved: 0, unchecked: 0 },
    },
    coverage: { total: {
      statements: { pct: 71 }, branches: { pct: 58 }, functions: { pct: 76 }, lines: { pct: 72 },
    } },
    lint: { results: [] },
    audit: { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } },
    docs: { checkStatus: 'pass', generatedPages: 69, roadmapLastAudited: '2026-08-31', roadmapAgeDays: 0 },
    log: 'Test Suites: 2 passed\n',
  });
  assert.equal(report.repository.commit, 'abc123');
  assert.equal(report.tests.naturalExit, true);
  assert.deepEqual(report.coverage, { statements: 71, branches: 58, functions: 76, lines: 72 });
  assert.equal(report.dependencies.auditStatus, 'pass');
  assert.equal(report.documentation.checkStatus, 'pass');

  const failedAudit = buildReport({
    audit: { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } } },
  });
  assert.equal(failedAudit.dependencies.auditStatus, 'fail');
});

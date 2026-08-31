import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLintRatchet, checkChangedCoverage, lintSummary, parseChangedLines, parseLcov } from './quality-gate.mjs';

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

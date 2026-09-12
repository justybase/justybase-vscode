import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLintRatchet, checkChangedCoverage, lintSummary, mergeLcovReports, parseChangedLines, parseLcov } from './quality-gate.mjs';
import { createChangedDiff } from './quality-changed-diff.mjs';
import { prepareQualityArtifacts } from './prepare-quality-artifacts.mjs';
import { buildReport, qualityInputFailures } from './quality-report.mjs';

const lintBaseline = { lint: { total: 3, areas: { media: 2, apps: 1 } } };

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function commitGitFixture(root, message) {
  return runGit(root, [
    '-c', 'user.name=Quality Tests',
    '-c', 'user.email=quality@example.invalid',
    'commit', '-m', message,
  ]);
}

test('includes staged and unstaged tracked edits when the base resolves', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-quality-git-'));
  const source = path.join(temporaryRoot, 'src', 'tracked.ts');

  try {
    runGit(temporaryRoot, ['init']);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export const initial = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    commitGitFixture(temporaryRoot, 'initial');

    fs.appendFileSync(source, 'export const committed = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    commitGitFixture(temporaryRoot, 'committed change');

    fs.appendFileSync(source, 'export const staged = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    fs.appendFileSync(source, 'export const working = true;\n');

    const diff = createChangedDiff({ root: temporaryRoot, configuredBase: 'HEAD~1' });
    assert.match(diff, /\+export const staged = true;/u);
    assert.match(diff, /\+export const working = true;/u);
    assert.deepEqual([...parseChangedLines(diff).get('src/tracked.ts')], [2, 3, 4]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('uses the merge base when the configured branch has diverged', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-quality-git-'));
  const source = path.join(temporaryRoot, 'src', 'tracked.ts');

  try {
    runGit(temporaryRoot, ['init']);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'export const initial = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    commitGitFixture(temporaryRoot, 'initial');

    const featureBranch = runGit(temporaryRoot, ['branch', '--show-current']).trim();
    runGit(temporaryRoot, ['branch', 'base']);

    fs.appendFileSync(source, 'export const feature = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    commitGitFixture(temporaryRoot, 'feature change');

    runGit(temporaryRoot, ['checkout', 'base']);
    fs.appendFileSync(source, 'export const baseOnly = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    commitGitFixture(temporaryRoot, 'base change');

    runGit(temporaryRoot, ['checkout', featureBranch]);
    fs.appendFileSync(source, 'export const staged = true;\n');
    runGit(temporaryRoot, ['add', 'src/tracked.ts']);
    fs.appendFileSync(source, 'export const working = true;\n');

    const diff = createChangedDiff({ root: temporaryRoot, configuredBase: 'base' });
    assert.match(diff, /\+export const feature = true;/u);
    assert.match(diff, /\+export const staged = true;/u);
    assert.match(diff, /\+export const working = true;/u);
    assert.doesNotMatch(diff, /baseOnly/u);
    assert.deepEqual([...parseChangedLines(diff).get('src/tracked.ts')], [2, 3, 4]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('includes the final line of an untracked file without a trailing newline', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-quality-git-'));
  const source = path.join(temporaryRoot, 'README.md');
  const untracked = path.join(temporaryRoot, 'src', 'untracked.ts');

  try {
    runGit(temporaryRoot, ['init']);
    fs.writeFileSync(source, 'fixture\n');
    runGit(temporaryRoot, ['add', 'README.md']);
    commitGitFixture(temporaryRoot, 'initial');

    fs.mkdirSync(path.dirname(untracked), { recursive: true });
    fs.writeFileSync(untracked, 'export const untracked = true;');

    const diff = createChangedDiff({ root: temporaryRoot, configuredBase: 'HEAD' });
    assert.match(diff, /\+\+\+ b\/src\/untracked\.ts\n@@ -0,0 \+1,1 @@/u);
    assert.deepEqual([...parseChangedLines(diff).get('src/untracked.ts')], [1]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('all first-party workspace packages declare their distribution license', () => {
  const packagesRoot = path.resolve(process.cwd(), 'packages');
  const packageDirectories = fs.readdirSync(packagesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(packagesRoot, entry.name));

  for (const packageDirectory of packageDirectories) {
    const manifestPath = path.join(packageDirectory, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const hasLicenseFile = fs.readdirSync(packageDirectory)
      .some(name => /^(licen[cs]e|copying|notice)(\.|$)/iu.test(name));
    assert.ok(
      typeof manifest.license === 'string' || hasLicenseFile,
      `${manifest.name ?? manifestPath} must declare a license or ship license text`,
    );
  }
});

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

test('prefers the full LCOV path over an earlier duplicate basename', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/core/index.ts\n@@ -1 +2 @@\n',
    lcov: [
      'SF:src/other/index.ts',
      'DA:2,0',
      'end_of_record',
      'SF:src/core/index.ts',
      'DA:2,1',
      'end_of_record',
    ].join('\n'),
    baseline: { changedHighRiskCoverage: { lines: 100, branches: 100, roots: ['src/core/'] } },
  });

  assert.equal(result.files[0].coveredLines, 1);
  assert.deepEqual(result.failures, []);
});

test('merges duplicate LCOV records for the same source file', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/activation/resultPanelRegression.ts\n@@ -1 +2 @@\n',
    lcov: [
      'SF:src/activation/resultPanelRegression.ts',
      'DA:2,0',
      'BRDA:2,0,0,-',
      'end_of_record',
      'SF:/home/dusko/source/justybase-vscode/src/activation/resultPanelRegression.ts',
      'DA:2,1',
      'BRDA:2,0,0,1',
      'end_of_record',
    ].join('\n'),
    baseline: { changedHighRiskCoverage: { lines: 100, branches: 100, roots: ['src/activation/'] } },
  });

  assert.equal(result.files[0].coveredLines, 1);
  assert.equal(result.files[0].coveredBranches, 1);
  assert.deepEqual(result.failures, []);
});

test('merges LCOV reports from separate UI/package collectors', () => {
  const merged = mergeLcovReports([
    'SF:packages/ui-core/src/reducer.ts\nDA:10,1\nend_of_record\n',
    'SF:apps/web/src/sharedUiAdapter.tsx\nDA:12,1\nend_of_record\n',
  ]);
  assert.deepEqual([...merged.keys()], ['packages/ui-core/src/reducer.ts', 'apps/web/src/sharedUiAdapter.tsx']);
  assert.equal(merged.get('packages/ui-core/src/reducer.ts')?.length, 1);
  assert.equal(merged.get('apps/web/src/sharedUiAdapter.tsx')?.length, 1);
});

test('handles Windows LCOV paths and changed filenames containing spaces', () => {
  const source = 'apps/web/src/feature with spaces.tsx';
  const result = checkChangedCoverage({
    diff: `+++ b/${source}\n@@ -1 +1 @@\n`,
    lcov: `SF:C:\\runner\\workspace\\${source.replaceAll('/', '\\\\')}\nDA:1,1\nBRDA:1,0,0,1\nend_of_record\n`,
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['apps/web/'] } },
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.files[0].coveredLines, 1);
  assert.equal(result.files[0].coveredBranches, 1);
});

test('fails a changed line that was collected but never executed', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/packages/ui-core/src/reducer.ts\n@@ -1 +10 @@\n',
    lcov: 'SF:packages/ui-core/src/reducer.ts\nDA:10,0\nend_of_record\n',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['packages/ui-core/'] } },
  });
  assert.equal(result.files[0].coveredLines, 0);
  assert.match(result.failures[0], /changed line coverage/);
});

test('fails a changed executable line missing from LCOV', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/core/missingCoverage.ts\n@@ -1 +2 @@\n',
    lcov: 'SF:src/core/missingCoverage.ts\nDA:1,1\nend_of_record\n',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/core/'] } },
  });
  assert.match(result.failures[0], /missing from LCOV/);
});

test('merges exact duplicate LCOV records in either order, including branches', () => {
  const source = 'src/activation/resultPanelRegression.ts';
  for (const [firstLineHit, secondLineHit, firstBranchHit, secondBranchHit] of [
    [0, 1, '-', '1'],
    [1, 0, '1', '-'],
  ]) {
    const records = parseLcov([
      `SF:${source}`,
      `DA:2,${firstLineHit}`,
      `BRDA:2,0,0,${firstBranchHit}`,
      'end_of_record',
      `SF:${source}`,
      `DA:2,${secondLineHit}`,
      `BRDA:2,0,0,${secondBranchHit}`,
      'end_of_record',
    ].join('\n'));
    assert.equal(records.get(source)?.length, 2);

    const result = checkChangedCoverage({
      diff: `+++ b/${source}\n@@ -1 +2 @@\n`,
      lcov: [
        `SF:${source}`,
        `DA:2,${firstLineHit}`,
        `BRDA:2,0,0,${firstBranchHit}`,
        'end_of_record',
        `SF:${source}`,
        `DA:2,${secondLineHit}`,
        `BRDA:2,0,0,${secondBranchHit}`,
        'end_of_record',
      ].join('\n'),
      baseline: { changedHighRiskCoverage: { lines: 100, branches: 100, roots: ['src/activation/'] } },
    });

    assert.equal(result.files[0].coveredLines, 1);
    assert.equal(result.files[0].coveredBranches, 1);
    assert.deepEqual(result.failures, []);
  }
});

test('merges duplicate basename-only LCOV records for one source key', () => {
  const source = 'index.ts';
  const lcov = [
    `SF:${source}`,
    'DA:2,0',
    'BRDA:2,0,0,-',
    'end_of_record',
    `SF:${source}`,
    'DA:2,1',
    'BRDA:2,0,0,1',
    'end_of_record',
  ].join('\n');

  const result = checkChangedCoverage({
    diff: '+++ b/src/activation/index.ts\n@@ -1 +2 @@\n',
    lcov,
    baseline: { changedHighRiskCoverage: { lines: 100, branches: 100, roots: ['src/activation/'] } },
  });

  assert.equal(result.files[0].coveredLines, 1);
  assert.equal(result.files[0].coveredBranches, 1);
  assert.deepEqual(result.failures, []);
});

test('rejects an ambiguous LCOV basename fallback', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/core/index.ts\n@@ -1 +2 @@\n',
    lcov: [
      'SF:generated/first/index.ts',
      'DA:2,1',
      'end_of_record',
      'SF:generated/second/index.ts',
      'DA:2,1',
      'end_of_record',
    ].join('\n'),
    baseline: { changedHighRiskCoverage: { lines: 100, branches: 100, roots: ['src/core/'] } },
  });

  assert.equal(result.files.length, 0);
  assert.match(result.failures[0], /no LCOV record/);
});

test('rejects changed high-risk files missing from coverage', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/migration/migrationService.ts\n@@ -46 +46 @@\n',
    lcov: '',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/migration/'] } },
  });
  assert.match(result.failures[0], /no LCOV record/);
});

test('allows type-only declarations and test setup files without executable coverage', () => {
  const typeOnly = path.resolve(process.cwd(), 'packages/ui-core/src/types.ts');
  const setup = path.resolve(process.cwd(), 'packages/ui-react/jest.setup.ts');
  const typeOnlyResult = checkChangedCoverage({
    diff: '+++ b/packages/ui-core/src/types.ts\n@@ -1 +1 @@\n',
    lcov: '',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['packages/ui-core/'] } },
  });
  const setupResult = checkChangedCoverage({
    diff: '+++ b/packages/ui-react/jest.setup.ts\n@@ -1 +1 @@\n',
    lcov: '',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['packages/ui-react/'] } },
  });
  assert.deepEqual(typeOnlyResult.failures, []);
  assert.deepEqual(setupResult.failures, []);
  assert.equal(fs.existsSync(typeOnly), true);
  assert.equal(fs.existsSync(setup), true);
});

test('ignores type members inside executable TypeScript modules', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/contracts/webview/webviewContracts.ts\n@@ -72 +73 @@\n',
    lcov: 'SF:src/contracts/webview/webviewContracts.ts\nDA:1,1\nend_of_record\n',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/contracts/'] } },
  });
  assert.deepEqual(result.failures, []);
  assert.equal(result.files[0]?.executableLines, 0);
});

test('does not require an LCOV record for changed declaration-only files', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/media/resultPanel/databaseGrouping.ts\n@@ -30 +31 @@\n',
    lcov: '',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['media/resultPanel/'] } },
  });
  assert.deepEqual(result.failures, []);
});

test('does not require LCOV for Istanbul-ignored files', () => {
  const result = checkChangedCoverage({
    diff: '+++ b/src/activation/resultPanelFilterPerformance.ts\n@@ -1 +1 @@\n',
    lcov: '',
    baseline: { changedHighRiskCoverage: { lines: 80, branches: 70, roots: ['src/'] } },
  });
  assert.deepEqual(result.failures, []);
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

test('removes stale quality and coverage artifacts before collection', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-quality-'));
  const artifactRoot = path.join(temporaryRoot, 'artifacts', 'quality');
  const coverageRoot = path.join(temporaryRoot, 'coverage');

  try {
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(coverageRoot, { recursive: true });
    fs.writeFileSync(path.join(artifactRoot, 'jest-results.json'), '{"stale":true}\n');
    fs.writeFileSync(path.join(coverageRoot, 'coverage-summary.json'), '{"stale":true}\n');

    prepareQualityArtifacts({ artifactRoot, coverageRoot });

    assert.equal(fs.existsSync(path.join(artifactRoot, 'jest-results.json')), false);
    assert.equal(fs.existsSync(path.join(coverageRoot, 'coverage-summary.json')), false);
    assert.equal(fs.existsSync(artifactRoot), true);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('rejects failed collectors and missing quality inputs', () => {
  const successfulStatuses = Object.fromEntries(
    ['testCoverage', 'lint', 'audit', 'docs', 'commit', 'gitStatus'].map(name => [name, { exitCode: 0, signal: null, error: null }]),
  );
  const validInputs = {
    commandStatuses: successfulStatuses,
    jest: { numTotalTestSuites: 1, numTotalTests: 1 },
    coverage: { total: {
      statements: { pct: 71 }, branches: { pct: 58 }, functions: { pct: 76 }, lines: { pct: 72 },
    } },
    lintResults: [],
    audit: { metadata: { vulnerabilities: { high: 0, critical: 0 } } },
    documentation: { checkStatus: 'pass' },
    commit: 'abc123',
  };

  assert.deepEqual(qualityInputFailures(validInputs), []);
  assert.match(qualityInputFailures({
    ...validInputs,
    commandStatuses: { ...successfulStatuses, audit: { exitCode: 1, signal: null, error: null } },
  })[0], /audit collector exited with code 1/);
  assert.match(qualityInputFailures({ ...validInputs, lintResults: undefined }).join('\n'), /lint artifact/);
  assert.match(qualityInputFailures({ ...validInputs, audit: undefined }).join('\n'), /audit artifact/);
});

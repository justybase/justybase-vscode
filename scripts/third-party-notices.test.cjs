const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const generatorPath = path.join(root, 'scripts', 'generate-third-party-notices.js');

/**
 * Builds a throwaway optional-extension package whose lockfile lists only its own
 * dependency, while its bundle source map also inlines `bundledSources`.
 */
function createFixturePackage(bundledSources) {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-third-party-notices-'));
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'fixture-extension',
    displayName: 'Fixture Extension',
    version: '1.0.0',
    license: 'Apache-2.0',
  }));
  fs.writeFileSync(path.join(packageDir, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'fixture-extension', version: '1.0.0' } },
  }));
  fs.mkdirSync(path.join(packageDir, 'dist'));
  fs.writeFileSync(path.join(packageDir, 'dist', 'extension.js.map'), JSON.stringify({
    version: 3,
    sources: bundledSources,
    names: [],
    mappings: '',
  }));
  return packageDir;
}

function runGenerator(packageDir) {
  return execFileSync(process.execPath, [generatorPath, packageDir], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('notices attribute packages inlined into the bundle even when the lockfile omits them', () => {
  const chevrotain = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'chevrotain', 'package.json'), 'utf8'));
  const packageDir = createFixturePackage(['../../../node_modules/chevrotain/src/api.ts']);
  try {
    runGenerator(packageDir);

    const notices = fs.readFileSync(path.join(packageDir, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    assert.match(notices, new RegExp(`\\| chevrotain \\| ${chevrotain.version.replaceAll('.', '\\.')} \\| Apache-2\\.0 \\|`));
    assert.match(notices, /### .*chevrotain@/u);
    assert.match(notices, /Apache License/u);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

test('notices fail loudly when a bundled package is not installed', () => {
  const packageDir = createFixturePackage(['../../../node_modules/__jb_missing_bundled_package__/index.js']);
  try {
    assert.throws(
      () => runGenerator(packageDir),
      error => {
        assert.match(String(error.stderr), /Bundled package __jb_missing_bundled_package__ is not installed/u);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(packageDir, 'THIRD_PARTY_NOTICES.md')), false);
  } finally {
    fs.rmSync(packageDir, { recursive: true, force: true });
  }
});

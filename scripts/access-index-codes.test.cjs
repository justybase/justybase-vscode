const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  canonicalizeResource,
  normalizeLineEndings,
  renderGeneratedFile,
  sha256File,
  sha256Text,
} = require('./generate-index-codes.cjs');

const root = path.resolve(__dirname, '..');

test('Access index-code manifest pins a revision and all source resources', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'tools/access-ddl-compare/access-index-codes.manifest.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.upstream.ref, /^[a-f0-9]{40}$/u);
  assert.ok(manifest.sources.length >= 1);
  for (const source of manifest.sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(source.file);
    assert.ok(source.name);
  }
});

test('Access index-code rendering is deterministic and explicitly generated', () => {
  const output = renderGeneratedFile([
    { name: 'FIRST', lines: ['A', 'B'] },
    { name: 'SECOND', lines: ['C'] },
  ]);

  assert.match(output, /^\/\* istanbul ignore file \*\//u);
  assert.match(output, /@generated/u);
  assert.match(output, /export const FIRST/u);
  assert.match(output, /export const SECOND/u);
  assert.equal(
    sha256Text(canonicalizeResource('A\r\nB\n\n')),
    sha256Text('A\nB'),
  );
});

test('generated output checksums tolerate Windows line endings', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-access-index-codes-'));
  const outputPath = path.join(tempDir, 'generated.ts');
  const rendered = renderGeneratedFile([{ name: 'FIRST', lines: ['A', 'B'] }]);

  try {
    fs.writeFileSync(outputPath, rendered.replace(/\n/g, '\r\n'), 'utf8');
    assert.equal(sha256File(outputPath), sha256Text(normalizeLineEndings(rendered)));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

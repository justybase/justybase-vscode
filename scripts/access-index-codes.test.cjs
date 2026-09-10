const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { canonicalizeResource, renderGeneratedFile, sha256Text } = require('./generate-index-codes.cjs');

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

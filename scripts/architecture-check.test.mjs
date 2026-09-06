import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findArchitectureViolations } from './architecture-check.mjs';

function createFixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-architecture-'));
}

function writeFixture(root, relativePath, source) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${source}\n`, 'utf8');
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('passes the repository shared-package boundaries', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '..');
  assert.deepEqual(findArchitectureViolations(repositoryRoot), []);
});

test('reports vscode imports from every shared package root', () => {
  const root = createFixture();
  try {
    for (const packageName of ['contracts', 'sql-core', 'database-runtime', 'designer-core']) {
      writeFixture(root, `packages/${packageName}/src/invalid.ts`, "import * as vscode from 'vscode';");
    }

    const violations = findArchitectureViolations(root);
    assert.equal(violations.length, 4);
    assert.ok(violations.every(violation => violation.endsWith(':1')));
  } finally {
    removeFixture(root);
  }
});

test('reports platform imports from designer-core', () => {
  const root = createFixture();
  try {
    writeFixture(root, 'packages/designer-core/src/invalid.ts', "import { useState } from 'react';");

    assert.deepEqual(findArchitectureViolations(root), [
      'packages/designer-core/src/invalid.ts:1 (designer-core platform import)',
    ]);
  } finally {
    removeFixture(root);
  }
});

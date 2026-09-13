import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const graphScript = path.join(repositoryRoot, 'scripts/workspace-build-graph.mjs');

function runWebBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [graphScript, 'web'], {
      cwd: repositoryRoot,
      env: { ...process.env, CI: '1' },
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('serializes two concurrent Web builds without corrupting workspace output', async () => {
  const results = await Promise.all([runWebBuild(), runWebBuild()]);
  for (const result of results) {
    assert.equal(result.signal, null);
    assert.equal(result.code, 0);
  }
});

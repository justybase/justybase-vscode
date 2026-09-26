import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const graphScript = path.join(repositoryRoot, 'scripts/workspace-build-graph.mjs');

function runRetiredWebBuildTarget() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [graphScript, 'web'], {
      cwd: repositoryRoot,
      env: { ...process.env, CI: '1' },
      stdio: 'pipe',
      windowsHide: false,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
}

test('the workspace build graph rejects the retired web target', async () => {
  const result = await runRetiredWebBuildTarget();
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /<shared\|desktop\|bundle>/);
});

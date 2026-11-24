const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_CACHE_PATH,
  describeVSCodeTestFailure,
  resolveVSCodeExecutable,
  toVSCodeTestError,
} = require('./vscodeTestRuntime');

function temporaryExecutable() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-vscode-test-runtime-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'Code.exe' : 'code');
  fs.writeFileSync(executable, '');
  return { directory, executable };
}

test('describeVSCodeTestFailure always returns a readable, non-empty reason', () => {
  assert.equal(describeVSCodeTestFailure(new Error('boom')), 'boom');
  assert.equal(describeVSCodeTestFailure(new TypeError('')), 'TypeError (no message)');
  // @vscode/test-electron rejects with a bare string when the release API
  // answers with a non-200 status; that used to surface as an empty message.
  assert.equal(describeVSCodeTestFailure('Failed to get JSON'), 'Failed to get JSON');
  // Node's connector rejects with an AggregateError whose own message is empty.
  assert.equal(
    describeVSCodeTestFailure(new AggregateError([
      new Error('connect ECONNREFUSED 1.2.3.4:443'),
      new Error('connect ENETUNREACH [::1]:443'),
    ])),
    'AggregateError (connect ECONNREFUSED 1.2.3.4:443; connect ENETUNREACH [::1]:443)',
  );
  assert.equal(describeVSCodeTestFailure(undefined), 'unknown error (the VS Code download step rejected without a message)');
  assert.equal(describeVSCodeTestFailure('   '), 'unknown error (the VS Code download step rejected without a message)');
});

test('resolveVSCodeExecutable returns the resolved path without retrying', async () => {
  const { directory, executable } = temporaryExecutable();
  const calls = [];
  try {
    const resolved = await resolveVSCodeExecutable({
      download: async options => {
        calls.push(options);
        return executable;
      },
      log: () => {},
    });
    assert.equal(resolved, executable);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cachePath, DEFAULT_CACHE_PATH);
    assert.equal(calls[0].extensionDevelopmentPath, path.resolve(__dirname, '..', '..'));
    assert.equal(calls[0].version, undefined, 'stable is left to the library so a cached install wins');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('resolveVSCodeExecutable forwards an explicit version and reports the attempts', async () => {
  const attempts = [];
  await assert.rejects(
    resolveVSCodeExecutable({
      version: '1.104.0',
      attempts: 3,
      retryDelayMs: 0,
      sleep: async () => {},
      log: () => {},
      download: async options => {
        attempts.push(options.version);
        throw new Error(`cdn unavailable (${attempts.length})`);
      },
    }),
    error => {
      assert.match(error.message, /Could not prepare VS Code 1\.104\.0/u);
      assert.match(error.message, /3 attempt\(s\)/u);
      assert.match(error.message, /cdn unavailable \(3\)/u);
      return true;
    },
  );
  assert.deepEqual(attempts, ['1.104.0', '1.104.0', '1.104.0']);
});

test('resolveVSCodeExecutable treats a missing executable as a failed attempt', async () => {
  const { directory, executable } = temporaryExecutable();
  const missing = path.join(directory, 'gone', 'Code.exe');
  try {
    await assert.rejects(
      resolveVSCodeExecutable({
        attempts: 2,
        retryDelayMs: 0,
        sleep: async () => {},
        log: () => {},
        download: async () => missing,
      }),
      /the VS Code executable is missing after resolution/u,
    );
    assert.ok(fs.existsSync(executable));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('toVSCodeTestError keeps a usable Error and repairs the empty ones', () => {
  const usable = new Error('scenario failed');
  assert.equal(toVSCodeTestError(usable), usable);

  // The CI failure surfaced as "iteration(s) failed: " because an
  // AggregateError with no message was rethrown unchanged.
  const aggregate = new AggregateError([new Error('connect ETIMEDOUT 10.0.0.1:443')]);
  assert.equal(aggregate.message, '');
  const repaired = toVSCodeTestError(aggregate);
  assert.ok(repaired instanceof Error);
  assert.equal(repaired.message, 'AggregateError (connect ETIMEDOUT 10.0.0.1:443)');

  assert.equal(toVSCodeTestError('Failed to get JSON').message, 'Failed to get JSON');
});

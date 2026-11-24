const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  ACCESS_FILE_PACKAGE,
  ACCESS_FILE_SOURCE,
  installAccessFileSourceHook,
  resolveAccessFileSource,
} = require('./access-file-source-runtime.cjs');

test('resolveAccessFileSource maps the package root and its subpaths', () => {
  assert.equal(resolveAccessFileSource(ACCESS_FILE_PACKAGE), ACCESS_FILE_SOURCE);
  assert.equal(
    resolveAccessFileSource(`${ACCESS_FILE_PACKAGE}/jet/JetPageChannel`),
    path.join(ACCESS_FILE_SOURCE, 'jet', 'JetPageChannel'),
  );
  assert.equal(
    resolveAccessFileSource(`${ACCESS_FILE_PACKAGE}/complexValues`),
    path.join(ACCESS_FILE_SOURCE, 'complexValues'),
  );
});

test('resolveAccessFileSource leaves every other specifier alone', () => {
  assert.equal(resolveAccessFileSource('vscode'), undefined);
  assert.equal(resolveAccessFileSource('node:path'), undefined);
  assert.equal(resolveAccessFileSource('@justybase/contracts'), undefined);
  // A near-miss must not be captured by the prefix check.
  assert.equal(resolveAccessFileSource('@justybase/access-file-extra'), undefined);
  assert.equal(resolveAccessFileSource(undefined), undefined);
});

test('installAccessFileSourceHook rewrites only the Access package and can be undone', () => {
  const loaded = [];
  const fakeModule = {
    _load(request) {
      loaded.push(request);
      return { request };
    },
  };

  const uninstall = installAccessFileSourceHook(fakeModule);
  try {
    // eslint-disable-next-line no-underscore-dangle
    fakeModule._load(`${ACCESS_FILE_PACKAGE}/jet/JetLayout`, {}, false);
    // eslint-disable-next-line no-underscore-dangle
    fakeModule._load('vscode', {}, false);
  } finally {
    uninstall();
  }

  assert.deepEqual(loaded, [
    path.join(ACCESS_FILE_SOURCE, 'jet', 'JetLayout'),
    'vscode',
  ]);
});

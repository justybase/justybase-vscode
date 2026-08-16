import { lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveLocalDatabasePath } from '../src/localDatabaseSandbox';

describe('local database sandbox', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'justybase-local-sandbox-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps each local database in the user directory and allows memory databases', () => {
    expect(resolveLocalDatabasePath('warehouse.sqlite', { root, userId: 'user-1' })).toBe(path.join(root, 'user-1', 'warehouse.sqlite'));
    expect(resolveLocalDatabasePath(':memory:', { root, userId: 'user-1' })).toBe(':memory:');
  });

  it('rejects traversal, absolute paths, URI paths, and invalid user scopes', () => {
    const options = { root, userId: 'user-1' };
    expect(() => resolveLocalDatabasePath('../outside.sqlite', options)).toThrow();
    expect(() => resolveLocalDatabasePath('nested/../../outside.sqlite', options)).toThrow();
    expect(() => resolveLocalDatabasePath('..\\outside.sqlite', options)).toThrow();
    expect(() => resolveLocalDatabasePath(path.join(root, 'outside.sqlite'), options)).toThrow();
    expect(() => resolveLocalDatabasePath('file:outside.sqlite', options)).toThrow();
    expect(() => resolveLocalDatabasePath('database.sqlite', { root, userId: '../other-user' })).toThrow();
  });

  it('rejects symlinks that leave the per-user sandbox', () => {
    const userRoot = path.join(root, 'user-1');
    const outside = mkdtempSync(path.join(os.tmpdir(), 'justybase-local-outside-'));
    mkdirSync(userRoot, { recursive: true });
    symlinkSync(outside, path.join(userRoot, 'linked'));
    try {
      expect(() => resolveLocalDatabasePath('linked/database.sqlite', { root, userId: 'user-1' })).toThrow(/symlink|sandbox/i);
      expect(lstatSync(path.join(userRoot, 'linked')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface LocalDatabaseSandboxOptions {
  root: string;
  userId: string;
  createUserDirectory?: boolean;
}

function normalized(value: string): string {
  return path.resolve(value);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function rejectTraversal(value: string): void {
  // Check both separators so a Windows-style path cannot be used to bypass
  // the check when the API runs on POSIX (and vice versa).
  if (value.split(/[\\/]/u).some(part => part === '..')) throw new Error('Local database paths cannot contain ".." segments.');
  if (value.includes('\u0000')) throw new Error('Local database paths cannot contain NUL characters.');
}

function realPathOrParent(filePath: string): string {
  if (existsSync(filePath)) return realpathSync.native(filePath);
  let current = path.dirname(filePath);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(realpathSync.native(current), path.relative(current, filePath));
}

function rejectEscapingSymlink(userRoot: string, candidate: string): void {
  let current = userRoot;
  for (const segment of path.relative(userRoot, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (!lstatSync(current).isSymbolicLink()) continue;
      const target = realpathSync.native(current);
      if (!isWithin(userRoot, target)) throw new Error('Local database symlinks cannot escape the per-user sandbox.');
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('cannot escape')) throw error;
      // lstat succeeds for dangling links, while realpath does not. Reject
      // them because opening the path could create a file at an unknown target.
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Dangling local database symlinks are not allowed.');
      } catch (nested: unknown) {
        if (nested instanceof Error && nested.message.includes('not allowed')) throw nested;
      }
    }
  }
}

/**
 * Resolve a local SQLite/DuckDB file into the per-user sandbox.
 *
 * The lexical check prevents traversal and the real-path check prevents a
 * symlink (including a symlinked parent directory) from escaping the user's
 * directory. `:memory:` is deliberately kept as the only non-file target.
 */
export function resolveLocalDatabasePath(database: string, options: LocalDatabaseSandboxOptions): string {
  const requested = database.trim();
  if (requested === ':memory:') return ':memory:';
  if (!requested) throw new Error('A local database file or :memory: is required.');
  if (/^file:/iu.test(requested)) throw new Error('SQLite URI database paths are not allowed for local profiles.');
  rejectTraversal(requested);

  const root = normalized(options.root);
  if (!options.userId || options.userId.includes('/') || options.userId.includes('\\') || options.userId.includes('..') || options.userId.includes('\u0000')) throw new Error('Invalid local database user scope.');
  if (!existsSync(root)) {
    if (options.createUserDirectory === false) throw new Error('The local database sandbox does not exist.');
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  const rootReal = realpathSync.native(root);
  const userRoot = path.join(rootReal, options.userId);
  if (!existsSync(userRoot)) {
    if (options.createUserDirectory === false) throw new Error('The local database user sandbox does not exist.');
    mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  }
  const userRootReal = realpathSync.native(userRoot);
  if (!isWithin(rootReal, userRootReal)) throw new Error('The local database user sandbox is invalid.');

  const candidate = path.resolve(userRootReal, requested);
  if (!isWithin(userRootReal, candidate)) throw new Error('Local database path must stay inside the per-user sandbox.');
  rejectEscapingSymlink(userRootReal, candidate);
  if (existsSync(candidate) && lstatSync(candidate).isDirectory()) throw new Error('The local database path must name a file.');
  const realCandidate = realPathOrParent(candidate);
  if (!isWithin(userRootReal, realCandidate)) throw new Error('Local database symlinks cannot escape the per-user sandbox.');
  return candidate;
}

export function validateLocalDatabasePath(database: string, root: string, userId: string): void {
  resolveLocalDatabasePath(database, { root, userId });
}

import path from 'node:path';
import { MAX_SQL_FILE_PATH_LENGTH } from '@justybase/contracts';

/** Protocol handled by the installed desktop app (file opens, automation hooks). */
export const JUSTYBASE_PROTOCOL = 'justybase' as const;

export interface LaunchTargets {
  /** Absolute .sql file paths requested by the OS (association, second instance). */
  readonly sqlFiles: readonly string[];
  /** Raw `justybase://` URLs requested by the OS or a browser. */
  readonly deepLinks: readonly string[];
}

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: (event: unknown, argv: readonly string[]) => void): void;
  setAsDefaultProtocolClient(protocol: string): boolean;
}

function isSqlPath(candidate: string): boolean {
  return candidate.toLowerCase().endsWith('.sql') && !candidate.includes('\0');
}

/**
 * Extracts OS launch targets from a raw process argv. Flags are ignored;
 * only absolute .sql paths and `justybase://` URLs are collected so a
 * hostile command line cannot smuggle any other intent.
 */
export function parseLaunchTargets(argv: readonly string[]): LaunchTargets {
  const sqlFiles: string[] = [];
  const deepLinks: string[] = [];
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length === 0 || argument.startsWith('-')) continue;
    if (argument.toLowerCase().startsWith(`${JUSTYBASE_PROTOCOL}://`)) {
      deepLinks.push(argument);
      continue;
    }
    if (isSqlPath(argument) && path.isAbsolute(argument)) sqlFiles.push(path.normalize(argument));
  }
  return { sqlFiles, deepLinks };
}

/**
 * Resolves a `justybase://open?path=<absolute .sql>` link to a validated
 * absolute .sql path. Every other shape is rejected: deep links arrive from
 * untrusted contexts (browsers, chat apps) and must not carry free-form
 * filesystem access.
 */
export function deepLinkToSqlPath(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${JUSTYBASE_PROTOCOL}:`) return undefined;
  if (parsed.hostname.toLowerCase() !== 'open') return undefined;
  const rawPath = parsed.searchParams.get('path');
  if (!rawPath || rawPath.length > MAX_SQL_FILE_PATH_LENGTH || !isSqlPath(rawPath) || !path.isAbsolute(rawPath)) return undefined;
  const normalized = path.normalize(rawPath);
  return normalized.length <= MAX_SQL_FILE_PATH_LENGTH && isSqlPath(normalized) && path.isAbsolute(normalized) ? normalized : undefined;
}

/** Collects validated .sql paths from launch targets (files + deep links). */
export function sqlPathsFromTargets(targets: LaunchTargets): string[] {
  const paths = [...targets.sqlFiles];
  for (const link of targets.deepLinks) {
    const resolved = deepLinkToSqlPath(link);
    if (resolved && !paths.includes(resolved)) paths.push(resolved);
  }
  return paths;
}

/**
 * Bounded queue for OS file-open requests that arrive before any window can
 * receive them (runtime still starting, renderer still loading). Drained into
 * the first window's launch hash and on every ready-to-show.
 */
export interface LaunchPathQueue {
  push(paths: readonly string[]): void;
  drain(): string[];
  readonly size: number;
}

export function createLaunchPathQueue(): LaunchPathQueue {
  const pending: string[] = [];
  return {
    push(paths: readonly string[]): void {
      for (const filePath of paths) {
        if (typeof filePath === 'string' && !pending.includes(filePath)) pending.push(filePath);
      }
    },
    drain(): string[] {
      return pending.splice(0, pending.length);
    },
    get size(): number {
      return pending.length;
    },
  };
}

/**
 * Acquires the product single-instance lock. Returns false when another
 * instance already owns the lock (the caller must quit without touching
 * shared state). Second-instance launches are forwarded, validated, to the
 * callback so the primary window can focus and open requested files.
 */
export function ensureSingleInstance(
  app: SingleInstanceApp,
  onSecondInstance: (targets: LaunchTargets) => void,
): boolean {
  if (!app.requestSingleInstanceLock()) return false;
  app.on('second-instance', (_event, argv) => {
    try {
      onSecondInstance(parseLaunchTargets(argv));
    } catch {
      // A malformed second-instance launch must never crash the primary window.
    }
  });
  return true;
}

/**
 * Registers the `justybase://` protocol handler. Best-effort: registration
 * can fail in dev containers or without installation, which must not block
 * startup. Returns whether registration succeeded.
 */
export function registerProtocolClient(app: SingleInstanceApp): boolean {
  try {
    return app.setAsDefaultProtocolClient(JUSTYBASE_PROTOCOL);
  } catch {
    return false;
  }
}

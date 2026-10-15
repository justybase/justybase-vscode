import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { DuckDbInstance, DuckDbModule } from './resolver';

interface FileInstance {
  instance: Promise<DuckDbInstance>;
  users: number;
}

export interface DuckDbInstanceLease {
  instance: DuckDbInstance;
  release(): void;
}

// Own the database handles instead of relying on the native cache and GC.
// Separate sessions still share one instance while any of them is open.
const instances = new WeakMap<DuckDbModule, Map<string, FileInstance>>();

function canonicalPath(databasePath: string): string {
  const absolute = path.resolve(databasePath);
  try {
    return realpathSync.native(absolute);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return path.join(realpathSync.native(path.dirname(absolute)), path.basename(absolute));
  }
}

export async function acquireFileInstance(module: DuckDbModule, databasePath: string): Promise<DuckDbInstanceLease> {
  const filename = canonicalPath(databasePath);
  const key = process.platform === 'win32' ? filename.toLowerCase() : filename;
  const files = instances.get(module) ?? new Map<string, FileInstance>();
  instances.set(module, files);
  let entry = files.get(key);
  if (!entry) {
    entry = { instance: module.DuckDBInstance.create(filename), users: 0 };
    files.set(key, entry);
  }
  const shared = entry;
  shared.users += 1;
  let instance: DuckDbInstance;
  try {
    instance = await shared.instance;
  } catch (error: unknown) {
    shared.users -= 1;
    if (shared.users === 0) files.delete(key);
    throw error;
  }
  let released = false;
  return {
    instance,
    release(): void {
      if (released) return;
      released = true;
      shared.users -= 1;
      if (shared.users === 0) {
        files.delete(key);
        instance.closeSync();
      }
    },
  };
}

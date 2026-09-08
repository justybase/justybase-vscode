import { createRequire } from 'node:module';

export interface DuckDbResultReader {
  readonly rowsChanged?: number;
  readonly columnCount: number;
  columnName(index: number): string;
  columnType(index: number): { toString(): string };
  getRowsJS(): unknown[][];
  getRowObjectsJS?(): Array<Record<string, unknown>>;
}

export interface DuckDbConnection {
  run(sql: string): Promise<{ rowsChanged?: number }>;
  runAndReadAll(sql: string): Promise<DuckDbResultReader>;
  streamAndReadUntil(sql: string, targetRowCount: number): Promise<DuckDbResultReader>;
  interrupt(): void;
  disconnectSync(): void;
}

export interface DuckDbInstance {
  connect(): Promise<DuckDbConnection>;
  closeSync(): void;
}

export interface DuckDbModule {
  DuckDBInstance: {
    create(databasePath?: string, options?: Record<string, string>): Promise<DuckDbInstance>;
    fromCache(databasePath?: string, options?: Record<string, string>): Promise<DuckDbInstance>;
  };
}

export interface DuckDbModuleResolverOptions {
  candidates?: readonly string[];
  resolveFrom?: string;
  missingDependencyMessage?: string;
}

export interface DuckDbModuleResolver {
  load(): Promise<DuckDbModule>;
  isAvailable(): boolean;
  invalidate(): void;
}

function asDuckDbModule(value: unknown): DuckDbModule | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as { DuckDBInstance?: unknown };
  const instance = candidate.DuckDBInstance as { create?: unknown; fromCache?: unknown } | undefined;
  if (!instance || typeof instance.create !== 'function' || typeof instance.fromCache !== 'function') return undefined;
  return value as DuckDbModule;
}

/**
 * Resolves the optional native DuckDB module without making the shared package
 * depend on a concrete installation location.
 */
export function createDuckDbModuleResolver(options: DuckDbModuleResolverOptions = {}): DuckDbModuleResolver {
  const nativeRequire = createRequire(options.resolveFrom ?? __filename);
  const candidates = [...new Set((options.candidates ?? ['@duckdb/node-api']).filter(candidate => candidate.trim().length > 0))];
  const missingDependencyMessage = options.missingDependencyMessage
    ?? 'DuckDB runtime dependency "@duckdb/node-api" is not installed.';
  let loaded: DuckDbModule | undefined;
  let pending: Promise<DuckDbModule> | undefined;

  const tryLoad = (): DuckDbModule | undefined => {
    for (const candidate of candidates) {
      try {
        const module = asDuckDbModule(nativeRequire(candidate));
        if (module) return module;
      } catch {
        // Optional dependency; try the next candidate.
      }
    }
    return undefined;
  };

  return {
    load(): Promise<DuckDbModule> {
      if (loaded) return Promise.resolve(loaded);
      pending ??= Promise.resolve().then(() => {
        const module = tryLoad();
        if (!module) throw new Error(missingDependencyMessage);
        loaded = module;
        return module;
      }).catch(error => {
        pending = undefined;
        throw error;
      });
      return pending;
    },
    isAvailable(): boolean {
      if (loaded) return true;
      const module = tryLoad();
      if (module) { loaded = module; return true; }
      return false;
    },
    invalidate(): void {
      loaded = undefined;
      pending = undefined;
    },
  };
}

import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ApiConfig {
  host: string;
  port: number;
  dataDir: string;
  webDistDir: string;
  masterKey: string;
  /** Root for per-user SQLite/DuckDB files. */
  localDbRoot?: string;
  adminUsername?: string;
  adminPassword?: string;
  /** Exact browser origins allowed to call the API with credentials. */
  webOrigins?: string[];
}

function parseWebOrigins(value: string | undefined): string[] {
  const origins = new Set<string>();
  for (const rawOrigin of (value ?? '').split(',')) {
    const candidate = rawOrigin.trim();
    if (!candidate) continue;

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`JUSTYBASE_WEB_ORIGINS contains an invalid origin '${candidate}'. Use an http:// or https:// origin.`);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username.length > 0
      || parsed.password.length > 0
      || (parsed.pathname !== '' && parsed.pathname !== '/')
      || parsed.search.length > 0
      || parsed.hash.length > 0) {
      throw new Error(`JUSTYBASE_WEB_ORIGINS contains an invalid origin '${candidate}'. Use an http:// or https:// origin without a path.`);
    }

    origins.add(parsed.origin);
  }
  return [...origins];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const masterKey = env.JUSTYBASE_MASTER_KEY;
  if (!masterKey && env.NODE_ENV !== 'test') {
    throw new Error('JUSTYBASE_MASTER_KEY must be configured before starting the web API.');
  }

  return {
    host: env.JUSTYBASE_HOST ?? env.HOST ?? '127.0.0.1',
    port: Number(env.JUSTYBASE_PORT ?? env.PORT ?? 3000),
    dataDir: path.resolve(env.JUSTYBASE_DATA_DIR ?? '.justybase-web'),
    localDbRoot: path.resolve(env.JUSTYBASE_LOCAL_DB_ROOT ?? path.join(env.JUSTYBASE_DATA_DIR ?? '.justybase-web', 'local-databases')),
    webDistDir: env.JUSTYBASE_WEB_DIST_DIR
      ? path.resolve(env.JUSTYBASE_WEB_DIST_DIR)
      : (existsSync(path.resolve('apps/web/dist'))
        ? path.resolve('apps/web/dist')
        : path.resolve('../web/dist')),
    masterKey: masterKey ?? 'test-only-master-key',
    adminUsername: env.JUSTYBASE_ADMIN_USER,
    adminPassword: env.JUSTYBASE_ADMIN_PASSWORD,
    webOrigins: parseWebOrigins(env.JUSTYBASE_WEB_ORIGINS),
  };
}

import { existsSync } from 'node:fs';
import path from 'node:path';

export interface ApiConfig {
  host: string;
  port: number;
  dataDir: string;
  webDistDir: string;
  masterKey: string;
  adminUsername?: string;
  adminPassword?: string;
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
    webDistDir: env.JUSTYBASE_WEB_DIST_DIR
      ? path.resolve(env.JUSTYBASE_WEB_DIST_DIR)
      : (existsSync(path.resolve('apps/web/dist'))
        ? path.resolve('apps/web/dist')
        : path.resolve('../web/dist')),
    masterKey: masterKey ?? 'test-only-master-key',
    adminUsername: env.JUSTYBASE_ADMIN_USER,
    adminPassword: env.JUSTYBASE_ADMIN_PASSWORD,
  };
}

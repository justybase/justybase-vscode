import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const repositoryRoot = path.resolve(__dirname, '..');
const dataDir = process.env.JUSTYBASE_PLAYWRIGHT_DATA_DIR
  ? path.resolve(process.env.JUSTYBASE_PLAYWRIGHT_DATA_DIR)
  : mkdtempSync(path.join(os.tmpdir(), 'justybase-web-playwright-'));

export default defineConfig({
  testDir: './tests',
  testMatch: /web-sql-workspace\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 1,
  outputDir: path.resolve(repositoryRoot, 'test-results/web-sql'),
  use: {
    baseURL: 'http://127.0.0.1:3010',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node apps/api/dist/main.js',
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:3010',
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      JUSTYBASE_HOST: '127.0.0.1',
      JUSTYBASE_PORT: '3010',
      JUSTYBASE_MASTER_KEY: 'playwright-web-sql-master-key',
      JUSTYBASE_ADMIN_USER: 'playwright-admin',
      JUSTYBASE_ADMIN_PASSWORD: 'playwright-admin-password',
      JUSTYBASE_DATA_DIR: dataDir,
      JUSTYBASE_WEB_DIST_DIR: path.resolve(repositoryRoot, 'apps/web/dist'),
    },
  },
});

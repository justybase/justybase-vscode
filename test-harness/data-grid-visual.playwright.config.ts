import path from 'node:path';
import { defineConfig } from '@playwright/test';

const repositoryRoot = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './tests',
  testMatch: /data-grid-visual\.spec\.ts/,
  timeout: 60_000,
  expect: {
    timeout: 20_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixelRatio: 0.01 },
  },
  retries: 0,
  outputDir: path.resolve(repositoryRoot, 'test-results/data-grid-visual'),
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: 'http://127.0.0.1:8894',
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    colorScheme: 'dark',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx http-server .. -p 8894 --cors --silent',
    cwd: __dirname,
    port: 8894,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

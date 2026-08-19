import path from 'node:path';
import { defineConfig } from '@playwright/test';

const repositoryRoot = path.resolve(__dirname, '..');

export default defineConfig({
    testDir: './tests',
    testMatch: /data-grid-performance\.spec\.ts/,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    retries: 0,
    outputDir: path.resolve(repositoryRoot, 'test-results/data-grid-performance'),
    use: {
        baseURL: 'http://127.0.0.1:8893',
        browserName: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    webServer: {
        command: 'npx http-server .. -p 8893 --cors --silent',
        cwd: __dirname,
        port: 8893,
        reuseExistingServer: true,
        timeout: 30_000,
    },
});

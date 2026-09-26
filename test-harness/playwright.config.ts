import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30000,
    retries: 1,
    use: {
        baseURL: 'http://localhost:8892',
        browserName: 'chromium',
        headless: true,
        viewport: { width: 1280, height: 720 },
        locale: 'en-US',
    },
    webServer: {
        command: 'npx http-server .. -p 8892 --cors --silent',
        cwd: __dirname,
        port: 8892,
        reuseExistingServer: true,
        timeout: 30000,
    },
});

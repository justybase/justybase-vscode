import { test, expect } from '@playwright/test';

const TEST_PAGE = 'http://localhost:8892/test-harness/table-rendering.html';

test('debug page load', async ({ page }) => {
    const logs: string[] = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[PAGE_ERROR] ${err.message}`));

    await page.goto(TEST_PAGE, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(5000);

    const info = await page.evaluate(() => {
        const el = document.getElementById('renderStatus');
        const w = window as unknown as { init?: unknown; TableCore?: unknown };
        return {
            status: el?.textContent || '(no element)',
            initType: typeof w.init,
            tableCore: typeof w.TableCore,
            scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean),
        };
    });
    console.log('PAGE STATE:', JSON.stringify(info, null, 2));
    console.log('CONSOLE LOGS:', logs.join('\n'));

    // Always pass — this is a diagnostic test
    expect(info.status).not.toBe('(no element)');
});

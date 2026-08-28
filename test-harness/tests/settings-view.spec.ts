import { test, expect } from '@playwright/test';

test.describe('Settings view rendering', () => {
    test.beforeEach(async ({ page }) => {
        const pageErrors: Error[] = [];
        page.on('pageerror', error => pageErrors.push(error));
        await page.goto('/test-harness/settings-view.html', { waitUntil: 'networkidle' });
        await page.waitForSelector('#contentWrapper .setting-row');
        expect(pageErrors).toEqual([]);
    });

    test('renders every main settings category with controls', async ({ page }) => {
        const sections = ['editor', 'sql', 'codelens', 'query', 'ddl', 'schema'];
        for (const section of sections) {
            await page.locator(`.nav-item[data-section="${section}"]`).click();
            await expect(page.locator('#contentWrapper .setting-row')).not.toHaveCount(0);
            await expect(page.locator('#contentWrapper .settings-card')).toBeVisible();
        }
    });

    test('keeps default values and renders the JSON control type', async ({ page }) => {
        await page.locator('.nav-item[data-section="editor"]').click();
        await expect(page.locator('[data-id="editor-toggle"]')).toBeChecked();
        await expect(page.locator('.json-textarea')).toHaveValue('[\n  "--flag"\n]');
        await page.locator('.nav-item[data-section="sql"]').click();
        await expect(page.locator('[data-id="sql-width"]')).toHaveValue('4');
        await expect(page.locator('#contentWrapper .setting-label')).toContainText('Tab Width');
    });
});

import { test, expect } from '@playwright/test';

test.describe('Import Wizard webview', () => {
    test('renders root container', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        await expect(page.locator('#app')).toBeVisible();
        await expect(page.locator('#app')).not.toBeEmpty();
    });
});

test.describe('Table Designer webview', () => {
    test('renders designer header and table name input', async ({ page }) => {
        await page.goto('/test-harness/table-designer.html');
        await expect(page.getByRole('heading', { name: 'Visual Table Designer' })).toBeVisible();
        await expect(page.locator('#tableName')).toHaveValue('TEST_TABLE');
        await expect(page.locator('#targetDisplay')).toContainText('JUST_DATA');
    });

    test('add column button is present', async ({ page }) => {
        await page.goto('/test-harness/table-designer.html');
        await expect(page.locator('#addColumnBtn')).toBeVisible();
    });
});

test.describe('Visual Query Builder webview', () => {
    test('renders the React Flow builder and schema select', async ({ page }) => {
        await page.goto('/test-harness/visual-query-builder.html');
        await expect(page.locator('#visual-query-builder-root')).toBeVisible();
        await expect(page.getByText('VISUAL QUERY BUILDER')).toBeVisible();
        await expect(page.locator('#vqb-schema')).toBeVisible();
    });

    test('source palette lists schema sources', async ({ page }) => {
        await page.goto('/test-harness/visual-query-builder.html');
        await expect(page.locator('[aria-label="Sources"]')).toContainText('DIM_ACCOUNT');
    });
});

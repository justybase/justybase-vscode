import { test, expect } from '@playwright/test';

test.describe('Import Wizard webview', () => {
    test('renders root container', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        await expect(page.locator('#app')).toBeVisible();
        await expect(page.locator('#app')).not.toBeEmpty();
    });

    test('puts the destination table at the top of the review', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        await expect(page.locator('.import-target-name')).toHaveText('JUST_DATA.ADMIN.QUERY_RESULTS_20261024_6031');
        await expect(page.locator('.import-target-label')).toHaveText('Import target');
        await expect(page.locator('.import-mapping .import-map-row')).toHaveCount(7);
    });

    test('does not render the redundant workflow stepper', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        await expect(page.locator('.import-steps')).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Import data' })).toBeVisible();
        await expect(page.locator('.import-target-name')).toBeVisible();
    });

    test('keeps secondary details collapsed and reveals destination fields on demand', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        const sqlDetails = page.locator('details[data-details-key="sql"]');
        await expect(sqlDetails).not.toHaveAttribute('open', '');
        await expect(page.locator('#target-table-name')).toBeHidden();

        await page.locator('#toggle-target-editor').click();
        await expect(page.locator('#target-table-name')).toBeVisible();
        await expect(page.locator('#target-table-name')).toHaveValue('QUERY_RESULTS_20261024_6031');

        await sqlDetails.locator('summary').click();
        await expect(sqlDetails).toHaveAttribute('open', '');
        await expect(sqlDetails.locator('.sql-card')).toHaveCount(2);
    });

    test('keeps the spinner element alive across progress updates', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        await page.waitForSelector('.import-target-name');
        await page.evaluate(() => {
            (window as unknown as { __showImportProgress: () => void }).__showImportProgress();
        });

        const spinner = page.locator('.progress-spinner');
        const spinnerHandle = await spinner.elementHandle();
        expect(spinnerHandle).not.toBeNull();

        await page.evaluate(() => {
            (window as unknown as { __updateImportProgress: () => void }).__updateImportProgress();
        });

        await expect(page.locator('.execution-progress-percent')).toHaveText('64%');
        expect(await spinnerHandle?.evaluate(element => element.isConnected)).toBe(true);
    });

    test('shows transfer metrics and database load status on separate lines', async ({ page }) => {
        await page.goto('/test-harness/import-wizard.html');
        await page.waitForSelector('.import-target-name');
        await page.evaluate(() => {
            (window as unknown as { __showImportProgress: () => void }).__showImportProgress();
        });

        const lines = page.locator('.execution-progress .progress-detail-line');
        await expect(lines).toHaveCount(2);
        await expect(lines.nth(0)).toContainText('248,412 / 776,286 rows');
        await expect(lines.nth(0)).toContainText('10.0 MB / 12.0 MB read');
        await expect(lines.nth(1)).toContainText('Plan 46');
        await expect(lines.nth(1)).toContainText('173,226 inserted');
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

    test('keeps generated DDL functional after editing the design', async ({ page }) => {
        await page.goto('/test-harness/table-designer.html');

        await page.locator('#tableName').fill('ORDERS');
        await page.locator('#ifNotExists').check();
        await page.locator('#organizeColumns').fill('ID');
        await page.locator('#addColumnBtn').click();

        await expect(page.locator('#ddlPreview')).toHaveValue(
            /CREATE TABLE IF NOT EXISTS JUST_DATA\.ADMIN\.ORDERS[\s\S]*DISTRIBUTE ON RANDOM[\s\S]*ORGANIZE ON \("ID"\);/u,
        );
        await expect(page.locator('#columnsBody tr')).toHaveCount(2);
        await expect(page.locator('#ddlPreview')).toHaveValue(/COLUMN_2 VARCHAR\(255\)/u);
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

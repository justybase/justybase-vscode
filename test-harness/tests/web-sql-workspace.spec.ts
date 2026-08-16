import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const screenshotDirectory = path.resolve(__dirname, '../../artifacts/playwright/web-sql');
const adminUsername = 'playwright-admin';
const adminPassword = 'playwright-admin-password';

const netezza = {
  host: process.env.NZ_DEV_HOST ?? '',
  port: process.env.NZ_DEV_PORT ?? '5480',
  user: process.env.NZ_DEV_USER ?? '',
  password: process.env.NZ_DEV_PASSWORD ?? '',
  database: process.env.NZ_DEV_DATABASE ?? '',
};

const singleQuery = `SELECT 1 AS SCENARIO_ID, 'NPS' AS ENGINE_NAME, CURRENT_DATE AS RUN_DATE`;
const gridQuery = `SELECT 1 AS SCENARIO_ID, 'NPS' AS ENGINE_NAME, 10 AS SAMPLE_VALUE
UNION ALL
SELECT 2, 'NPS', 20
UNION ALL
SELECT 3, 'NPS', 30`;

function hasLiveNetezzaConfiguration(): boolean {
  return Boolean(netezza.host && netezza.user && netezza.password && netezza.database);
}

async function capture(page: Page, name: string): Promise<void> {
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, name), fullPage: false });
}

async function replaceEditorText(page: Page, sql: string): Promise<void> {
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(sql);
  await page.waitForTimeout(300);
}

async function waitForCompletedResult(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('.results-header').innerText()).toMatch(/complete/);
  await expect(page.locator('.result-grid, .explain-panel').first()).toBeVisible();
}

async function openRunMenu(page: Page): Promise<void> {
  await page.getByTitle('More run options').click();
  await expect(page.locator('.tb-run-dropdown')).toBeVisible();
}

test.describe('live Netezza web workspace', () => {
  test('captures read-only editor workflows and result scenarios', async ({ page }) => {
    test.skip(!hasLiveNetezzaConfiguration(), 'Set NZ_DEV_HOST, NZ_DEV_USER, NZ_DEV_PASSWORD and NZ_DEV_DATABASE for live Netezza screenshots.');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await capture(page, '01-login.png');

    await page.getByLabel('Username').fill(adminUsername);
    await page.getByLabel('Password').fill(adminPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.sidebar .section-title').filter({ hasText: 'Connections' })).toBeVisible();
    await capture(page, '02-workspace-after-login.png');

    const profileName = `Playwright Netezza ${Date.now()}`;
    await page.locator('.sidebar .icon-button').first().click();
    await page.getByLabel('Profile name').fill(profileName);
    await page.getByLabel('Host').fill(netezza.host);
    await page.getByLabel('Port').fill(netezza.port);
    await page.getByRole('textbox', { name: 'Database', exact: true }).fill(netezza.database);
    await page.getByLabel('User').fill(netezza.user);
    await page.getByLabel('Password').fill(netezza.password);

    const connectionTest = page.waitForResponse(response => response.url().endsWith('/api/connections/test') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Test connection' }).click();
    expect((await connectionTest).status()).toBe(200);
    await expect(page.getByRole('status')).toContainText('Connection succeeded.');
    await capture(page, '03-netezza-connection-test-success.png');

    await page.getByRole('dialog', { name: 'Add connection' }).getByRole('button', { name: 'Add connection', exact: true }).click();
    await expect(page.getByRole('button', { name: profileName, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Add connection' })).toHaveCount(0);
    await expect(page.locator('.schema-tree-loading')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.schema-tree .schema-label').first()).toBeVisible({ timeout: 30_000 });

    const databaseNode = page.locator('.schema-tree .schema-node').first();
    await databaseNode.locator('.schema-expander').click();
    await expect(databaseNode.locator('.schema-children.expanded .schema-label').first()).toBeVisible({ timeout: 30_000 });
    await capture(page, '04-schema-database-expanded.png');

    const schemaNode = databaseNode.locator('.schema-children.expanded .schema-node').first();
    await schemaNode.locator('.schema-expander').click();
    await expect(schemaNode.locator('.schema-children.expanded .schema-label').first()).toBeVisible({ timeout: 30_000 });
    await capture(page, '05-schema-groups-expanded.png');

    await replaceEditorText(page, gridQuery);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await waitForCompletedResult(page);
    await expect(page.locator('.result-grid tbody tr').first()).toBeVisible();
    await capture(page, '06-single-query-result-grid.png');

    await page.getByRole('button', { name: 'Aggregates', exact: true }).click();
    await expect(page.locator('.grid-aggregates-title')).toContainText('Aggregates for 3 rows');
    await capture(page, '07-result-grid-aggregates.png');

    await page.getByRole('button', { name: 'Hide aggregates', exact: true }).click();
    await page.locator('.result-grid tbody tr').first().locator('td').nth(1).click({ button: 'right' });
    await expect(page.getByRole('button', { name: 'Copy row as JSON' })).toBeVisible();
    await capture(page, '08-result-cell-context-menu.png');
    await page.getByRole('button', { name: 'View full row' }).click();
    await expect(page.getByText('Row details', { exact: true })).toBeVisible();
    await capture(page, '09-result-row-details.png');
    await page.locator('.grid-row-details button').click();

    await replaceEditorText(page, singleQuery);
    await openRunMenu(page);
    await page.getByRole('button', { name: 'Explain current statement', exact: true }).click();
    await expect(page.locator('.explain-panel')).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => page.locator('.results-header').innerText()).toMatch(/complete/);
    await capture(page, '10-explain-plan.png');

    await page.getByRole('button', { name: /Settings/ }).click();
    await expect(page.locator('.modal-card .section-title').filter({ hasText: 'Editor settings' })).toBeVisible();
    await capture(page, '11-editor-settings.png');
    await page.locator('.modal-card .icon-button').click();

    await replaceEditorText(page, `SELECT 11 AS SMART_VALUE;\nSELECT 22 AS SMART_VALUE`);
    const editor = page.locator('.monaco-editor');
    await editor.click();
    await page.keyboard.press('Control+A');
    await openRunMenu(page);
    await page.getByRole('button', { name: 'Smart run (split by ;)', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Statement 1/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: /^Statement 2/ })).toBeVisible({ timeout: 30_000 });
    await waitForCompletedResult(page);
    await capture(page, '12-smart-run-statements.png');

    await replaceEditorText(page, `SELECT 31 AS BATCH_VALUE;\nSELECT 32 AS BATCH_VALUE`);
    await openRunMenu(page);
    await page.getByRole('button', { name: 'Run whole document (sequential)', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Statement 2/ })).toBeVisible({ timeout: 30_000 });
    await waitForCompletedResult(page);
    await capture(page, '13-batch-run-sequential.png');

    const missingObject = `__JWB_PLAYWRIGHT_MISSING_${Date.now()}__`;
    await replaceEditorText(page, `SELECT 41 AS BEFORE_ERROR;\nSELECT * FROM ${missingObject};\nSELECT 43 AS AFTER_ERROR`);
    await openRunMenu(page);
    await page.getByRole('button', { name: 'Run whole document (sequential)', exact: true }).click();
    await expect(page.locator('.results-header')).toContainText('error', { timeout: 30_000 });
    await expect(page.getByText(/subsequent statements were not executed/i)).toBeVisible({ timeout: 30_000 });
    await capture(page, '14-batch-stops-on-first-error.png');
  });
});

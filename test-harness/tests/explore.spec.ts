import { test, expect, type Page } from '@playwright/test';

async function enterExplore(page: Page): Promise<void> {
    await page.goto('/test-harness/table-rendering.html');
    await expect(page.locator('#renderStatus')).toContainText('Rendered');
    await page.locator('#viewModeSelect').selectOption('explore', { force: true });
    await expect(page.locator('#exploreSubtitle')).toContainText('1,000');
}

async function operationCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as unknown as { __postedMessages: Array<{ command: string }> }).__postedMessages.filter(message => message.command === 'requestExploreOperation').length);
}

async function respond(page: Page, rows: unknown[][], filters = { dimensions: [], dates: [], measures: [] }): Promise<void> {
    await page.evaluate(({ rows, filters }) => {
        const messages = (window as unknown as { __postedMessages: Array<{ command: string; requestId: number }> }).__postedMessages;
        const request = messages.filter(message => message.command === 'requestExploreOperation').at(-1)!;
        window.dispatchEvent(new MessageEvent('message', { data: { command: 'exploreOperationResult', requestId: request.requestId,
            result: { rows, filters, sql: 'SELECT fixture', scope: 'database', computedAt: Date.now(), truncated: false } } }));
    }, { rows, filters });
}

test('Explore filters are explicit, editable and independent of the main grid', async ({ page }) => {
    await enterExplore(page);
    await expect(page.locator('#exploreSubtitle')).toContainText('First rows; not a random sample');
    await page.getByRole('button', { name: 'Add filter', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Edit Explore filter' });
    await editor.getByLabel('Column', { exact: true }).selectOption('5');
    await editor.getByLabel('Engineering', { exact: true }).check();
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('#exploreFilterBar')).toContainText('Engineering');
    expect(await operationCount(page)).toBe(0);
    await page.getByRole('button', { name: '↩ Undo', exact: true }).click();
    await expect(page.locator('#exploreFilterBar')).toContainText('No filters');
    await page.getByRole('button', { name: '↪ Redo', exact: true }).click();
    await expect(page.locator('#exploreFilterBar')).toContainText('Engineering');
    await page.locator('#viewModeSelect').selectOption('table', { force: true });
    await expect(page.locator('#gridContainer')).toBeVisible();
    await expect(page.locator('#rowCountInfo')).toContainText('1,000');
    await page.locator('#viewModeSelect').selectOption('explore', { force: true });
    await expect(page.locator('#exploreFilterBar')).toContainText('Engineering');
});

test('category ranking runs without a date and uses stale result filters for drill-through', async ({ page }) => {
    await enterExplore(page);
    await page.getByRole('tab', { name: 'Charts', exact: true }).click();
    await page.getByLabel('Category', { exact: true }).selectOption('5');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    expect(await operationCount(page)).toBe(1);
    await respond(page, [['Engineering', 167, null, 0], ['Other', 833, null, 1]]);
    await expect(page.locator('.explore-table')).toContainText('Engineering');
    await page.getByRole('button', { name: 'Add filter', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Edit Explore filter' });
    await editor.getByLabel('Column', { exact: true }).selectOption('5');
    await editor.getByLabel('Marketing', { exact: true }).check();
    await editor.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator('.explore-database-status')).toContainText('Out of date');
    expect(await operationCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Explore selection', exact: true }).first().click();
    await page.getByRole('button', { name: 'Show rows', exact: true }).click();
    expect(await operationCount(page)).toBe(1);
    await page.getByRole('button', { name: 'Load rows', exact: true }).click();
    const selected = await page.evaluate(() => {
        const messages = (window as unknown as { __postedMessages: Array<{ command: string; operation: unknown }> }).__postedMessages;
        return messages.filter(message => message.command === 'requestExploreOperation').at(-1)?.operation;
    });
    expect(selected).toMatchObject({ kind: 'rows', filters: { dimensions: [{ columnIndex: 5, values: ['Engineering'] }] } });
    await respond(page, [[1, 'Fixture', '10.25', '2026-01-01', true, 'Engineering']]);
    await expect(page.locator('#exploreSelection')).toContainText('1 matching rows');
    await page.locator('#viewModeSelect').selectOption('table', { force: true });
    await page.locator('#viewModeSelect').selectOption('explore', { force: true });
    await expect(page.locator('.explore-table')).toContainText('Engineering');
    await expect(page.locator('.explore-database-status')).toContainText('Out of date');
});

test('sample histogram has keyboard actions and local rows at a narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 });
    await enterExplore(page);
    const salary = page.locator('.explore-column-card').filter({ has: page.locator('.explore-card-name', { hasText: 'salary' }) });
    await salary.getByText('Distribution ranges', { exact: true }).click();
    const range = salary.locator('details button').first();
    await range.focus(); await range.press('Enter');
    await page.getByRole('button', { name: 'Show rows', exact: true }).click();
    await expect(page.locator('#exploreSelection table tbody tr').first()).toBeVisible();
    expect(await operationCount(page)).toBe(0);
});


test('Explore examines the first 50,000 rows and keeps the fetched population separate', async ({ page }) => {
    await page.goto('/test-harness/table-rendering.html?rows=50001&initiallyHidden=1');
    await expect(page.locator('#renderStatus')).toContainText('Rendered');
    await page.locator('#viewModeSelect').selectOption('explore', { force: true });
    await expect(page.locator('#exploreSubtitle')).toContainText('First 50,000 of 50,001 loaded rows');
    await expect(page.locator('#exploreSubtitle')).toContainText('50,000 matching rows in the sample');
    const id = page.locator('.explore-column-card').filter({ has: page.locator('.explore-card-name', { hasText: /^id$/ }) });
    await expect(id).toContainText('50,000');
    expect(await operationCount(page)).toBe(0);
});

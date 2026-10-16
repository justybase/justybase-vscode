import { test, expect, type Page } from '@playwright/test';

function groupOptions(page: Page) {
    return page.getByRole('listbox', { name: 'Groups' }).getByRole('option');
}

async function enterAnalytical(page: Page): Promise<void> {
    await page.goto('/test-harness/table-rendering.html');
    await expect(page.locator('#renderStatus')).toContainText('Rendered');
    await page.locator('#viewModeSelect').selectOption('analytical', { force: true });
    await expect(page.locator('.analytical-view')).toBeVisible();
}

async function chooseFirstSuggestion(page: Page): Promise<string> {
    const suggestion = page.locator('.analytical-suggestion').first();
    await expect(suggestion).toBeVisible();
    const name = (await suggestion.textContent()) ?? '';
    await suggestion.click();
    await expect(groupOptions(page).first()).toBeVisible();
    return name;
}

test('analytical view groups loaded rows by a suggested column and shows per-group detail', async ({ page }) => {
    await enterAnalytical(page);
    await expect(page.locator('.analytical-title')).toHaveText('Analytical');
    await expect(page.locator('.analytical-empty')).toContainText('Choose one to three columns');

    await chooseFirstSuggestion(page);

    const groups = groupOptions(page);
    await expect(groups.first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.analytical-detail-title')).not.toHaveText('');
    await expect(page.locator('.analytical-column').first()).toBeVisible();
});

test('arrow keys move the selected group in the master list and update the detail pane', async ({ page }) => {
    await enterAnalytical(page);
    await chooseFirstSuggestion(page);

    const options = groupOptions(page);
    const initialTitle = await page.locator('.analytical-detail-title').textContent();
    // Roving tabindex: the selected option is the single tab stop, and arrow keys bubble to the listbox.
    await page.locator('[role="option"][tabindex="0"]').focus();
    await page.keyboard.press('ArrowDown');

    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toBeFocused();
    await expect(page.locator('.analytical-detail-title')).not.toHaveText(initialTitle ?? '');
});

test('the grouping survives a round trip through the table view', async ({ page }) => {
    await enterAnalytical(page);
    const chosen = await chooseFirstSuggestion(page);

    await page.locator('#viewModeSelect').selectOption('table', { force: true });
    await expect(page.locator('.analytical-view')).toBeHidden();
    await page.locator('#viewModeSelect').selectOption('analytical', { force: true });

    await expect(page.locator('.analytical-chip-name')).toHaveText(chosen);
    await expect(groupOptions(page).first()).toBeVisible();
});

test('on a narrow results panel the master and detail panes stack instead of sitting side by side', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 720 });
    await enterAnalytical(page);
    await chooseFirstSuggestion(page);

    const tracks = await page.locator('.analytical-layout').evaluate(
        element => getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
    );
    expect(tracks).toBe(1);
});

test('the group list scrolls on its own in a short results panel and the view itself does not grow', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 320 });
    await enterAnalytical(page);
    // The id column yields far more groups than fit, so the master list has to scroll.
    await page.locator('select.analytical-add').selectOption({ label: 'id' });
    await expect(groupOptions(page).nth(20)).toBeVisible();
    await expect(page.locator('.analytical-notice').first()).toContainText('Showing the 500 largest of 1000 groups');

    const master = page.locator('.analytical-master');
    await expect.poll(() => master.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect.poll(() => master.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
    const viewFits = await page.locator('.analytical-view').evaluate(element => element.scrollHeight <= element.clientHeight + 1);
    expect(viewFits).toBe(true);
});

test('column statistics wrap inside the detail pane instead of overflowing sideways', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 720 });
    await enterAnalytical(page);
    await chooseFirstSuggestion(page);

    const stats = page.locator('.analytical-column-stats').first();
    await expect(stats).toBeVisible();
    const fits = await stats.evaluate(element => element.scrollWidth <= element.clientWidth + 1);
    expect(fits).toBe(true);
});

test('the options panel switches the detection mode and the header reports the effective mode', async ({ page }) => {
    await enterAnalytical(page);
    await chooseFirstSuggestion(page);

    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await page.locator('#analytical-options-mode').selectOption('rest');
    await expect(page.locator('.analytical-mode')).toContainText('Rest of result');
    await expect(page.getByRole('region', { name: 'Analysis options' })).toBeVisible();
});

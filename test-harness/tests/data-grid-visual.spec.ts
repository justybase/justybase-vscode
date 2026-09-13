import { test, expect } from '@playwright/test';

async function settleLayout(page: import('@playwright/test').Page): Promise<void> {
  await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; caret-color: transparent !important; }' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

test('renders the canonical shared result grid in stable and interactive states', async ({ page }) => {
  await page.goto('/test-harness/shared-data-grid.html?profile=comparison', { waitUntil: 'networkidle' });
  await expect(page.locator('.shared-grid-harness')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.ui-data-grid')).toBeVisible();
  await settleLayout(page);

  const firstRow = page.locator('.ui-data-grid tbody tr[data-row-index="0"]');
  await expect.poll(async () => (await firstRow.boundingBox())?.height ?? 0).toBeLessThanOrEqual(32);
  await expect(page.locator('.ui-data-grid tbody td').first()).toHaveCSS('user-select', 'none');
  await expect(page.locator('.ui-data-grid-column-filter').first()).toHaveCSS('user-select', 'text');

  await expect(page.locator('.shared-grid-harness')).toHaveScreenshot('shared-grid-initial.png');

  await page.getByRole('button', { name: 'Pin ID' }).click();
  await page.getByRole('button', { name: 'Group by CATEGORY' }).click();
  await page.getByRole('textbox', { name: 'Filter NAME' }).fill('needle');
  const grid = page.locator('.ui-data-grid-scroll');
  await grid.evaluate(element => {
    element.scrollLeft = 420;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.locator('td').filter({ hasText: 'needle-start' }).first().click();
  await settleLayout(page);
  await expect(page.locator('.ui-data-grid-group-panel')).toContainText('CATEGORY');
  await expect(page.locator('.shared-grid-harness')).toHaveScreenshot('shared-grid-interactive.png');
});

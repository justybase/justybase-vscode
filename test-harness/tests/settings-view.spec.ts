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

    test('groups navigation sections and shows setting counts', async ({ page }) => {
        await expect(page.locator('.nav-group-title')).toHaveCount(2);
        await expect(page.locator('.nav-group-title').first()).toHaveText('Core');
        await expect(page.locator('.nav-group-title').nth(1)).toHaveText('Data');
        await expect(page.locator('.nav-item[data-section="general"] .nav-count')).toHaveText('1');
        await expect(page.locator('.nav-item[data-section="editor"] .nav-count')).toHaveText('2');
        await expect(page.locator('.nav-item[data-section="schema"] .nav-count')).toHaveText('1');
    });

    test('activates a section from the keyboard', async ({ page }) => {
        const item = page.locator('.nav-item[data-section="query"]');
        await item.focus();
        await page.keyboard.press('Enter');
        await expect(item).toHaveClass(/active/);
        await expect(item).toHaveAttribute('aria-current', 'true');
        await expect(page.locator('#contentWrapper .section-title')).toHaveText('Query Execution');
    });

    test('shows a search empty state for unmatched queries', async ({ page }) => {
        await page.fill('#searchInput', 'no-such-setting-zzz');
        await expect(page.locator('.search-empty')).toBeVisible();
        await expect(page.locator('.search-empty-title')).toHaveText('No settings found');
    });

    test('keeps reset actions visible and labeled for keyboard users', async ({ page }) => {
        await page.locator('.nav-item[data-section="editor"]').click();
        const reset = page.locator('[data-reset-key="highlightActiveStatement"]');
        await expect(reset).toBeVisible();
        await reset.focus();
        await expect(reset).toBeFocused();
        const opacity = Number(await reset.evaluate(element => getComputedStyle(element).opacity));
        expect(opacity).toBeGreaterThan(0.25);
        await expect(reset).toHaveAttribute(
            'aria-label',
            'Reset Highlight Active Statement to default'
        );
    });

    test('switches to a horizontal navigation bar in a narrow panel', async ({ page }) => {
        await page.setViewportSize({ width: 640, height: 800 });
        await expect(page.locator('body')).toHaveCSS('flex-direction', 'column');
        await expect(page.locator('.nav-group-title').first()).toBeHidden();
        await expect(page.locator('.sidebar-nav')).toHaveCSS('overflow-x', 'auto');
        await expect(page.locator('.nav-item[data-section="general"]')).toBeVisible();
    });

    test('closes the snippet overlay with Escape', async ({ page }) => {
        await page.evaluate(() => {
            document.getElementById('newSnippetOverlay')?.classList.add('show');
        });
        await expect(page.locator('#newSnippetOverlay')).toHaveClass(/show/);
        await page.keyboard.press('Escape');
        await expect(page.locator('#newSnippetOverlay')).not.toHaveClass(/show/);
    });
});

import { test, expect } from '@playwright/test';

type Theme = 'light' | 'dark';

const LIGHT = {
    surface: 'rgb(255, 255, 255)',
    header: 'rgb(245, 245, 245)',
    accent: 'rgb(33, 115, 70)',
    headerText: 'rgb(75, 75, 75)',
};

const DARK = {
    surface: 'rgb(31, 31, 31)',
    header: 'rgb(43, 43, 43)',
    accent: 'rgb(78, 201, 160)',
    headerText: 'rgb(201, 201, 201)',
};

async function openPreview(page: import('@playwright/test').Page, theme: Theme): Promise<void> {
    await page.goto(`/test-harness/spreadsheet-preview.html?theme=${theme}`);
    await expect(page.locator('.body-table td.cell').first()).toBeVisible();
}

test.describe('Spreadsheet preview chrome', () => {
    test('renders an Excel-like sheet surface, headers and workbook title', async ({ page }) => {
        await openPreview(page, 'light');

        await expect(page.locator('body')).toHaveCSS('background-color', LIGHT.surface);
        await expect(page.locator('.head-table th[data-col="1"]')).toHaveCSS('background-color', LIGHT.header);
        await expect(page.locator('.file-badge')).toHaveText('CSV');
        await expect(page.locator('.file-title')).toHaveText('sales.csv');
        await expect(page.locator('.sheet-tab.active')).toHaveText('Data');
        await expect(page.locator('.name-box')).toHaveValue('A1');

        const cell = page.locator('.body-table td.cell[data-row="0"][data-col="0"]');
        await expect(cell).toHaveCSS('background-color', LIGHT.surface);
        const box = await cell.boundingBox();
        expect(box?.height).toBe(20);
        await expect(page.locator('.body-table th.rowhdr').first()).toHaveCSS('width', '44px');

        // Excel always shows the select-all triangle in the corner header.
        const triangle = await page.locator('.head-table th.corner').evaluate(
            element => getComputedStyle(element, '::after').borderBottomColor,
        );
        expect(triangle).toBe(LIGHT.headerText);
    });

    test('uses the dark sheet palette and the green Excel accent', async ({ page }) => {
        await openPreview(page, 'dark');

        await expect(page.locator('body')).toHaveCSS('background-color', DARK.surface);
        await expect(page.locator('.head-table th[data-col="1"]')).toHaveCSS('background-color', DARK.header);
        await expect(page.locator('td.cell[data-row="0"][data-col="0"]')).toHaveCSS('background-color', DARK.surface);
    });

    test('outlines a selected range and highlights its headers like Excel', async ({ page }) => {
        await openPreview(page, 'dark');
        await page.locator('td.cell[data-row="1"][data-col="1"]').click();
        await page.locator('td.cell[data-row="3"][data-col="2"]').click({ modifiers: ['Shift'] });

        const topLeft = page.locator('td.cell[data-row="1"][data-col="1"]');
        await expect(topLeft).toHaveClass(/sel-top/);
        await expect(topLeft).toHaveClass(/sel-left/);
        const topLeftShadow = await topLeft.evaluate(element => getComputedStyle(element).boxShadow);
        expect(topLeftShadow).toContain(DARK.accent);

        const bottomRight = page.locator('td.cell[data-row="3"][data-col="2"]');
        await expect(bottomRight).toHaveClass(/sel-bottom/);
        await expect(bottomRight).toHaveClass(/sel-right/);

        // The anchor cell stays on the sheet surface with its own accent frame.
        await expect(topLeft).toHaveCSS('background-color', DARK.surface);

        await expect(page.locator('.head-table th.colhdr.sel')).toHaveCount(2);
        const activeColumn = page.locator('.head-table th.colhdr.active');
        await expect(activeColumn).toHaveCount(1);
        await expect(activeColumn).toHaveCSS('background-color', DARK.accent);
        await expect(page.locator('.body-table th.rowhdr.active')).toHaveCount(1);
        await expect(page.locator('.name-box')).toHaveValue('B2:C4');
    });

    test('accepts a typed cell or range reference in the name box', async ({ page }) => {
        await openPreview(page, 'light');
        const nameBox = page.locator('.name-box');

        await nameBox.click();
        await nameBox.fill('C2:D3');
        await nameBox.press('Enter');
        await expect(nameBox).toHaveValue('C2:D3');
        await expect(page.locator('td.cell[data-row="1"][data-col="2"]')).toHaveClass(/sel-top/);
        await expect(page.locator('td.cell[data-row="2"][data-col="3"]')).toHaveClass(/sel-bottom/);

        // Invalid input leaves the previous selection untouched.
        await nameBox.click();
        await nameBox.fill('not a cell');
        await nameBox.press('Enter');
        await expect(nameBox).toHaveValue('C2:D3');

        await nameBox.click();
        await nameBox.fill('a5');
        await nameBox.press('Enter');
        await expect(nameBox).toHaveValue('A5');
        await expect(page.locator('.value-bar')).toHaveText('West');

        // Clicking a column header shows the whole column, as in Excel.
        await page.locator('.head-table th.colhdr[data-col="1"]').click();
        await expect(nameBox).toHaveValue('B:B');
    });

    test('reports selection statistics in the Excel-style status bar', async ({ page }) => {
        await openPreview(page, 'light');
        await page.locator('td.cell[data-row="1"][data-col="1"]').click();
        await page.locator('td.cell[data-row="3"][data-col="2"]').click({ modifiers: ['Shift'] });

        const status = page.locator('.sheet-status');
        await expect(status).toContainText('Count: 6');
        await expect(status).toContainText('Sum: 5,065.75');
        await expect(status).toContainText('Average: 844.2917');
    });

    test('overflows text into empty neighbours and keeps it inside the allowed span', async ({ page }) => {
        await openPreview(page, 'light');

        const cell = page.locator('td.cell[data-row="1"][data-col="3"]');
        await expect(cell).toHaveClass(/ovf/);
        const text = cell.locator('.cell-overflow');
        await expect(text).toHaveText('long descriptive note that overflows');

        const cellBox = await cell.boundingBox();
        const textBox = await text.boundingBox();
        expect(cellBox).not.toBeNull();
        expect(textBox).not.toBeNull();
        expect((textBox?.width ?? 0)).toBeGreaterThan(cellBox?.width ?? 0);
    });

    test('moves the active cell with Excel keyboard navigation', async ({ page }) => {
        await openPreview(page, 'light');
        await page.locator('td.cell[data-row="0"][data-col="0"]').click();

        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Tab');
        await expect(page.locator('.name-box')).toHaveValue('B2');

        await page.keyboard.press('Enter');
        await expect(page.locator('.name-box')).toHaveValue('B3');

        await page.keyboard.press('Control+Home');
        await expect(page.locator('.name-box')).toHaveValue('A1');
    });

    test('autofits a column on double-click and restores the default width with Alt', async ({ page }) => {
        await openPreview(page, 'light');
        const header = page.locator('.head-table th[data-col="1"]');
        await expect(header).toHaveCSS('width', '96px');

        await header.locator('.col-resize').dblclick();
        await expect(header).not.toHaveCSS('width', '96px');

        await header.locator('.col-resize').dblclick({ modifiers: ['Alt'] });
        await expect(header).toHaveCSS('width', '96px');
    });

    test('explains when the preview stopped before the last column', async ({ page }) => {
        await openPreview(page, 'light');
        await page.locator('.sheet-tab', { hasText: 'Limited' }).click();

        const status = page.locator('.sheet-status');
        await expect(status).toContainText('first 3 columns shown (justybase.filePreview.maxColumns)');
    });

    test('appends streamed rows and reports loading progress', async ({ page }) => {
        await openPreview(page, 'light');
        await page.locator('.sheet-tab', { hasText: 'Streaming' }).click();

        const status = page.locator('.sheet-status');
        await expect(status).toContainText('loading… 1 rows');

        await page.evaluate(() => {
            window.postMessage({
                command: 'sheetAppend',
                sheetIndex: 3,
                rows: [['three', 'four'], ['five', 'six']],
                done: false,
                columnsTruncated: false,
            }, '*');
        });
        await expect(status).toContainText('loading… 3 rows');
        await expect(page.locator('td.cell[data-row="3"][data-col="0"]')).toHaveText('five');

        await page.evaluate(() => {
            window.postMessage({
                command: 'sheetAppend',
                sheetIndex: 3,
                rows: [],
                done: true,
                columnsTruncated: false,
            }, '*');
        });
        await expect(status).not.toContainText('loading…');
    });

    test('drag-selects whole rows and columns from their headers', async ({ page }) => {
        await openPreview(page, 'light');
        const nameBox = page.locator('.name-box');

        const row2 = await page.locator('.body-table th.rowhdr[data-row="1"]').boundingBox();
        const row4 = await page.locator('.body-table th.rowhdr[data-row="3"]').boundingBox();
        expect(row2).not.toBeNull();
        expect(row4).not.toBeNull();
        if (!row2 || !row4) return;
        await page.mouse.move(row2.x + 10, row2.y + 10);
        await page.mouse.down();
        await page.mouse.move(row4.x + 10, row4.y + row4.height - 2, { steps: 5 });
        await page.mouse.up();
        await expect(nameBox).toHaveValue('2:4');
        await expect(page.locator('.body-table th.rowhdr.sel')).toHaveCount(3);

        const colB = await page.locator('.head-table th.colhdr[data-col="1"]').boundingBox();
        const colD = await page.locator('.head-table th.colhdr[data-col="3"]').boundingBox();
        expect(colB).not.toBeNull();
        expect(colD).not.toBeNull();
        if (!colB || !colD) return;
        await page.mouse.move(colB.x + 10, colB.y + 10);
        await page.mouse.down();
        await page.mouse.move(colD.x + colD.width / 2, colD.y + 10, { steps: 5 });
        await page.mouse.up();
        await expect(nameBox).toHaveValue('B:D');
        await expect(page.locator('.head-table th.colhdr.sel')).toHaveCount(3);
    });

    test('adds whole rows and columns to the selection with Ctrl+click', async ({ page }) => {
        await openPreview(page, 'light');
        const nameBox = page.locator('.name-box');

        await page.locator('.body-table th.rowhdr[data-row="1"]').click();
        await page.locator('.body-table th.rowhdr[data-row="3"]').click({ modifiers: ['Control'] });
        await expect(page.locator('.body-table th.rowhdr.sel')).toHaveCount(2);
        await expect(nameBox).toHaveValue('4:4');

        await page.locator('.head-table th.colhdr[data-col="1"]').click();
        await page.locator('.head-table th.colhdr[data-col="3"]').click({ modifiers: ['Control'] });
        await expect(page.locator('.head-table th.colhdr.sel')).toHaveCount(2);
        await expect(nameBox).toHaveValue('D:D');
    });

    test('copies the selection from the right-click menu', async ({ page }) => {
        await openPreview(page, 'light');
        await page.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });

        await page.locator('td.cell[data-row="1"][data-col="1"]').click({ button: 'right' });
        const menu = page.locator('.context-menu');
        await expect(menu).toBeVisible();
        // Right-clicking outside the selection selects that cell first, as in Excel.
        await expect(page.locator('.name-box')).toHaveValue('B2');

        await menu.locator('[data-action="copy"]').click();
        await expect(menu).toBeHidden();
        const posted = await page.evaluate(
            () => (window as unknown as { __posted: Array<{ command: string; text: string }> }).__posted,
        );
        expect(posted).toContainEqual({ command: 'copyToClipboard', text: '120' });

        // Escape closes the menu without changing the selection.
        await page.locator('td.cell[data-row="2"][data-col="1"]').click({ button: 'right' });
        await expect(menu).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(page.locator('.name-box')).toHaveValue('B3');

        // The menu also copies all areas of a Ctrl+click selection.
        await page.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });
        await page.locator('td.cell[data-row="0"][data-col="0"]').click();
        await page.locator('td.cell[data-row="2"][data-col="0"]').click({ modifiers: ['Control'] });
        await page.locator('td.cell[data-row="2"][data-col="0"]').click({ button: 'right' });
        await menu.locator('[data-action="copy"]').click();
        const multiPosted = await page.evaluate(
            () => (window as unknown as { __posted: Array<{ command: string; text: string }> }).__posted,
        );
        expect(multiPosted).toContainEqual({ command: 'copyToClipboard', text: 'Region\nSouth' });
    });

    test('offers importing the current sheet into a database', async ({ page }) => {
        await openPreview(page, 'light');
        const posted = () => page.evaluate(
            () => (window as unknown as { __posted: Array<{ command: string; sheetIndex?: number }> }).__posted,
        );
        await page.evaluate(() => { (window as unknown as { __posted: unknown[] }).__posted.length = 0; });

        await page.getByRole('button', { name: 'Import to Database' }).click();
        expect(await posted()).toContainEqual({ command: 'importSheetToDatabase', sheetIndex: 0 });

        await page.locator('.sheet-tab', { hasText: 'Summary' }).click();
        await page.getByRole('button', { name: 'Import to Database' }).click();
        expect(await posted()).toContainEqual({ command: 'importSheetToDatabase', sheetIndex: 1 });
    });

    test('switches sheets from the Excel-style tabs', async ({ page }) => {
        await openPreview(page, 'light');
        await page.locator('.sheet-tab', { hasText: 'Summary' }).click();

        await expect(page.locator('.sheet-tab.active')).toHaveText('Summary');
        await expect(page.locator('.head-table th.colhdr')).toHaveCount(2);
        await expect(page.locator('td.cell[data-row="0"][data-col="0"]')).toHaveText('Total');
        await expect(page.locator('.sheet-status')).toContainText('2 rows');
    });
});

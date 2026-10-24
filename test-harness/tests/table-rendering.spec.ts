import { test, expect, type Locator, type Page } from '@playwright/test';

const TEST_PAGE = 'http://localhost:8892/test-harness/table-rendering.html';

/** Starts a native column-header drag and waits until the grouping drop zone is revealed. */
async function startColumnHeaderDrag(page: Page, source: Locator): Promise<void> {
    const sourceBox = await source.boundingBox();
    if (!sourceBox) {
        throw new Error('Column header is not laid out');
    }
    const y = sourceBox.y + sourceBox.height / 2;
    await page.mouse.move(sourceBox.x + 8, y);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 20, y, { steps: 2 });
    await expect(page.locator('body')).toHaveClass(/group-dragging/);
}

test.beforeEach(({ browser }) => {
    // Keep the managed Chromium version in the report for every static
    // webview run, including failures before the page is loaded.
    test.info().annotations.push({ type: 'chromium', description: browser.version() });
});

test.describe('Table rendering', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto(TEST_PAGE, { waitUntil: 'networkidle' });
        // Wait for the grid to finish rendering — ✅ emoji appears only after init() succeeds
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 }
        );
    });

    test('result tabs and close controls remain accessible at narrow and desktop widths', async ({ page }) => {
        for (const width of [320, 1280]) {
            await page.setViewportSize({ width, height: 720 });
            await expect(page.getByRole('tablist', { name: 'Query results' })).toBeVisible();
            const tab = page.getByRole('tab').first();
            await tab.focus();
            await expect(tab).toBeFocused();
            await expect(tab).toHaveAttribute('aria-selected', 'true');
            await tab.press('End');
            await expect(page.getByRole('tab').last()).toBeFocused();
            await expect(page.locator('button.result-set-close-btn').first()).toHaveAccessibleName(/Close/);
            await expect(page.locator('button.pin-icon').first()).toHaveAttribute('aria-pressed', /true|false/);
        }
    });

    test('dragging a column header toward the right grid edge scrolls the grid and moves the column', async ({ page }) => {
        await page.setViewportSize({ width: 480, height: 720 });
        const wrapper = page.locator('#gridContainer .grid-wrapper.active');
        await expect.poll(() => wrapper.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

        const firstHeader = wrapper.locator('thead th[data-col-id]').first();
        const originalFirstColId = await firstHeader.getAttribute('data-col-id');
        await startColumnHeaderDrag(page, firstHeader);

        const wrapperBox = await wrapper.boundingBox();
        const headerRowBox = await wrapper.locator('thead').boundingBox();
        if (!wrapperBox || !headerRowBox) {
            throw new Error('Grid is not laid out during drag');
        }
        await page.mouse.move(wrapperBox.x + wrapperBox.width - 8, headerRowBox.y + headerRowBox.height / 2, { steps: 8 });
        await expect.poll(() => wrapper.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

        // Drop on the right-most data column header that is still visible at the right edge, inside its
        // right part. Dropping on the left half of the column next to the source is a no-op, so the
        // target must be chosen explicitly.
        const dropPoint = await wrapper.evaluate((el) => {
            const wrapperRect = el.getBoundingClientRect();
            const headerRects = Array.from(el.querySelectorAll<HTMLElement>('thead th[data-col-id]'))
                .map((th) => th.getBoundingClientRect())
                .filter((rect) => rect.right > wrapperRect.left + 100 && rect.left < wrapperRect.right - 20);
            const target = headerRects.reduce<DOMRect | null>(
                (rightMost, rect) => (!rightMost || rect.left > rightMost.left ? rect : rightMost),
                null,
            );
            const headerRow = el.querySelector('thead')?.getBoundingClientRect();
            if (!target || !headerRow) {
                return null;
            }
            return {
                x: Math.min(target.right, wrapperRect.right) - 10,
                y: headerRow.y + headerRow.height / 2,
            };
        });
        if (!dropPoint) {
            throw new Error('No fully visible data column header to drop on');
        }
        await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 4 });
        await page.mouse.up();

        await expect.poll(() => wrapper.locator('thead th[data-col-id]').first().getAttribute('data-col-id'))
            .not.toBe(originalFirstColId);
    });

    test('dragging a column header over the right part of the row-number column scrolls the grid left', async ({ page }) => {
        await page.setViewportSize({ width: 480, height: 720 });
        const wrapper = page.locator('#gridContainer .grid-wrapper.active');
        await expect.poll(() => wrapper.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await wrapper.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
        await expect.poll(() => wrapper.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        const scrolledLeft = await wrapper.evaluate((el) => el.scrollLeft);

        await startColumnHeaderDrag(page, wrapper.locator('thead th[data-col-id]').last());

        const rowNumberBox = await wrapper.locator('thead th.row-number-header').boundingBox();
        const headerRowBox = await wrapper.locator('thead').boundingBox();
        if (!rowNumberBox || !headerRowBox) {
            throw new Error('Row-number header is not laid out during drag');
        }
        await page.mouse.move(
            rowNumberBox.x + rowNumberBox.width - 4,
            headerRowBox.y + headerRowBox.height / 2,
            { steps: 8 },
        );
        // Chromium delivers dragover on pointer movement, so nudge the pointer while waiting for the edge scroll.
        let nudge = 0;
        await expect.poll(async () => {
            nudge += 1;
            await page.mouse.move(rowNumberBox.x + rowNumberBox.width - 4 + (nudge % 2), headerRowBox.y + headerRowBox.height / 2);
            return wrapper.evaluate((el) => el.scrollLeft);
        }).toBeLessThan(scrolledLeft);

        // Cancel without dropping: the row-number column is not a column drop target.
        await page.keyboard.press('Escape');
        await page.mouse.up();
    });

    test('cell context menu stays fully reachable in a short results panel', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 200 });
        const cell = page.locator('#gridContainer tbody td:not(.row-number-cell)').nth(3);
        await cell.click({ button: 'right' });

        const menu = page.locator('.grid-context-menu');
        await expect(menu).toBeVisible();
        await expect.poll(() => menu.evaluate((el) => {
            const rect = el.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight;
        })).toBe(true);
        await expect.poll(() => menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    });

    test('export menu starts from defaults and posts Export & Open / Export & Copy file', async ({ page }) => {
        const exportMessages = () => page.evaluate(() =>
            ((window as unknown as { __postedMessages: Array<Record<string, unknown>> }).__postedMessages)
                .filter(message => message.command === 'initiateExportWithSelection')
                .map(message => ({ format: message.format, destination: message.destination })));
        const menu = page.locator('#exportPrimaryMenu');

        await page.locator('#exportBtn').click();
        await expect(menu).toBeVisible();
        await expect(menu.getByRole('radio', { name: 'Excel', exact: true })).toHaveAttribute('aria-checked', 'true');
        // Text content can only be copied for text formats.
        await expect(menu.getByRole('menuitem', { name: /Copy content/ })).toHaveCount(0);
        await menu.getByRole('radio', { name: 'CSV', exact: true }).click();
        await expect(menu.getByRole('menuitem', { name: /Copy content/ })).toBeVisible();
        await menu.getByRole('menuitem', { name: /Export & Open/ }).click();
        await expect(menu).toBeHidden();

        // Reopening must not remember CSV: the button never repeats an earlier choice.
        await page.locator('#exportBtn').click();
        await expect(menu.getByRole('radio', { name: 'Excel', exact: true })).toHaveAttribute('aria-checked', 'true');
        await menu.getByRole('menuitem', { name: /Export & Copy file/ }).click();

        await expect.poll(exportMessages).toEqual([
            { format: 'csv', destination: 'open' },
            { format: 'xlsx', destination: 'temp' },
        ]);
    });

    test('Copy as JSON from the cell context menu writes plain JSON', async ({ page }) => {
        await page.evaluate(() => {
            const target = window as unknown as { __copiedText?: string };
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    writeText: async (text: string) => { target.__copiedText = text; },
                    write: async () => { throw new Error('rich clipboard must not be used for JSON'); },
                },
            });
        });
        const cell = page.locator('#gridContainer tbody td:not(.row-number-cell)').nth(1);
        await cell.click();
        await cell.click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: /^Copy as$/ }).hover();
        await page.locator('.grid-context-submenu .grid-context-menu-item', { hasText: /^JSON$/ }).click();

        const copied = await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText))
            .toBeTruthy().then(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText ?? ''));
        const rows = JSON.parse(copied) as Array<Record<string, unknown>>;
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0])).toHaveLength(1);
        await expect(page.locator('.grid-context-menu')).toHaveCount(0);
    });

    test('Copy as SQL IN list writes one plain IN predicate for the selected column cells', async ({ page }) => {
        await page.evaluate(() => {
            const target = window as unknown as { __copiedText?: string };
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: {
                    writeText: async (text: string) => { target.__copiedText = text; },
                    write: async () => { throw new Error('rich clipboard must not be used for an IN list'); },
                },
            });
        });
        const cellInRow = (row: number) =>
            page.locator('#gridContainer tbody tr').nth(row).locator('td:not(.row-number-cell)').nth(1);
        await cellInRow(0).click();
        await page.keyboard.press('Shift+ArrowDown');
        await page.keyboard.press('Shift+ArrowDown');
        await cellInRow(1).click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: /^Copy as$/ }).hover();
        await page.locator('.grid-context-submenu .grid-context-menu-item', { hasText: /^SQL IN list$/ }).click();

        await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText))
            .toBeTruthy();
        const copied = await page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText ?? '');
        const expectedValues = await Promise.all([0, 1, 2].map(row => cellInRow(row).innerText()));
        expect(copied).toMatch(/^IN \(.+\)$/);
        // No header row and at most one literal per distinct selected value.
        const distinct = new Set(expectedValues.map(value => value.trim()).filter(value => value && value !== 'NULL'));
        expect(copied.slice(4, -1).split(', ').length).toBe(distinct.size);
        await expect(page.locator('.grid-context-menu')).toHaveCount(0);
    });

    test('dragging a cell selection across grouped rows leaves no native text selection behind', async ({ page }) => {
        await page.locator('#gridContainer tbody tr td:not(.row-number-cell)').nth(5).click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: 'Group by This Column' }).click();

        const groupHeader = page.locator('#gridContainer tr.group-header').first();
        await expect(groupHeader).toBeVisible();
        // First span is the zero-width indent; the second is the expand indicator.
        await groupHeader.locator('span').nth(1).click();
        const childCell = page.locator('#gridContainer tbody tr:not(.group-header) td[data-cell-id]').nth(0);
        await expect(childCell).toBeVisible();

        const headerText = await groupHeader.locator('td').nth(1).boundingBox();
        const target = await childCell.boundingBox();
        if (!headerText || !target) {
            throw new Error('Grouped rows are not laid out');
        }
        await page.mouse.move(headerText.x + 40, headerText.y + headerText.height / 2);
        await page.mouse.down();
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
        await page.mouse.up();

        const nativeSelection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
        expect(nativeSelection).toBe('');
    });

    test('grouped leaf rows keep cell values under their own column headers', async ({ page }) => {
        const groupedColumnPosition = 5;
        const headers = page.locator('#gridContainer .grid-wrapper.active thead th[data-col-id]');
        const groupedColId = await headers.nth(groupedColumnPosition).getAttribute('data-col-id');
        await page.locator('#gridContainer tbody tr td:not(.row-number-cell)').nth(groupedColumnPosition).click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: 'Group by This Column' }).click();

        const groupHeader = page.locator('#gridContainer tr.group-header').first();
        await expect(groupHeader).toBeVisible();
        const groupValue = (await groupHeader.innerText()).trim().match(/: (.*) \(\d+ rows?\)$/)?.[1];
        expect(groupValue).toBeDefined();
        // Headers keep the grouped column in place; leaf cells must follow the same order.
        await expect(headers.nth(groupedColumnPosition)).toHaveAttribute('data-col-id', groupedColId!);

        // First span is the zero-width indent; the second is the expand indicator.
        await groupHeader.locator('span').nth(1).click();
        const leafRow = page.locator('#gridContainer tbody tr:not(.group-header):has(td[data-cell-id])').first();
        await expect(leafRow).toBeVisible();
        await expect(leafRow.locator('td:not(.row-number-cell)').nth(groupedColumnPosition)).toHaveText(groupValue!);
    });

    test('group chip sort button orders groups ascending, descending and back to default', async ({ page }) => {
        await page.locator('#gridContainer tbody tr td:not(.row-number-cell)').nth(5).click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: 'Group by This Column' }).click();

        const sortButton = page.locator('#groupingPanel .group-chip .group-sort');
        await expect(sortButton).toHaveCount(1);
        await expect(sortButton).not.toHaveClass(/active/);
        const groupValues = () => page.locator('#gridContainer tr.group-header').evaluateAll(rows =>
            rows.map(row => (row.textContent ?? '').match(/: (.*) \(\d+ rows?\)/)?.[1] ?? ''));
        const defaultOrder = await groupValues();
        expect(defaultOrder.length).toBeGreaterThan(1);
        const ascending = [...defaultOrder].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

        await sortButton.click();
        await expect(page.locator('#groupingPanel .group-chip .group-sort')).toHaveClass(/active/);
        await expect.poll(groupValues).toEqual(ascending);

        await page.locator('#groupingPanel .group-chip .group-sort').click();
        await expect.poll(groupValues).toEqual([...ascending].reverse());

        await page.locator('#groupingPanel .group-chip .group-sort').click();
        await expect(page.locator('#groupingPanel .group-chip .group-sort')).not.toHaveClass(/active/);
        await expect.poll(groupValues).toEqual(defaultOrder);
    });

    test('removing grouped columns leaves no stale grouping drop zone', async ({ page }) => {
        const bodyCells = page.locator('#gridContainer tbody tr:not(.group-header) td:not(.row-number-cell)');
        await bodyCells.nth(5).click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: 'Group by This Column' }).click();
        await expect(page.locator('#groupingPanel .group-chip')).toHaveCount(1);

        // Expand a group so a second column can be grouped from a leaf row.
        await page.locator('#gridContainer tr.group-header').first().locator('span').nth(1).click();
        await expect(bodyCells.first()).toBeVisible();
        await bodyCells.nth(6).click({ button: 'right' });
        await page.locator('.grid-context-menu-item', { hasText: 'Group by This Column' }).click();

        const chips = page.locator('#groupingPanel .group-chip');
        await expect(chips).toHaveCount(2);

        // Reorder the chips natively. The drop lands on a chip (which stops propagation) and
        // the re-render replaces the drag source, so its dragend can be lost.
        const firstBox = await chips.nth(0).boundingBox();
        const secondBox = await chips.nth(1).boundingBox();
        if (!firstBox || !secondBox) {
            throw new Error('Group chips are not laid out');
        }
        const dragY = secondBox.y + secondBox.height / 2;
        await page.mouse.move(secondBox.x + 8, dragY);
        await page.mouse.down();
        await page.mouse.move(secondBox.x + 28, dragY, { steps: 3 });
        await expect(page.locator('body')).toHaveClass(/group-dragging/);
        await page.mouse.move(firstBox.x + 8, dragY, { steps: 5 });
        await page.mouse.up();
        await expect(page.locator('body')).not.toHaveClass(/group-dragging/);
        await expect(chips).toHaveCount(2);

        // Removing the grouped columns must hide the reveal zone again.
        while (await chips.count() > 0) {
            await chips.first().locator('.remove-group').click();
        }
        await expect(page.locator('#groupingPanel')).toBeHidden();
        await expect(page.locator('body')).not.toHaveClass(/group-dragging/);
    });

    test('renders the grid container with table element', async ({ page }) => {
        const gridContainer = page.locator('#gridContainer');
        await expect(gridContainer).toBeVisible({ timeout: 10000 });

        const table = gridContainer.locator('table');
        await expect(table).toBeVisible({ timeout: 5000 });
    });

    test('renders thead, tbody, and tfoot elements', async ({ page }) => {
        const table = page.locator('#gridContainer table');
        await expect(table.locator('thead')).toBeVisible();
        await expect(table.locator('tbody')).toBeVisible();
        // tfoot exists but may be empty (no aggregations) — check it's in the DOM
        const tfoot = table.locator('tfoot');
        await expect(tfoot).toHaveCount(1);
    });

    test('renders column headers in thead', async ({ page }) => {
        const thead = page.locator('#gridContainer table thead');
        const headerRow = thead.locator('tr').first();
        const thElements = headerRow.locator('th');

        // Expected: row-number header (#) + 8 data columns = 9 th elements
        await expect(thElements).toHaveCount(9);

        // First th should be the row number header
        const firstTh = thElements.first();
        await expect(firstTh).toHaveText('#');
        await expect(firstTh).toHaveClass(/row-number-header/);

        // Check column names
        const expectedHeaders = ['#', 'id', 'name', 'salary', 'hire_date', 'active', 'department', 'projects', 'rating'];
        for (let i = 0; i < expectedHeaders.length; i++) {
            await expect(thElements.nth(i)).toContainText(expectedHeaders[i]);
        }
    });

    test('renders data rows in tbody with row numbers', async ({ page }) => {
        const tbody = page.locator('#gridContainer table tbody');
        const rows = tbody.locator('tr');

        // Should have at least some visible rows
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThan(0);

        // First real data row should have row-number cell with value 1
        const firstRowWithNumber = rows.filter({ has: page.locator('td.row-number-cell') }).first();
        await expect(firstRowWithNumber).toBeVisible();

        const rowNumCell = firstRowWithNumber.locator('td.row-number-cell').first();
        const rowNumText = await rowNumCell.textContent();
        expect(Number(rowNumText?.trim())).toBe(1);
    });

    test('Row View compares selected rows from the selection model', async ({ page }) => {
        const firstRowHeader = page.locator('#gridContainer tbody tr[data-index="0"] td.row-number-cell');
        const secondRowHeader = page.locator('#gridContainer tbody tr[data-index="1"] td.row-number-cell');
        await firstRowHeader.click();
        await secondRowHeader.click({ modifiers: ['Control'] });

        // Scroll both selected rows out of the rendered virtual window before opening Row View.
        await page.locator('#gridContainer .grid-wrapper').evaluate(element => { element.scrollTop = 5000; });
        await expect.poll(async () => page.locator('#gridContainer tbody tr[data-index="0"]').count()).toBe(0);
        await page.evaluate(() => {
            (window as Window & { toggleRowView?: () => void }).toggleRowView?.();
        });

        const sections = page.locator('#rowViewContent .row-view-section');
        await expect(sections).toHaveCount(8);
        await expect(page.locator('#rowViewContent .row-view-val.label')).toHaveCount(16);
        await expect(page.locator('#rowViewContent .row-view-section.diff').first()).toBeVisible();

        await page.locator('#gridContainer table thead th').nth(1).locator('.header-btn-sort').click();
        await expect.poll(async () => page.locator('#gridContainer .selected-cell').count()).toBe(0);
        await expect(page.locator('#rowViewContent .row-view-placeholder')).toContainText('Select 1 to 10 rows');
    });

    test('Row View drag selects a cell rectangle and copies it instead of native text selection', async ({ page }) => {
        await page.evaluate(() => {
            const target = window as unknown as { __copiedText?: string };
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: async (text: string) => { target.__copiedText = text; } },
            });
        });
        await page.locator('#gridContainer tbody tr[data-index="0"] td.row-number-cell').click();
        await page.evaluate(() => {
            (window as Window & { toggleRowView?: () => void }).toggleRowView?.();
        });
        const keys = page.locator('#rowViewContent .row-view-key');
        const values = page.locator('#rowViewContent .row-view-val[data-rv-col="1"]');
        await expect(keys).toHaveCount(8);
        // The panel slides open with a width transition; measure cells only once it settles.
        await expect.poll(() => page.locator('#rowViewPanel').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(400);

        const from = await keys.nth(1).boundingBox();
        const to = await values.nth(2).boundingBox();
        if (!from || !to) {
            throw new Error('Row View cells are not laid out');
        }
        await page.mouse.move(from.x + 10, from.y + from.height / 2);
        await page.mouse.down();
        await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
        await page.mouse.up();

        await expect(page.locator('#rowViewContent .rv-selected')).toHaveCount(4);
        expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');

        const expected = (await Promise.all([1, 2].map(async index => [
            (await keys.nth(index).getAttribute('data-rv-copy')) ?? '',
            (await values.nth(index).getAttribute('data-rv-copy')) ?? (await values.nth(index).textContent()) ?? '',
        ].join('\t')))).join('\n');
        await page.keyboard.press('Control+c');
        await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText)).toBe(expected);

        await page.keyboard.press('Escape');
        await expect(page.locator('#rowViewContent .rv-selected')).toHaveCount(0);
        await page.keyboard.press('Control+a');
        await expect(page.locator('#rowViewContent .rv-selected')).toHaveCount(16);
    });

    test('renders correct number of columns per data row', async ({ page }) => {
        const tbody = page.locator('#gridContainer table tbody');
        // Find first actual data row (has row-number-cell)
        const dataRows = tbody.locator('tr').filter({ has: page.locator('td.row-number-cell') });
        const firstRow = dataRows.first();
        // Row-number cell + 8 data columns = 9 td elements
        const cells = firstRow.locator('td');
        await expect(cells).toHaveCount(9);
    });

    test('column headers have data-col-id attributes', async ({ page }) => {
        const theadTh = page.locator('#gridContainer table thead th');

        for (let i = 1; i <= 8; i++) {
            await expect(theadTh.nth(i)).toHaveAttribute('data-col-id', String(i - 1));
        }
    });

    test('responsive collapsed columns preserve virtual rows while resizing', async ({ page }) => {
        await page.setViewportSize({ width: 520, height: 720 });
        const wrapper = page.locator('#gridContainer .grid-wrapper');
        await expect(wrapper).toBeVisible();

        const headerCount = () => page.locator('#gridContainer table thead th[data-col-id]').count();
        const getVisibleAnchor = () => wrapper.evaluate((element) => {
            const headerHeight = element.querySelector('thead')?.getBoundingClientRect().height ?? 0;
            const viewport = element.getBoundingClientRect();
            const bodyTop = viewport.top + headerHeight;
            for (const row of Array.from(element.querySelectorAll<HTMLTableRowElement>('tbody tr[data-data-row-index]'))) {
                const rect = row.getBoundingClientRect();
                if (rect.height > 0 && rect.bottom > bodyTop && rect.top < viewport.bottom) {
                    return {
                        index: row.dataset.dataRowIndex ?? '',
                        offset: rect.top - bodyTop,
                    };
                }
            }
            return null;
        });
        expect(await headerCount()).toBe(8);

        await page.locator('#toolbarMoreToggle').click();
        const option = page.locator('#toolbarMoreMenu [data-action="responsive-collapse"]');
        await expect(option).toHaveAttribute('aria-disabled', 'false');
        await option.click();

        await expect.poll(headerCount).toBeLessThan(8);
        const narrowColumnCount = await headerCount();
        expect(narrowColumnCount).toBeGreaterThanOrEqual(1);

        await wrapper.evaluate((element) => {
            const table = element.querySelector('table');
            if (table) table.style.minWidth = '1200px';
            element.scrollTop = 4000;
            element.scrollLeft = 100;
        });
        await expect.poll(async () => wrapper.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        await expect.poll(async () => wrapper.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        const unalignedAnchor = await getVisibleAnchor();
        expect(unalignedAnchor).not.toBeNull();
        if (!unalignedAnchor) throw new Error('No visible virtual row was found before expansion');
        await wrapper.evaluate((element, offset) => { element.scrollTop += offset; }, unalignedAnchor.offset);
        await wrapper.evaluate(() => new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        const firstVisibleAnchor = await getVisibleAnchor();
        expect(firstVisibleAnchor).not.toBeNull();
        if (!firstVisibleAnchor) throw new Error('No visible virtual row was found after anchor alignment');
        const firstDataRow = page.locator(
            `#gridContainer tbody tr[data-data-row-index="${firstVisibleAnchor?.index}"]`,
        );
        await expect(firstDataRow).toBeVisible();
        const rowNumberBeforeExpansion = await firstDataRow.locator('.row-number-value').textContent();
        await firstDataRow.locator('.responsive-details-toggle').evaluate((button: HTMLButtonElement) => button.click());
        const details = page.locator('#gridContainer tbody tr.responsive-details-row').first();
        await expect(details).toBeVisible();
        await expect(details.locator('.responsive-details-item').first()).toBeVisible();
        const anchorAfterExpansion = await getVisibleAnchor();
        expect(anchorAfterExpansion?.index).toBe(firstVisibleAnchor?.index);
        expect(Math.abs((anchorAfterExpansion?.offset ?? 0) - firstVisibleAnchor.offset)).toBeLessThanOrEqual(1);
        const visibleRowsBeforeResize = await page.locator('#gridContainer tbody td.row-number-cell').count();
        await wrapper.evaluate(element => { element.scrollLeft = 100; });
        const horizontalBeforeResize = await wrapper.evaluate(element => element.scrollLeft);
        expect(horizontalBeforeResize).toBeGreaterThan(0);

        await page.setViewportSize({ width: 760, height: 720 });
        await expect.poll(headerCount).toBeGreaterThan(narrowColumnCount);
        await wrapper.evaluate(() => new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }));
        await expect.poll(async () => wrapper.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
        const horizontalStateAfterResize = await wrapper.evaluate(element => ({
            left: element.scrollLeft,
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
            tableWidth: element.querySelector('table')?.getBoundingClientRect().width ?? 0,
            minWidth: element.querySelector('table')?.style.minWidth ?? '',
        }));
        expect(horizontalStateAfterResize.left, JSON.stringify(horizontalStateAfterResize))
            .toBeGreaterThanOrEqual(Math.min(horizontalBeforeResize, horizontalStateAfterResize.scrollWidth - horizontalStateAfterResize.width));
        await expect.poll(async () => page.locator('#gridContainer tbody td.row-number-cell').count())
            .toBeGreaterThan(0);
        const visibleAnchorAfterResize = await getVisibleAnchor();
        expect(visibleAnchorAfterResize?.index, JSON.stringify({
            beforeExpansion: firstVisibleAnchor,
            afterExpansion: anchorAfterExpansion,
            afterResize: visibleAnchorAfterResize,
            scrollTop: await wrapper.evaluate(element => element.scrollTop),
        })).toBe(anchorAfterExpansion?.index);
        expect(Math.abs((visibleAnchorAfterResize?.offset ?? 0) - (anchorAfterExpansion?.offset ?? 0)), JSON.stringify({
            beforeExpansion: firstVisibleAnchor,
            afterExpansion: anchorAfterExpansion,
            afterResize: visibleAnchorAfterResize,
        }))
            .toBeLessThanOrEqual(5);
        expect(await page.locator('#gridContainer tbody td.row-number-cell').count())
            .toBeLessThanOrEqual(visibleRowsBeforeResize + 10);

        await page.locator('#toolbarMoreToggle').click();
        await expect(option).toHaveAttribute('aria-checked', 'true');
        await option.click();
        await expect.poll(headerCount).toBe(8);
        await expect(page.locator('#gridContainer tbody tr.responsive-details-row')).toHaveCount(0);
        expect(rowNumberBeforeExpansion).toBeTruthy();
    });

    test('renders row count info', async ({ page }) => {
        const rowCountInfo = page.locator('#rowCountInfo');
        await expect(rowCountInfo).toBeVisible();
        const text = await rowCountInfo.textContent();
        expect(text).toContain('row');
        expect(text).toMatch(/\d[\d ]* row/);
    });

    test('data values are displayed in cells', async ({ page }) => {
        const tbody = page.locator('#gridContainer table tbody');
        // Find first actual data row
        const dataRows = tbody.locator('tr').filter({ has: page.locator('td.row-number-cell') });
        const firstRow = dataRows.first();
        const cells = firstRow.locator('td');

        // Cell index 2 should contain a name (0=row-number, 1=id, 2=name)
        const nameCell = cells.nth(2);
        await expect(nameCell).not.toBeEmpty();

        const nameText = await nameCell.textContent();
        expect(nameText?.trim().length).toBeGreaterThan(0);
    });

    test('scrolling updates visible rows via virtualizer', async ({ page }) => {
        const gridWrapper = page.locator('#gridContainer .grid-wrapper');
        await expect(gridWrapper).toBeVisible();

        // Confirm initial state — first visible row has number 1
        const initialFirstRowNum = await page.evaluate(() => {
            const cell = document.querySelector(
                '#gridContainer table tbody td.row-number-cell'
            );
            return cell ? Number(cell.textContent?.trim()) : 0;
        });
        expect(initialFirstRowNum).toBe(1);

        // Scroll down significantly
        await gridWrapper.evaluate(el => {
            el.scrollTop = 10000;
        });

        // Wait for virtualizer to catch up (requestAnimationFrame cycle + render)
        await page.waitForTimeout(1000);

        // After scroll, the first row-number-cell should be for a row much later than row 1
        const scrolledFirstRowNum = await page.evaluate(() => {
            const cell = document.querySelector(
                '#gridContainer table tbody td.row-number-cell'
            );
            return cell ? Number(cell.textContent?.trim()) : 0;
        });

        expect(scrolledFirstRowNum).toBeGreaterThan(initialFirstRowNum);
    });

    test('grid renders with proper structure and row numbers', async ({ page }) => {
        // Verify the grid is properly rendered through DOM structure
        // (window.grids is not reliable because resetGrids() reassigns the array)
        const table = page.locator('#gridContainer table');
        await expect(table).toBeVisible();

        // Verify thead has proper header row
        const headerTh = table.locator('thead th');
        await expect(headerTh.first()).toHaveClass(/row-number-header/);
        await expect(headerTh).toHaveCount(9);

        // Verify tbody has data rows with row numbers
        const firstDataRow = table.locator('tbody tr').filter({ has: page.locator('td.row-number-cell') }).first();
        await expect(firstDataRow).toBeVisible();

        // Verify rendering cycle completed — row count should be visible
        const rowCountInfo = page.locator('#rowCountInfo');
        await expect(rowCountInfo).not.toBeEmpty();
    });

    test('handles empty result set with state card', async ({ page }) => {
        // Replace data with empty set and re-initialize
        await page.evaluate(() => {
            const w = window as unknown as { resultSets?: unknown[]; init?: () => void };
            w.resultSets = [{
                data: [],
                columns: [],
                executionTimestamp: Date.now(),
                isLog: false,
                isError: false,
                isTextContent: false,
                sourceUri: 'test-empty',
            }];
            // init() calls renderGrids() — this triggers full re-render
            w.init?.();
        });
        await page.waitForTimeout(500);

        // Should show a state card with "Empty Result Set" title
        const stateCard = page.locator('.result-state-card');
        await expect(stateCard).toBeVisible({ timeout: 5000 });
        await expect(stateCard.locator('.result-state-title')).toContainText('Empty');
    });

    test('clicking column header changes row order (sorting)', async ({ page }) => {
        const getIdValues = () => page.evaluate(() => {
            const cells = document.querySelectorAll('#gridContainer table tbody td:nth-child(2)');
            const values: number[] = [];
            for (const cell of cells) {
                const text = cell.textContent?.trim();
                const num = Number(text);
                if (!isNaN(num) && num > 0 && num < 10000) {
                    values.push(num);
                }
                if (values.length >= 5) break;
            }
            return values;
        });

        // Get order before any sort
        const before = await getIdValues();
        expect(before.length).toBe(5);

        // Sorting is an explicit header action; clicking the header text selects
        // the column and intentionally does not toggle sorting.
        const idHeader = page.locator('#gridContainer table thead th').nth(1);
        await idHeader.locator('.header-btn-sort').click();
        // TanStack starts numeric columns in descending order. The fixture is
        // already descending, so the second click is the first visible change.
        await page.locator('#gridContainer table thead th').nth(1).locator('.header-btn-sort').click();

        await expect.poll(async () => {
            const afterClick = await getIdValues();
            return before.some((value, index) => value !== afterClick[index]);
        }).toBe(true);
    });

    test('sort icon points in the direction of the active sort', async ({ page }) => {
        const ASC_ARROW = 'M8 3l4.5 6h-9L8 3z';
        const DESC_ARROW = 'M8 13l4.5-6h-9L8 13z';
        const sortButton = page.locator('#gridContainer table thead th').nth(1).locator('.header-btn-sort');
        const sortTitle = async () => (await sortButton.getAttribute('title')) ?? '';
        const expectArrowMatchesTitle = async () => {
            await expect.poll(sortTitle).toMatch(/Sorted (ascending|descending)/);
            const expected = (await sortTitle()).includes('descending') ? DESC_ARROW : ASC_ARROW;
            await expect.poll(() => sortButton.locator('svg path').getAttribute('d')).toBe(expected);
        };

        await sortButton.click();
        await expectArrowMatchesTitle();
        const firstTitle = await sortTitle();

        await sortButton.click();
        await expect.poll(sortTitle).not.toBe(firstTitle);
        await expectArrowMatchesTitle();
    });

    test('global filter input is functional', async ({ page }) => {
        const filterInput = page.locator('#globalFilter');
        await expect(filterInput).toBeVisible();

        await filterInput.fill('Michał');

        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toMatch(/125 rows of 1,000/);
        await expect(page.locator('#gridContainer tbody td').filter({ hasText: 'Michał' }).first())
            .toBeVisible();

        await filterInput.fill('');
        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toContain('1,000 rows');
    });

    test('undoes and redoes a global filter for the active result', async ({ page }) => {
        const filterInput = page.locator('#globalFilter');
        const moreToggle = page.locator('#toolbarMoreToggle');

        await filterInput.fill('Anna');
        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toMatch(/125 rows of 1,000/);

        await moreToggle.click();
        await page.locator('#toolbarMoreMenu [data-action="filter-undo"]').click();
        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toContain('1,000 rows');

        await moreToggle.click();
        await page.locator('#toolbarMoreMenu [data-action="filter-redo"]').click();
        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toMatch(/125 rows of 1,000/);
    });

    test('stages a typed edit against the original row after filtering', async ({ page }) => {
        await page.evaluate(() => {
            const w = window as unknown as {
                resultSets: Array<Record<string, unknown>>;
                activeSource?: string;
                updateEditButtons?: () => void;
                addPendingEdit?: (...args: unknown[]) => void;
                __stagedEdit?: unknown[];
            };
            w.resultSets[0].isEditable = true;
            w.resultSets[0].editSource = { db: 'DB', schema: 'PUBLIC', table: 'EMPLOYEE' };
            w.activeSource = 'test-source-1';
            w.addPendingEdit = (...args) => { w.__stagedEdit = args; };
            w.updateEditButtons?.();
        });

        await page.locator('#globalFilter').fill('Anna');
        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toMatch(/125 rows of 1,000/);
        await page.locator('#editToggleBtn').click();

        const firstRow = page.locator('#gridContainer tbody tr').filter({ has: page.locator('td.row-number-cell') }).first();
        await expect(firstRow).toBeVisible();
        const originalRowIndex = await firstRow.getAttribute('data-data-row-index');
        expect(originalRowIndex).toBe('7');
        const originalSalary = await page.evaluate(() => {
            const w = window as unknown as { resultSets: Array<{ data: unknown[][] }> };
            return w.resultSets[0].data[7][2];
        });

        await firstRow.locator('td').nth(3).dblclick();
        const editor = page.locator('.edit-cell-input');
        await expect(editor).toBeVisible();
        await editor.fill('12345678901234567890.123456');
        await editor.press('Enter');

        await expect.poll(() => page.evaluate(() => {
            const w = window as unknown as { __stagedEdit?: unknown[] };
            return w.__stagedEdit ?? null;
        })).toEqual([7, 2, originalSalary, '12345678901234567890.123456']);
    });

    test('column filter changes the rendered result and can be cleared', async ({ page }) => {
        const departmentHeader = page.locator('#gridContainer table thead th').nth(6);
        await departmentHeader.locator('.header-btn-filter').click();

        const dropdown = page.locator('.column-filter-dropdown');
        await expect(dropdown).toBeVisible();
        await dropdown.locator('.filter-search-input').fill('Engineering');

        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toMatch(/167 rows of 1,000/);
        await expect(page.locator('#gridContainer tbody td').filter({ hasText: 'Engineering' }).first())
            .toBeVisible();

        await page.keyboard.press('Escape');
        await page.locator('#toolbarMoreToggle').click();
        await page.locator('#toolbarMoreMenu [data-action="filter-clear"]').click();
        await expect.poll(() => page.locator('#rowCountInfo').textContent()).toContain('1,000 rows');
    });

    test('opens the grouping panel and renders deterministic grouped rows', async ({ page }) => {
        await page.goto(`${TEST_PAGE}?trace=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 },
        );

        await page.evaluate(() => {
            const panel = window as unknown as {
                __toggleDatabaseGroupingPanel?: () => void;
                __testConfigureDatabaseGrouping?: (
                    columns: number[],
                    functions?: Array<{ fn: string; columnIndex?: number }>,
                ) => void;
                __runGroupingQuery?: () => Promise<void>;
            };
            panel.__toggleDatabaseGroupingPanel?.();
            panel.__testConfigureDatabaseGrouping?.([5], [{ fn: 'count' }]);
        });

        await expect(page.locator('#databaseGroupingPanel')).toHaveClass(/visible/);
        await expect(page.locator('#groupingChipsContainer')).toContainText('department');

        await page.evaluate(async () => {
            const panel = window as unknown as { __runGroupingQuery?: () => Promise<void> };
            await panel.__runGroupingQuery?.();
        });

        const groupingTable = page.locator('#groupingResultsArea .grouping-table');
        await expect(groupingTable).toBeVisible({ timeout: 10000 });
        await expect(groupingTable.locator('thead')).toContainText('department');
        await expect(groupingTable.locator('thead')).toContainText('COUNT(*)');
        await expect(groupingTable.locator('tbody tr')).toHaveCount(6);
        await expect(page.locator('#groupingResultsArea .grouping-summary')).toContainText('6');
    });

    test('renders after an initially hidden view without ResizeObserver', async ({ page }) => {
        await page.goto(`${TEST_PAGE}?initiallyHidden=1&disableResizeObserver=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 },
        );

        await expect.poll(() => page.evaluate(() =>
            (window as unknown as { __resultPanelInitCount?: number }).__resultPanelInitCount,
        )).toBe(1);
        await expect(page.locator('#gridContainer table')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('#gridContainer tbody tr').filter({ has: page.locator('td.row-number-cell') }).first())
            .toBeVisible();
    });

    test('applies hydrate then streamed rows for an Untitled source', async ({ page }) => {
        await page.goto(`${TEST_PAGE}?protocol=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 },
        );

        const tabs = page.locator('#resultSetTabs .result-set-tab');
        await expect(tabs).toHaveCount(2, { timeout: 10000 });
        await expect(tabs.nth(0)).toContainText('Logs');
        await expect(page.locator('#gridContainer table thead th').nth(1)).toContainText('id');

        const dataRows = page.locator('#gridContainer table tbody tr').filter({ has: page.locator('td.row-number-cell') });
        await expect(dataRows).toHaveCount(2, { timeout: 10000 });
        await expect(page.locator('#rowCountInfo')).toContainText('2');
    });

    test('requests an authoritative hydrate when streamed Untitled rows arrive without Logs', async ({ page }) => {
        await page.goto(`${TEST_PAGE}?protocol=missing-shell`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 },
        );

        await expect.poll(() => page.evaluate(() => {
            const messages = (window as unknown as { __postedMessages?: Array<{ command?: string; reason?: string }> })
                .__postedMessages ?? [];
            return messages.some(message =>
                message.command === 'requestResultSync'
                && message.reason === 'missing-log-shell-before-data',
            );
        })).toBe(true);

        const tabs = page.locator('#resultSetTabs .result-set-tab');
        await expect(tabs).toHaveCount(2, { timeout: 10000 });
        await expect(tabs.nth(0)).toContainText('Logs');
        await expect(page.locator('#gridContainer table thead th').nth(1)).toContainText('id');
        await expect(page.locator('#gridContainer td.row-number-cell')).toHaveCount(1);
    });

    test('recovers missing, duplicate, delayed, and out-of-order stream chunks without duplicate rows', async ({ page }) => {
        await page.goto(`${TEST_PAGE}?protocol=faulty-stream`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 },
        );

        await expect.poll(() => page.evaluate(() => {
            const messages = (window as unknown as { __postedMessages?: Array<{ command?: string; reason?: string }> })
                .__postedMessages ?? [];
            return messages.filter(message =>
                message.command === 'requestResultSync'
                && message.reason === 'out-of-order-chunk',
            ).length;
        })).toBe(1);

        await expect(page.locator('#gridContainer td.row-number-cell')).toHaveCount(8, { timeout: 10000 });
        await expect(page.locator('#rowCountInfo')).toContainText('8');
        const ids = await page.locator('#gridContainer tbody tr td:nth-child(2)').allTextContents();
        expect(ids.map(value => Number(value.trim())).filter(Number.isFinite)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });
});

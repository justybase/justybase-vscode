import { test, expect } from '@playwright/test';

const TEST_PAGE = 'http://localhost:8892/test-harness/table-rendering.html';

test.describe('Table rendering', () => {

    test.beforeEach(async ({ page }) => {
        await page.goto(TEST_PAGE, { waitUntil: 'networkidle' });
        // Wait for the grid to finish rendering — ✅ emoji appears only after init() succeeds
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 }
        );
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

    test('recovers rendering and scrolling after hidden initialization without ResizeObserver', async ({ page }) => {
        await page.goto(`${TEST_PAGE}?initiallyHidden=1&disableResizeObserver=1`, { waitUntil: 'networkidle' });
        await page.waitForFunction(
            () => document.getElementById('renderStatus')?.textContent?.includes('✅'),
            { timeout: 15000 }
        );

        const hiddenRowCount = await page.locator('#gridContainer td.row-number-cell').count();
        expect(hiddenRowCount).toBeGreaterThan(0);

        await page.evaluate(() => {
            const splitView = document.getElementById('mainSplitView');
            if (splitView) splitView.style.display = 'flex';
        });

        const gridWrapper = page.locator('#gridContainer .grid-wrapper');
        await expect(gridWrapper).toBeVisible();
        const initialFirstRowNum = Number(
            (await page.locator('#gridContainer td.row-number-cell').first().textContent())?.trim()
        );

        await gridWrapper.evaluate(element => {
            element.scrollTop = 10000;
        });
        await page.waitForTimeout(1000);

        const scrolledFirstRowNum = Number(
            (await page.locator('#gridContainer td.row-number-cell').first().textContent())?.trim()
        );
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

        // Click 'id' column header (th at index 1) to toggle sort
        const idHeader = page.locator('#gridContainer table thead th').nth(1);
        await idHeader.click();
        await page.waitForTimeout(800);

        // After first click, the order should have changed
        const afterClick = await getIdValues();

        // Compare: the order should be different from before
        const changed = before.some((v, i) => v !== afterClick[i]);
        expect(changed).toBe(true);
    });

    test('global filter input is functional', async ({ page }) => {
        const filterInput = page.locator('#globalFilter');
        await expect(filterInput).toBeVisible();

        await filterInput.fill('search-term');
        await page.waitForTimeout(300);

        const inputValue = await filterInput.inputValue();
        expect(inputValue).toBe('search-term');
    });
});

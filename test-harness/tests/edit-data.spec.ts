import { test, expect, type Page } from '@playwright/test';

type Posted = { command: string; [key: string]: unknown };

async function open(page: Page, query = ''): Promise<void> {
    await page.goto(`/test-harness/edit-data.html${query}`);
    await page.waitForSelector('.data-grid tbody tr[data-key]');
}

async function posted(page: Page): Promise<Posted[]> {
    return page.evaluate(() => (window as unknown as { __posted: Posted[] }).__posted);
}

type DetailsFixture = {
    command: 'setData';
    data: Record<string, unknown>[];
    columns: string[];
    metadata: Record<string, unknown>;
    readOnly: boolean;
};

async function loadDetails(page: Page, fixture: DetailsFixture, readySelector: string): Promise<void> {
    await page.evaluate((message) => window.postMessage(message, '*'), fixture);
    await page.waitForSelector(readySelector, { state: 'attached' });
}

const cell = (page: Page, row: number, col: number) =>
    page.locator(`.data-grid tr[data-index="${row}"] td[data-col="${col}"]`);

test.describe('Edit Data panel webview', () => {
    test('renders a typed grid with row numbers and load details', async ({ page }) => {
        await open(page);
        await expect(page.locator('.data-grid thead th[data-col]')).toHaveCount(8);
        await expect(page.locator('.data-grid thead th[data-col="0"] .tb')).toHaveText('INTE');
        await expect(page.locator('.data-grid thead th[data-col="0"] .key-mark.pk')).toBeVisible();
        await expect(page.locator('.data-grid tr[data-index="0"] td.gutter')).toHaveText('1');
        await expect(cell(page, 4, 2)).toHaveText('NULL');
        await expect(page.locator('#statusLeft')).toContainText('1 200 rows');
        await expect(page.locator('#saveBtn')).toBeDisabled();
    });

    test('edits a cell inline and submits a coerced numeric change', async ({ page }) => {
        await open(page);
        await cell(page, 1, 3).dblclick();
        const editor = page.locator('input.cell-editor');
        await expect(editor).toBeFocused();
        await editor.fill('42');
        await page.keyboard.press('Enter');

        await expect(cell(page, 1, 3)).toHaveClass(/cell-modified/);
        await expect(page.locator('#pendingCount')).toHaveText('1');
        // Enter moved the active cell down.
        await expect(cell(page, 2, 3)).toHaveClass(/cell-active/);

        await page.keyboard.press('Control+s');
        const save = (await posted(page)).find(m => m.command === 'save');
        expect(save?.changes).toEqual({ updates: [{ rowId: 1700007, changes: { BALANCE: 42 } }], deletes: [], inserts: [] });
    });

    test('Escape cancels an edit started by typing', async ({ page }) => {
        await open(page);
        await cell(page, 0, 1).click();
        await page.keyboard.type('Zed');
        await expect(page.locator('input.cell-editor')).toHaveValue('Zed');
        await page.keyboard.press('Escape');
        await expect(cell(page, 0, 1)).toHaveText('Anna Kowalska');
        await expect(page.locator('#pendingCount')).toBeHidden();
    });

    test('marks rows for deletion and inserts new rows', async ({ page }) => {
        await open(page);
        await page.locator('.data-grid tr[data-index="2"] td.gutter').click();
        await page.keyboard.press('Delete');
        await expect(page.locator('.data-grid tr[data-index="2"]')).toHaveClass(/row-deleted/);

        await page.click('#addRowBtn');
        await expect(page.locator('input.cell-editor')).toBeFocused();
        await page.keyboard.type('77');
        await page.keyboard.press('Tab');
        await expect(page.locator('.data-grid tr.row-new')).toHaveCount(1);
        await expect(page.locator('#statusLeft')).toContainText('1 inserted');
        await expect(page.locator('#statusLeft')).toContainText('1 deleted');
    });

    test('asks before discarding pending changes on refresh', async ({ page }) => {
        await open(page);
        await cell(page, 0, 1).dblclick();
        await page.locator('input.cell-editor').fill('Changed');
        await page.keyboard.press('Enter');

        await page.click('#refreshBtn');
        const dialog = page.locator('.dialog');
        await expect(dialog).toContainText('Discard pending changes?');
        await dialog.locator('[data-dialog-button="cancel"]').click();
        expect((await posted(page)).some(m => m.command === 'refresh')).toBe(false);

        await page.click('#refreshBtn');
        await page.locator('.dialog [data-dialog-button="ok"]').click();
        expect((await posted(page)).some(m => m.command === 'refresh')).toBe(true);
    });

    test('shows the SQL preview returned by the host', async ({ page }) => {
        await open(page);
        await page.locator('.data-grid tr[data-index="0"] td.gutter').click();
        await page.keyboard.press('Delete');
        await page.click('#previewSqlBtn');
        await expect(page.locator('.dialog .code-text')).toContainText('DELETE FROM JUST_DATA.ADMIN.CUSTOMER_ORDERS WHERE ROWID IN (1700000)');
        await expect(page.locator('.dialog .code-text')).toContainText('COMMIT;');
    });

    test('virtualizes rows and keeps numbering while scrolling', async ({ page }) => {
        await open(page);
        expect(await page.locator('.data-grid tbody tr[data-key]').count()).toBeLessThan(120);
        await page.locator('#gridContainer').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await expect(page.locator('.data-grid tr[data-index="1199"] td.gutter')).toHaveText('1200');
    });

    test('confirms dropping a column from the Structure tab', async ({ page }) => {
        await open(page);
        await page.click('.tab[data-target="tab-metadata"]');
        await expect(page.locator('.struct-grid tbody tr[data-name]')).toHaveCount(8);
        const row = page.locator('.struct-grid tr[data-name="notes"]');
        await row.hover();
        await row.locator('.drop-col-btn').click();
        await page.locator('.dialog [data-dialog-button="ok"]').click();
        expect(await posted(page)).toContainEqual({ command: 'dropColumn', column: 'NOTES' });
    });

    test('loads DDL lazily when the DDL tab opens', async ({ page }) => {
        await open(page);
        expect((await posted(page)).some(m => m.command === 'requestDdl')).toBe(false);
        await page.click('.tab[data-target="tab-ddl"]');
        await expect(page.locator('#ddlContent .code-text')).toContainText('CREATE TABLE JUST_DATA.ADMIN.CUSTOMER_ORDERS');
        await expect(page.locator('#ddlCopyBtn')).toBeEnabled();
    });

    test('renders views read-only with inspector-only structure', async ({ page }) => {
        await open(page);
        await loadDetails(page, {
            command: 'setData',
            data: [{ CUSTOMER_ID: 1, NAME: 'Anna' }],
            columns: ['CUSTOMER_ID', 'NAME'],
            metadata: {
                tableComment: 'Reporting view',
                objectKind: 'view',
                columns: [
                    { ATTNAME: 'CUSTOMER_ID', FORMAT_TYPE: 'INTEGER', IS_NOT_NULL: 1, COLDEFAULT: null, DESCRIPTION: 'Business key', IS_PK: 0, IS_FK: 0 },
                    { ATTNAME: 'NAME', FORMAT_TYPE: 'VARCHAR(100)', IS_NOT_NULL: 0, COLDEFAULT: null, DESCRIPTION: '', IS_PK: 0, IS_FK: 0 },
                ],
            },
            readOnly: true,
        }, '.struct-grid tbody tr[data-name]');

        await page.click('.tab[data-target="tab-metadata"]');
        await expect(page.locator('#tableCommentBox')).toHaveAttribute('readonly', '');
        await expect(page.locator('#saveTableCommentBtn')).toHaveCount(0);
        await expect(page.locator('#revertTableCommentBtn')).toHaveCount(0);
        await expect(page.locator('#showAddColumnBtn')).toHaveCount(0);
        await expect(page.locator('.col-comment-readonly')).toHaveText('Business key');
        await expect(page.locator('input.col-comment')).toHaveCount(0);
        await expect(page.locator('.drop-col-btn')).toHaveCount(0);

        await page.click('.tab[data-target="tab-data"]');
        await cell(page, 0, 1).dblclick();
        await expect(page.locator('input.cell-editor')).toHaveCount(0);
        await page.keyboard.press('Control+s');
        expect((await posted(page)).some(m => m.command === 'save')).toBe(false);
    });

    test('renders procedure definition and arguments without column editing', async ({ page }) => {
        await open(page);
        await loadDetails(page, {
            command: 'setData',
            data: [],
            columns: [],
            metadata: {
                tableComment: '',
                objectKind: 'procedure',
                columns: [],
                properties: [
                    { label: 'Kind', value: 'PROCEDURE' },
                    { label: 'Signature', value: 'LOAD_CUSTOMERS(INT)' },
                    { label: 'Owner', value: 'ADMIN' },
                ],
                arguments: [{ position: 1, type: 'INT' }],
            },
            readOnly: true,
        }, '.struct-property');

        await page.click('.tab[data-target="tab-metadata"]');
        await expect(page.locator('.struct-property')).toHaveCount(3);
        await expect(page.locator('.struct-properties')).toContainText('LOAD_CUSTOMERS(INT)');
        await expect(page.locator('.struct-grid tbody tr[data-name]')).toHaveCount(1);
        await expect(page.locator('#tableCommentBox')).toHaveCount(0);
        await expect(page.locator('#showAddColumnBtn')).toHaveCount(0);
    });
});

import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const screenshotDirectory = path.resolve(__dirname, '../../artifacts/playwright/web-sql');

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

test.beforeEach(({ browser }) => {
  // Keep the managed browser version in the Playwright report. A missing
  // chromium executable and an incompatible browser version are different
  // failures, so the gate must leave an auditable environment fingerprint.
  test.info().annotations.push({ type: 'chromium', description: browser.version() });
});

function hasLiveNetezzaConfiguration(): boolean {
  return Boolean(netezza.host && netezza.user && netezza.password && netezza.database);
}

async function capture(page: Page, name: string): Promise<void> {
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDirectory, name), fullPage: false });
}

async function replaceEditorText(page: Page, sql: string): Promise<void> {
  const editor = page.locator('.monaco-editor:visible').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(sql);
  const visibleMarker = sql.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1) ?? '';
  const expectedMarker = sql.trim().toUpperCase() === 'SX' ? 'SELECT' : visibleMarker;
  await expect.poll(async () => (await page.locator('.monaco-editor .view-line').allTextContents()).join('\n').replaceAll('\u00a0', ' ')).toContain(expectedMarker);
}

async function replaceMonacoTextAndWait(page: Page, sql: string): Promise<void> {
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(sql);
  // Monaco virtualizes view lines. Move the caret to the end so the marker
  // used below is in the rendered viewport even for long diagnostic fixtures.
  await page.keyboard.press('Control+End');
  // Monaco may append an auto-closing parenthesis when a multi-line paste
  // contains a CTE. Remove only that generated trailing delimiter; the
  // source fixture remains the exact SQL sent to the API.
  if (sql.includes('(')) {
    await page.keyboard.press('Backspace');
  }
  const visibleMarker = sql.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1) ?? '';
  const expectedMarker = sql.trim().toUpperCase() === 'SX' ? 'SELECT' : visibleMarker;
  await expect.poll(async () => (await page.locator('.monaco-editor .view-line').allTextContents()).join('\n').replaceAll('\u00a0', ' ')).toContain(expectedMarker);
}

async function waitForCompletedResult(page: Page): Promise<void> {
  await expect.poll(async () => page.locator('.results-header').innerText()).toMatch(/complete/);
  await expect(page.locator('.result-grid, .explain-panel').first()).toBeVisible();
}

async function openRunMenu(page: Page): Promise<void> {
  await page.getByTitle('More run options').click();
  await expect(page.locator('.tb-run-dropdown')).toBeVisible();
}

async function loginWithTestData(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'Use test login data', exact: true });
  await expect(button).toBeVisible();
  await button.click();
}

async function connectionIdByName(page: Page, profileName: string): Promise<string> {
  return page.evaluate(async name => {
    const response = await fetch('/api/connections', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not load connection profiles (${response.status}).`);
    const profiles = await response.json() as Array<{ id?: unknown; name?: unknown }>;
    const profile = profiles.find(item => item.name === name);
    if (!profile || typeof profile.id !== 'string') throw new Error(`Connection profile ${name} was not returned by the API.`);
    return profile.id;
  }, profileName);
}

/** Execute a guarded schema mutation and wait for the real query event terminal. */
async function executeWriteStatement(page: Page, connectionId: string, sql: string, database = ':memory:'): Promise<void> {
  const outcome = await page.evaluate(async input => {
    const csrfCookie = document.cookie.split('; ').find(cookie => cookie.startsWith('justybase_csrf='));
    const csrf = csrfCookie?.slice('justybase_csrf='.length);
    if (!csrf) throw new Error('The browser session did not expose a CSRF token.');
    const postJson = async (url: string, body: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-justybase-csrf': decodeURIComponent(csrf) },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* error below carries the status */ }
      if (!response.ok) throw new Error(`${url} failed (${response.status}): ${String(payload.message ?? text).slice(0, 300)}`);
      return payload;
    };
    const preview = await postJson('/api/query/preview', { connectionId: input.connectionId, database: input.database, sql: input.sql, mode: 'single' });
    const started = await postJson('/api/query', {
      connectionId: input.connectionId,
      database: input.database,
      sql: input.sql,
      mode: 'single',
      writeConfirmed: true,
      writePreviewToken: preview.previewToken,
    });
    if (typeof started.queryId !== 'string') throw new Error('The schema mutation did not return a query id.');
    return await new Promise<{ status: string; message?: string }>((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/iu, 'ws')}/api/ws`);
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        socket.close();
        callback();
      };
      const timer = window.setTimeout(() => finish(() => reject(new Error('Timed out waiting for the schema mutation event.'))), 30_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', queryId: started.queryId })));
      socket.addEventListener('message', event => {
        const payload = JSON.parse(String(event.data)) as { type?: string; status?: string; message?: string };
        if (payload.type === 'error') finish(() => reject(new Error(payload.message ?? 'The schema mutation failed.')));
        if (payload.type === 'batch-complete') finish(() => resolve({ status: payload.status ?? 'unknown', message: payload.message }));
      });
      socket.addEventListener('error', () => finish(() => reject(new Error('The schema mutation WebSocket failed.'))));
    });
  }, { connectionId, database, sql });
  expect(outcome.status, outcome.message).toBe('complete');
}

async function monacoDocumentText(page: Page): Promise<string> {
  return (await page.locator('.monaco-editor .view-line').allTextContents()).join('\n').replaceAll('\u00a0', ' ');
}

test.describe('deterministic SQLite API-backed web workspace', () => {
  test('runs a controlled fixture through authentication, connection, result, and history @web-api', async ({ page }) => {
    const profileName = `Playwright SQLite ${Date.now()}`;
    const fixtureQuery = `SELECT 1 AS SCENARIO_ID, 'SQLITE_FIXTURE' AS ENGINE_NAME
UNION ALL
SELECT 2, 'SQLITE_FIXTURE'
UNION ALL
SELECT 3, 'SQLITE_FIXTURE'`;

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await page.evaluate(() => {
      localStorage.setItem('jwb_sidebar', '333');
      localStorage.setItem('jwb_editor_pct', '62');
    });
    await loginWithTestData(page);
    await expect(page.locator('.dockyard-schema-tool:visible')).toBeVisible();
    await expect.poll(async () => page.locator('.dockyard-query-editor:visible').first().getAttribute('style')).toContain('height: 62%');
    await expect.poll(async () => page.evaluate(() => ({
      sidebar: Object.entries(localStorage).find(([key]) => key.endsWith(':sidebar'))?.[1] ?? null,
      editorPct: Object.entries(localStorage).find(([key]) => key.endsWith(':editor_pct'))?.[1] ?? null,
      legacySidebar: localStorage.getItem('jwb_sidebar'),
      legacyEditorPct: localStorage.getItem('jwb_editor_pct'),
    }))).toEqual({ sidebar: '333', editorPct: '62', legacySidebar: null, legacyEditorPct: null });

    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(page.locator('.dockyard-connections-tool:visible')).toBeVisible();
    await page.locator('.dockyard-connections-tool .section-title .icon-button').click();
    const dialog = page.getByRole('dialog', { name: 'Add connection' });
    await dialog.getByLabel('Database type').selectOption('sqlite');
    await dialog.getByLabel('Profile name').fill(profileName);
    await dialog.locator('#connection-database').fill(':memory:');
    await dialog.getByLabel('User').fill('local');
    await dialog.getByRole('button', { name: 'Add connection', exact: true }).click();
    await expect(page.getByRole('button', { name: profileName, exact: true })).toBeVisible();

    await replaceEditorText(page, fixtureQuery);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await waitForCompletedResult(page);
    await expect(page.locator('.result-grid tbody tr')).toHaveCount(3);
    await expect(page.locator('.result-grid')).toContainText('SQLITE_FIXTURE');
    const sortButton = page.getByTitle('Sort by SCENARIO_ID');
    await sortButton.click();
    await expect(sortButton.getByLabel('Sorted ascending')).toBeVisible();
    await expect(page.locator('.grid-error')).toHaveCount(0);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('.history-card .section-title')).toContainText('Query history');
    await expect(page.locator('.history-entry').first()).toContainText('SQLITE_FIXTURE');
  });

  test('keeps Monaco input focused in a short editor pane while typing @web-api', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await loginWithTestData(page);

    const editor = page.locator('.monaco-editor:visible').first();
    await expect(editor).toBeVisible();
    const split = page.locator('.split-handle-v:visible').first();
    const splitBox = await split.boundingBox();
    if (splitBox) {
      await page.mouse.move(splitBox.x + splitBox.width / 2, splitBox.y);
      await page.mouse.down();
      await page.mouse.move(splitBox.x + splitBox.width / 2, Math.max(160, splitBox.y - 180), { steps: 8 });
      await page.mouse.up();
    }
    await expect.poll(async () => (await editor.boundingBox())?.height ?? 0).toBeGreaterThan(80);

    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    const sql = 'SELECT * FROM JUST_DATA.ADMIN.DIMDATE D WHERE D.';
    await page.keyboard.type(sql, { delay: 8 });
    await expect.poll(() => monacoDocumentText(page), { timeout: 15_000 }).toContain('SELECT * FROM JUST_DATA.ADMIN.DIMDATE D WHERE D.');
    await expect.poll(async () => page.evaluate(() => document.activeElement?.className ?? ''), { timeout: 15_000 }).toContain('native-edit-context');
  });

  test('keeps query documents and Dockyard tool layout across reorder, float, auto-hide, and reload @web-api', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await loginWithTestData(page);
    await expect(page.locator('.dockyard-host.ad-manager')).toBeVisible();

    const documents = page.locator('.ad-document-pane .ad-tab');
    await expect(documents).toHaveCount(1);
    await page.getByRole('button', { name: 'New query', exact: true }).click();
    await expect(documents).toHaveCount(2);
    await expect(documents.nth(1).locator('.ad-label-text')).toContainText('Query 2');
    await page.getByRole('button', { name: 'New query', exact: true }).click();
    await expect(documents).toHaveCount(3);
    await replaceEditorText(page, 'SELECT 99 AS CLOSE_CANCEL');
    await documents.nth(2).click({ button: 'right' });
    const dirtyTabMenu = page.getByRole('menu', { name: 'Query 3' });
    await expect(dirtyTabMenu).toBeVisible();
    page.once('dialog', dialog => { void dialog.dismiss(); });
    await dirtyTabMenu.getByRole('menuitem', { name: /^Close Ctrl\+F4$/u }).click();
    await expect(documents).toHaveCount(3);
    await documents.nth(2).click({ button: 'right' });
    await expect(dirtyTabMenu).toBeVisible();
    page.once('dialog', dialog => { void dialog.accept(); });
    await dirtyTabMenu.getByRole('menuitem', { name: /^Close Ctrl\+F4$/u }).click();
    await expect(documents).toHaveCount(2);

    const secondTabBox = await documents.nth(1).boundingBox();
    const firstTabBox = await documents.nth(0).boundingBox();
    expect(secondTabBox).not.toBeNull();
    expect(firstTabBox).not.toBeNull();
    await page.mouse.move(secondTabBox!.x + secondTabBox!.width / 2, secondTabBox!.y + secondTabBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(firstTabBox!.x + 4, firstTabBox!.y + firstTabBox!.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await documents.nth(0).locator('.ad-label-text').textContent())?.trim()).toBe('Query 2');

    await documents.nth(0).click({ button: 'right' });
    const queryMenu = page.getByRole('menu', { name: 'Query 2' });
    await expect(queryMenu).toBeVisible();
    await expect(queryMenu.getByRole('menuitem', { name: 'Float', exact: true })).toBeVisible();
    await expect(queryMenu.getByRole('menuitem', { name: 'Open in browser window', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(queryMenu).toHaveCount(0);

    await documents.nth(0).dblclick();
    await expect(page.locator('.ad-floating')).toHaveCount(1);
    await page.getByRole('button', { name: 'Dock window' }).click();
    await expect(page.locator('.ad-floating')).toHaveCount(0);

    const explorerPane = page.locator('.ad-anchorable-pane:has([data-tab-id="schema"])');
    await explorerPane.getByRole('button', { name: 'Auto-hide group' }).click();
    const schemaAnchor = page.locator('.ad-anchor-tab[data-content-id="schema"]');
    await expect(schemaAnchor).toBeVisible();
    await schemaAnchor.click();
    await expect(page.locator('.ad-peek')).toBeVisible();
    await page.getByRole('button', { name: 'Pin tool window' }).click();
    await expect(schemaAnchor).toHaveCount(0);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.locator('.dockyard-history-tool .section-title')).toContainText('Query history');
    await page.getByRole('button', { name: 'Explain', exact: true }).click();
    await expect(page.locator('.dockyard-explain-tool')).toBeVisible();

    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.locator('.dockyard-connections-tool .section-title .icon-button').click();
    await expect(page.getByRole('dialog', { name: 'Add connection' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Add connection' })).toHaveCount(0);

    await page.getByRole('button', { name: '⚙ Settings', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Editor settings' })).toBeVisible();
    await page.getByRole('button', { name: 'Close editor settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Editor settings' })).toHaveCount(0);

    const storedLayout = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(value => value.endsWith(':dockyard_layout_v1'));
      return key ? localStorage.getItem(key) : null;
    });
    expect(storedLayout).not.toBeNull();
    expect(storedLayout).toContain('justybase-dockyard-layout');
    expect(storedLayout).not.toMatch(/password|resultRows|rowData|runtimeHandle/iu);
    const reorderedFirstId = await documents.nth(0).getAttribute('data-tab-id');
    const persistedDocumentOrder = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(value => value.endsWith(':dockyard_layout_v1'));
      const raw = key ? localStorage.getItem(key) : null;
      if (!raw) return [];
      const root = (JSON.parse(raw) as { payload?: { snapshot?: { layout?: unknown } } }).payload?.snapshot?.layout;
      const order: string[] = [];
      const visit = (record: unknown): void => {
        if (!record || typeof record !== 'object') return;
        const value = record as { type?: unknown; props?: { ContentId?: unknown }; children?: unknown[]; rootPanel?: unknown; sides?: Record<string, unknown>; floatingWindows?: unknown[]; hidden?: unknown[] };
        if (value.type === 'LayoutDocument' && typeof value.props?.ContentId === 'string') order.push(value.props.ContentId);
        visit(value.rootPanel);
        for (const child of value.children ?? []) visit(child);
        for (const side of Object.values(value.sides ?? {})) visit(side);
        for (const child of value.floatingWindows ?? []) visit(child);
        for (const child of value.hidden ?? []) visit(child);
      };
      visit(root);
      return order;
    });
    expect(persistedDocumentOrder[0]).toBe(reorderedFirstId);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.dockyard-host.ad-manager')).toBeVisible();
    await expect(page.locator('.dockyard-init-error')).toHaveCount(0);
    await expect(documents).toHaveCount(2);
    await expect.poll(async () => (await documents.nth(0).locator('.ad-label-text').textContent())?.trim()).toBe('Query 2');

    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.dockyard-shell')).toBeVisible();
    await expect(page.locator('.dockyard-tool-buttons')).toBeVisible();

    const layoutKey = await page.evaluate(() => Object.keys(localStorage).find(value => value.endsWith(':dockyard_layout_v1')) ?? null);
    expect(layoutKey).not.toBeNull();
    const validLayoutKey = layoutKey as string;
    await page.evaluate(key => {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 99, scope: 'user', payload: {} }));
    }, validLayoutKey);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('.dockyard-host.ad-manager')).toBeVisible();
    await expect(page.locator('.dockyard-init-error')).toHaveCount(0);
    await expect.poll(async () => page.evaluate(key => localStorage.getItem(key), validLayoutKey)).toContain('justybase-dockyard-layout');
  });
});

test.describe('shared React web workspace', () => {
  test('opens and copies reconstructed SQLite table/view DDL from the schema explorer @web-shared', async ({ page }) => {
    const profileName = `Shared DDL SQLite ${Date.now()}`;
    const database = `shared-ddl-${Date.now()}.sqlite`;
    const tableName = `pw_ddl_table_${Date.now()}`;
    const viewName = `pw_ddl_view_${Date.now()}`;

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await loginWithTestData(page);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await page.locator('.shared-sidebar-heading button[aria-label="Add connection"]').click();
    const dialog = page.getByRole('dialog', { name: 'Add connection' });
    await dialog.getByLabel('Database type').selectOption('sqlite');
    await dialog.getByLabel('Profile name').fill(profileName);
    await dialog.locator('#connection-database').fill(database);
    await dialog.getByLabel('User').fill('local');
    await dialog.locator('input[type="checkbox"]').uncheck();
    await dialog.getByRole('button', { name: 'Add connection', exact: true }).click();
    await expect(page.getByRole('button', { name: profileName, exact: true })).toBeVisible();

    const connectionId = await connectionIdByName(page, profileName);
    await executeWriteStatement(page, connectionId, `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount NUMERIC);`, 'main');
    await executeWriteStatement(page, connectionId, `CREATE VIEW ${viewName} AS SELECT id, label FROM ${tableName};`, 'main');

    const schema = page.getByRole('tree', { name: 'Schema' });
    await page.getByRole('button', { name: 'Refresh schema' }).click();
    const search = page.getByRole('textbox', { name: 'Search schema' });
    await search.fill(tableName);
    const tableNode = schema.getByRole('treeitem').filter({ hasText: tableName }).first();
    await expect(tableNode).toBeVisible({ timeout: 30_000 });
    await tableNode.click({ button: 'right' });
    const tableMenu = page.getByRole('menu', { name: `Actions for ${tableName}` });
    await expect(tableMenu).toBeVisible();
    await tableMenu.getByRole('menuitem', { name: 'Copy DDL', exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toContain(`CREATE TABLE main.${tableName}`);
    await expect(page.getByRole('status').filter({ hasText: 'Reconstructed DDL copied' })).toBeVisible();

    await tableNode.click({ button: 'right' });
    await page.getByRole('menu', { name: `Actions for ${tableName}` }).getByRole('menuitem', { name: 'Open DDL', exact: true }).click();
    await expect(page.getByRole('tab', { name: `DDL · ${tableName}`, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => monacoDocumentText(page), { timeout: 30_000 }).toContain(`CREATE TABLE main.${tableName}`);
    await expect.poll(() => monacoDocumentText(page), { timeout: 30_000 }).toContain('label TEXT');
    await expect(page.getByRole('status').filter({ hasText: 'Reconstructed DDL opened' })).toBeVisible();

    await tableNode.click({ button: 'right' });
    await page.getByRole('menu', { name: `Actions for ${tableName}` }).getByRole('menuitem', { name: 'Open Object Designer', exact: true }).click();
    const designer = page.getByRole('dialog', { name: tableName });
    await expect(designer).toBeVisible();
    await expect(designer.getByText('Runtime available')).toBeVisible();
    await expect(designer.getByText('Writable connection')).toBeVisible();
    await designer.getByRole('button', { name: 'Columns', exact: true }).click();
    await designer.getByLabel('Column name').fill('designer_added');
    await designer.getByLabel('Data type').fill('TEXT');
    await designer.getByRole('button', { name: 'Preview SQL', exact: true }).click();
    await expect.poll(() => designer.getByLabel('SQL preview').inputValue()).toContain(`ALTER TABLE "main"."${tableName}"`);
    await expect(designer.getByText('1 statement(s)')).toBeVisible();
    await designer.getByRole('button', { name: 'Apply preview', exact: true }).click();
    await expect(designer).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Object designer change applied' })).toBeVisible();

    await page.getByRole('button', { name: 'Refresh schema' }).click();
    await search.fill(tableName);
    const refreshedTableNode = schema.getByRole('treeitem').filter({ hasText: tableName }).first();
    await expect(refreshedTableNode).toBeVisible({ timeout: 30_000 });
    await refreshedTableNode.click({ button: 'right' });
    await page.getByRole('menu', { name: `Actions for ${tableName}` }).getByRole('menuitem', { name: 'Copy DDL', exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toContain('designer_added TEXT');

    await search.fill(viewName);
    const viewNode = schema.getByRole('treeitem').filter({ hasText: viewName }).first();
    await expect(viewNode).toBeVisible({ timeout: 30_000 });
    await viewNode.click({ button: 'right' });
    const viewMenu = page.getByRole('menu', { name: `Actions for ${viewName}` });
    await viewMenu.getByRole('menuitem', { name: 'Copy DDL', exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toContain(`CREATE VIEW ${viewName} AS SELECT id, label FROM ${tableName}`);
    await expect(page.getByRole('status').filter({ hasText: 'Reconstructed DDL copied' })).toBeVisible();

    await viewNode.click({ button: 'right' });
    await page.getByRole('menu', { name: `Actions for ${viewName}` }).getByRole('menuitem', { name: 'Open DDL', exact: true }).click();
    await expect(page.getByRole('tab', { name: `DDL · ${viewName}`, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => monacoDocumentText(page), { timeout: 30_000 }).toContain(`CREATE VIEW ${viewName} AS SELECT id, label FROM ${tableName}`);
  });

  test('uses the shared authoring and Result Grid contract in a real browser @web-shared', async ({ page }) => {
    const profileName = `Shared SQLite ${Date.now()}`;
    const fixtureQuery = `WITH RECURSIVE seq(value) AS (
  SELECT 1
  UNION ALL
  SELECT value + 1 FROM seq WHERE value < 1200
)
SELECT value AS ID,
  'shared-grid-' || value AS LABEL,
  value % 5 AS BUCKET,
  value AS COL_04,
  value AS COL_05,
  value AS COL_06,
  value AS COL_07,
  value AS COL_08,
  value AS COL_09,
  value AS COL_10,
  value AS COL_11,
  value AS COL_12
FROM seq`;

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await loginWithTestData(page);
    await expect(page.getByRole('heading', { name: 'JustyBase' })).toBeVisible();
    await expect(page.getByRole('tree', { name: 'Schema' })).toBeVisible();
    // Results and Problems share one output panel. Verify the diagnostics
    // tab explicitly instead of assuming both panels are mounted together.
    await page.getByRole('tab', { name: /Problems/ }).click();
    await expect(page.getByRole('region', { name: 'SQL Problems' })).toBeVisible();
    await page.getByRole('tab', { name: 'Results', exact: true }).click();

    await page.locator('.shared-sidebar-heading button[aria-label="Add connection"]').click();
    const dialog = page.getByRole('dialog', { name: 'Add connection' });
    await dialog.getByLabel('Database type').selectOption('sqlite');
    await dialog.getByLabel('Profile name').fill(profileName);
    await dialog.locator('#connection-database').fill(':memory:');
    await dialog.getByLabel('User').fill('local');
    await dialog.getByRole('button', { name: 'Add connection', exact: true }).click();
    const connection = page.getByRole('button', { name: profileName, exact: true });
    await expect(connection).toBeVisible();
    await expect(connection).toHaveAttribute('aria-pressed', 'true');

    const dialect = page.getByLabel('SQL authoring dialect');
    const authoringCompletionChecks = [
      ['postgresql', 'RETURN', 'RETURNING'],
      ['db2', 'FETCH', 'FETCH FIRST'],
      ['clickhouse', 'PRE', 'PREWHERE'],
      ['oracle', 'CONNECT', 'CONNECT BY'],
      ['mssql', 'TOP', 'TOP'],
    ] as const;
    for (const [kind, prefix, expected] of authoringCompletionChecks) {
      await dialect.selectOption(kind);
      await expect(dialect).toHaveValue(kind);
      await replaceMonacoTextAndWait(page, `SELECT * FROM T ${prefix}`);
      await page.locator('.monaco-editor').click();
      await page.keyboard.press('Control+Space');
      const dialectSuggestionWidget = page.locator('.suggest-widget');
      await expect(dialectSuggestionWidget).toBeVisible({ timeout: 30_000 });
      await expect(dialectSuggestionWidget).toContainText(expected);
      await page.keyboard.press('Escape');
    }
    await dialect.selectOption('netezza');
    await expect(dialect).toHaveValue('netezza');

    // Exercise the production Monaco provider path, not only the textarea
    // fallback used by component tests. Completion must arrive from the same
    // API/LSP contract that feeds diagnostics and code actions.
    await replaceMonacoTextAndWait(page, 'SELECT NU');
    const editor = page.locator('.monaco-editor');
    await editor.click();
    await page.keyboard.press('Control+Space');
    const suggestionWidget = page.locator('.suggest-widget');
    await expect(suggestionWidget).toBeVisible({ timeout: 30_000 });
    await expect(suggestionWidget).toContainText(/NULLIF|SUBSTR|NVL2/u);
    await page.keyboard.press('Escape');

    // Parser diagnostics and the shared Problems view must remain actionable
    // on a long document, where selecting a problem also has to reveal its
    // source line in Monaco.
    const badSql = `${'SELECT 1;\n'.repeat(80)}SELCT 2;`;
    await replaceMonacoTextAndWait(page, badSql);
    await page.getByRole('tab', { name: /Problems/ }).click();
    const typoProblem = page.locator('.ui-sql-problem').filter({ hasText: 'PAR004' }).first();
    await expect(typoProblem).toBeVisible({ timeout: 30_000 });
    await typoProblem.click();
    await page.keyboard.press('Control+.');
    const codeActionWidget = page.locator('.action-widget');
    await expect(codeActionWidget).toBeVisible({ timeout: 30_000 });
    await expect(codeActionWidget).toContainText(/Fix typo|Apply PAR004/u);
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Results', exact: true }).click();

    await replaceMonacoTextAndWait(page, 'SX ');
    await expect.poll(async () => (await page.locator('.monaco-editor .view-line').allTextContents()).join('\n').replaceAll('\u00a0', ' ')).toContain('SELECT ');
    await replaceMonacoTextAndWait(page, fixtureQuery);
    await page.getByRole('button', { name: 'Run', exact: true }).click();

    const grid = page.locator('.ui-data-grid-scroll');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => await grid.getAttribute('aria-label'), { timeout: 30_000 }).toBe('Data grid with 1200 rows');
    await expect(page.locator('table.ui-data-grid')).toBeVisible();
    await expect(page.locator('tr[data-source-index]').first()).toBeVisible();

    // A filter that is outside the first hydrated page must drive the shared
    // adapter through subsequent pages before it is considered complete.
    const resultFilter = page.getByLabel('Filter results');
    await resultFilter.fill('shared-grid-1199');
    await expect(page.locator('tr[data-source-index="1198"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('tr[data-source-index="1198"]')).toContainText('shared-grid-1199');
    await resultFilter.fill('');
    await expect.poll(async () => await page.locator('tr[data-source-index]').count()).toBeGreaterThan(0);

    // The common renderer must preserve both axes and the exact virtual row
    // anchor when the result surface is unmounted and mounted again.
    await grid.evaluate(element => {
      element.scrollTop = 9_000;
      element.scrollLeft = 320;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect.poll(async () => await grid.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(expect.objectContaining({ top: 9_000, left: 320 }));
    await expect(page.locator('tr[data-source-index="300"]')).toBeVisible();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query history' })).toBeVisible();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(grid).toBeVisible();
    await expect.poll(async () => await grid.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft }))).toEqual(expect.objectContaining({ top: 9_000, left: 320 }));
    await expect(page.locator('tr[data-source-index="300"]')).toBeVisible();

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const contextCell = page.locator('tr[data-source-index]').first().locator('td').nth(1);
    await contextCell.click({ button: 'right' });
    const contextMenu = page.getByRole('menu', { name: /Actions for row/u });
    await expect(contextMenu).toBeVisible();
    await contextMenu.getByRole('menuitem', { name: 'Copy row as JSON' }).click();
    await expect.poll(async () => page.evaluate(async () => navigator.clipboard.readText())).toContain('shared-grid-');

    await contextCell.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'View Cell Value' }).click();
    await expect(page.getByRole('dialog', { name: /Cell Value/u })).toBeVisible();
    await page.getByRole('button', { name: 'Close cell value' }).click();

    await contextCell.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'View full row' }).click();
    await expect(page.getByRole('heading', { name: 'Row details' })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/u);
  });
});

test.describe('live Netezza web workspace', () => {
  test('captures read-only editor workflows and result scenarios', async ({ page }) => {
    test.skip(!hasLiveNetezzaConfiguration(), 'Set NZ_DEV_HOST, NZ_DEV_USER, NZ_DEV_PASSWORD and NZ_DEV_DATABASE for live Netezza screenshots.');

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Web database editor' })).toBeVisible();
    await capture(page, '01-login.png');

    await loginWithTestData(page);
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

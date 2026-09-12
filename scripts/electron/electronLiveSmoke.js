'use strict';

const { existsSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

const repositoryRoot = path.resolve(__dirname, '../..');
const electronBinaryCandidates = process.env.JUSTYBASE_ELECTRON_BINARY
  ? [path.resolve(process.env.JUSTYBASE_ELECTRON_BINARY)]
  : [
      path.join(repositoryRoot, 'node_modules/electron/dist/electron'),
      path.join(repositoryRoot, 'apps/electron/node_modules/electron/dist/electron'),
    ];
const electronBinary = electronBinaryCandidates.find(candidate => existsSync(candidate)) ?? electronBinaryCandidates[0];
const mainEntry = path.join(repositoryRoot, 'apps/electron/dist/main/main.js');
const rendererDirectory = path.join(repositoryRoot, 'apps/electron/dist/renderer');
const timeoutMs = 120_000;

function publicError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/password|secret|credential/giu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .slice(0, 500);
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : undefined;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('Could not reserve a CDP port.');
  return port;
}

async function waitFor(description, predicate, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${publicError(lastError)}` : '.'}`);
}

function monacoText(page) {
  return page.locator('.monaco-editor .view-line').allTextContents()
    .then(lines => lines.join('\n').replaceAll('\u00a0', ' '));
}

async function replaceMonacoText(page, sql) {
  const editor = page.locator('.monaco-editor');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(sql);
  // Monaco inserts a matching closing parenthesis while the CTE is typed.
  // Remove that editor-generated delimiter so the fixture sent to the API is
  // exactly the SQL represented by this smoke test.
  if (sql.includes('(')) {
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Backspace');
  }
  const marker = sql.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).at(-1) ?? '';
  const expectedMarker = sql.trim().toUpperCase() === 'SX' ? 'SELECT' : marker;
  await expect.poll(() => monacoText(page), { timeout: 30_000 }).toContain(expectedMarker);
}

async function refreshAndExpandSqliteSchema(page, schema) {
  await schema.getByRole('button', { name: 'Refresh schema', exact: true }).click();
  await expect(schema).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
  await expect(schema.locator('.electron-schema-node').first().locator('.electron-schema-label')).toHaveAttribute('title', 'main', { timeout: 30_000 });
  const expandAll = schema.getByRole('button', { name: 'Expand all schema nodes', exact: true });
  await expect(expandAll).toBeEnabled({ timeout: 30_000 });
  await expandAll.click();
}

async function connectionIdByName(page, profileName) {
  return page.evaluate(async name => {
    const response = await fetch('/api/connections', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Could not load connection profiles (${response.status}).`);
    const profiles = await response.json();
    const profile = profiles.find(item => item.name === name);
    if (!profile || typeof profile.id !== 'string') throw new Error(`Connection profile ${name} was not returned by the API.`);
    return profile.id;
  }, profileName);
}

/** Execute a guarded schema mutation and wait for the real query event terminal. */
async function executeWriteStatement(page, connectionId, sql, database = ':memory:') {
  const outcome = await page.evaluate(async input => {
    const csrfCookie = document.cookie.split('; ').find(cookie => cookie.startsWith('justybase_csrf='));
    const csrf = csrfCookie?.slice('justybase_csrf='.length);
    if (!csrf) throw new Error('The Electron session did not expose a CSRF token.');
    const postJson = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-justybase-csrf': decodeURIComponent(csrf) },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let payload = {};
      try { payload = JSON.parse(text); } catch { /* error below carries the status */ }
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
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/iu, 'ws')}/api/ws`);
      let timer;
      let settled = false;
      const finish = callback => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) window.clearTimeout(timer);
        socket.close();
        callback();
      };
      timer = window.setTimeout(() => finish(() => reject(new Error('Timed out waiting for the schema mutation event.'))), 30_000);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'subscribe', queryId: started.queryId })));
      socket.addEventListener('message', event => {
        const payload = JSON.parse(String(event.data));
        if (payload.type === 'error') finish(() => reject(new Error(payload.message ?? 'The schema mutation failed.')));
        if (payload.type === 'batch-complete') finish(() => resolve({ status: payload.status ?? 'unknown', message: payload.message }));
      });
      socket.addEventListener('error', () => finish(() => reject(new Error('The schema mutation WebSocket failed.'))));
    });
  }, { connectionId, database, sql });
  expect(outcome.status, outcome.message).toBe('complete');
}

async function spawnElectron(port, dataDirectory) {
  if (!existsSync(electronBinary)) {
    throw new Error(`Electron binary is missing at ${electronBinary}; install Electron or set JUSTYBASE_ELECTRON_BINARY.`);
  }
  const electronArguments = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    mainEntry,
  ];
  const environment = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_DISABLE_SANDBOX: '1',
    JUSTYBASE_ELECTRON_DATA_DIR: dataDirectory,
    JUSTYBASE_ELECTRON_WEB_DIST: rendererDirectory,
    JUSTYBASE_ELECTRON_PROVISION_SQLITE: '1',
  };
  delete environment.ELECTRON_RUN_AS_NODE;

  const useXvfb = process.platform === 'linux';
  const command = useXvfb ? 'xvfb-run' : electronBinary;
  const argumentsList = useXvfb
    ? ['--auto-servernum', '--server-args=-screen 0 1600x1000x24', electronBinary, ...electronArguments]
    : electronArguments;
  const child = spawn(command, argumentsList, {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exit = false;
  child.once('exit', () => { exit = true; });
  child.stdout.resume();
  child.stderr.resume();
  return { child, hasExited: () => exit };
}

async function stopElectron(processHandle) {
  if (!processHandle || processHandle.hasExited()) return;
  processHandle.child.kill('SIGTERM');
  await waitFor('Electron process shutdown', () => processHandle.hasExited(), 10_000).catch(() => {
    if (!processHandle.hasExited()) processHandle.child.kill('SIGKILL');
  });
}

async function closeBrowser(browser) {
  if (!browser) return;
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise(resolve => setTimeout(resolve, 3_000)),
  ]);
}

async function run() {
  const checks = [];
  let phase = 'initialisation';
  let browser;
  let processHandle;
  let dataDirectory;
  try {
    dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'justybase-electron-live-'));
    const port = await findFreePort();
    processHandle = await spawnElectron(port, dataDirectory);
    await waitFor('Electron CDP endpoint', async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        return response.ok;
      } catch {
        return false;
      }
    }, 30_000);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Electron CDP did not expose a browser context.');
    const page = await waitFor('Electron renderer page', () => context.pages().find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//u.test(candidate.url())), 30_000);
    await page.waitForLoadState('domcontentloaded');
    page.setDefaultTimeout(20_000);

    phase = 'shell bootstrap';
    await expect(page.getByRole('heading', { name: 'JustyBase', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Database schema', exact: true })).toBeVisible();
    const fixtureConnection = page.getByRole('button', { name: 'Electron SQLite fixture sqlite', exact: true });
    await expect(fixtureConnection).toBeVisible();
    await expect(fixtureConnection).toHaveAttribute('aria-pressed', 'true');
    checks.push('authenticated shell and isolated SQLite fixture');

    phase = 'authoring parity';
    const dialect = page.getByLabel('SQL authoring dialect');
    const authoringCompletionChecks = [
      ['postgresql', 'RETURN', 'RETURNING'],
      ['db2', 'FETCH', 'FETCH FIRST'],
      ['clickhouse', 'PRE', 'PREWHERE'],
      ['oracle', 'CONNECT', 'CONNECT BY'],
      ['mssql', 'TOP', 'TOP'],
    ];
    for (const [kind, prefix, expected] of authoringCompletionChecks) {
      await dialect.selectOption(kind);
      await expect(dialect).toHaveValue(kind);
      await replaceMonacoText(page, `SELECT * FROM T ${prefix}`);
      await page.locator('.monaco-editor').click();
      await page.keyboard.press('Control+Space');
      const suggestionWidget = page.locator('.suggest-widget');
      await expect(suggestionWidget).toBeVisible({ timeout: 30_000 });
      await expect(suggestionWidget).toContainText(expected);
      await page.keyboard.press('Escape');
    }
    await dialect.selectOption('netezza');
    await expect(dialect).toHaveValue('netezza');
    await replaceMonacoText(page, 'SX ');
    await expect.poll(() => monacoText(page), { timeout: 30_000 }).toContain('SELECT ');
    checks.push('Monaco completion parity for PostgreSQL, Db2, ClickHouse, Oracle and MSSQL plus SX shortcut');

    phase = 'schema DDL';
    const ddlProfileName = `Electron DDL SQLite ${Date.now()}`;
    const tableName = `electron_ddl_table_${Date.now()}`;
    const viewName = `electron_ddl_view_${Date.now()}`;
    const addedColumnName = `designer_added_${Date.now()}`;
    const ddlDatabase = `designer_${Date.now()}.sqlite`;
    await page.getByRole('button', { name: 'Add connection', exact: true }).click();
    const connectionDialog = page.getByRole('dialog', { name: 'New connection', exact: true });
    await connectionDialog.getByLabel('Database type').selectOption('sqlite');
    await connectionDialog.getByLabel('Profile name').fill(ddlProfileName);
    await connectionDialog.locator('input[maxlength="2048"]').fill(ddlDatabase);
    await connectionDialog.getByLabel('User').fill('local');
    await connectionDialog.locator('input[type="checkbox"]').uncheck();
    await connectionDialog.getByRole('button', { name: 'Add connection', exact: true }).click();
    await waitFor('new connection save or validation error', async () => {
      if (!(await connectionDialog.isVisible())) return true;
      const validationError = connectionDialog.getByRole('alert');
      return (await validationError.count()) > 0 && (await validationError.first().textContent())?.trim();
    }, 30_000);
    if (await connectionDialog.isVisible()) {
      throw new Error(`Electron connection profile could not be saved: ${await connectionDialog.getByRole('alert').first().textContent()}`);
    }
    const ddlConnectionItem = page.locator('.electron-connection-item').filter({ hasText: ddlProfileName }).first();
    await expect(ddlConnectionItem).toBeVisible({ timeout: 30_000 });
    await ddlConnectionItem.locator('button[aria-pressed]').click();
    await expect(ddlConnectionItem.locator('button[aria-pressed]')).toHaveAttribute('aria-pressed', 'true');
    const ddlConnectionId = await connectionIdByName(page, ddlProfileName);
    await executeWriteStatement(page, ddlConnectionId, `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount NUMERIC);`, ddlDatabase);
    await executeWriteStatement(page, ddlConnectionId, `CREATE VIEW ${viewName} AS SELECT id, label FROM ${tableName};`, ddlDatabase);
    const metadataObjects = await page.evaluate(async connectionId => {
      const response = await fetch(`/api/metadata/objects?connectionId=${encodeURIComponent(connectionId)}&database=main&schema=main`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Could not read SQLite metadata after DDL (${response.status}).`);
      return await response.json();
    }, ddlConnectionId);
    expect(metadataObjects.some(item => item.name === tableName && item.objectType === 'TABLE')).toBe(true);

    const schema = page.getByRole('region', { name: 'Database schema', exact: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await refreshAndExpandSqliteSchema(page, schema);
    const tableNode = schema.locator('.electron-schema-label').filter({ hasText: tableName }).first();
    await expect(tableNode).toBeVisible({ timeout: 30_000 });
    await tableNode.click({ button: 'right' });
    const tableMenu = page.getByRole('menu').filter({ hasText: tableName }).first();
    await expect(tableMenu).toBeVisible();
    await tableMenu.getByRole('button', { name: 'Copy DDL', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => navigator.clipboard.readText()), { timeout: 10_000 }).toContain(`CREATE TABLE main.${tableName}`);
    await expect(page.getByRole('status').filter({ hasText: 'Reconstructed DDL copied' })).toBeVisible();

    await tableNode.click({ button: 'right' });
    await page.getByRole('menu').filter({ hasText: tableName }).first().getByRole('button', { name: 'Open DDL', exact: true }).click();
    await expect(page.getByRole('tab', { name: `DDL · ${tableName}`, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => monacoText(page), { timeout: 30_000 }).toContain(`CREATE TABLE main.${tableName}`);
    await expect.poll(() => monacoText(page), { timeout: 30_000 }).toContain('label TEXT');

    await tableNode.click({ button: 'right' });
    const designerMenu = page.getByRole('menu').filter({ hasText: tableName }).first();
    await designerMenu.getByRole('button', { name: 'Open Object Designer', exact: true }).click();
    const designer = page.getByRole('dialog', { name: tableName, exact: true });
    await expect(designer).toBeVisible();
    await expect(designer.getByText('Runtime available', { exact: true })).toBeVisible();
    await expect(designer.getByText('Writable connection', { exact: true })).toBeVisible();
    await designer.getByRole('button', { name: 'Columns', exact: true }).click();
    await designer.getByLabel('Column name', { exact: true }).fill(addedColumnName);
    await designer.getByLabel('Data type', { exact: true }).fill('TEXT');
    await expect(designer.getByLabel('SQL preview', { exact: true })).toHaveValue(`ALTER TABLE "main"."${tableName}" ADD COLUMN "${addedColumnName}" TEXT;`);
    await designer.getByRole('button', { name: 'Preview SQL', exact: true }).click();
    await expect(designer.getByText('1 statement(s)', { exact: true })).toBeVisible();
    await designer.getByRole('button', { name: 'Apply preview', exact: true }).click();
    await expect(designer).toBeHidden({ timeout: 30_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Object designer change applied' })).toBeVisible();
    const updatedColumns = await page.evaluate(async ({ connectionId, table }) => {
      const response = await fetch(`/api/metadata/columns?connectionId=${encodeURIComponent(connectionId)}&database=main&schema=main&table=${encodeURIComponent(table)}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Could not read SQLite columns after designer apply (${response.status}).`);
      return await response.json();
    }, { connectionId: ddlConnectionId, table: tableName });
    expect(updatedColumns.some(item => item.name === addedColumnName)).toBe(true);
    await refreshAndExpandSqliteSchema(page, schema);
    await expect(schema.locator('.electron-schema-label').filter({ hasText: tableName }).first()).toBeVisible({ timeout: 30_000 });
    await expect(schema.locator('.electron-schema-label').filter({ hasText: addedColumnName }).first()).toBeVisible({ timeout: 30_000 });
    checks.push('shared Object Designer preview/apply and refreshed SQLite columns');

    const viewNode = schema.locator('.electron-schema-label').filter({ hasText: viewName }).first();
    await expect(viewNode).toBeVisible({ timeout: 30_000 });
    await viewNode.click({ button: 'right' });
    const viewMenu = page.getByRole('menu').filter({ hasText: viewName }).first();
    await viewMenu.getByRole('button', { name: 'Copy DDL', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => navigator.clipboard.readText()), { timeout: 10_000 }).toContain(`CREATE VIEW ${viewName} AS SELECT id, label FROM ${tableName}`);
    await expect(page.getByRole('status').filter({ hasText: 'Reconstructed DDL copied' })).toBeVisible();

    await viewNode.click({ button: 'right' });
    await page.getByRole('menu').filter({ hasText: viewName }).first().getByRole('button', { name: 'Open DDL', exact: true }).click();
    await expect(page.getByRole('tab', { name: `DDL · ${viewName}`, exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => monacoText(page), { timeout: 30_000 }).toContain(`CREATE VIEW ${viewName} AS SELECT id, label FROM ${tableName}`);
    checks.push('schema explorer table/view DDL open/copy through guarded SQLite metadata');

    phase = 'result execution';
    const fixtureQuery = `WITH RECURSIVE seq(value) AS (
  SELECT 1
  UNION ALL
  SELECT value + 1 FROM seq WHERE value < 1200
)
SELECT value AS ID,
  'electron-grid-' || value AS LABEL,
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
    await replaceMonacoText(page, fixtureQuery);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const grid = page.locator('.ui-data-grid-scroll');
    await expect(grid).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('tab', { name: 'Result 1', exact: true })).toHaveAttribute('data-result-status', 'complete', { timeout: 30_000 });
    await expect.poll(() => grid.getAttribute('aria-label'), { timeout: 30_000 }).toBe('Data grid with 1200 rows');
    await expect(page.locator('table.ui-data-grid')).toBeVisible();
    await expect(page.locator('tr[data-source-index]').first()).toBeVisible();
    checks.push('1200-row result through API/WebSocket and shared grid');

    phase = 'server filtering';
    const filter = page.getByLabel('Filter results');
    await filter.fill('electron-grid-1199');
    await expect(page.locator('tr[data-source-index]').filter({ hasText: 'electron-grid-1199' })).toHaveCount(1, { timeout: 30_000 });
    await filter.fill('');
    await expect(page.locator('tr[data-source-index="0"]')).toBeVisible({ timeout: 30_000 });
    checks.push('server-backed filter and clear');

    phase = 'scroll persistence';
    await grid.evaluate(element => {
      element.scrollTop = 9_000;
      element.scrollLeft = 320;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect.poll(() => grid.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft })), { timeout: 20_000 }).toEqual({ top: 9_000, left: 320 });
    await expect(page.locator('tr[data-source-index="300"]')).toBeVisible();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Query history', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await expect(grid).toBeVisible();
    await expect.poll(() => grid.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft })), { timeout: 20_000 }).toEqual({ top: 9_000, left: 320 });
    await expect(page.locator('tr[data-source-index="300"]')).toBeVisible();
    checks.push('vertical/horizontal scroll and exact virtual anchor restoration');

    phase = 'grid context actions';
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    const contextCell = page.locator('tr[data-source-index]').first().locator('td').nth(1);
    await contextCell.click({ button: 'right' });
    const contextMenu = page.getByRole('menu', { name: /Actions for row/u });
    await expect(contextMenu).toBeVisible();
    await contextMenu.getByRole('menuitem', { name: 'Copy row as JSON' }).click();
    await expect.poll(() => page.evaluate(async () => navigator.clipboard.readText()), { timeout: 10_000 }).toContain('electron-grid-');
    await contextCell.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'View Cell Value' }).click();
    await expect(page.getByRole('dialog', { name: /Cell Value/u })).toBeVisible();
    await page.getByRole('button', { name: 'Close cell value' }).click();
    await contextCell.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'View full row' }).click();
    await expect(page.getByRole('heading', { name: 'Row details', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    checks.push('clipboard, cell viewer, and full-row context actions');

    phase = 'result export';
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/u);
    checks.push('CSV export download');
    const compressedDownloadPromise = page.waitForEvent('download');
    await page.getByLabel('Electron export format').selectOption('csv.gz');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const compressedDownload = await compressedDownloadPromise;
    expect(compressedDownload.suggestedFilename()).toMatch(/\.csv\.gz$/u);
    const compressedPath = await compressedDownload.path();
    if (!compressedPath) throw new Error('Electron did not expose the compressed export download path.');
    expect(gunzipSync(await readFile(compressedPath)).toString('utf8')).toContain('electron-grid-');
    checks.push('CSV gzip export download and decompression');

    console.log(JSON.stringify({
      scenarioId: 'electron-real-window',
      status: 'passed',
      checkCount: checks.length,
      checks,
      rowCount: 1200,
      scroll: { top: 9_000, left: 320, anchorRow: 300 },
    }));
  } catch (error) {
    console.error(JSON.stringify({ scenarioId: 'electron-real-window', status: 'failed', phase, message: publicError(error), checkCount: checks.length }));
    process.exitCode = 1;
  } finally {
    await stopElectron(processHandle);
    await closeBrowser(browser);
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  }
}

void run().then(() => {
  // CDP can retain a detached socket when Electron is force-terminated. The
  // smoke gate has completed all assertions and cleanup above, so make its
  // process boundary deterministic for CI and local live runs.
  process.exit(process.exitCode ?? 0);
});

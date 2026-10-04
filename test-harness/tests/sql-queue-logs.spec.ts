import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const work = mkdtempSync(path.join(tmpdir(), 'sql-queue-logs-'));
const bundle = path.join(work, 'queue.js');
test.beforeAll(() => {
    buildSync({ entryPoints: [path.resolve(__dirname, '../../media/resultPanel/sqlQueueLogs.ts')], bundle: true, format: 'iife', globalName: 'queueLogs', outfile: bundle });
    buildSync({ entryPoints: [path.resolve(__dirname, '../../media/resultPanel/logRunGroups.ts')], bundle: true, format: 'iife', globalName: 'runLogs', outfile: path.join(work, 'runs.js') });
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

test('Logs presents parallel sessions, safe controls and restores overview after source switching', async ({ page }) => {
    await page.setContent('<div class="console-wrapper"><div class="console-view">Existing transcript</div></div>');
    await page.evaluate(() => {
        Object.assign(window, { activeSource: 'file:///query.sql#query-a', messages: [], acquireVsCodeApi: () => ({ postMessage: (message: unknown) => (window as unknown as {messages: unknown[]}).messages.push(message) }) });
    });
    await page.addScriptTag({ path: bundle });
    const state = [{ sourceKey: 'lane', sourceUri: 'file:///query.sql', paused: false, maxConcurrency: 20,
        running: [{ id: 'a', executionUri: 'file:///query.sql#query-a', status: 'running', sql: '<script>bad</script>' }, { id: 'b', status: 'cancelling', sql: 'SELECT 2' }], queued: [{ id: 'c', status: 'queued', sql: 'SELECT 3' }] }];
    await page.evaluate(json => (window as unknown as {queueLogs: {updateSqlQueueLogs:(json:string)=>void}}).queueLogs.updateSqlQueueLogs(json), JSON.stringify(state));
    await expect(page.getByText('2 running / 20 · 1 queued', { exact: true })).toBeVisible();
    await expect(page.locator('.sql-queue-job')).toHaveCount(3);
    await page.locator('.sql-queue-job-summary').first().click();
    await expect(page.locator('.sql-queue-job').first()).toHaveAttribute('open', '');
    await expect(page.locator('.sql-queue-job-detail').first()).toBeVisible();
    await expect(page.locator('.sql-queue-overview script')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page.getByRole('button', { name: 'Clear queued', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as {messages:unknown[]}).messages)).toEqual([
        { command: 'sqlQueueAction', sourceKey: 'lane', action: 'cancel', jobId: 'a' },
        { command: 'sqlQueueAction', sourceKey: 'lane', action: 'remove', jobId: 'c' },
        { command: 'sqlQueueAction', sourceKey: 'lane', action: 'clear' },
    ]);
    await page.evaluate(() => { const w = window as unknown as {activeSource:string;queueLogs:{updateSqlQueueLogs:()=>void}}; w.activeSource='file:///other.sql'; w.queueLogs.updateSqlQueueLogs(); });
    await expect(page.locator('.sql-queue-overview')).toHaveCount(0);
    await page.evaluate(() => { const w = window as unknown as {activeSource:string;queueLogs:{updateSqlQueueLogs:()=>void}}; w.activeSource='file:///query.sql#query-a'; w.queueLogs.updateSqlQueueLogs(); });
    await expect(page.locator('.sql-queue-job')).toHaveCount(3);
    await expect(page.locator('.console-view')).toHaveText('Existing transcript');
});


test('run transcripts collapse by stable execution identity and retain incremental details', async ({ page }) => {
    await page.setContent('<div id="transcript"></div>');
    await page.addScriptTag({ path: path.join(work, 'runs.js') });
    const append = async (rows: unknown[][]) => page.evaluate(rows => {
        const api = window as unknown as {runLogs:{appendRunLogRows:(container:HTMLElement,rows:unknown[][],factory:(row:unknown[])=>HTMLElement)=>void}};
        api.runLogs.appendRunLogRows(document.getElementById('transcript')!, rows, row => { const line=document.createElement('div');line.textContent=String(row[1]);return line; });
    }, rows);
    await append([['12:00', '▶ RUNNING: SELECT 1', { executionId: 'a', event:'start', status:'running', sql:'SELECT <script> FROM T' }]]);
    await expect(page.locator('.log-run')).toHaveCount(1);
    await expect(page.locator('.log-run-body')).toBeHidden();
    await page.locator('.log-run-summary').click();
    await append([['12:01','Received 20 rows', {executionId:'a',event:'message'}], ['12:02','✓ SUCCESS: SELECT 1 | 20 rows',{executionId:'a',event:'end',status:'success',durationMs:2000,rowCount:20}], ['12:03','▶ RUNNING: SELECT 2',{executionId:'b',event:'start',status:'running',sql:'SELECT 2'}]]);
    await expect(page.locator('.log-run')).toHaveCount(2);
    await expect(page.locator('.log-run').first()).toHaveAttribute('open','');
    await expect(page.locator('.log-run').first()).toHaveAttribute('data-status','success');
    await expect(page.locator('.log-run').first().locator('.log-run-body')).toContainText('Received 20 rows');
    await expect(page.locator('.log-run-summary').first()).toContainText('SUCCESS');
    await expect(page.locator('#transcript script')).toHaveCount(0);
});

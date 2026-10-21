import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const work = mkdtempSync(path.join(tmpdir(), 'log-console-layout-'));
const runsBundle = path.join(work, 'runs.js');
const stylesBundle = path.join(work, 'styles.js');
test.beforeAll(() => {
    buildSync({ entryPoints: [path.resolve(__dirname, '../../media/resultPanel/logRunGroups.ts')], bundle: true, format: 'iife', globalName: 'runLogs', outfile: runsBundle });
    buildSync({ entryPoints: [path.resolve(__dirname, '../../media/resultPanel/styles.ts')], bundle: true, format: 'iife', globalName: 'panelStyles', outfile: stylesBundle });
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

async function renderTranscript(page: import('@playwright/test').Page, cards: number, lines: number) {
    await page.setContent(
        '<div style="height:600px;display:flex;flex-direction:column">' +
        '<div id="gridContainer" style="flex:1;position:relative;overflow:hidden">' +
        '<div class="grid-wrapper console-wrapper" data-index="0" style="display:block">' +
        '<div class="console-view"></div></div></div></div>',
    );
    await page.addStyleTag({ content: readFileSync(path.resolve(__dirname, '../../media/resultPanel.css'), 'utf8') });
    await page.addScriptTag({ path: stylesBundle });
    await page.evaluate(() => (window as unknown as { panelStyles: { injectStyles: () => void } }).panelStyles.injectStyles());
    await page.addScriptTag({ path: runsBundle });
    await page.evaluate(({ cards, lines }) => {
        const api = window as unknown as { runLogs: { appendRunLogRows: (c: HTMLElement, r: unknown[][], f: (row: unknown[]) => HTMLElement) => void } };
        const view = document.querySelector('.console-view') as HTMLElement;
        const rows: unknown[][] = [];
        for (let i = 0; i < cards; i++) {
            rows.push([`12:00:${String(i % 60).padStart(2, '0')}`, `▶ RUNNING: SELECT * FROM T WHERE X = ${i}`, { executionId: `exec-${i}`, event: 'start', status: 'running', sql: `SELECT * FROM T WHERE X = ${i}`, connectionName: 'NZ_DEV' }]);
            rows.push([`12:01:${String(i % 60).padStart(2, '0')}`, `✓ SUCCESS: SELECT * FROM T WHERE X = ${i} | NZ_DEV | 120 ms | 20 rows`, { executionId: `exec-${i}`, event: 'end', status: 'success', durationMs: 120, rowCount: 20 }]);
        }
        for (let i = 0; i < lines; i++) {
            rows.push([`12:02:${String(i % 60).padStart(2, '0')}`, `plain lifecycle line ${i}`]);
        }
        api.runLogs.appendRunLogRows(view, rows, (row) => {
            const line = document.createElement('div');
            line.className = 'console-line';
            const time = document.createElement('span');
            time.className = 'console-time';
            time.textContent = String(row[0] ?? '');
            const msg = document.createElement('span');
            msg.className = 'console-msg';
            msg.textContent = String(row[1] ?? '');
            line.append(time, msg);
            return line;
        });
    }, { cards, lines });
}

test('many log cards keep natural height and scroll instead of squeezing', async ({ page }) => {
    await renderTranscript(page, 40, 10);
    const metrics = await page.evaluate(() => {
        const view = document.querySelector('.console-view') as HTMLElement;
        const cards = Array.from(document.querySelectorAll('.log-run')).map((el) => el.getBoundingClientRect().height);
        const minCard = Math.min(...cards);
        return {
            clientHeight: view.clientHeight,
            scrollHeight: view.scrollHeight,
            canScroll: view.scrollHeight > view.clientHeight,
            cardCount: cards.length,
            minCard,
        };
    });
    expect(metrics.cardCount).toBe(40);
    expect(metrics.minCard).toBeGreaterThanOrEqual(24);
    expect(metrics.canScroll).toBe(true);
});

test('scrolling to the bottom reveals the last log entry', async ({ page }) => {
    await renderTranscript(page, 40, 10);
    const visible = await page.evaluate(() => {
        const view = document.querySelector('.console-view') as HTMLElement;
        view.scrollTop = view.scrollHeight;
        const entries = Array.from(document.querySelectorAll('.log-run, .console-line'));
        const last = entries[entries.length - 1] as HTMLElement;
        const row = last.getBoundingClientRect();
        const viewport = view.getBoundingClientRect();
        return row.bottom <= viewport.bottom + 2 && row.bottom > viewport.top;
    });
    expect(visible).toBe(true);
});

test('plain lifecycle lines alone also scroll instead of squeezing', async ({ page }) => {
    await renderTranscript(page, 0, 60);
    const metrics = await page.evaluate(() => {
        const view = document.querySelector('.console-view') as HTMLElement;
        const lines = Array.from(document.querySelectorAll('.console-line')).map((el) => el.getBoundingClientRect().height);
        return {
            canScroll: view.scrollHeight > view.clientHeight,
            minLine: Math.min(...lines),
            lineCount: lines.length,
        };
    });
    expect(metrics.lineCount).toBe(60);
    expect(metrics.minLine).toBeGreaterThanOrEqual(16);
    expect(metrics.canScroll).toBe(true);
});

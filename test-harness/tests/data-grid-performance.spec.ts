import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import {
    createBenchmarkEnvironment,
    type BenchmarkEnvironment,
    type BenchmarkValidation,
    type DataGridBenchmarkRecord,
} from '../../Benchmark/dataGridPerformance/contract';
import { calculateTimingStats } from '../../Benchmark/dataGridPerformance/stats';
import { writeDataGridBenchmarkReport } from '../../Benchmark/dataGridPerformance/report';

const webviewReportOptions = {
    jsonPath: path.join(__dirname, '../../Benchmark/data-grid-playwright.v1.results.json'),
    markdownPath: path.join(__dirname, '../../Benchmark/data-grid-playwright.v1.results.md'),
};

interface SearchResult {
    durationMs: number;
    rowCount: number;
    workerMessages: Array<{ command?: string; id?: number; seq?: number }>;
    firstVisibleText: string;
}

interface ExportResult {
    durationMs: number | null;
    rowCount: number | null;
    columnCount: number | null;
    command: string | null;
}

interface FixturePerfApi {
    rows: unknown[][];
    rowCount: number;
    columnCount: number;
    initialRenderMs: number | null;
    beginExport: () => number;
    exportState: (startedAt: number) => ExportResult;
    search: (query: string) => Promise<SearchResult>;
    searchBurst: () => Promise<SearchResult & { finalFilter: string }>;
}

declare global {
    interface Window {
        __dataGridPerf: FixturePerfApi;
        __hostMessages: Array<{ message: { command?: string; data?: { rowIndices?: unknown[]; columnIds?: unknown[] } }; time: number }>;
    }
}

const records: DataGridBenchmarkRecord[] = [];
let environment: BenchmarkEnvironment;

function checked(expectedRows: number, actualRows: number, message?: string): BenchmarkValidation {
    const ok = expectedRows === actualRows;
    return { ok, expectedRows, actualRows, message: message ?? (ok ? undefined : `Expected ${expectedRows} rows, got ${actualRows}.`) };
}

async function openFixture(page: Page, profile: string): Promise<{ errors: string[]; bytes: number; totalRows: number; columnCount: number }> {
    const errors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/test-harness/data-grid-performance.html?profile=${encodeURIComponent(profile)}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('renderStatus')?.textContent?.includes('✅') === true, undefined, { timeout: 45_000 });
    const metadata = await page.evaluate(() => {
        const perf = window.__dataGridPerf;
        return {
            bytes: new Blob([JSON.stringify(perf.rows)]).size,
            totalRows: perf.rowCount,
            columnCount: perf.columnCount,
        };
    });
    return { errors, ...metadata };
}

function addRecord(
    operation: DataGridBenchmarkRecord['operation'],
    stage: string,
    caseId: string,
    rowCount: number,
    columnCount: number,
    gridMode: DataGridBenchmarkRecord['gridMode'],
    samples: number[],
    validation: BenchmarkValidation,
    inputBytes: number,
    format?: string,
    notes?: string[],
): void {
    const timing = calculateTimingStats(samples);
    const seconds = timing.medianMs / 1000;
    records.push({
        suiteVersion: 'data-grid.v1',
        operation,
        stage,
        caseId,
        rowCount,
        columnCount,
        gridMode,
        format,
        ...timing,
        rowsPerSecond: seconds > 0 ? rowCount / seconds : undefined,
        bytesPerSecond: seconds > 0 ? inputBytes / seconds : undefined,
        inputBytes,
        validation,
        status: validation.ok ? 'PASS' : 'WARN',
        environment,
        notes,
    });
}

async function search(page: Page, query: string): Promise<SearchResult> {
    return page.evaluate(async (value) => window.__dataGridPerf.search(value) as Promise<SearchResult>, query);
}

async function searchSamples(page: Page, query: string, sampleCount = 8): Promise<{ samples: number[]; last: SearchResult }> {
    for (let index = 0; index < 2; index += 1) await search(page, query);
    const samples: number[] = [];
    let last: SearchResult = { durationMs: 0, rowCount: -1, workerMessages: [], firstVisibleText: '' };
    for (let index = 0; index < sampleCount; index += 1) {
        last = await search(page, query);
        samples.push(last.durationMs);
    }
    return { samples, last };
}

async function clickCsvExport(page: Page): Promise<ExportResult> {
    const startedAt = await page.evaluate(() => window.__dataGridPerf.beginExport());
    await page.locator('#exportBtn').click();
    const menu = page.locator('#exportPrimaryMenu');
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: /^CSV Comma separated values$/ }).click();
    await menu.getByRole('menuitem', { name: /^Save to file/ }).click();
    await page.waitForFunction(() => window.__hostMessages.some(item => item.message?.command === 'initiateExportWithSelection'));
    return page.evaluate((start) => window.__dataGridPerf.exportState(start) as ExportResult, startedAt);
}

async function clickFilteredSelectionCsvExport(page: Page): Promise<ExportResult> {
    const rowNumber = page.locator('.grid-wrapper.active tbody tr[data-index] td.row-number-cell').first();
    await expect(rowNumber).toBeVisible();
    await rowNumber.click();
    await rowNumber.click({ button: 'right' });
    const menu = page.locator('.grid-context-menu');
    await expect(menu).toBeVisible();
    const startedAt = await page.evaluate(() => {
        window.__hostMessages.length = 0;
        return performance.now();
    });
    await menu.getByText('Export Selection to CSV', { exact: true }).click();
    await page.waitForFunction(() => window.__hostMessages.some(item => item.message?.command === 'exportCsv'));
    return page.evaluate((start) => window.__dataGridPerf.exportState(start) as ExportResult, startedAt);
}

test.describe('Data Grid performance webview', () => {
    test.beforeAll(async ({ browser }) => {
        const version = browser.version();
        const majorMatch = version.match(/^(\d+)/);
        environment = createBenchmarkEnvironment('chromium', {
            chromium: version,
            chromiumMajor: majorMatch ? Number(majorMatch[1]) : undefined,
            viewport: { width: 1280, height: 720 },
            workerCount: 1,
        });
    });

    test.afterAll(() => {
        writeDataGridBenchmarkReport(records, environment, webviewReportOptions);
    });

    test('measures first render and inline search results for predictable terms', async ({ page }) => {
        const fixture = await openFixture(page, 'inline');
        const renderMs = await page.evaluate(() => window.__dataGridPerf.initialRenderMs as number);
        addRecord('render', 'first_grid_render', 'inline/first-paint', fixture.totalRows, fixture.columnCount, 'inline', [renderMs], checked(fixture.totalRows, fixture.totalRows), fixture.bytes);

        const queries = [
            ['start', 'needle-start', 1],
            ['middle', 'needle-middle', 1],
            ['missing', 'needle-absent', 0],
            ['clear', '', fixture.totalRows],
        ] as const;
        for (const [name, query, expected] of queries) {
            const result = await searchSamples(page, query);
            expect(result.last.rowCount).toBe(expected);
            addRecord('search', 'webview_global_filter', `inline/${name}`, fixture.totalRows, fixture.columnCount, 'inline', result.samples, checked(expected, result.last.rowCount), fixture.bytes);
        }
        expect(fixture.errors, fixture.errors.join('\n')).toEqual([]);
    });

    test('measures the 19,999/20,000 worker switch and search correctness', async ({ page }) => {
        for (const [profile, expectedMode] of [['worker-boundary-19999', 'inline'], ['worker-boundary-20000', 'worker']] as const) {
            const fixture = await openFixture(page, profile);
            const result = await search(page, 'needle-middle');
            const workerSearch = result.workerMessages.some(message => message.command === 'search');
            expect(workerSearch).toBe(expectedMode === 'worker');
            expect(result.rowCount).toBe(1);
            addRecord('search', 'webview_worker_threshold', `${profile}/middle`, fixture.totalRows, fixture.columnCount, expectedMode, [result.durationMs], checked(1, result.rowCount), fixture.bytes, undefined, [`Observed mode: ${workerSearch ? 'worker' : 'inline'}.`]);
            expect(fixture.errors, fixture.errors.join('\n')).toEqual([]);
        }
    });

    test('measures worker cold/warm searches and rejects stale rapid results', async ({ page }) => {
        const fixture = await openFixture(page, 'large');
        const cold = await search(page, 'needle-start');
        expect(cold.rowCount).toBe(1);
        expect(cold.workerMessages.some(message => message.command === 'initData')).toBe(true);
        expect(cold.workerMessages.some(message => message.command === 'search')).toBe(true);
        addRecord('search', 'webview_worker_cold', 'large/start', fixture.totalRows, fixture.columnCount, 'worker', [cold.durationMs], checked(1, cold.rowCount), fixture.bytes);

        const warmSamples = await searchSamples(page, 'needle-middle');
        expect(warmSamples.last.rowCount).toBe(1);
        expect(warmSamples.last.workerMessages.some(message => message.command === 'search')).toBe(true);
        addRecord('search', 'webview_worker_warm', 'large/middle', fixture.totalRows, fixture.columnCount, 'worker', warmSamples.samples, checked(1, warmSamples.last.rowCount), fixture.bytes);

        const rapid = await page.evaluate(() => window.__dataGridPerf.searchBurst() as Promise<SearchResult & { finalFilter: string }>);
        expect(rapid.finalFilter).toBe('needle-middle');
        expect(rapid.rowCount).toBe(1);
        expect(rapid.firstVisibleText).toContain('needle-middle');
        addRecord('search', 'webview_rapid_queries', 'large/start-then-middle', fixture.totalRows, fixture.columnCount, 'worker', [rapid.durationMs], checked(1, rapid.rowCount), fixture.bytes, undefined, ['The final filter must win when worker responses arrive out of order.']);

        const missing = await search(page, 'needle-absent');
        expect(missing.rowCount).toBe(0);
        addRecord('search', 'webview_worker_warm', 'large/missing', fixture.totalRows, fixture.columnCount, 'worker', [missing.durationMs], checked(0, missing.rowCount), fixture.bytes);
        const clear = await search(page, '');
        expect(clear.rowCount).toBe(fixture.totalRows);
        addRecord('search', 'webview_filter_clear', 'large/clear', fixture.totalRows, fixture.columnCount, 'worker', [clear.durationMs], checked(fixture.totalRows, clear.rowCount), fixture.bytes);
        expect(fixture.errors, fixture.errors.join('\n')).toEqual([]);
    });

    test('measures export payload preparation for full and filtered grid views', async ({ page }) => {
        const fixture = await openFixture(page, 'inline');
        const full = await clickCsvExport(page);
        expect(full.command).toBe('initiateExportWithSelection');
        expect(full.rowCount).toBe(fixture.totalRows);
        expect(full.columnCount).toBe(fixture.columnCount);
        addRecord('export', 'webview_payload_prepare', 'inline/full', fixture.totalRows, fixture.columnCount, 'inline', [full.durationMs ?? -1], checked(fixture.totalRows, full.rowCount ?? -1), fixture.bytes, 'csv');

        const filteredSearch = await search(page, 'needle-middle');
        expect(filteredSearch.rowCount).toBe(1);
        const filtered = await clickFilteredSelectionCsvExport(page);
        expect(filtered.command).toBe('exportCsv');
        expect(filtered.rowCount).toBe(1);
        addRecord('export', 'webview_payload_prepare', 'inline/filtered-middle', fixture.totalRows, fixture.columnCount, 'inline', [filtered.durationMs ?? -1], checked(1, filtered.rowCount ?? -1), fixture.bytes, 'csv');
        expect(fixture.errors, fixture.errors.join('\n')).toEqual([]);
    });
});

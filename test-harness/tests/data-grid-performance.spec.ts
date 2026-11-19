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

interface SharedGridMeasurement {
    durationMs: number;
    rowCount: number;
    firstRowId: number | null;
    firstVisibleText: string;
    renderedRowCount: number;
    scrollTop: number;
    scrollLeft: number;
    anchorRow: number;
}

interface SharedGridHarnessApi {
    profile: string;
    rowCount: number;
    columnCount: number;
    rows: unknown[][];
    measureFilter: (query: string) => Promise<SharedGridMeasurement>;
    measureSort: (descending: boolean) => Promise<SharedGridMeasurement>;
    measureScroll: (top: number, left: number) => Promise<SharedGridMeasurement>;
    measureAppend: () => Promise<{
        beforeScrollHeight: number;
        afterScrollHeight: number;
        beforeTop: number;
        afterTop: number;
        beforeAnchor: number;
        afterAnchor: number;
    }>;
    snapshot: () => SharedGridMeasurement;
}

declare global {
    interface Window {
        __sharedDataGrid: SharedGridHarnessApi;
    }
}

const records: DataGridBenchmarkRecord[] = [];
let environment: BenchmarkEnvironment;

function checked(expectedRows: number, actualRows: number, message?: string): BenchmarkValidation {
    const ok = expectedRows === actualRows;
    return { ok, expectedRows, actualRows, message: message ?? (ok ? undefined : `Expected ${expectedRows} rows, got ${actualRows}.`) };
}

async function openSharedFixture(page: Page, profile: string): Promise<{ errors: string[]; bytes: number; totalRows: number; columnCount: number }> {
    const errors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/test-harness/shared-data-grid.html?profile=${encodeURIComponent(profile)}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.shared-grid-harness')?.dataset.ready === 'true', undefined, { timeout: 45_000 });
    const metadata = await page.evaluate(() => {
        const perf = window.__sharedDataGrid;
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

async function sharedFilter(page: Page, query: string): Promise<SharedGridMeasurement> {
    return page.evaluate((value) => window.__sharedDataGrid.measureFilter(value), query);
}

async function collectSharedFilterSamples(page: Page, query: string, sampleCount = 5): Promise<{ samples: number[]; last: SharedGridMeasurement }> {
    await sharedFilter(page, '');
    const samples: number[] = [];
    let last = await sharedFilter(page, query);
    samples.push(last.durationMs);
    for (let index = 1; index < sampleCount; index += 1) {
        last = await sharedFilter(page, query);
        samples.push(last.durationMs);
    }
    return { samples, last };
}

async function sharedSort(page: Page, descending: boolean): Promise<SharedGridMeasurement> {
    return page.evaluate((desc) => window.__sharedDataGrid.measureSort(desc), descending);
}

async function sharedScroll(page: Page, top: number, left: number): Promise<SharedGridMeasurement> {
    return page.evaluate(({ scrollTop, scrollLeft }) => window.__sharedDataGrid.measureScroll(scrollTop, scrollLeft), { scrollTop: top, scrollLeft: left });
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

    test('measures shared renderer filtering, sorting, scrolling and viewport restoration', async ({ page }) => {
        const profile = 'filter-4000x32';
        const shared = await openSharedFixture(page, profile);
        const filterCases = [
            ['start', 'needle-start', 1],
            ['middle', 'needle-middle', 1],
            ['missing', 'needle-absent', 0],
            ['clear', '', shared.totalRows],
        ] as const;

        for (const [name, query, expectedRows] of filterCases) {
            const result = await sharedFilter(page, query);
            expect(result.rowCount, `filter case: ${name}`).toBe(expectedRows);
            if (query && expectedRows > 0) expect(result.firstVisibleText.toLowerCase()).toContain(query);
        }

        const sharedFilterMeasurements = await collectSharedFilterSamples(page, 'needle-absent', 5);
        expect(sharedFilterMeasurements.last.rowCount).toBe(0);
        addRecord(
            'search',
            'shared_filter',
            `${profile}/missing`,
            shared.totalRows,
            shared.columnCount,
            'shared',
            sharedFilterMeasurements.samples,
            checked(0, sharedFilterMeasurements.last.rowCount),
            shared.bytes,
            undefined,
            ['Shared React renderer used by the VS Code webview; deterministic rows and the production filter contract.'],
        );

        const sharedSortSamples: number[] = [];
        let sharedSortLast = await sharedSort(page, true);
        sharedSortSamples.push(sharedSortLast.durationMs);
        for (let index = 1; index < 5; index += 1) {
            await sharedSort(page, false);
            sharedSortLast = await sharedSort(page, true);
            sharedSortSamples.push(sharedSortLast.durationMs);
        }
        expect(sharedSortLast.rowCount).toBe(shared.totalRows);
        expect(sharedSortLast.firstRowId).toBe(shared.totalRows);
        addRecord(
            'sort',
            'shared_sort',
            `${profile}/descending`,
            shared.totalRows,
            shared.columnCount,
            'shared',
            sharedSortSamples,
            checked(shared.totalRows, sharedSortLast.rowCount, `First row after descending sort: ${sharedSortLast.firstRowId ?? 'missing'}.`),
            shared.bytes,
            undefined,
            ['Shared renderer sort state is exercised directly through the harness.'],
        );

        await sharedSort(page, false);
        const scrollTargets = [6_000, 9_000, 12_000, 15_000];
        const sharedScrollSamples: number[] = [];
        let sharedScrollLast = await sharedScroll(page, scrollTargets[0]!, 320);
        sharedScrollSamples.push(sharedScrollLast.durationMs);
        for (const target of scrollTargets.slice(1)) {
            sharedScrollLast = await sharedScroll(page, target, 320);
            sharedScrollSamples.push(sharedScrollLast.durationMs);
        }
        expect(sharedScrollLast.scrollTop).toBeGreaterThan(0);
        expect(sharedScrollLast.scrollLeft).toBeGreaterThan(0);
        expect(sharedScrollLast.anchorRow).toBeGreaterThan(0);
        expect(sharedScrollLast.renderedRowCount).toBeGreaterThan(0);
        addRecord(
            'scroll',
            'shared_scroll',
            `${profile}/viewport`,
            shared.totalRows,
            shared.columnCount,
            'shared',
            sharedScrollSamples,
            checked(1, sharedScrollLast.anchorRow > 0 ? 1 : 0, `Restored viewport anchor: ${sharedScrollLast.anchorRow}.`),
            shared.bytes,
            undefined,
            [`Rendered rows in viewport: ${sharedScrollLast.renderedRowCount}.`],
        );

        const sharedScrollBeforeReload = sharedScrollLast;
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.shared-grid-harness')?.dataset.ready === 'true', undefined, { timeout: 45_000 });
        // Chrome can briefly report an intermediate native scroll offset while
        // the controlled grid re-applies the persisted position after reload.
        // Wait for the final position instead of the first nonzero sample so a
        // transient offset cannot beat the restoration frame.
        const minimumReloadTop = sharedScrollBeforeReload.scrollTop * 0.8;
        const minimumReloadLeft = sharedScrollBeforeReload.scrollLeft * 0.8;
        await page.waitForFunction(({ top, left }) => {
            const snapshot = window.__sharedDataGrid?.snapshot();
            return (snapshot?.scrollTop ?? 0) >= top
                && (snapshot?.scrollLeft ?? 0) >= left
                && (snapshot?.anchorRow ?? 0) > 0;
        }, { top: minimumReloadTop, left: minimumReloadLeft }, { timeout: 45_000 });
        const sharedScrollAfterReload = await page.evaluate(() => window.__sharedDataGrid.snapshot());
        expect(sharedScrollAfterReload.scrollTop).toBeGreaterThanOrEqual(sharedScrollBeforeReload.scrollTop * 0.8);
        expect(sharedScrollAfterReload.scrollLeft).toBeGreaterThanOrEqual(sharedScrollBeforeReload.scrollLeft * 0.8);
        expect(sharedScrollAfterReload.anchorRow).toBeGreaterThan(0);

        expect(shared.errors, shared.errors.join('\n')).toEqual([]);
    });

    test('keeps the viewport anchored when a 10k page is appended', async ({ page }) => {
        await openSharedFixture(page, 'append-10k');
        const measurement = await page.evaluate(() => window.__sharedDataGrid.measureAppend());

        expect(measurement.beforeScrollHeight).toBeGreaterThan(0);
        expect(measurement.afterScrollHeight).toBeGreaterThan(measurement.beforeScrollHeight);
        expect(measurement.beforeTop).toBeGreaterThan(0);
        expect(measurement.afterTop).toBe(measurement.beforeTop);
        expect(measurement.afterAnchor).toBe(measurement.beforeAnchor);
    });
});

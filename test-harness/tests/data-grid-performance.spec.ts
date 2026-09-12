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

interface InlineFilterModelResult {
    samples: number[];
    rowCount: number;
}

interface UiFilterResult {
    durationMs: number;
    rowCount: number;
    bodyAppends: number;
}

interface FixturePerfApi {
    rows: unknown[][];
    rowCount: number;
    columnCount: number;
    initialRenderMs: number | null;
    getState: () => { rowCount: number | null; totalRows: number; columnCount: number; filter: string };
    beginExport: () => number;
    exportState: (startedAt: number) => ExportResult;
    search: (query: string) => Promise<SearchResult>;
    measureInlineFilter: (query: string, sampleCount?: number) => InlineFilterModelResult;
    measureUiFilter: (query: string) => Promise<UiFilterResult>;
    searchBurst: () => Promise<SearchResult & { finalFilter: string }>;
}

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
    snapshot: () => SharedGridMeasurement;
}

interface LegacyTableState {
    sorting?: Array<{ id: string; desc: boolean }>;
}

interface LegacyTable {
    getState: () => LegacyTableState;
    setSorting: (sorting: Array<{ id: string; desc: boolean }>) => void;
}

interface LegacyGridHandle {
    tanTable?: LegacyTable;
    getScrollAnchorIndex?: () => number | undefined;
    render?: () => void;
}

interface GridSnapshot {
    rowCount: number;
    firstRowId: number | null;
    renderedRowCount: number;
    scrollTop: number;
    scrollLeft: number;
    anchorRow: number;
}

declare global {
    interface Window {
        __dataGridPerf: FixturePerfApi;
        __sharedDataGrid: SharedGridHarnessApi;
        __mockState: unknown;
        getGrid: (index: number) => LegacyGridHandle | undefined;
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

async function readLegacySnapshot(page: Page): Promise<GridSnapshot> {
    return page.evaluate(() => {
        const wrapper = document.querySelector<HTMLElement>('.grid-wrapper.active');
        const row = wrapper?.querySelector<HTMLElement>('tbody tr[data-index]:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.virtual-row-placeholder)');
        const firstCell = row?.querySelector<HTMLElement>('td:not(.row-number-cell)');
        const firstRowValue = Number((firstCell?.textContent ?? '').replace(/[\s,\u00a0]/gu, ''));
        const target = wrapper;
        const grid = window.getGrid(0);
        const state = window.__dataGridPerf.getState();
        return {
            rowCount: state.rowCount ?? -1,
            firstRowId: Number.isFinite(firstRowValue) ? firstRowValue : null,
            renderedRowCount: wrapper?.querySelectorAll('tbody tr[data-index]:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.virtual-row-placeholder)').length ?? 0,
            scrollTop: target?.scrollTop ?? 0,
            scrollLeft: target?.scrollLeft ?? 0,
            anchorRow: grid?.getScrollAnchorIndex?.() ?? Number(row?.dataset.index ?? -1),
        };
    });
}

async function waitForLegacyFirstRow(page: Page, expectedId: number): Promise<void> {
    await page.waitForFunction((expected) => {
        const row = document.querySelector<HTMLElement>('.grid-wrapper.active tbody tr[data-index]:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.virtual-row-placeholder)');
        const firstCell = row?.querySelector<HTMLElement>('td:not(.row-number-cell)');
        return Number((firstCell?.textContent ?? '').replace(/[\s,\u00a0]/gu, '')) === expected;
    }, expectedId, { timeout: 45_000 });
}

async function resetLegacySorting(page: Page): Promise<void> {
    await page.evaluate(() => {
        const table = window.getGrid(0)?.tanTable;
        if (!table) throw new Error('Result Panel table is not initialized');
        table.setSorting([]);
    });
    await page.waitForFunction(() => {
        const sorting = window.getGrid(0)?.tanTable?.getState().sorting ?? [];
        return sorting.length === 0;
    }, undefined, { timeout: 45_000 });
    await waitForLegacyFirstRow(page, 1);
}

async function measureLegacySort(page: Page, descending: boolean): Promise<GridSnapshot & { durationMs: number }> {
    const startedAt = await page.evaluate((desc) => {
        const table = window.getGrid(0)?.tanTable;
        if (!table) throw new Error('Result Panel table is not initialized');
        table.setSorting([{ id: '0', desc }]);
        return performance.now();
    }, descending);
    await page.waitForFunction((desc) => {
        const sorting = window.getGrid(0)?.tanTable?.getState().sorting ?? [];
        const row = document.querySelector<HTMLElement>('.grid-wrapper.active tbody tr[data-index]:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.virtual-row-placeholder)');
        const firstCell = row?.querySelector<HTMLElement>('td:not(.row-number-cell)');
        const firstId = Number((firstCell?.textContent ?? '').replace(/[\s,\u00a0]/gu, ''));
        return sorting[0]?.id === '0' && sorting[0]?.desc === desc && firstId === (desc ? 4_000 : 1);
    }, descending, { timeout: 45_000 });
    const snapshot = await readLegacySnapshot(page);
    const durationMs = await page.evaluate((start) => performance.now() - start, startedAt);
    return { ...snapshot, durationMs };
}

async function measureLegacyScroll(page: Page, top: number, left: number): Promise<GridSnapshot & { durationMs: number }> {
    const startedAt = await page.evaluate(({ scrollTop, scrollLeft }) => {
        const target = document.querySelector<HTMLElement>('.grid-wrapper.active');
        if (!target) throw new Error('Result Panel scroll target is not initialized');
        target.scrollTop = scrollTop;
        target.scrollLeft = scrollLeft;
        target.dispatchEvent(new Event('scroll'));
        return performance.now();
    }, { scrollTop: top, scrollLeft: left });
    await page.waitForFunction(() => {
        const target = document.querySelector<HTMLElement>('.grid-wrapper.active');
        const row = target?.querySelector<HTMLElement>('tbody tr[data-index]:not(.virtual-pad-top):not(.virtual-pad-bottom):not(.virtual-row-placeholder)');
        return (target?.scrollTop ?? 0) > 0
            && (target?.scrollLeft ?? 0) > 0
            && Number(row?.dataset.index ?? 0) > 0;
    }, undefined, { timeout: 45_000 });
    const snapshot = await readLegacySnapshot(page);
    const durationMs = await page.evaluate((start) => performance.now() - start, startedAt);
    return { ...snapshot, durationMs };
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

    test('keeps a 4,000 x 32 inline filter fast and renders it once', async ({ page }) => {
        const fixture = await openFixture(page, 'filter-regression-4000x32');
        const model = await page.evaluate(() => window.__dataGridPerf.measureInlineFilter('needle-absent', 5));
        expect(model.rowCount).toBe(0);
        const coldModelMs = model.samples[0] ?? Number.POSITIVE_INFINITY;
        const warmModelStats = calculateTimingStats(model.samples.slice(1));
        expect(coldModelMs).toBeLessThan(250);
        expect(warmModelStats.medianMs).toBeLessThan(20);
        addRecord(
            'search',
            'webview_global_filter_model',
            'filter-regression-4000x32/missing',
            fixture.totalRows,
            fixture.columnCount,
            'inline',
            model.samples,
            checked(0, model.rowCount),
            fixture.bytes,
            undefined,
            ['First sample builds the row search cache; later samples use new query text and the same cached rows.'],
        );

        const ui = await page.evaluate(() => window.__dataGridPerf.measureUiFilter('needle-absent'));
        expect(ui.rowCount).toBe(0);
        expect(ui.bodyAppends).toBe(1);
        addRecord(
            'search',
            'webview_global_filter_render',
            'filter-regression-4000x32/missing',
            fixture.totalRows,
            fixture.columnCount,
            'inline',
            [ui.durationMs],
            checked(0, ui.rowCount),
            fixture.bytes,
            undefined,
            [`tbody append operations: ${ui.bodyAppends}.`],
        );
        expect(fixture.errors, fixture.errors.join('\n')).toEqual([]);
    });

    test('measures worker cold/warm searches and coalesces rapid queries', async ({ page }) => {
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
        expect(rapid.workerMessages.filter(message => message.command === 'search')).toHaveLength(1);
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

    test('keeps shared renderer behaviour and performance aligned with the VS Code grid', async ({ page }) => {
        const profile = 'filter-regression-4000x32';
        const sharedProfile = 'filter-4000x32';
        const legacy = await openFixture(page, profile);
        const filterCases = [
            ['start', 'needle-start', 1],
            ['middle', 'needle-middle', 1],
            ['missing', 'needle-absent', 0],
            ['clear', '', legacy.totalRows],
        ] as const;

        const legacyFilterResults = new Map<string, SearchResult>();
        for (const [name, query, expectedRows] of filterCases) {
            const result = await search(page, query);
            expect(result.rowCount).toBe(expectedRows);
            if (query && expectedRows > 0) expect(result.firstVisibleText.toLowerCase()).toContain(query);
            legacyFilterResults.set(name, result);
        }

        const legacyFilterSamples = await searchSamples(page, 'needle-absent', 5);
        expect(legacyFilterSamples.last.rowCount).toBe(0);
        addRecord(
            'search',
            'legacy_shared_filter_parity',
            `${profile}/missing`,
            legacy.totalRows,
            legacy.columnCount,
            'legacy',
            legacyFilterSamples.samples,
            checked(0, legacyFilterSamples.last.rowCount),
            legacy.bytes,
            undefined,
            ['Current VS Code Result Panel renderer; includes its production debounce and virtualized DOM update.'],
        );

        await search(page, '');
        const legacySortSamples: number[] = [];
        let legacySortLast: GridSnapshot & { durationMs: number } = await measureLegacySort(page, true);
        legacySortSamples.push(legacySortLast.durationMs);
        for (let index = 1; index < 5; index += 1) {
            await resetLegacySorting(page);
            legacySortLast = await measureLegacySort(page, true);
            legacySortSamples.push(legacySortLast.durationMs);
        }
        expect(legacySortLast.rowCount).toBe(legacy.totalRows);
        expect(legacySortLast.firstRowId).toBe(legacy.totalRows);
        addRecord(
            'sort',
            'legacy_shared_sort_parity',
            `${profile}/descending`,
            legacy.totalRows,
            legacy.columnCount,
            'legacy',
            legacySortSamples,
            checked(legacy.totalRows, legacySortLast.rowCount, `First row after descending sort: ${legacySortLast.firstRowId ?? 'missing'}.`),
            legacy.bytes,
            undefined,
            ['Sorting was driven through the current VS Code grid table state.'],
        );

        await resetLegacySorting(page);
        const legacyScrollTargets = [6_000, 9_000, 12_000, 15_000];
        const legacyScrollSamples: number[] = [];
        let legacyScrollLast = await measureLegacyScroll(page, legacyScrollTargets[0]!, 320);
        legacyScrollSamples.push(legacyScrollLast.durationMs);
        for (const target of legacyScrollTargets.slice(1)) {
            legacyScrollLast = await measureLegacyScroll(page, target, 320);
            legacyScrollSamples.push(legacyScrollLast.durationMs);
        }
        expect(legacyScrollLast.scrollTop).toBeGreaterThan(0);
        expect(legacyScrollLast.scrollLeft).toBeGreaterThan(0);
        expect(legacyScrollLast.anchorRow).toBeGreaterThan(0);
        expect(legacyScrollLast.renderedRowCount).toBeGreaterThan(0);
        addRecord(
            'scroll',
            'legacy_shared_scroll_parity',
            `${profile}/viewport`,
            legacy.totalRows,
            legacy.columnCount,
            'legacy',
            legacyScrollSamples,
            checked(1, legacyScrollLast.anchorRow > 0 ? 1 : 0, `Restored viewport anchor: ${legacyScrollLast.anchorRow}.`),
            legacy.bytes,
            undefined,
            [`Rendered rows in viewport: ${legacyScrollLast.renderedRowCount}.`],
        );

        await page.waitForFunction(() => {
            try {
                return JSON.stringify(window.__mockState ?? null).includes('scrollTop');
            } catch {
                return false;
            }
        }, undefined, { timeout: 45_000 });
        const legacyScrollBeforeRerender = legacyScrollLast;
        await page.evaluate(() => {
            const target = document.querySelector<HTMLElement>('.grid-wrapper.active');
            if (!target) throw new Error('Result Panel scroll target is not initialized');
            target.scrollTop = 0;
            target.scrollLeft = 0;
            window.getGrid(0)?.render?.();
        });
        await page.waitForFunction(() => {
            const target = document.querySelector<HTMLElement>('.grid-wrapper.active');
            return (target?.scrollTop ?? 0) > 0 && (target?.scrollLeft ?? 0) > 0;
        }, undefined, { timeout: 45_000 });
        const legacyScrollAfterRerender = await readLegacySnapshot(page);
        expect(legacyScrollAfterRerender.scrollTop).toBeGreaterThanOrEqual(legacyScrollBeforeRerender.scrollTop * 0.8);
        expect(legacyScrollAfterRerender.scrollLeft).toBeGreaterThanOrEqual(legacyScrollBeforeRerender.scrollLeft * 0.8);

        await page.evaluate((currentProfile) => {
            for (const suffix of ['top', 'left', 'anchor']) sessionStorage.removeItem(`shared-grid-scroll:${currentProfile}:${suffix}`);
        }, sharedProfile);
        const shared = await openSharedFixture(page, sharedProfile);
        const sharedFilterResults = new Map<string, SharedGridMeasurement>();
        for (const [name, query, expectedRows] of filterCases) {
            const result = await sharedFilter(page, query);
            expect(result.rowCount).toBe(expectedRows);
            if (query && expectedRows > 0) expect(result.firstVisibleText.toLowerCase()).toContain(query);
            sharedFilterResults.set(name, result);
        }

        for (const [name] of filterCases) {
            const legacyResult = legacyFilterResults.get(name);
            const sharedResult = sharedFilterResults.get(name);
            expect(sharedResult).toBeDefined();
            expect(legacyResult).toBeDefined();
            expect(sharedResult?.rowCount).toBe(legacyResult?.rowCount);
        }

        const sharedFilterMeasurements = await collectSharedFilterSamples(page, 'needle-absent', 5);
        expect(sharedFilterMeasurements.last.rowCount).toBe(0);
        addRecord(
            'search',
            'legacy_shared_filter_parity',
            `${profile}/missing`,
            shared.totalRows,
            shared.columnCount,
            'shared',
            sharedFilterMeasurements.samples,
            checked(0, sharedFilterMeasurements.last.rowCount),
            shared.bytes,
            undefined,
            ['Shared React renderer used by Web and Electron; same deterministic rows and filter contract.'],
        );
        const legacyFilterStats = calculateTimingStats(legacyFilterSamples.samples);
        const sharedFilterStats = calculateTimingStats(sharedFilterMeasurements.samples);
        expect(sharedFilterStats.medianMs).toBeLessThanOrEqual(legacyFilterStats.medianMs * 2 + 50);

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
            'legacy_shared_sort_parity',
            `${profile}/descending`,
            shared.totalRows,
            shared.columnCount,
            'shared',
            sharedSortSamples,
            checked(shared.totalRows, sharedSortLast.rowCount, `First row after descending sort: ${sharedSortLast.firstRowId ?? 'missing'}.`),
            shared.bytes,
            undefined,
            ['Shared renderer sort state is compared with the current VS Code grid.'],
        );
        const legacySortStats = calculateTimingStats(legacySortSamples);
        const sharedSortStats = calculateTimingStats(sharedSortSamples);
        expect(sharedSortStats.medianMs).toBeLessThanOrEqual(legacySortStats.medianMs * 2 + 75);

        await sharedSort(page, false);
        const sharedScrollSamples: number[] = [];
        let sharedScrollLast = await sharedScroll(page, legacyScrollTargets[0]!, 320);
        sharedScrollSamples.push(sharedScrollLast.durationMs);
        for (const target of legacyScrollTargets.slice(1)) {
            sharedScrollLast = await sharedScroll(page, target, 320);
            sharedScrollSamples.push(sharedScrollLast.durationMs);
        }
        expect(sharedScrollLast.scrollTop).toBeGreaterThan(0);
        expect(sharedScrollLast.scrollLeft).toBeGreaterThan(0);
        expect(sharedScrollLast.anchorRow).toBeGreaterThan(0);
        expect(sharedScrollLast.renderedRowCount).toBeGreaterThan(0);
        addRecord(
            'scroll',
            'legacy_shared_scroll_parity',
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
        const legacyScrollStats = calculateTimingStats(legacyScrollSamples);
        const sharedScrollStats = calculateTimingStats(sharedScrollSamples);
        expect(sharedScrollStats.medianMs).toBeLessThanOrEqual(legacyScrollStats.medianMs * 2.5 + 75);

        const sharedScrollBeforeReload = sharedScrollLast;
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.shared-grid-harness')?.dataset.ready === 'true', undefined, { timeout: 45_000 });
        await page.waitForFunction(() => {
            const snapshot = window.__sharedDataGrid?.snapshot();
            return (snapshot?.scrollTop ?? 0) > 0
                && (snapshot?.scrollLeft ?? 0) > 0
                && (snapshot?.anchorRow ?? 0) > 0;
        }, undefined, { timeout: 45_000 });
        const sharedScrollAfterReload = await page.evaluate(() => window.__sharedDataGrid.snapshot());
        expect(sharedScrollAfterReload.scrollTop).toBeGreaterThanOrEqual(sharedScrollBeforeReload.scrollTop * 0.8);
        expect(sharedScrollAfterReload.scrollLeft).toBeGreaterThanOrEqual(sharedScrollBeforeReload.scrollLeft * 0.8);
        expect(sharedScrollAfterReload.anchorRow).toBeGreaterThan(0);

        expect(shared.errors, shared.errors.join('\n')).toEqual([]);
    });
});

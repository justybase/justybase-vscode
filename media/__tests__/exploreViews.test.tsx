import type { ExploreFilterModel, ExploreResponse } from '@justybase/contracts';
import type { ResultSet } from '../resultPanel/types.js';
import { renderExploreView, disposeExploreView, computeExploreOverview } from '../resultPanel/explore/explorePanel.js';
import { renderRankingTab, disposeRankingChart } from '../resultPanel/explore/rankingTab.js';
import { renderComposerTab } from '../resultPanel/explore/composerTab.js';
import { renderPivotTab } from '../resultPanel/explore/pivotTab.js';
import { renderFullStatsCard } from '../resultPanel/explore/fullStatsCard.js';
import { requestExploreOperation, requestExploreComposer, requestExplorePivot, requestExploreFullStats, openExploreSqlInEditor } from '../resultPanel/explore/hostBridge.js';
import { fetchRowsFromHost } from '../resultPanel/diskBackedGrid.js';

const chartEvents = new Map<string, (event: unknown) => void>();
jest.mock('echarts/core', () => ({ use: jest.fn(), init: jest.fn(() => ({
    dispose: jest.fn(), resize: jest.fn(), setOption: jest.fn(), on: jest.fn((name: string, fn: (event: unknown) => void) => chartEvents.set(name, fn)),
})) }));
jest.mock('echarts/charts', () => ({ BarChart: {}, LineChart: {} }));
jest.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {}, DataZoomComponent: {}, TitleComponent: {}, BrushComponent: {}, ToolboxComponent: {} }));
jest.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));
jest.mock('../resultPanel/explore/hostBridge.js', () => ({ requestExploreOperation: jest.fn(), requestExploreComposer: jest.fn(),
    requestExplorePivot: jest.fn(), requestExploreFullStats: jest.fn(), cancelExploreRequests: jest.fn(),
    previewExploreComposer: jest.fn(async () => 'SELECT preview'), previewExplorePivot: jest.fn(async () => 'SELECT preview'),
    previewExploreFilteredSql: jest.fn(async () => 'SELECT preview'), openExploreSqlInEditor: jest.fn(),
}));
let results: ResultSet[] = [];
let saved: Record<string, unknown> = {};
jest.mock('../resultPanel/types.js', () => ({ getActiveSourceUri: () => 'file:///explore.sql', getResultSetAt: (index: number) => results[index] }));
jest.mock('../resultPanel/state.js', () => ({ getActiveGridIndex: () => 0 }));
jest.mock('../resultPanel/protocol.js', () => ({ getHostState: () => saved, setHostState: (value: Record<string, unknown>) => { saved = value; }, postHostMessage: jest.fn() }));
jest.mock('../resultPanel/diskBackedGrid.js', () => ({ fetchRowsFromHost: jest.fn() }));
const empty = (): ExploreFilterModel => ({ dimensions: [], dates: [], measures: [] });
const columns = [{ name: 'CATEGORY', type: 'VARCHAR', index: 0, role: 'dimension' as const },
    { name: 'AMOUNT', type: 'DECIMAL', index: 1, role: 'measure' as const },
    { name: 'DAY', type: 'DATE', index: 2, role: 'date' as const }];
const rows = [['A', 10, '2026-01-01'], ['B', 20, '2026-02-01'], ['A', 30, '2026-03-01']];
const response = (data: unknown[][] = [['A', 2, 66.66, 0], [null, 1, 33.33, 1]]): ExploreResponse => ({ rows: data, sql: 'SELECT ranking', filters: empty(), scope: 'database', computedAt: 1, truncated: false });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const click = (root: ParentNode, text: string) => {
    const target = Array.from(root.querySelectorAll('button')).find(item => item.textContent === text);
    if (!target) throw new Error(`Missing ${text}`); target.click();
};

describe('Explore views and lifecycle', () => {
    let serial = 0;
    let root: HTMLElement;
    beforeEach(() => {
        jest.clearAllMocks(); saved = {}; chartEvents.clear();
        global.structuredClone = value => JSON.parse(JSON.stringify(value)) as typeof value;
        document.body.innerHTML = '<div id="analysisContainer"></div>';
        root = document.getElementById('analysisContainer')!;
        results = [{ resultSetId: `explore-${++serial}`, columns, data: rows, sql: 'SELECT source', executionTimestamp: serial }];
        jest.mocked(requestExploreOperation).mockResolvedValue(response());
    });
    afterEach(() => { disposeExploreView(); disposeRankingChart(); });

    it('renders profiles, sample scope and keyboard selection actions', async () => {
        renderExploreView(0); await settle();
        expect(root.textContent).toContain('All loaded rows'); expect(root.textContent).toContain('Charts');
        const value = root.querySelector<HTMLElement>('.explore-top-row')!;
        value.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(root.textContent).toContain('Filter to selection'); click(root, 'Filter to selection');
        expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('includes');
        expect(requestExploreOperation).not.toHaveBeenCalled();
        click(root, '↩ Undo'); click(root, '↪ Redo'); click(root, '✕ Clear');
        expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('No filters');
    });
    it('filters the sample once per filter change for scope, quality banner and cards', async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const filtering = require('../resultPanel/explore/filtering.js') as typeof import('../resultPanel/explore/filtering.js');
        const filterSpy = jest.spyOn(filtering, 'filterExploreRows');
        renderExploreView(0); await settle();
        root.querySelector<HTMLElement>('.explore-top-row')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        filterSpy.mockClear();
        click(root, 'Filter to selection');
        expect(root.textContent).toContain('2 matching rows in the sample');
        expect(filterSpy).toHaveBeenCalledTimes(1);
        filterSpy.mockRestore();
    });
    it('edits and removes category, NULL, empty, date and measure chips independently', async () => {
        results[0].data = [...rows, [null, 40, '2026-04-01'], ['', 50, '2026-05-01']];
        renderExploreView(0); await settle(); click(root, 'Add filter');
        const editor = () => root.querySelector<HTMLElement>('.explore-filter-editor')!;
        editor().querySelector<HTMLInputElement>('input[aria-label="NULL"]')!.checked = true;
        editor().querySelector<HTMLInputElement>('input[aria-label="Empty string"]')!.checked = true;
        click(editor(), 'Apply');
        expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('NULL');
        const chip = root.querySelector<HTMLElement>('.explore-filter-chip-label')!;
        chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); expect(editor()).toBeNull();
        for (const key of ['Enter', ' ']) {
            chip.dispatchEvent(new KeyboardEvent('keydown', { key })); expect(editor()).not.toBeNull(); click(editor(), 'Cancel');
        }
        chip.click(); expect(editor()).not.toBeNull(); click(editor(), 'Cancel');
        root.querySelector<HTMLElement>('.explore-filter-chip button')!.click(); expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('Empty string');
        root.querySelector<HTMLElement>('.explore-filter-chip button')!.click();
        for (const [index, lower, upper] of [[1, '10', '30'], [2, '2026-01-01', '2026-03-01']] as const) {
            click(root, 'Add filter'); const column = editor().querySelector<HTMLSelectElement>('select')!;
            column.value = String(index); column.dispatchEvent(new Event('change'));
            const inputs = editor().querySelectorAll<HTMLInputElement>('input:not([type=search])'); inputs[0].value = lower; inputs[1].value = upper;
            click(editor(), 'Apply'); expect(root.querySelectorAll('.explore-filter-chip')).toHaveLength(1);
            root.querySelector<HTMLElement>('.explore-filter-chip button')!.click();
        }
        expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('No filters');
    });
    it('restores chart settings and invalidates computed data when the schema or execution changes', async () => {
        renderExploreView(0); await settle(); click(root, 'Charts'); click(root, 'Run'); await settle();
        expect(root.querySelector('tbody')?.textContent).toContain('A');
        results[0].executionTimestamp = 999; renderExploreView(0); await settle(); expect(root.querySelector('tbody')).toBeNull();
        results[0].columns = [{ name: 'CHANGED', type: 'VARCHAR' }]; renderExploreView(0); await settle(); expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('No filters');
        delete results[0].sql; renderExploreView(0); await settle();
        expect(root.textContent).toContain('No reusable SQL'); expect(Array.from(root.querySelectorAll('button')).find(button => button.textContent === 'Run')?.disabled).toBe(true);
    });
    it('describes streaming and partial samples while preserving navigation configuration', async () => {
        results[0].isStreamingComplete = false; results[0].limitReached = true;
        renderExploreView(0); await settle(); expect(root.textContent).toContain('Streaming'); expect(root.textContent).toContain('Row limit reached');
        click(root, 'Charts'); disposeExploreView(); renderExploreView(0); await settle();
        expect(root.textContent).toContain('Category ranking');
    });
    it('keeps filters attached to stable IDs when an earlier result closes', async () => {
        const target = { ...results[0], resultSetId: `shift-${serial}` };
        results = [{ ...target, resultSetId: 'earlier' }, target]; renderExploreView(1); await settle();
        root.querySelector<HTMLElement>('.explore-top-row')!.click(); click(root, 'Filter to selection');
        results = [target]; renderExploreView(0); await settle();
        expect(root.querySelector('#exploreFilterBar')?.textContent).toContain('includes');
        expect(saved).toHaveProperty('_exploreStates');
    });
    it('reads an unfiltered disk sample and never substitutes sample stats after a database failure', async () => {
        results[0].storageMode = 'sqlite'; results[0].totalRowCount = 90000;
        jest.mocked(fetchRowsFromHost).mockResolvedValue(rows);
        renderExploreView(0); await settle();
        expect(fetchRowsFromHost).toHaveBeenCalledWith('file:///explore.sql', 0, 0, 50000, true);
        expect(root.textContent).toContain(`${(90000).toLocaleString()} loaded rows`);
        jest.mocked(requestExploreFullStats).mockRejectedValue(new Error('Database unavailable'));
        click(root, 'Σ Full stats'); await settle();
        expect(root.textContent).toContain('Database unavailable'); expect(root.textContent).toContain('Retry');
    });
    it('rejects stale loads after replacing the owner and handles an empty/error overview', async () => {
        let finish!: (data: unknown[][]) => void;
        results[0].storageMode = 'sqlite'; jest.mocked(fetchRowsFromHost).mockReturnValue(new Promise(resolve => { finish = resolve; }));
        renderExploreView(0); disposeExploreView(); root.replaceChildren(); finish(rows); await settle(); expect(root.textContent).toBe('');
        results[0].isError = true; await expect(computeExploreOverview(0)).rejects.toThrow('No tabular');
        results[0] = { ...results[0], isError: false, storageMode: 'memory', data: [], columns: [] };
        renderExploreView(0); await settle(); expect(root.textContent).toContain('No columns');
    });
    it('renders ranking without dates, retains stale snapshots and drills through synthetic Other', async () => {
        let filters = empty(); const state = {}; const selected = jest.fn();
        renderRankingTab(root, columns.slice(0, 2), () => filters, undefined, state, jest.fn(), selected);
        click(root, 'Run'); await settle();
        expect(root.textContent).toContain('Category'); expect(root.textContent).toContain('Other (remaining categories)');
        filters = { ...empty(), dimensions: [{ columnIndex: 0, values: ['B'] }] };
        root.dispatchEvent(new Event('exploreFiltersChanged')); expect(root.textContent).toContain('Out of date');
        Array.from(root.querySelectorAll('button')).filter(item => item.textContent === 'Explore selection')[1].click();
        expect(selected.mock.calls[0][0].filters.dimensions[0]).toMatchObject({ mode: 'exclude', values: ['A'] });
        jest.mocked(requestExploreOperation).mockRejectedValue(new Error('Query failed')); click(root, 'Run'); await settle();
        expect(root.textContent).toContain('Query failed'); expect(root.querySelector('tbody')?.textContent).toContain('A');
    });
    it('validates ranking size/measure and disables non-additive Other and share', () => {
        renderRankingTab(root, columns, empty, undefined, {}, jest.fn(), jest.fn());
        const n = root.querySelector<HTMLInputElement>('input[aria-label="N"]')!; n.value = '101'; click(root, 'Run'); expect(root.textContent).toContain('between 1 and 100');
        n.value = '10'; const aggregate = root.querySelector<HTMLSelectElement>('select[aria-label="Aggregate"]')!; aggregate.value = 'avg'; aggregate.dispatchEvent(new Event('change', { bubbles: true }));
        expect(root.querySelector<HTMLInputElement>('input[aria-label="Include Other"]')!.disabled).toBe(true);
        click(root, 'Run'); expect(root.textContent).toContain('Select a measure');
    });
    it('shows empty rankings, unavailable shares and distinct NULL/empty/Other selections', async () => {
        const selected = jest.fn();
        const config = { categoryColumnIndex: 0, aggregate: 'sum' as const, measureColumnIndex: 1, direction: 'bottom' as const, count: 3, showShare: true, includeOther: true };
        const filters = { ...empty(), dimensions: [{ columnIndex: 0, values: ['A', 'Other'] }] };
        const result = { ...response([[null, -1, null, 0], ['', 2, null, 0], ['Other', 3, null, 0], [null, 4, null, 1]]), filters };
        const state = { result, executedConfig: { ...config, filters } };
        renderRankingTab(root, columns, () => filters, config, state, jest.fn(), selected);
        expect(root.textContent).toContain('Share unavailable');
        const actions = Array.from(root.querySelectorAll('button')).filter(item => item.textContent === 'Explore selection');
        actions[0].click(); expect(selected.mock.calls[0][0].filters.dimensions[0].includeNull).toBe(true);
        actions[1].click(); expect(selected.mock.calls[1][0].filters.dimensions[0].includeEmpty).toBe(true);
        actions[3].click(); expect(selected.mock.calls[2][0].filters.dimensions).toHaveLength(2);
        click(root, 'Open SQL'); await settle(); expect(openExploreSqlInEditor).toHaveBeenCalled();
        jest.mocked(requestExploreOperation).mockResolvedValue(response([])); click(root, 'Run'); await settle(); expect(root.textContent).toContain('No matching categories');
    });
    it('renders current time-series point selections and preserves previous results on retry failure', async () => {
        const selected = jest.fn(); const cache = {};
        jest.mocked(requestExploreComposer).mockResolvedValue({ rows: [['2026-01-01', 10], ['2026-02-01', 20]], sql: 'SELECT time', columnIndexes: { bucket: 0, measure: 1, dimension: undefined, split: undefined, previous: undefined } });
        renderComposerTab(root, { columns, filters: empty(), getFilters: empty, cache, onConfigChange: jest.fn(), onSelect: selected });
        click(root, 'Run'); await settle(); click(root, 'Explore selection');
        expect(selected.mock.calls[0][0].filters.dates[0]).toMatchObject({ from: '2026-01-01', to: '2026-02-01', toExclusive: true });
        chartEvents.get('click')?.({ seriesIndex: 0, dataIndex: 1 }); expect(selected).toHaveBeenCalledTimes(2);
        chartEvents.get('brushEnd')?.({ areas: [{ coordRange: [0, 1] }] }); expect(selected.mock.calls[2][0].filters.dates[0].to).toBe('2026-03-01');
        jest.mocked(requestExploreComposer).mockRejectedValue(new Error('Timeout')); click(root, 'Run'); await settle();
        expect(root.textContent).toContain('Timeout'); expect(root.textContent).toContain('2026-01-01');
    });
    it.each([
        ['day', '2026-01-02'], ['week', '2026-01-08'], ['quarter', '2026-04-01'], ['year', '2027-01-01'],
    ] as const)('selects %s buckets with dimensions, split remainders and exact end boundaries', async (grain, end) => {
        const selected = jest.fn();
        jest.mocked(requestExploreComposer).mockResolvedValue({ rows: [['2026-01-01', 'North', null, 1, '10.25', 5]], sql: 'SELECT time',
            columnIndexes: { bucket: 0, dimension: 1, split: 2, splitOther: 3, measure: 4, previous: 5 } });
        const extended = [...columns, { name: 'REGION', type: 'VARCHAR', index: 3, role: 'dimension' as const }];
        renderComposerTab(root, { columns: extended, filters: empty(), config: { dateColumnIndex: 2, measureColumnIndex: 1, dimensionColumnIndex: 0, splitByColumnIndex: 3, splitValues: ['Known'], comparePrevious: true, grain, aggFn: 'sum' }, onConfigChange: jest.fn(), onSelect: selected });
        click(root, 'Run'); await settle(); click(root, 'Explore selection');
        const selection = selected.mock.calls[0][0]; expect(selection.filters.dates[0].to).toBe(end);
        expect(selection.filters.dimensions).toEqual(expect.arrayContaining([{ columnIndex: 3, mode: 'exclude', values: ['Known'] }]));
        chartEvents.get('brushEnd')?.({ areas: [{ coordRange: [0, 0] }] }); expect(selected.mock.calls[1][0].filters.dates[0].to).toBe(end);
        chartEvents.get('brushEnd')?.({ areas: [] }); chartEvents.get('click')?.({ seriesIndex: 1, dataIndex: 0 }); expect(selected).toHaveBeenCalledTimes(2);
    });
    it('selects a NULL time-series dimension with IS NULL semantics instead of the string "null"', async () => {
        const selected = jest.fn();
        jest.mocked(requestExploreComposer).mockResolvedValue({ rows: [['2026-01-01', null, '10']], sql: 'SELECT time',
            columnIndexes: { bucket: 0, dimension: 1, measure: 2, split: undefined, previous: undefined } });
        renderComposerTab(root, { columns, filters: empty(), config: { dateColumnIndex: 2, measureColumnIndex: 1, dimensionColumnIndex: 0, comparePrevious: false, grain: 'month', aggFn: 'sum' }, onConfigChange: jest.fn(), onSelect: selected });
        click(root, 'Run'); await settle(); click(root, 'Explore selection');
        expect(selected.mock.calls[0][0].filters.dimensions).toEqual([{ columnIndex: 0, values: [], includeNull: true }]);
    });
    it('keeps pivot results after a failed refresh and restores them without querying', async () => {
        const cache = {};
        jest.mocked(requestExplorePivot).mockResolvedValue({ rows: [['A', 10]], columns: [{ name: 'CATEGORY', kind: 'row' }, { name: 'Value', kind: 'value' }], totalRows: 1, pivotValues: ['A'], sql: 'SELECT pivot' });
        renderPivotTab(root, { columns, filters: empty(), cache, onStateChange: jest.fn() }); click(root, 'Run Pivot'); await settle();
        expect(root.textContent).toContain('Database');
        jest.mocked(requestExplorePivot).mockRejectedValue(new Error('Disconnected')); click(root, 'Run Pivot'); await settle();
        expect(root.textContent).toContain('Disconnected'); expect(root.querySelector('tbody')?.textContent).toContain('A');
        renderPivotTab(root, { columns, filters: empty(), cache, onStateChange: jest.fn() }); expect(root.querySelector('tbody')?.textContent).toContain('A');
        expect(requestExplorePivot).toHaveBeenCalledTimes(2);
        click(root, 'SQL'); expect(openExploreSqlInEditor).toHaveBeenCalledWith('SELECT pivot', 'Explore pivot query');
        const aggregate = root.querySelector<HTMLSelectElement>('#explorePivotAgg')!;
        aggregate.value = 'max'; aggregate.dispatchEvent(new Event('change', { bubbles: true })); expect(root.textContent).toContain('Out of date');
        renderPivotTab(root, { columns, filters: { ...empty(), measures: [{ columnIndex: 1, min: '20' }] }, cache, onStateChange: jest.fn() });
        expect(root.textContent).toContain('Out of date');
        click(root, 'SQL…'); await settle(); expect(document.body.textContent).toContain('Pivot SQL');
    });
    it('validates incomplete pivot dimensions and recovers empty or truncated results', async () => {
        renderPivotTab(root, { columns: [], filters: empty(), onStateChange: jest.fn() });
        click(root, 'Run Pivot'); expect(root.textContent).toContain('Select at least one row dimension');
        renderPivotTab(root, { columns: [columns[0]], filters: empty(), onStateChange: jest.fn() });
        click(root, 'Run Pivot'); expect(root.textContent).toContain('Select a value column');
        renderPivotTab(root, { columns, filters: empty(), onStateChange: jest.fn() });
        const col = root.querySelector<HTMLSelectElement>('#explorePivotCol')!; col.value = '-1';
        click(root, 'Run Pivot'); expect(root.textContent).toContain('Select a pivot column');
        col.value = '0';
        jest.mocked(requestExplorePivot).mockResolvedValue({ rows: [], columns: [], totalRows: 0, pivotValues: [], sql: 'SELECT empty' });
        click(root, 'Run Pivot'); await settle(); expect(root.textContent).toContain('Pivot returned no rows');
        jest.mocked(requestExplorePivot).mockResolvedValue({ rows: [['A', null], ['B', 'invalid']], columns: [{ name: 'Category', kind: 'row' }, { name: 'Value', kind: 'value' }], totalRows: 2, pivotValues: [], sql: 'SELECT bounded', truncated: true });
        click(root, 'Run Pivot'); await settle(); expect(root.textContent).toContain('Results truncated'); expect(root.querySelector('tbody')?.textContent).toContain('NULL');
    });
    it('retains database statistics with their applied filters and retries explicitly', async () => {
        const cache = new Map();
        jest.mocked(requestExploreFullStats).mockResolvedValue({ columnIndex: 1, values: { count: 3, sum: 60, p25: null }, percentilesUnavailable: true, stddevUnavailable: true, sql: 'SELECT stats' });
        renderFullStatsCard(root, 1, empty(), cache, true); await settle(); expect(root.textContent).toContain('60');
        const filters = { ...empty(), measures: [{ columnIndex: 1, min: '20' }] };
        renderFullStatsCard(root, 1, filters, cache); expect(root.textContent).toContain('Out of date');
        jest.mocked(requestExploreFullStats).mockRejectedValue(new Error('Stats failed')); renderFullStatsCard(root, 1, filters, cache, true); await settle();
        expect(root.textContent).toContain('Stats failed'); expect(root.textContent).toContain('60');
    });
});

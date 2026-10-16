import type { ResultSet } from '../types';
import type { DiskColumnGroupStats, DiskGroupStatsRequest, DiskGroupStatsResult } from '../types';

// Host-facing modules are replaced; the analytical engine, rules and DOM panes run for real.
let mockOwner: ResultSet;
let mockHostState: Record<string, unknown> = {};
const mockFetchRows = jest.fn();
const mockQueryStats = jest.fn();

jest.mock('../dom', () => ({
    getElementById: (id: string) => document.getElementById(id),
    asHtml: (value: unknown) => value,
}));
jest.mock('../types', () => ({
    getActiveSourceUri: () => 'file:///analytical.sql',
    getResultSetAt: () => mockOwner,
}));
jest.mock('../protocol', () => ({
    getHostState: () => mockHostState,
    setHostState: (state: Record<string, unknown>) => {
        mockHostState = state;
    },
}));
jest.mock('../diskBackedGrid', () => ({
    fetchRowsFromHost: (...args: unknown[]) => mockFetchRows(...args),
    queryDiskGroupStats: (...args: unknown[]) => mockQueryStats(...args),
}));

type PanelModule = typeof import('../analytical/analyticalPanel');
let panel: PanelModule;

const COLUMNS = [
    { name: 'REGION', type: 'varchar' },
    { name: 'AMOUNT', type: 'numeric' },
    { name: 'STATUS', type: 'varchar' },
];

/** Five normal groups of 20 rows and one spiking group whose amounts and statuses are off-pattern. */
function buildRows(): unknown[][] {
    const rows: unknown[][] = [];
    for (let g = 1; g <= 5; g++) {
        for (let i = 0; i < 20; i++) {
            rows.push([`R${g}`, 100 + (i % 5), i % 2 === 0 ? 'OK' : 'ERR']);
        }
    }
    for (let i = 0; i < 20; i++) {
        rows.push(['SPIKE', 5000 + (i % 5), 'OK']);
    }
    return rows;
}

/** Plain-JS stand-in for the host's exact group statistics, computed from the same fixture rows. */
function columnStatsFor(rows: unknown[][], columnIndex: number, topColumns: readonly number[]): DiskColumnGroupStats {
    const values = rows.map(row => row[columnIndex]).filter(value => value !== null && value !== undefined && value !== '');
    const numeric = values.every(value => typeof value === 'number');
    const stats: DiskColumnGroupStats = {
        columnIndex,
        nonNullCount: values.length,
        distinctCount: new Set(values).size,
        min: numeric ? Math.min(...(values as number[])) : [...values].sort()[0] ?? null,
        max: numeric ? Math.max(...(values as number[])) : [...values].sort().slice(-1)[0] ?? null,
    };
    if (numeric && values.length > 0) {
        const nums = values as number[];
        const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
        const stddev = Math.sqrt(nums.reduce((sum, value) => sum + (value - mean) ** 2, 0) / nums.length);
        stats.numeric = { mean, stddev };
    }
    if (topColumns.includes(columnIndex)) {
        const counts = new Map<string, number>();
        for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
        stats.topValues = [...counts.entries()]
            .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
            .slice(0, 8)
            .map(([value, count]) => ({ value, count }));
    }
    return stats;
}

function fakeGroupStats(request: DiskGroupStatsRequest): DiskGroupStatsResult {
    const data = buildRows();
    const groupIndex = request.groupColumns[0];
    const members = new Map<string, unknown[][]>();
    for (const row of data) {
        const key = String(row[groupIndex]);
        members.set(key, [...(members.get(key) ?? []), row]);
    }
    const topColumns = request.topColumns ?? [];
    const groups = [...members.entries()]
        .map(([value, rows]) => ({
            values: [value],
            count: rows.length,
            columns: request.statColumns.map(column => columnStatsFor(rows, column, topColumns)),
        }))
        .sort((a, b) => (b.count - a.count) || (a.values[0] < b.values[0] ? -1 : 1))
        .slice(0, request.limit);
    const listed = groups.reduce((sum, group) => sum + group.count, 0);
    return {
        groupColumns: request.groupColumns,
        totalRows: data.length,
        totalGroups: members.size,
        groups,
        unlistedRows: data.length - listed,
        population: request.statColumns.map(column => columnStatsFor(data, column, topColumns)),
    };
}

function makeOwner(overrides: Partial<ResultSet> = {}): ResultSet {
    const data = buildRows();
    return {
        columns: COLUMNS,
        data,
        executionTimestamp: 1,
        sql: 'select * from t',
        storageSessionId: 'session-1',
        storageMode: 'memory',
        isLog: false,
        isError: false,
        resultSetId: 'rs-1',
        totalRowCount: data.length,
        ...overrides,
    } as unknown as ResultSet;
}

async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt++) {
        const value = read();
        if (value) {
            return value;
        }
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('Condition not reached');
}

function container(): HTMLElement {
    return document.getElementById('analysisContainer') as HTMLElement;
}

function groupItems(): HTMLElement[] {
    return Array.from(container().querySelectorAll<HTMLElement>('.analytical-group'));
}

function chooseSuggestion(name: string): void {
    const button = Array.from(container().querySelectorAll<HTMLButtonElement>('.analytical-suggestion'))
        .find(item => item.textContent === name);
    if (!button) {
        throw new Error(`No suggestion named ${name}`);
    }
    button.click();
}

describe('AnalyticalPanel', () => {
    beforeEach(async () => {
        // The view cache is module state; a fresh module per test keeps groupings from leaking between tests.
        jest.resetModules();
        panel = await import('../analytical/analyticalPanel');
        document.body.innerHTML = '<div id="analysisContainer"></div>';
        mockHostState = {};
        mockOwner = makeOwner();
        mockFetchRows.mockReset();
        mockFetchRows.mockResolvedValue([]);
        mockQueryStats.mockReset();
        mockQueryStats.mockImplementation(async (_rsIndex: number, request: DiskGroupStatsRequest) => fakeGroupStats(request));
    });

    afterEach(() => {
        panel.disposeAnalyticalView();
    });

    it('shows the empty state with one-click suggestions before any grouping is chosen', () => {
        panel.renderAnalyticalView(0);
        expect(container().textContent).toContain('Choose one to three columns to group the rows');
        const suggestions = Array.from(container().querySelectorAll('.analytical-suggestion')).map(item => item.textContent);
        expect(suggestions).toEqual(expect.arrayContaining(['REGION', 'STATUS']));
    });

    it('computes groups on demand and shows the anomalous group and its explanation when selected', async () => {
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');
        await waitFor(() => groupItems().length === 6 || null);

        const sort = container().querySelector<HTMLSelectElement>('select[aria-label="Sort groups"]') as HTMLSelectElement;
        sort.value = 'score:desc';
        sort.dispatchEvent(new Event('change'));

        const spike = groupItems()[0];
        expect(spike.dataset.key).toBe(JSON.stringify(['SPIKE']));
        expect(spike.classList.contains('is-anomalous')).toBe(true);

        spike.click();
        const detail = container().querySelector('.analytical-detail') as HTMLElement;
        expect(detail.querySelector('.analytical-detail-title')?.textContent).toBe('SPIKE');
        expect(detail.querySelector('.analytical-detail-badge')?.textContent).toBe('Anomalous');
        // Rule messages explain the flags in plain words.
        expect(detail.textContent).toContain('Average');
        expect(detail.textContent).toContain('is 100% of this group');
    });

    it('moves selection with the keyboard and restores focus on the new group', async () => {
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');
        await waitFor(() => groupItems().length === 6 || null);

        const listbox = container().querySelector('.analytical-master-list') as HTMLElement;
        const selectedBefore = groupItems().find(item => item.classList.contains('is-selected'))?.dataset.key;
        listbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

        const selectedAfter = groupItems().find(item => item.classList.contains('is-selected'))?.dataset.key;
        expect(selectedAfter).not.toBe(selectedBefore);
        expect(document.activeElement?.getAttribute('data-key')).toBe(selectedAfter);
    });

    it('persists the grouping and selection per result in host state and restores them in a fresh module', async () => {
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');
        await waitFor(() => groupItems().length === 6 || null);

        const saved = mockHostState._analyticalStates as Record<string, { groupColumns: Array<{ name: string }>; selectedGroupKey?: string }>;
        const entry = Object.values(saved)[0];
        expect(entry.groupColumns.map(ref => ref.name)).toEqual(['REGION']);
        expect(entry.selectedGroupKey).toBeDefined();

        // A fresh module instance has no in-memory cache, so the grouping must come from host state.
        panel.disposeAnalyticalView();
        jest.resetModules();
        const fresh: PanelModule = await import('../analytical/analyticalPanel');
        fresh.renderAnalyticalView(0);
        expect(container().querySelector('.analytical-chip-name')?.textContent).toBe('REGION');
        fresh.disposeAnalyticalView();
    });

    it('does not recompute for an unchanged revision: the cached result is painted synchronously', async () => {
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');
        await waitFor(() => groupItems().length === 6 || null);

        panel.renderAnalyticalView(0);
        expect(groupItems()).toHaveLength(6);
        expect(container().querySelector('.analytical-status')).toBeNull();
    });

    it('recomputes when the result revision changes', async () => {
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');
        await waitFor(() => groupItems().length === 6 || null);

        mockOwner = makeOwner({ executionTimestamp: 2 });
        panel.renderAnalyticalView(0);
        expect(container().querySelector('.analytical-status')).not.toBeNull();
        await waitFor(() => groupItems().length === 6 || null);
    });

    it('analyses every spilled row exactly, without a sampling notice, in column batches', async () => {
        mockOwner = makeOwner({ storageMode: 'sqlite', totalRowCount: 120, data: undefined as unknown as unknown[][] });
        mockFetchRows.mockResolvedValue(buildRows().slice(0, 200));
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');

        await waitFor(() => groupItems().length === 6 || null);
        expect(container().textContent).not.toContain('50,000');
        expect(mockFetchRows).not.toHaveBeenCalledWith(expect.anything(), 0, 0, 50000, true);
        expect(mockQueryStats).toHaveBeenCalled();
        const request = mockQueryStats.mock.calls[0][1] as DiskGroupStatsRequest;
        expect(request.groupColumns).toEqual([0]);
        expect(request.limit).toBe(500);
    });

    it('reports rules the disk path could not evaluate as a notice', async () => {
        mockOwner = makeOwner({ storageMode: 'sqlite', totalRowCount: 120, data: undefined as unknown as unknown[][] });
        mockFetchRows.mockResolvedValue(buildRows().slice(0, 200));
        mockQueryStats.mockImplementation(async (_rsIndex: number, request: DiskGroupStatsRequest) => ({
            ...fakeGroupStats(request),
            omitted: [{ columnIndex: 1, field: 'topValues', reason: 'too-many-distinct' }],
        }));
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');

        await waitFor(() => groupItems().length === 6 || null);
        const notices = Array.from(container().querySelectorAll('.analytical-notice')).map(item => item.textContent).join(' ');
        expect(notices).toContain('Not evaluated for AMOUNT');
        expect(notices).toContain('Dominant value');
    });

    it('shows a retryable error without restarting the work automatically', async () => {
        mockQueryStats.mockRejectedValue(new Error('host unavailable'));
        mockOwner = makeOwner({ storageMode: 'sqlite', totalRowCount: 120, data: undefined as unknown as unknown[][] });
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');

        const alert = await waitFor(() => container().querySelector<HTMLElement>('.analytical-status.is-error'));
        expect(alert.textContent).toContain('host unavailable');
        await new Promise(resolve => setTimeout(resolve, 5));
        expect(mockQueryStats).toHaveBeenCalledTimes(1);
    });

    it('does not paint a late result after the view is disposed', async () => {
        panel.renderAnalyticalView(0);
        chooseSuggestion('REGION');
        panel.disposeAnalyticalView();
        const before = container().innerHTML;

        await new Promise(resolve => setTimeout(resolve, 5));
        expect(container().innerHTML).toBe(before);
    });

    it('refuses non-tabular results instead of analysing log or error output', () => {
        mockOwner = makeOwner({ isLog: true });
        panel.renderAnalyticalView(0);
        expect(container().textContent).toContain('Analytical view needs a tabular result.');
        expect(container().querySelector('.analytical-picker')).toBeNull();
    });
});

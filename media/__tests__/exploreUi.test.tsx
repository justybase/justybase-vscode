/** @jest-environment jsdom */
import type { ExploreFilterModel, ExploreResponse } from '@justybase/contracts';
import { renderFilterEditor } from '../resultPanel/explore/filterEditor.js';
import { showSelectionActions } from '../resultPanel/explore/selectionActions.js';
import { requestExploreOperation, openExploreSqlInEditor } from '../resultPanel/explore/hostBridge.js';
import { renderFilterBar } from '../resultPanel/explore/filterBar.js';
import { ExploreFilterState } from '../resultPanel/explore/filterState.js';
import { computeColumnStatistics } from '../resultPanel/explore/statistics.js';

jest.mock('../resultPanel/explore/hostBridge.js', () => ({
    requestExploreOperation: jest.fn(), openExploreSqlInEditor: jest.fn(), cancelExploreRequests: jest.fn(),
}));
const empty = (): ExploreFilterModel => ({ dimensions: [], dates: [], measures: [] });
const columns = [{ index: 0, name: 'Category', type: 'VARCHAR', role: 'dimension' as const },
    { index: 1, name: 'Amount', type: 'DECIMAL', role: 'measure' as const },
    { index: 2, name: 'Date', type: 'DATE', role: 'date' as const }];
const control = (root: HTMLElement, label: string): HTMLInputElement => {
    const field = Array.from(root.querySelectorAll('label')).find(item => item.querySelector('span')?.textContent === label);
    return field?.querySelector('input') as HTMLInputElement;
};
const click = (root: HTMLElement, text: string) => {
    const button = Array.from(root.querySelectorAll('button')).find(item => item.textContent === text);
    if (!button) throw new Error(`Missing button ${text}`);
    button.click();
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('Explore filter and selection UI', () => {
    let root: HTMLElement;
    beforeEach(() => {
        jest.clearAllMocks();
        global.structuredClone = value => JSON.parse(JSON.stringify(value)) as typeof value;
        root = document.createElement('div'); document.body.replaceChildren(root);
    });
    it('renders exact include/exclude and open-ended range chips with keyboard editing', () => {
        const state = new ExploreFilterState();
        const edit = jest.fn(); const remove = jest.fn();
        const filters: ExploreFilterModel = { dimensions: [{ columnIndex: 0, mode: 'exclude', values: ['NULL'], includeNull: true, includeEmpty: true }],
            dates: [{ columnIndex: 2, grain: 'day' }, { columnIndex: 2, grain: 'day', from: '2026-01-01', to: '2026-02-01', toExclusive: false }],
            measures: [{ columnIndex: 1 }, { columnIndex: 1, min: '0', max: '10', maxExclusive: false }, { columnIndex: 9, max: '20', maxExclusive: true }] };
        renderFilterBar(root, filters, columns, state, { onUndo: jest.fn(), onRedo: jest.fn(), onClear: jest.fn(), onEditChip: edit, onRemoveChip: remove });
        expect(root.textContent).toContain('excludes'); expect(root.textContent).toContain('Col 10');
        root.querySelectorAll<HTMLElement>('.explore-filter-chip-label').forEach(chip => { chip.click(); chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); chip.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })); chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(edit).toHaveBeenCalledTimes(24);
        root.querySelectorAll<HTMLButtonElement>('.explore-filter-chip-remove').forEach(button => button.click()); expect(remove).toHaveBeenCalledTimes(8);
        click(root, 'Add filter');
    });
    it('does not execute a query while editing and commits Include/Exclude atomically', () => {
        const state = new ExploreFilterState();
        renderFilterEditor(root, columns, [['A'], ['B'], [null], ['']], state.filters, filters => state.replace(filters));
        const mode = root.querySelectorAll('select')[1]; mode.value = 'exclude';
        control(root, 'A').checked = true; control(root, 'A').dispatchEvent(new Event('change'));
        control(root, 'NULL').checked = true;
        expect(requestExploreOperation).not.toHaveBeenCalled();
        click(root, 'Apply');
        expect(state.filters.dimensions[0]).toMatchObject({ values: ['A'], mode: 'exclude', includeNull: true });
        expect(state.historyDepth).toBe(1); state.undo(); expect(state.filters).toEqual(empty());
    });
    it('searches beyond the first eight sample values and keeps selected values when searching', () => {
        renderFilterEditor(root, columns, Array.from({ length: 20 }, (_, i) => [`Category ${i}`]), empty(), jest.fn());
        expect(control(root, 'Category 19')).toBeDefined();
        control(root, 'Category 19').checked = true; control(root, 'Category 19').dispatchEvent(new Event('change'));
        const search = control(root, 'Search values'); search.value = 'Category 1'; search.dispatchEvent(new Event('input'));
        expect(control(root, 'Category 19').checked).toBe(true);
        expect(requestExploreOperation).not.toHaveBeenCalled();
    });
    it('requires explicit database search and excludes the edited column filter from the request', async () => {
        const response: ExploreResponse = { rows: [['Outside sample']], filters: empty(), scope: 'database', sql: 'SELECT 1', computedAt: 0, truncated: true };
        jest.mocked(requestExploreOperation).mockResolvedValue(response);
        renderFilterEditor(root, columns, [['A']], { ...empty(), dimensions: [{ columnIndex: 0, values: ['A'] }] }, jest.fn());
        click(root, 'Search database'); await settle();
        expect(requestExploreOperation).toHaveBeenCalledWith({ kind: 'values', columnIndex: 0, search: '', filters: empty() });
        expect(root.textContent).toContain('More values available');
        expect(control(root, 'Outside sample')).toBeDefined();
        expect(control(root, 'A').checked).toBe(true);
    });
    it('validates exact decimal ranges and Cancel leaves the filters untouched', () => {
        const apply = jest.fn(); renderFilterEditor(root, columns, [], empty(), apply, 1);
        control(root, 'Min').value = '9007199254740993'; control(root, 'Max').value = '9007199254740992';
        click(root, 'Apply'); expect(apply).not.toHaveBeenCalled(); expect(root.textContent).toContain('must not exceed');
        control(root, 'Max').value = '9007199254740994'; click(root, 'Apply');
        expect(apply).toHaveBeenCalledWith({ ...empty(), measures: [{ columnIndex: 1, min: '9007199254740993', max: '9007199254740994' }] });
        renderFilterEditor(root, columns, [], empty(), apply, 1); click(root, 'Cancel'); expect(apply).toHaveBeenCalledTimes(1);
    });
    it('includes the whole final day and restores the same date without drifting', () => {
        const apply = jest.fn(); renderFilterEditor(root, columns, [], empty(), apply, 2);
        control(root, 'To').value = '2026-01-31'; click(root, 'Apply');
        const filters = apply.mock.calls[0][0] as ExploreFilterModel;
        expect(filters.dates[0]).toMatchObject({ to: '2026-02-01', toExclusive: true });
        renderFilterEditor(root, columns, [], filters, apply, 2);
        expect(control(root, 'To').value).toBe('2026-01-31');
    });
    it('shows sample rows locally with safe text and no mutation of global filters', () => {
        const apply = jest.fn(); showSelectionActions(root, { label: 'A', scope: 'sample', filters: empty() }, columns, [['<img src=x>', 10]], apply);
        click(root, 'Show rows'); expect(root.textContent).toContain('<img src=x>'); expect(root.querySelector('img')).toBeNull();
        expect(requestExploreOperation).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    });
    it('requires Load rows for database selections and paginates the same bounded response', async () => {
        jest.mocked(requestExploreOperation).mockResolvedValue({ rows: Array.from({ length: 1000 }, (_, i) => [`row ${i}`]), filters: empty(), sql: 'SELECT 1', truncated: true, scope: 'database', computedAt: 0 });
        showSelectionActions(root, { label: 'A', scope: 'database', filters: empty() }, columns, [], jest.fn());
        click(root, 'Show rows'); expect(requestExploreOperation).not.toHaveBeenCalled();
        click(root, 'Load rows'); await settle(); expect(root.querySelectorAll('tbody tr')).toHaveLength(100);
        expect(root.textContent).toContain('Showing first 1,000'); click(root, 'Next page');
        expect(root.querySelector('tbody')?.textContent).toContain('row 100'); expect(requestExploreOperation).toHaveBeenCalledTimes(1);
    });
    it('Open SQL only requests a preview', async () => {
        jest.mocked(requestExploreOperation).mockResolvedValue({ rows: [], filters: empty(), sql: 'SELECT details', scope: 'database', computedAt: 0, truncated: false });
        showSelectionActions(root, { label: 'A', scope: 'database', filters: empty() }, columns, [], jest.fn());
        click(root, 'Open SQL'); await settle();
        expect(requestExploreOperation).toHaveBeenCalledWith({ kind: 'rows', filters: empty() }, true);
        expect(openExploreSqlInEditor).toHaveBeenCalledWith('SELECT details', expect.any(String));
    });
    it('handles failed database details with retry and ignores a late response after Close', async () => {
        jest.mocked(requestExploreOperation).mockRejectedValueOnce(new Error('Read failed'));
        showSelectionActions(root, { label: 'A', scope: 'database', filters: empty() }, columns, [], jest.fn());
        click(root, 'Show rows'); click(root, 'Load rows'); await settle();
        expect(root.textContent).toContain('Read failed');
        jest.mocked(requestExploreOperation).mockResolvedValue({ rows: [], filters: empty(), sql: 'SELECT details', scope: 'database', computedAt: 0, truncated: false });
        click(root, 'Retry'); await settle(); expect(root.textContent).toContain('0 matching rows');
        click(root, 'Previous page'); // Disabled navigation must not issue a query.
        expect(requestExploreOperation).toHaveBeenCalledTimes(2);
        let finish!: (response: ExploreResponse) => void;
        jest.mocked(requestExploreOperation).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
        click(root, 'Show rows'); click(root, 'Load rows'); click(root, 'Close');
        finish({ rows: [['late']], filters: empty(), sql: '', scope: 'database', computedAt: 0, truncated: false }); await settle();
        expect(root.textContent).toBe('');
    });
    it('filters local preview rows, supports both page directions and applies the captured selection', () => {
        const filters = { ...empty(), dimensions: [{ columnIndex: 0, values: ['A'] }] };
        const apply = jest.fn();
        showSelectionActions(root, { label: 'A', scope: 'sample', filters }, columns, [...Array.from({ length: 205 }, (_, i) => ['A', i]), ['B', 500]], apply);
        click(root, 'Show rows'); expect(root.textContent).toContain('205 matching rows');
        click(root, 'Next page'); expect(root.querySelector('tbody')?.textContent).toContain('100');
        click(root, 'Previous page'); expect(root.querySelector('tbody')?.firstChild?.textContent).toContain('0');
        click(root, 'Filter to selection'); expect(apply).toHaveBeenCalledWith(filters);
    });
    it('examines up to 50,000 rows including values after the old 2,000-row boundary', () => {
        const rows = Array.from({ length: 50001 }, (_, i) => [i === 49999 ? 100 : i === 50000 ? 10000 : 0]);
        const stats = computeColumnStatistics(rows, 0);
        expect(stats.count).toBe(50000); expect(stats.max).toBe(100); expect(stats.sum).toBe(100);
    });
});

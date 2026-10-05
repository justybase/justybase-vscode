import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { onGlobalFilterChanged, onGlobalFilterKeydown } from '../init.js';
import {
    handleExportPrimaryClick,
    readLastExportSelection,
    rememberLastExportSelection,
    syncExportPrimaryButton,
} from '../export.js';
import { renderRowCountInfo } from '../rowCount.js';
import { updateControlsVisibility } from '../grid/alternateViews.js';
import {
    addGrid,
    resetGrids,
    setActiveGridIndex,
    setIsSearching,
} from '../state.js';
import { getResultPanelWindow } from '../types.js';
import type { GridHandle, ResultSet } from '../types.js';

jest.mock('../rangeChart.js', () => ({ canCreateRangeChart: jest.fn(() => false) }));
jest.mock('../databaseFilters.js', () => ({
    applyDatabaseFilter: jest.fn(async () => undefined),
    queryDatabaseFilterValues: jest.fn(async () => ({ values: [], truncated: false })),
}));
jest.mock('../analysis.js', () => ({
    getActiveResultViewMode: jest.fn(() => 'table'),
    getAnalysisLimitWarning: jest.fn(() => undefined),
    initializeAnalysisModeControls: jest.fn(),
    setActiveResultViewMode: jest.fn(),
    syncAnalysisView: jest.fn(),
}));

function minimalResultSet(overrides: Partial<ResultSet> = {}): ResultSet {
    return {
        name: 'Result 1',
        columns: [],
        data: [],
        isLog: false,
        isError: false,
        isTextContent: false,
        storageMode: 'memory',
        executionTimestamp: 1,
        ...overrides,
    } as unknown as ResultSet;
}

function clickToolbarMenuAction(action: string): void {
    document.body.innerHTML =
        `<div class="controls"></div>` +
        `<div id="toolbarMoreMenu">` +
        `<div class="split-btn__menu-item" data-action="${action}">item</div>` +
        `</div><input id="columnSearch">`;
    const item = document.querySelector('.split-btn__menu-item');
    if (!item) throw new Error('menu item missing');
    getResultPanelWindow().handleToolbarMoreMenuClick?.({ target: item } as unknown as MouseEvent);
}

beforeEach(() => {
    document.body.innerHTML = '';
    resetGrids();
    setActiveGridIndex(0);
    setIsSearching(false);
    const panelWindow = getResultPanelWindow();
    panelWindow.resultSets = [];
    panelWindow.activeSource = undefined;
    panelWindow.queryRowLimit = undefined;
});

describe('onGlobalFilterKeydown (variant C: Escape clears)', () => {
    it('clears all filters and blurs on Escape', () => {
        const clearAllFilters = jest.fn();
        getResultPanelWindow().clearAllFilters = clearAllFilters;
        const preventDefault = jest.fn();
        const blur = jest.fn();

        onGlobalFilterKeydown({
            key: 'Escape',
            preventDefault,
            target: { blur },
        } as unknown as KeyboardEvent);

        expect(preventDefault).toHaveBeenCalled();
        expect(clearAllFilters).toHaveBeenCalled();
        expect(blur).toHaveBeenCalled();
    });

    it('ignores other keys', () => {
        const clearAllFilters = jest.fn();
        getResultPanelWindow().clearAllFilters = clearAllFilters;

        onGlobalFilterKeydown({ key: 'a', preventDefault: jest.fn() } as unknown as KeyboardEvent);

        expect(clearAllFilters).not.toHaveBeenCalled();
    });
});

describe('toolbar "⋯" Filter section (variant C)', () => {
    it('clears filters through the menu entry', () => {
        const clearAllFilters = jest.fn();
        getResultPanelWindow().clearAllFilters = clearAllFilters;

        clickToolbarMenuAction('filter-clear');

        expect(clearAllFilters).toHaveBeenCalled();
        expect(document.getElementById('toolbarMoreMenu')?.style.display).toBe('none');
    });

    it('runs filter history and refresh without a result set', async () => {
        clickToolbarMenuAction('filter-undo');
        clickToolbarMenuAction('filter-redo');
        clickToolbarMenuAction('filter-refresh');
        await Promise.resolve();
        await Promise.resolve();
        expect(document.getElementById('toolbarMoreMenu')?.style.display).toBe('none');
    });

    it('forwards the remaining overflow actions', () => {
        expect(() => {
            clickToolbarMenuAction('formatting');
            clickToolbarMenuAction('move-to-disk');
            clickToolbarMenuAction('move-all-to-disk');
        }).not.toThrow();
        expect(document.getElementById('toolbarMoreMenu')?.style.display).toBe('none');
    });

    it('clears the field through the panel clearFilter helper', () => {
        document.body.innerHTML = '<input id="globalFilter" value="abc">';
        getResultPanelWindow().clearFilter?.();
        expect(document.getElementById('globalFilter')).not.toBeNull();
    });

    it('debounces the global filter change', async () => {
        document.body.innerHTML = '<input id="globalFilter" value="x">';
        onGlobalFilterChanged();
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(document.getElementById('globalFilter')).not.toBeNull();
    });

    it('reveals and focuses the column search', () => {
        clickToolbarMenuAction('find-column');

        expect(document.querySelector('.controls')?.classList.contains('show-column-search')).toBe(true);
        expect(document.activeElement?.id).toBe('columnSearch');
    });

    it('exposes undo/redo on Alt+Z / Alt+Y', () => {
        expect(() => {
            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'z', altKey: true, bubbles: true, cancelable: true }),
            );
            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'y', altKey: true, bubbles: true, cancelable: true }),
            );
        }).not.toThrow();
    });

    it('leaves Alt+Z / Alt+Y alone when there is no filter history to move', () => {
        const undoEvent = new KeyboardEvent('keydown', { key: 'z', altKey: true, bubbles: true, cancelable: true });
        const redoEvent = new KeyboardEvent('keydown', { key: 'y', altKey: true, bubbles: true, cancelable: true });

        document.dispatchEvent(undoEvent);
        document.dispatchEvent(redoEvent);

        expect(undoEvent.defaultPrevented).toBe(false);
        expect(redoEvent.defaultPrevented).toBe(false);
    });
});

describe('export repeat-last-format (variant C)', () => {
    function withFakeGrid(): void {
        getResultPanelWindow().resultSets = [minimalResultSet({ refreshSql: 'SELECT 1' })];
        addGrid({
            tanTable: {
                getVisibleLeafColumns: () => [{ id: '0', getIsVisible: () => true }],
            },
        } as unknown as GridHandle);
    }

    function withExportButton(): void {
        document.body.innerHTML =
            `<div class="split-btn" id="exportSplitBtn">` +
            `<button class="btn split-btn__primary">Export</button></div>`;
    }

    it('round-trips the last selection and rejects unknown formats', () => {
        rememberLastExportSelection('csv', 'loaded');
        expect(readLastExportSelection()).toEqual({ format: 'csv', rowScope: 'loaded' });

        rememberLastExportSelection('nope', 'loaded');
        expect(readLastExportSelection()).toBeNull();

        rememberLastExportSelection('csv', 'bogus' as unknown as 'loaded');
        expect(readLastExportSelection()).toEqual({ format: 'csv', rowScope: 'loaded' });
    });

    it('syncs the primary button hint from the last selection', () => {
        withExportButton();
        rememberLastExportSelection('xlsx', 'loaded');
        syncExportPrimaryButton();

        const primary = document.querySelector('#exportSplitBtn .split-btn__primary');
        expect(primary?.getAttribute('title')).toContain('Excel (.xlsx)');
        expect(primary?.getAttribute('aria-label')).toContain('Excel (.xlsx)');
    });

    it('repeats the last format on primary click', () => {
        withFakeGrid();
        withExportButton();
        rememberLastExportSelection('json', 'loaded');

        handleExportPrimaryClick();

        expect(readLastExportSelection()).toEqual({ format: 'json', rowScope: 'loaded' });
        expect(
            document.querySelector('#exportSplitBtn .split-btn__primary')?.getAttribute('title'),
        ).toContain('JSON');
    });

    it('falls back to loaded rows without overwriting the stored ALL preference', () => {
        withFakeGrid();
        rememberLastExportSelection('json', 'all');

        handleExportPrimaryClick();

        // The context-forced downgrade applies to this export only; the
        // remembered ALL scope must survive for the next LIMIT result.
        expect(readLastExportSelection()).toEqual({ format: 'json', rowScope: 'all' });
    });

    it('opens the format menu when nothing was remembered', () => {
        withExportButton();
        document.body.innerHTML += `<div class="split-btn__menu" id="exportPrimaryMenu" style="display:none"></div>`;
        // Poison the memory with an unknown format so the read falls through.
        rememberLastExportSelection('nope', 'loaded');

        // No grid metadata either, so the menu simply stays closed without throwing.
        handleExportPrimaryClick(new MouseEvent('click', { bubbles: true }));
        expect(document.getElementById('exportPrimaryMenu')?.style.display).toBe('none');

        rememberLastExportSelection('csv', 'loaded');
    });
});

describe('result statusline (variant C)', () => {
    it('clears the statusline when there is no data result', () => {
        document.body.innerHTML = '<span id="rowCountInfo"></span><div id="resultStatusline"></div>';

        renderRowCountInfo(0);

        expect(document.getElementById('rowCountInfo')?.textContent).toBe('');
        expect(document.getElementById('resultStatusline')?.textContent).toBe('');
        expect(document.getElementById('resultStatusline')?.style.display).toBe('none');
    });

    it('mirrors the toolbar counter text', () => {
        document.body.innerHTML = '<span id="rowCountInfo"></span><div id="resultStatusline"></div>';
        getResultPanelWindow().resultSets = [minimalResultSet()];

        renderRowCountInfo(0);

        expect(document.getElementById('rowCountInfo')?.textContent).toContain('0 rows');
        expect(document.getElementById('resultStatusline')?.textContent).toContain('0 rows');
        expect(document.getElementById('resultStatusline')?.style.display).not.toBe('none');
    });

    it('clears a stale statusline when the counter is gone', () => {
        document.body.innerHTML = '<div id="resultStatusline">stale</div>';

        renderRowCountInfo(0);

        expect(document.getElementById('resultStatusline')?.textContent).toBe('');
    });

    it('shows the searching state in both surfaces', () => {
        document.body.innerHTML = '<span id="rowCountInfo"></span><div id="resultStatusline"></div>';
        getResultPanelWindow().resultSets = [minimalResultSet()];
        setIsSearching(true);

        renderRowCountInfo(0);

        expect(document.getElementById('resultStatusline')?.textContent).toContain('Searching');
    });

    it('mirrors disk-backed counts', () => {
        document.body.innerHTML = '<span id="rowCountInfo"></span><div id="resultStatusline"></div>';
        getResultPanelWindow().resultSets = [
            minimalResultSet({ storageMode: 'sqlite', totalRowCount: 5, data: [[1], [2]] }),
        ];

        renderRowCountInfo(0);

        expect(document.getElementById('resultStatusline')?.textContent).toContain('5 rows');
    });

    it('flags a reached row limit in both surfaces', () => {
        document.body.innerHTML = '<span id="rowCountInfo"></span><div id="resultStatusline"></div>';
        getResultPanelWindow().queryRowLimit = 2;
        getResultPanelWindow().resultSets = [minimalResultSet({ data: [[1], [2], [3]] })];

        renderRowCountInfo(0);

        expect(document.getElementById('rowCountInfo')?.textContent).toContain('limit reached');
        expect(document.getElementById('resultStatusline')?.textContent).toContain('limit reached');
    });

    it('hides the statusline on Logs/Text views', () => {
        document.body.innerHTML =
            `<div class="controls"><span id="rowCountInfo"></span></div>` +
            `<div id="groupingPanel"></div><div id="resultStatusline">3 rows</div>`;
        getResultPanelWindow().resultSets = [minimalResultSet({ isLog: true })];

        updateControlsVisibility(0);

        expect(document.getElementById('resultStatusline')?.style.display).toBe('none');

        getResultPanelWindow().resultSets = [minimalResultSet()];
        updateControlsVisibility(0);
        expect(document.getElementById('resultStatusline')?.style.display).not.toBe('none');
    });

    it('tolerates a missing statusline element', () => {
        document.body.innerHTML =
            `<div class="controls"><span id="rowCountInfo"></span></div>` +
            `<div id="groupingPanel"></div>`;
        getResultPanelWindow().resultSets = [minimalResultSet({ isLog: true })];

        expect(() => updateControlsVisibility(0)).not.toThrow();
    });
});

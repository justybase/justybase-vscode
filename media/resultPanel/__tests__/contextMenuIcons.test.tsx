import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { showContextMenu } from '../selection/menu.js';
import type { TanStackTable } from '../types.js';

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

function buildGridFixture(): { table: TanStackTable; cell: HTMLTableCellElement } {
    const column = {
        id: '0',
        columnDef: { header: 'DATEKEY', dataType: 'INTEGER' },
        getFilterValue: () => undefined,
        setFilterValue: jest.fn(),
        getIsSorted: () => false,
        getToggleSortingHandler: () => jest.fn(),
        toggleVisibility: jest.fn(),
        getIsVisible: () => true,
    };
    const table = {
        getVisibleLeafColumns: () => [column],
        getRowModel: () => ({ rows: [{ index: 3, getValue: () => 17 }] }),
        getState: () => ({ sorting: [], columnFilters: [], grouping: [] }),
        setSorting: jest.fn(),
        setColumnFilters: jest.fn(),
        setGrouping: jest.fn(),
    } as unknown as TanStackTable;

    const cell = document.createElement('td');
    cell.textContent = '17';
    const row = document.createElement('tr');
    row.dataset.index = '0';
    row.append(document.createElement('td'), cell);
    const tableElement = document.createElement('table');
    tableElement.appendChild(row);
    document.body.appendChild(tableElement);

    return { table, cell };
}

function openMenu(): HTMLDivElement {
    const { table, cell } = buildGridFixture();
    showContextMenu({
        table,
        wrapper: document.createElement('div'),
        model: { selectedCells: new Set(['0-0']) } as never,
    }, 12, 24, cell);
    const menu = document.querySelector('.grid-context-menu');
    expect(menu).not.toBeNull();
    return menu as HTMLDivElement;
}

function menuItem(menu: ParentNode, label: string): HTMLElement {
    const match = Array.from(menu.querySelectorAll<HTMLElement>('.grid-context-menu-item'))
        .find((item) => item.querySelector('.grid-context-menu-label')?.textContent === label);
    expect(match).toBeDefined();
    return match as HTMLElement;
}

function expectIcon(item: HTMLElement): void {
    const slot = item.firstElementChild;
    expect(slot?.classList.contains('grid-context-menu-icon')).toBe(true);
    expect(slot?.getAttribute('aria-hidden')).toBe('true');
    expect(slot?.querySelector('svg')).not.toBeNull();
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('result grid context menu icons', () => {
    it('renders a decorative icon slot on every menu row without changing label text', () => {
        const menu = openMenu();

        const items = Array.from(menu.querySelectorAll<HTMLElement>('.grid-context-menu-item'));
        expect(items.length).toBeGreaterThan(5);
        for (const item of items) {
            expectIcon(item);
            expect(item.querySelector('.grid-context-menu-label')?.textContent?.trim()).toBeTruthy();
        }

        expect(menuItem(menu, 'Sort Ascending').textContent).toBe('Sort Ascending');
        expect(menuItem(menu, 'Hide Column').textContent).toBe('Hide Column');
        expect(menuItem(menu, 'Copy as').classList.contains('has-submenu')).toBe(true);
    });

    it('keeps icons in the "Copy as" and export submenus', () => {
        const copySelection = jest.fn();
        Object.assign(window, { copySelection });
        const menu = openMenu();

        const copyAs = menuItem(menu, 'Copy as');
        copyAs.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

        const submenu = document.querySelector('.grid-context-submenu');
        expect(submenu).not.toBeNull();
        const entries = Array.from(submenu!.querySelectorAll<HTMLElement>('.grid-context-menu-item'));
        expect(entries.map((entry) => entry.querySelector('.grid-context-menu-label')?.textContent))
            .toEqual(['Tabbed with headers', 'Markdown table', 'CSV', 'JSON', 'SQL INSERT statements', 'SQL IN list', 'HTML table']);
        for (const entry of entries) {
            expectIcon(entry);
        }

        const json = menuItem(submenu!, 'JSON');
        json.click();
        expect(copySelection).toHaveBeenCalledWith(true, 'json');
        expect(document.querySelector('.grid-context-menu')).toBeNull();
    });
});

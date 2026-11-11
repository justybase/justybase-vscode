import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { showContextMenu } from '../selection/menu.js';
import type { TanStackTable } from '../types.js';

const postHostMessage = jest.fn();
const promptForMenuValue = jest.fn<(title: string) => Promise<string | undefined>>();
const showColumnFilterDropdown = jest.fn();
const setActiveResultViewMode = jest.fn();
const focusExploreColumn = jest.fn();

jest.mock('../protocol.js', () => ({
    postHostMessage: (...args: unknown[]) => postHostMessage(...args),
    getHostState: jest.fn(),
    setHostState: jest.fn(),
}));
jest.mock('../selection/valuePrompt.js', () => ({
    promptForMenuValue: (title: string) => promptForMenuValue(title),
}));
jest.mock('../filter.js', () => ({
    showColumnFilterDropdown: (...args: unknown[]) => showColumnFilterDropdown(...args),
}));
jest.mock('../analysis.js', () => ({
    getActiveResultViewMode: jest.fn(() => 'table'),
    getAnalysisLimitWarning: jest.fn(() => undefined),
    initializeAnalysisModeControls: jest.fn(),
    setActiveResultViewMode: (...args: unknown[]) => setActiveResultViewMode(...args),
    syncAnalysisView: jest.fn(),
}));
jest.mock('../explore/focusColumn.js', () => ({
    focusExploreColumn: (...args: unknown[]) => focusExploreColumn(...args),
}));
jest.mock('../rangeChart.js', () => ({ canCreateRangeChart: jest.fn(() => false) }));

interface Fixture {
    table: TanStackTable;
    cell: HTMLTableCellElement;
}

function buildGridFixture(options: { editSource?: boolean } = {}): Fixture {
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

    const panel = window as unknown as Record<string, unknown>;
    panel.activeSource = 'untitled:result';
    panel.getActiveGridIndex = () => 0;
    panel.resultSets = [{
        columns: [{ name: 'DATEKEY', type: 'INTEGER' }],
        data: [[17]],
        isEditable: true,
        editSource: options.editSource === false
            ? undefined
            : { db: 'SALES', schema: 'ADMIN', table: 'ORDERS' },
    }];

    return { table, cell };
}

function openMenu(fixture: Fixture): HTMLDivElement {
    showContextMenu({
        table: fixture.table,
        wrapper: document.createElement('div'),
        model: { selectedCells: new Set(['0-0']) } as never,
    }, 12, 24, fixture.cell);
    const menu = document.querySelector('.grid-context-menu');
    expect(menu).not.toBeNull();
    return menu as HTMLDivElement;
}

function menuItem(menu: ParentNode, label: string): HTMLElement | undefined {
    return Array.from(menu.querySelectorAll<HTMLElement>('.grid-context-menu-item'))
        .find((item) => item.querySelector('.grid-context-menu-label')?.textContent === label);
}

function clickMenuItem(menu: ParentNode, label: string): void {
    const item = menuItem(menu, label);
    expect(item).toBeDefined();
    item!.click();
}

afterEach(() => {
    document.body.innerHTML = '';
    const panel = window as unknown as Record<string, unknown>;
    delete panel.resultSets;
    delete panel.activeSource;
    delete panel.getActiveGridIndex;
    delete panel.copySelection;
});

beforeEach(() => {
    jest.clearAllMocks();
    promptForMenuValue.mockResolvedValue(undefined);
});

describe('result grid column menu catalog actions', () => {
    it('copies the column name and adds the column to SELECT', () => {
        const fixture = buildGridFixture();
        let menu = openMenu(fixture);

        clickMenuItem(menu, 'Copy Name');
        expect(postHostMessage).toHaveBeenCalledWith({
            command: 'copyToClipboard',
            text: 'DATEKEY',
        });

        menu = openMenu(fixture);
        clickMenuItem(menu, 'Add to SELECT');
        expect(postHostMessage).toHaveBeenCalledWith({
            command: 'columnAction',
            sourceUri: 'untitled:result',
            resultSetIndex: 0,
            action: 'addToSelect',
            columnName: 'DATEKEY',
            editSource: { db: 'SALES', schema: 'ADMIN', table: 'ORDERS' },
        });
    });

    it('hides table-bound actions when the result is not bound to one table', () => {
        const menu = openMenu(buildGridFixture({ editSource: false }));

        expect(menuItem(menu, 'Copy Qualified Name')).toBeUndefined();
        expect(menuItem(menu, 'Comment on Column...')).toBeUndefined();
        expect(menuItem(menu, 'Find References')).toBeUndefined();
        expect(menuItem(menu, 'Add to favorites')).toBeUndefined();

        expect(menuItem(menu, 'Copy Name')).toBeDefined();
        expect(menuItem(menu, 'Add to SELECT')).toBeDefined();
        expect(menuItem(menu, 'Profile Column')).toBeDefined();
    });

    it('posts qualified-name, comment, references, and favorite actions', () => {
        const fixture = buildGridFixture();
        let menu = openMenu(fixture);

        clickMenuItem(menu, 'Copy Qualified Name');
        menu = openMenu(fixture);
        clickMenuItem(menu, 'Comment on Column...');
        menu = openMenu(fixture);
        clickMenuItem(menu, 'Find References');
        menu = openMenu(fixture);
        clickMenuItem(menu, 'Add to favorites');

        const actions = postHostMessage.mock.calls
            .map(([message]) => (message as { action?: string }).action)
            .filter(Boolean);
        expect(actions).toEqual([
            'copyQualifiedName',
            'commentOnColumn',
            'findReferences',
            'toggleFavorite',
        ]);
        for (const [message] of postHostMessage.mock.calls) {
            expect(message).toMatchObject({
                command: 'columnAction',
                sourceUri: 'untitled:result',
                resultSetIndex: 0,
                columnName: 'DATEKEY',
                editSource: { db: 'SALES', schema: 'ADMIN', table: 'ORDERS' },
            });
        }
    });

    it('prompts for a value and applies an equality condition', async () => {
        promptForMenuValue.mockResolvedValue('17');
        const fixture = buildGridFixture();
        const menu = openMenu(fixture);

        clickMenuItem(menu, 'Filter by Value...');
        await Promise.resolve();
        await Promise.resolve();

        expect(promptForMenuValue).toHaveBeenCalledWith('Filter DATEKEY by value');
        expect(fixture.table.setColumnFilters).toHaveBeenCalledWith([{
            id: '0',
            value: {
                _isConditionFilter: true,
                conditions: [{ type: 'equals', value: '17' }],
                logic: 'and',
            },
        }]);
    });

    it('treats an empty prompt as the column empty-value filter', async () => {
        promptForMenuValue.mockResolvedValue('   ');
        const fixture = buildGridFixture();
        const menu = openMenu(fixture);

        clickMenuItem(menu, 'Filter by Value...');
        await Promise.resolve();
        await Promise.resolve();

        expect(fixture.table.setColumnFilters).toHaveBeenCalledWith([{
            id: '0',
            value: {
                _isConditionFilter: true,
                conditions: [{ type: 'isEmpty', value: '' }],
                logic: 'and',
            },
        }]);
    });

    it('opens the distinct-value dropdown and the Explore profile', () => {
        const fixture = buildGridFixture();
        let menu = openMenu(fixture);

        clickMenuItem(menu, 'Select Distinct');
        expect(showColumnFilterDropdown).toHaveBeenCalledWith(
            expect.objectContaining({ id: '0' }),
            fixture.table,
            fixture.cell,
            0,
        );

        menu = openMenu(fixture);
        clickMenuItem(menu, 'Profile Column');
        expect(setActiveResultViewMode).toHaveBeenCalledWith('explore');
        expect(focusExploreColumn).toHaveBeenCalledWith(0);
    });
});

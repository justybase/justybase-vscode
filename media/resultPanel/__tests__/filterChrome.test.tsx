import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { showColumnFilterDropdown } from '../filter.js';

jest.mock('../databaseFilters.js', () => ({
    applyDatabaseFilter: jest.fn(async () => undefined),
    queryDatabaseFilterValues: jest.fn(async () => ({ values: [], truncated: false })),
}));

function openFilter(columnHeader = 'ENGLISHMONTHNAME') {
    document.body.innerHTML = '';
    Object.assign(window, { resultSets: [], activeSource: undefined });
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const column = {
        id: '3',
        columnDef: {
            header: columnHeader,
            dataType: 'VARCHAR',
            accessorFn: (row: { v: string }) => row.v,
        },
        getFilterValue: () => undefined,
        setFilterValue: jest.fn(),
    };
    const rows = ['April', 'August', 'December'].map((v) => ({ original: { v } }));
    const table = {
        getCoreRowModel: () => ({ rows }),
        getState: () => ({ columnFilters: [] }),
    };
    showColumnFilterDropdown(
        column as unknown as Parameters<typeof showColumnFilterDropdown>[0],
        table as unknown as Parameters<typeof showColumnFilterDropdown>[1],
        anchor,
        0,
    );
    return document.querySelector('.column-filter-dropdown') as HTMLDivElement | null;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('filter dropdown chrome', () => {
    it('renders a context header naming the column above the tabs', () => {
        const dropdown = openFilter('ENGLISHMONTHNAME');
        expect(dropdown).not.toBeNull();
        const title = dropdown!.querySelector('.filter-context-title');
        expect(title?.textContent).toContain('ENGLISHMONTHNAME');
        expect(title?.textContent).toMatch(/filter:/i);
        expect(dropdown!.querySelector('.filter-context-subtitle')?.textContent).toMatch(/conditions/i);
        // Header precedes the tab row.
        const header = dropdown!.querySelector('.filter-context-header') as HTMLElement;
        const tabs = dropdown!.querySelector('.filter-tabs');
        expect(header.compareDocumentPosition(tabs!).toString()).not.toBe('0');
        expect(header.compareDocumentPosition(tabs!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('uses inline SVG icons instead of emoji on tabs and search', () => {
        const dropdown = openFilter();
        expect(dropdown).not.toBeNull();
        const labels = Array.from(dropdown!.querySelectorAll('.filter-tab')).map((tab) => tab.textContent);
        expect(labels).toEqual(expect.arrayContaining(['Values', 'Conditions']));
        for (const tab of dropdown!.querySelectorAll('.filter-tab')) {
            expect(tab.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
            // Inline SVG contributes no text: exact label means no emoji glyphs remain.
            expect(['Values', 'Conditions']).toContain(tab.textContent);
        }
        const searchIcon = dropdown!.querySelector('.filter-search-icon');
        expect(searchIcon?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
        expect(searchIcon?.textContent).not.toContain('🔍');
        expect(dropdown!.querySelector('.filter-search-input')?.getAttribute('placeholder')).toBe('Search values...');
    });

    it('keeps value selection behaviour with the flat row structure', () => {
        const dropdown = openFilter();
        expect(dropdown).not.toBeNull();
        const boxes = Array.from(
            dropdown!.querySelectorAll<HTMLInputElement>('.filter-values-container input[type="checkbox"]'),
        );
        expect(boxes).toHaveLength(3);
        expect(boxes.every((box) => box.checked)).toBe(true);
        const rows = dropdown!.querySelectorAll('.filter-value-item');
        expect(rows.length).toBe(3);
        for (const row of rows) {
            expect(row.querySelector('.filter-value-label')).not.toBeNull();
            expect(row.querySelector('.filter-value-count')).not.toBeNull();
        }
        // Deselect all flips the selection summary without applying.
        dropdown!.querySelectorAll<HTMLButtonElement>('.filter-selection-btn')[1]?.click();
        const summaries = dropdown!.querySelectorAll(':scope > .filter-dropdown-selection-info');
        const summary = summaries[summaries.length - 1]?.textContent ?? '';
        expect(summary).toMatch(/no values selected/i);
    });

    it('switches to the Conditions tab on click', () => {
        const dropdown = openFilter();
        expect(dropdown).not.toBeNull();
        const conditionsTab = Array.from(dropdown!.querySelectorAll<HTMLButtonElement>('.filter-tab'))
            .find((tab) => tab.textContent === 'Conditions');
        conditionsTab?.click();
        expect(conditionsTab?.classList.contains('active')).toBe(true);
        expect(dropdown!.querySelector('.filter-tab-content[data-tab-content="conditions"]')?.classList.contains('active')).toBe(true);
    });
});

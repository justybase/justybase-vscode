import { afterEach, describe, expect, it } from '@jest/globals';
import { renderRowViewComparison } from '../rowViewComparison.js';
import { clampRowViewKeyWidth } from '../rowViewColumnResize.js';
import type { TanStackColumn } from '../types.js';

function column(id: string, header: string, dataType?: string): TanStackColumn {
    return {
        id,
        columnDef: { header, dataType, isRowNumber: false },
        getFilterValue: () => undefined,
        setFilterValue: () => undefined,
        getIsSorted: () => false,
        getToggleSortingHandler: () => () => undefined,
        toggleVisibility: () => undefined,
        getIsVisible: () => true,
    };
}

function renderInto(content: HTMLElement, columns: readonly TanStackColumn[]): void {
    renderRowViewComparison(content, columns, [[1]]);
}

function keyWidth(table: Element): number {
    return Number.parseFloat((table as HTMLElement).style.getPropertyValue('--rv-key-width'));
}

function mockTableWidth(table: Element): void {
    (table as HTMLElement).getBoundingClientRect = () => ({
        width: 400,
        height: 300,
        left: 0,
        top: 0,
        right: 400,
        bottom: 300,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
}

afterEach(() => {
    window.localStorage.clear();
    document.body.replaceChildren();
});

describe('row view column-name resizing', () => {
    it('clamps the shared name column inside usable bounds', () => {
        expect(clampRowViewKeyWidth(90, 400)).toBe(72);
        expect(clampRowViewKeyWidth(-10, 400)).toBeCloseTo(27.5, 1);
        expect(clampRowViewKeyWidth(Number.NaN, 400)).toBe(42);
    });

    it('renders an accessible splitter and widens the column from the keyboard', () => {
        const content = document.createElement('div');
        renderInto(content, [column('0', 'FULLDATEALTERNATETIMESTAMP', 'TIMESTAMP')]);
        const table = content.querySelector('.row-view-table');
        const splitter = content.querySelector('.row-view-splitter');
        expect(table).not.toBeNull();
        expect(splitter).not.toBeNull();
        expect(splitter?.getAttribute('role')).toBe('separator');
        expect(splitter?.getAttribute('aria-orientation')).toBe('vertical');
        expect(splitter?.getAttribute('aria-valuemin')).toBe('12');
        expect(splitter?.getAttribute('aria-valuemax')).toBe('72');

        splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        expect(keyWidth(table!)).toBeCloseTo(44, 5);
        expect(splitter?.getAttribute('aria-valuenow')).toBe('44');

        splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
        expect(keyWidth(table!)).toBeCloseTo(36, 5);
    });

    it('drags the splitter and remembers the chosen width on the next render', () => {
        const content = document.createElement('div');
        renderInto(content, [column('0', 'DATECREATED', 'TIMESTAMP')]);
        const table = content.querySelector('.row-view-table') as HTMLElement;
        const splitter = content.querySelector('.row-view-splitter') as HTMLElement;
        mockTableWidth(table);

        splitter.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 168 }));
        splitter.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 240 }));
        splitter.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

        expect(keyWidth(table)).toBeCloseTo(60, 5);

        const rerendered = document.createElement('div');
        renderInto(rerendered, [column('0', 'DATECREATED', 'TIMESTAMP')]);
        expect(keyWidth(rerendered.querySelector('.row-view-table')!)).toBeCloseTo(60, 5);
    });

    it('fits the name column to the longest column name on double-click', () => {
        const content = document.createElement('div');
        renderInto(content, [column('0', 'FULLDATEALTERNATETIMESTAMP', 'TIMESTAMP')]);
        const table = content.querySelector('.row-view-table') as HTMLElement;
        const splitter = content.querySelector('.row-view-splitter') as HTMLElement;
        mockTableWidth(table);
        const name = content.querySelector('.row-view-key-name') as HTMLElement;
        const type = content.querySelector('.row-view-key-type') as HTMLElement;
        Object.defineProperty(name, 'scrollWidth', { configurable: true, value: 200 });
        Object.defineProperty(type, 'offsetWidth', { configurable: true, value: 20 });

        splitter.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));

        // 200 name + 20 type + 6 gap + 26 section chrome over a 400px panel.
        expect(keyWidth(table)).toBeCloseTo(63, 5);
    });
});

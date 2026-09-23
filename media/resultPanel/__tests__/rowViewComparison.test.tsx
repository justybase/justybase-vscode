import {
    areRowViewValuesEqual,
    renderRowViewComparison,
} from '../rowViewComparison.js';
import type { TanStackColumn } from '../types.js';

function column(id: string, header: string, dataType?: string, visible = true): TanStackColumn {
    return {
        id,
        columnDef: { header, dataType, isRowNumber: false },
        getFilterValue: () => undefined,
        setFilterValue: () => undefined,
        getIsSorted: () => false,
        getToggleSortingHandler: () => () => undefined,
        toggleVisibility: () => undefined,
        getIsVisible: () => visible,
    };
}

describe('rowViewComparison', () => {
    it('compares typed values and distinguishes SQL NULL from empty text', () => {
        expect(areRowViewValuesEqual([null, undefined])).toBe(true);
        expect(areRowViewValuesEqual([null, ''])).toBe(false);
        expect(areRowViewValuesEqual([1, '1'])).toBe(false);
        expect(areRowViewValuesEqual([new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z')])).toBe(true);
        expect(areRowViewValuesEqual([new Uint8Array([1, 2]), new Uint8Array([1, 2])])).toBe(true);
        expect(areRowViewValuesEqual([{ b: 2, a: 1 }, { a: 1, b: 2 }])).toBe(true);
        expect(areRowViewValuesEqual([
            { a: 'x,"b":string:y' },
            { a: 'x', b: 'string:y' },
        ])).toBe(false);
        expect(areRowViewValuesEqual([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toBe(false);
    });

    it('renders hidden columns and untrusted names/values as text, highlighting typed differences', () => {
        const content = document.createElement('div');
        const columns = [
            column('0', '<img src=x onerror=alert(1)>', 'VARCHAR', false),
            column('1', 'OPTIONAL', 'VARCHAR', false),
        ];

        renderRowViewComparison(content, columns, [
            ['<script>alert(1)</script>', null],
            ['<script>alert(1)</script>', ''],
        ]);

        expect(content.querySelectorAll('.row-view-section')).toHaveLength(2);
        expect(content.querySelectorAll('img, script')).toHaveLength(0);
        expect(content.querySelector('.row-view-key-name')?.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(content.querySelectorAll('.row-view-section.diff')).toHaveLength(1);
        expect(content.textContent).toContain('<script>alert(1)</script>');
        expect(content.querySelector('.row-view-val.null')?.textContent).toBe('NULL');
    });

    it('does not mark equal Date values as different and preserves false boolean display', () => {
        const content = document.createElement('div');
        renderRowViewComparison(
            content,
            [column('0', 'CREATED', 'TIMESTAMP'), column('1', 'ENABLED', 'BOOLEAN')],
            [[new Date('2026-01-01T00:00:00Z'), false], [new Date('2026-01-01T00:00:00Z'), false]],
        );

        expect(content.querySelectorAll('.row-view-section.diff')).toHaveLength(0);
        expect(content.querySelectorAll('.boolean-f')).toHaveLength(2);
        expect(content.textContent).toContain('✕ false');
    });
});

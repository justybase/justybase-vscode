import {
    compareObjectTypesByPriority,
    compareSearchResultsByObjectPriority,
    getObjectTypeCategory,
    getObjectTypeSortPriority
} from '../../metadata/objectTypeSortPriority';

describe('objectTypeSortPriority', () => {
    it('assigns table, view, column, then other priorities', () => {
        expect(getObjectTypeSortPriority('TABLE')).toBe(1);
        expect(getObjectTypeSortPriority('EXTERNAL TABLE')).toBe(1);
        expect(getObjectTypeSortPriority('VIEW')).toBe(2);
        expect(getObjectTypeSortPriority('COLUMN')).toBe(3);
        expect(getObjectTypeSortPriority('PROCEDURE')).toBe(4);
        expect(getObjectTypeSortPriority('SYNONYM')).toBe(4);
    });

    it('classifies table-like and view-like object types', () => {
        expect(getObjectTypeCategory('TABLE')).toBe('table');
        expect(getObjectTypeCategory('EXTERNAL TABLE')).toBe('table');
        expect(getObjectTypeCategory('VIEW')).toBe('view');
        expect(getObjectTypeCategory('MATERIALIZED VIEW')).toBe('view');
        expect(getObjectTypeCategory('COLUMN')).toBe('column');
        expect(getObjectTypeCategory('FUNCTION')).toBe('other');
    });

    it('orders groups as tables, views, columns, then the rest', () => {
        expect(compareObjectTypesByPriority('TABLE', 'VIEW')).toBeLessThan(0);
        expect(compareObjectTypesByPriority('VIEW', 'COLUMN')).toBeLessThan(0);
        expect(compareObjectTypesByPriority('COLUMN', 'PROCEDURE')).toBeLessThan(0);
        expect(compareObjectTypesByPriority('PROCEDURE', 'SYNONYM')).toBe(compareObjectTypesByPriority('SYNONYM', 'PROCEDURE') * -1);
    });

    it('sorts search results by object priority before database and name', () => {
        const results = [
            { TYPE: 'COLUMN', DATABASE: 'DB1', NAME: 'A_COL' },
            { TYPE: 'TABLE', DATABASE: 'DB2', NAME: 'Z_TAB' },
            { TYPE: 'VIEW', DATABASE: 'DB1', NAME: 'B_VIEW' },
            { TYPE: 'PROCEDURE', DATABASE: 'DB1', NAME: 'C_PROC' }
        ];

        const sorted = [...results].sort(compareSearchResultsByObjectPriority);

        expect(sorted.map(item => item.TYPE)).toEqual(['TABLE', 'VIEW', 'COLUMN', 'PROCEDURE']);
    });
});

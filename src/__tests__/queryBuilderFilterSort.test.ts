import {
    buildGridGroupByClause,
    buildGridHavingClause,
    buildGridOrderByClause,
    buildGridSelectClause,
    buildGridSqlParts,
    buildGridWhereClause,
    moveGridColumn,
    normalizeGridColumn,
    normalizeGridCriteria,
    type GridSourceTable,
    type QueryGridColumn,
} from '../../media/visualQueryBuilder/filterSort';

const SOURCES: GridSourceTable[] = [
    { instanceId: 'T1', alias: 'T1' },
    { instanceId: 'T2', alias: 'ORD' },
];

function column(overrides: Partial<QueryGridColumn>): QueryGridColumn {
    return {
        id: 'F1',
        tableInstanceId: '',
        columnName: '',
        show: true,
        aggregate: 'NONE',
        sort: 'NONE',
        criteriaRows: ['', '', ''],
        ...overrides,
    };
}

describe('normalizeGridCriteria', () => {
    it('treats blank cells as empty', () => {
        expect(normalizeGridCriteria('')).toBe('');
        expect(normalizeGridCriteria('   ')).toBe('');
    });

    it('implicitly prepends "=" to literal expressions like Access', () => {
        expect(normalizeGridCriteria("'ACTIVE'")).toBe("= 'ACTIVE'");
        expect(normalizeGridCriteria('100')).toBe('= 100');
        expect(normalizeGridCriteria('CURRENT_DATE')).toBe('= CURRENT_DATE');
    });

    it('preserves expressions that already start with a comparison operator', () => {
        expect(normalizeGridCriteria('> 100')).toBe('> 100');
        expect(normalizeGridCriteria('<> 5')).toBe('<> 5');
        expect(normalizeGridCriteria('>= 10')).toBe('>= 10');
        expect(normalizeGridCriteria('!= 0')).toBe('!= 0');
        expect(normalizeGridCriteria('LIKE A%')).toBe('LIKE A%');
        expect(normalizeGridCriteria('IS NOT NULL')).toBe('IS NOT NULL');
        expect(normalizeGridCriteria('IN (1, 2)')).toBe('IN (1, 2)');
        expect(normalizeGridCriteria('BETWEEN 1 AND 5')).toBe('BETWEEN 1 AND 5');
        expect(normalizeGridCriteria('NOT IN (SELECT 1)')).toBe('NOT IN (SELECT 1)');
    });
});

describe('buildGridWhereClause', () => {
    it('returns empty when there are no columns', () => {
        expect(buildGridWhereClause([], SOURCES)).toBe('');
    });

    it('returns empty when the column has no field or no source', () => {
        expect(buildGridWhereClause([column({ criteriaRows: ["'x'", '', ''] })], SOURCES)).toBe('');
        expect(buildGridWhereClause([
            column({ tableInstanceId: 'missing', columnName: 'X', criteriaRows: ['= 1', '', ''] }),
        ], SOURCES)).toBe('');
    });

    it('ignores empty criteria cells', () => {
        expect(buildGridWhereClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ['', '', ''] }),
        ], SOURCES)).toBe('');
    });

    it('builds a single predicate with Access-style implicit "="', () => {
        const result = buildGridWhereClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["'ACTIVE'", '', ''] }),
        ], SOURCES);
        expect(result).toBe("T1.STATUS = 'ACTIVE'");
    });

    it('ANDs predicates across fields on the same row', () => {
        const result = buildGridWhereClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["'ACTIVE'", '', ''] }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'AMOUNT', criteriaRows: ['> 100', '', ''] }),
        ], SOURCES);
        expect(result).toBe("T1.STATUS = 'ACTIVE' AND T1.AMOUNT > 100");
    });

    it('ORs the criteria row against the Or rows of the same field', () => {
        const result = buildGridWhereClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["= 'ACTIVE'", '', "= 'PENDING'"] }),
        ], SOURCES);
        expect(result).toBe("(T1.STATUS = 'ACTIVE') OR (T1.STATUS = 'PENDING')");
    });

    it('groups rows across fields as (row0 AND row0) OR (row1 AND row1)', () => {
        const result = buildGridWhereClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'A', criteriaRows: ['= 1', '', '= 3'] }),
            column({ id: 'F2', tableInstanceId: 'T2', columnName: 'B', criteriaRows: ['= 2', '', ''] }),
        ], SOURCES);
        expect(result).toBe('(T1.A = 1 AND ORD.B = 2) OR (T1.A = 3)');
    });

    it('quotes identifiers that are not plain uppercase names', () => {
        const result = buildGridWhereClause([
            column({ tableInstanceId: 'T2', columnName: 'order-date', criteriaRows: ['= 1', '', ''] }),
        ], SOURCES);
        expect(result).toBe('ORD."order-date" = 1');
    });

    it('quotes non-simple aliases', () => {
        const result = buildGridWhereClause([
            column({ tableInstanceId: 'T1', columnName: 'X', criteriaRows: ['= 1', '', ''] }),
        ], [{ instanceId: 'T1', alias: 'weird-alias' }]);
        expect(result).toBe('"weird-alias".X = 1');
    });
});

describe('buildGridOrderByClause', () => {
    it('returns empty when nothing is sorted', () => {
        expect(buildGridOrderByClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', sort: 'NONE' }),
            column({ tableInstanceId: 'T1', columnName: 'X' }),
        ], SOURCES)).toBe('');
    });

    it('lists sorted fields in grid order', () => {
        const result = buildGridOrderByClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'NAME', sort: 'ASC' }),
            column({ id: 'F2', tableInstanceId: 'T2', columnName: 'DATE', sort: 'DESC' }),
            column({ id: 'F3', tableInstanceId: 'T1', columnName: 'IGNORED', sort: 'NONE' }),
        ], SOURCES);
        expect(result).toBe('T1.NAME ASC, ORD.DATE DESC');
    });

    it('skips sorted fields that lost their source or column', () => {
        const result = buildGridOrderByClause([
            column({ tableInstanceId: 'missing', columnName: 'A', sort: 'ASC' }),
            column({ tableInstanceId: 'T1', columnName: '', sort: 'ASC' }),
        ], SOURCES);
        expect(result).toBe('');
    });

    it('quotes identifiers in sort expressions', () => {
        const result = buildGridOrderByClause([
            column({ tableInstanceId: 'T2', columnName: 'order-date', sort: 'ASC' }),
        ], SOURCES);
        expect(result).toBe('ORD."order-date" ASC');
    });

    it('sorts aggregated fields by their aggregate call', () => {
        const result = buildGridOrderByClause([
            column({ tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'SUM', sort: 'DESC' }),
            column({ tableInstanceId: 'T2', columnName: 'NAME', aggregate: 'GROUP BY', sort: 'ASC' }),
        ], SOURCES);
        expect(result).toBe('SUM(T1.AMOUNT) DESC, ORD.NAME ASC');
    });

    it('skips Where-only fields in ordering', () => {
        const result = buildGridOrderByClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', aggregate: 'WHERE', sort: 'ASC' }),
        ], SOURCES);
        expect(result).toBe('');
    });
});

describe('buildGridSelectClause', () => {
    it('returns empty when no columns are shown', () => {
        expect(buildGridSelectClause([], SOURCES)).toBe('');
        expect(buildGridSelectClause([
            column({ tableInstanceId: 'T1', columnName: 'X', show: false }),
        ], SOURCES)).toBe('');
    });

    it('lists plain shown fields in grid order', () => {
        const result = buildGridSelectClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'NAME' }),
            column({ id: 'F2', tableInstanceId: 'T2', columnName: 'DATE' }),
        ], SOURCES);
        expect(result).toBe('T1.NAME,\n    ORD.DATE');
    });

    it('wraps aggregate functions around the qualified field', () => {
        const result = buildGridSelectClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'SUM' }),
            column({ id: 'F2', tableInstanceId: 'T2', columnName: 'STATUS', aggregate: 'GROUP BY' }),
        ], SOURCES);
        expect(result).toBe('SUM(T1.AMOUNT),\n    ORD.STATUS');
    });

    it('emits COUNT DISTINCT with the DISTINCT syntax', () => {
        const result = buildGridSelectClause([
            column({ tableInstanceId: 'T2', columnName: 'REGION', aggregate: 'COUNT DISTINCT' }),
        ], SOURCES);
        expect(result).toBe('COUNT(DISTINCT ORD.REGION)');
    });

    it('skips Where columns and raw-embeds Expression columns', () => {
        const result = buildGridSelectClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'WHERE' }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'AMOUNT * 1.23', aggregate: 'EXPRESSION' }),
        ], SOURCES);
        expect(result).toBe('AMOUNT * 1.23');
    });
});

describe('buildGridGroupByClause', () => {
    it('returns empty when the grid has no aggregates', () => {
        expect(buildGridGroupByClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS' }),
        ], SOURCES)).toBe('');
    });

    it('implicitly groups plain shown fields when an aggregate exists', () => {
        const result = buildGridGroupByClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'STATUS' }),
            column({ id: 'F2', tableInstanceId: 'T2', columnName: 'AMOUNT', aggregate: 'SUM' }),
        ], SOURCES);
        expect(result).toBe('T1.STATUS');
    });

    it('always groups explicit Group By fields even without aggregates', () => {
        const result = buildGridGroupByClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', aggregate: 'GROUP BY' }),
            column({ tableInstanceId: 'T2', columnName: 'NAME' }),
        ], SOURCES);
        expect(result).toBe('T1.STATUS');
    });

    it('skips hidden plain fields and Where fields', () => {
        const result = buildGridGroupByClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'HIDDEN', show: false }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'FILTER', aggregate: 'WHERE' }),
            column({ id: 'F3', tableInstanceId: 'T2', columnName: 'AMOUNT', aggregate: 'SUM' }),
        ], SOURCES);
        expect(result).toBe('');
    });

    it('keeps grid column order for grouping priority', () => {
        const result = buildGridGroupByClause([
            column({ id: 'F1', tableInstanceId: 'T2', columnName: 'DATE' }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'STATUS' }),
            column({ id: 'F3', tableInstanceId: 'T2', columnName: 'AMOUNT', aggregate: 'SUM' }),
        ], SOURCES);
        expect(result).toBe('ORD.DATE, T1.STATUS');
    });
});

describe('buildGridHavingClause', () => {
    it('returns empty when nothing is aggregated', () => {
        expect(buildGridHavingClause([
            column({ tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["= 'ACTIVE'", '', ''] }),
        ], SOURCES)).toBe('');
    });

    it('builds HAVING predicates from criteria on aggregated fields', () => {
        const result = buildGridHavingClause([
            column({ tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'SUM', criteriaRows: ['> 100', '', ''] }),
        ], SOURCES);
        expect(result).toBe('SUM(T1.AMOUNT) > 100');
    });

    it('ORs having rows like the criteria grid', () => {
        const result = buildGridHavingClause([
            column({ tableInstanceId: 'T2', columnName: 'TOTAL', aggregate: 'COUNT', criteriaRows: ['>= 5', '', '< 2'] }),
        ], SOURCES);
        expect(result).toBe('(COUNT(ORD.TOTAL) >= 5) OR (COUNT(ORD.TOTAL) < 2)');
    });

    it('uses the raw expression for Expression fields', () => {
        const result = buildGridHavingClause([
            column({ tableInstanceId: 'T1', columnName: 'SUM(AMOUNT) * 1.1', aggregate: 'EXPRESSION', criteriaRows: ['> 200', '', ''] }),
        ], SOURCES);
        expect(result).toBe('SUM(AMOUNT) * 1.1 > 200');
    });

    it('splits WHERE and HAVING by aggregation state', () => {
        const where = buildGridWhereClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["= 'ACTIVE'", '', ''] }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'SUM', criteriaRows: ['> 100', '', ''] }),
        ], SOURCES);
        const having = buildGridHavingClause([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["= 'ACTIVE'", '', ''] }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'SUM', criteriaRows: ['> 100', '', ''] }),
        ], SOURCES);
        expect(where).toBe("T1.STATUS = 'ACTIVE'");
        expect(having).toBe('SUM(T1.AMOUNT) > 100');
    });
});

describe('moveGridColumn', () => {
    const columns = [
        column({ id: 'F1', tableInstanceId: 'T1', columnName: 'A' }),
        column({ id: 'F2', tableInstanceId: 'T1', columnName: 'B' }),
        column({ id: 'F3', tableInstanceId: 'T1', columnName: 'C' }),
    ];

    it('moves a column up', () => {
        expect(moveGridColumn(columns, 'F2', -1).map(c => c.id)).toEqual(['F2', 'F1', 'F3']);
    });

    it('moves a column down', () => {
        expect(moveGridColumn(columns, 'F1', 1).map(c => c.id)).toEqual(['F2', 'F1', 'F3']);
    });

    it('ignores out-of-bounds moves', () => {
        expect(moveGridColumn(columns, 'F1', -1).map(c => c.id)).toEqual(['F1', 'F2', 'F3']);
        expect(moveGridColumn(columns, 'F3', 1).map(c => c.id)).toEqual(['F1', 'F2', 'F3']);
    });

    it('ignores unknown column ids', () => {
        expect(moveGridColumn(columns, 'F99', -1).map(c => c.id)).toEqual(['F1', 'F2', 'F3']);
    });

    it('does not mutate the input array', () => {
        moveGridColumn(columns, 'F1', 1);
        expect(columns.map(c => c.id)).toEqual(['F1', 'F2', 'F3']);
    });
});

describe('normalizeGridColumn', () => {
    it('fills defaults for legacy snapshots without Show/Total', () => {
        const normalized = normalizeGridColumn({
            id: 'F1',
            tableInstanceId: 'T1',
            columnName: 'STATUS',
            criteriaRows: ["= 'ACTIVE'", '', ''],
        });
        expect(normalized.show).toBe(true);
        expect(normalized.aggregate).toBe('NONE');
        expect(normalized.sort).toBe('NONE');
    });

    it('pads short criteria row arrays', () => {
        const normalized = normalizeGridColumn({ id: 'F1', criteriaRows: ['= 1'] });
        expect(normalized.criteriaRows).toEqual(['= 1', '', '']);
    });
});

describe('buildGridSqlParts', () => {
    it('assembles every clause in one pass', () => {
        const parts = buildGridSqlParts([
            column({ id: 'F1', tableInstanceId: 'T1', columnName: 'STATUS', criteriaRows: ["= 'ACTIVE'", '', ''] }),
            column({ id: 'F2', tableInstanceId: 'T1', columnName: 'AMOUNT', aggregate: 'SUM', sort: 'DESC', criteriaRows: ['> 100', '', ''] }),
        ], SOURCES);
        expect(parts).toEqual({
            select: 'T1.STATUS,\n    SUM(T1.AMOUNT)',
            where: "T1.STATUS = 'ACTIVE'",
            groupBy: 'T1.STATUS',
            having: 'SUM(T1.AMOUNT) > 100',
            orderBy: 'SUM(T1.AMOUNT) DESC',
        });
    });
});

describe('expression fields without a selected source', () => {
    it('embeds the raw expression in the SELECT list', () => {
        expect(buildGridSelectClause([
            column({ tableInstanceId: '', columnName: 'AMOUNT * 1.23', aggregate: 'EXPRESSION' }),
        ], SOURCES)).toBe('AMOUNT * 1.23');
    });

    it('builds HAVING predicates from the raw expression', () => {
        expect(buildGridHavingClause([
            column({ tableInstanceId: '', columnName: 'SUM(AMOUNT) * 1.1', aggregate: 'EXPRESSION', criteriaRows: ['> 200', '', ''] }),
        ], SOURCES)).toBe('SUM(AMOUNT) * 1.1 > 200');
    });

    it('sorts by the raw expression', () => {
        expect(buildGridOrderByClause([
            column({ tableInstanceId: '', columnName: 'UPPER(NAME)', aggregate: 'EXPRESSION', sort: 'ASC' }),
        ], SOURCES)).toBe('UPPER(NAME) ASC');
    });

    it('keeps source-less expression criteria out of WHERE (they belong to HAVING)', () => {
        expect(buildGridWhereClause([
            column({ tableInstanceId: '', columnName: 'X', aggregate: 'EXPRESSION', criteriaRows: ['= 1', '', ''] }),
        ], SOURCES)).toBe('');
    });

    it('still requires a source for aggregate functions', () => {
        expect(buildGridSelectClause([
            column({ tableInstanceId: '', columnName: 'AMOUNT', aggregate: 'SUM' }),
        ], SOURCES)).toBe('');
        expect(buildGridHavingClause([
            column({ tableInstanceId: '', columnName: 'AMOUNT', aggregate: 'SUM', criteriaRows: ['> 1', '', ''] }),
        ], SOURCES)).toBe('');
    });
});

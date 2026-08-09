import {
    buildExploreWhereSql,
    wrapSourceSqlWithFilters,
    exploreFiltersAreEmpty,
    escapeSqlLiteral,
    formatNumberLiteral,
} from '../../../src/results/explore/exploreFilters';

const COLUMNS = [
    { name: 'REGION', type: 'VARCHAR(20)' },
    { name: 'AMOUNT', type: 'DECIMAL(10,2)' },
    { name: 'ORDER_DATE', type: 'DATE' },
];

describe('exploreFilters (host)', () => {
    it('returns empty WHERE for empty filters', () => {
        expect(buildExploreWhereSql(undefined, COLUMNS)).toBe('');
        expect(buildExploreWhereSql({ dimensions: [], dates: [], measures: [] }, COLUMNS)).toBe('');
        expect(exploreFiltersAreEmpty({ dimensions: [], dates: [], measures: [] })).toBe(true);
    });

    it('builds IN lists for dimension filters', () => {
        const sql = buildExploreWhereSql({
            dimensions: [{ columnIndex: 0, values: ['EU', 'US'] }],
            dates: [],
            measures: [],
        }, COLUMNS);
        expect(sql).toBe('t."REGION" IN (\'EU\', \'US\')');
    });

    it('uses equality for single dimension value and escapes quotes', () => {
        const sql = buildExploreWhereSql({
            dimensions: [{ columnIndex: 0, values: ["O'Brien"] }],
            dates: [],
            measures: [],
        }, COLUMNS);
        expect(sql).toBe('t."REGION" = \'O\'\'Brien\'');
    });

    it('builds range predicates for dates', () => {
        const sql = buildExploreWhereSql({
            dimensions: [],
            dates: [{ columnIndex: 2, grain: 'month', from: '2024-01-01', to: '2024-12-31' }],
            measures: [],
        }, COLUMNS);
        expect(sql).toBe('t."ORDER_DATE" >= \'2024-01-01\'\nAND t."ORDER_DATE" <= \'2024-12-31\'');
    });

    it('builds range predicates for measures', () => {
        const sql = buildExploreWhereSql({
            dimensions: [],
            dates: [],
            measures: [{ columnIndex: 1, min: 10, max: 100.5 }],
        }, COLUMNS);
        expect(sql).toBe('t."AMOUNT" >= 10\nAND t."AMOUNT" <= 100.5');
    });

    it('skips invalid column indexes', () => {
        const sql = buildExploreWhereSql({
            dimensions: [{ columnIndex: 99, values: ['X'] }],
            dates: [],
            measures: [],
        }, COLUMNS);
        expect(sql).toBe('');
    });

    it('wraps the source SQL in a derived table with WHERE', () => {
        const wrapped = wrapSourceSqlWithFilters('SELECT * FROM SALES LIMIT 100;', {
            dimensions: [{ columnIndex: 0, values: ['EU'] }],
            dates: [],
            measures: [],
        }, COLUMNS);
        expect(wrapped.sql).toBe([
            'FROM (',
            'SELECT * FROM SALES LIMIT 100',
            ') t',
            'WHERE t."REGION" = \'EU\'',
        ].join('\n'));
    });

    it('escapes literals', () => {
        expect(escapeSqlLiteral("a'b")).toBe("'a''b'");
        expect(formatNumberLiteral(5)).toBe('5');
        expect(formatNumberLiteral(5.25)).toBe('5.25');
    });
});

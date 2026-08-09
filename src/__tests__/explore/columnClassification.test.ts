import {
    classifyColumnRole,
    classifyColumns,
    isLikelyDimensionName,
    isNumericType,
    isTemporalType,
    parseNumericValue,
} from '../../../media/resultPanel/explore/columnClassification.js';

describe('explore columnClassification', () => {
    describe('type detection', () => {
        it('recognizes numeric types across dialects', () => {
            expect(isNumericType('INTEGER')).toBe(true);
            expect(isNumericType('decimal(10,2)')).toBe(true);
            expect(isNumericType('DOUBLE PRECISION')).toBe(true);
            expect(isNumericType('BIGINT')).toBe(true);
            expect(isNumericType('VARCHAR')).toBe(false);
            expect(isNumericType(undefined)).toBe(false);
        });

        it('recognizes temporal types', () => {
            expect(isTemporalType('DATE')).toBe(true);
            expect(isTemporalType('TIMESTAMP')).toBe(true);
            expect(isTemporalType('timestamp with time zone')).toBe(true);
            expect(isTemporalType('DATETIME2')).toBe(true);
            expect(isTemporalType('INT')).toBe(false);
        });
    });

    describe('name heuristics', () => {
        it('detects identifier-like names', () => {
            expect(isLikelyDimensionName('CUSTOMER_ID')).toBe(true);
            expect(isLikelyDimensionName('order_code')).toBe(true);
            expect(isLikelyDimensionName('STATUS_TYPE')).toBe(true);
            expect(isLikelyDimensionName('IS_ACTIVE')).toBe(true);
            expect(isLikelyDimensionName('COUNTRY')).toBe(false);
        });
    });

    describe('parseNumericValue', () => {
        it('parses numbers, numeric strings and bigint', () => {
            expect(parseNumericValue(42)).toBe(42);
            expect(parseNumericValue('1,234.5')).toBe(1234.5);
            expect(parseNumericValue(BigInt(7))).toBe(7);
            expect(parseNumericValue('12.5%')).toBeNull();
            expect(parseNumericValue('abc')).toBeNull();
            expect(parseNumericValue(null)).toBeNull();
            expect(parseNumericValue('')).toBeNull();
        });
    });

    describe('classifyColumnRole', () => {
        it('classifies date columns as date', () => {
            expect(classifyColumnRole('ORDER_DATE', 'TIMESTAMP', ['2024-01-01'])).toBe('date');
        });

        it('classifies booleans as dimension', () => {
            expect(classifyColumnRole('IS_ACTIVE', 'BOOLEAN', [true, false])).toBe('dimension');
        });

        it('classifies plain numeric columns as measure', () => {
            expect(classifyColumnRole('AMOUNT', 'DECIMAL(10,2)', [1, 2, 3])).toBe('measure');
            expect(classifyColumnRole('SALARY', 'INT', [100, 200])).toBe('measure');
        });

        it('classifies numeric identifier columns as dimension', () => {
            expect(classifyColumnRole('CUSTOMER_ID', 'INT', [1, 2, 3])).toBe('dimension');
            expect(classifyColumnRole('ACCOUNT_KEY', 'BIGINT', [10, 20])).toBe('dimension');
        });

        it('classifies low-cardinality text as dimension', () => {
            const values = ['A', 'B', 'C', 'A', 'B'];
            expect(classifyColumnRole('REGION', 'VARCHAR(50)', values)).toBe('dimension');
        });

        it('classifies high-cardinality text with numeric-like values as measure', () => {
            const values = Array.from({ length: 100 }, (_, i) => String(i * 1.5));
            expect(classifyColumnRole('VALUE', 'VARCHAR(50)', values)).toBe('measure');
        });

        it('falls back to dimension for text', () => {
            const values = Array.from({ length: 100 }, (_, i) => `value-${i}`);
            expect(classifyColumnRole('DESCRIPTION', 'VARCHAR(200)', values)).toBe('dimension');
        });
    });

    describe('classifyColumns', () => {
        it('classifies all columns of a result set', () => {
            const columns = [
                { name: 'ID', type: 'INT' },
                { name: 'AMOUNT', type: 'DECIMAL(10,2)' },
                { name: 'CREATED_AT', type: 'TIMESTAMP' },
                { name: 'STATUS', type: 'VARCHAR(20)' },
            ];
            const rows = [
                [1, 10.5, '2024-01-01', 'open'],
                [2, 20.25, '2024-01-02', 'closed'],
                [3, 30.0, '2024-01-03', 'open'],
            ];
            expect(classifyColumns(columns, rows)).toEqual([
                'dimension',
                'measure',
                'date',
                'dimension',
            ]);
        });
    });
});

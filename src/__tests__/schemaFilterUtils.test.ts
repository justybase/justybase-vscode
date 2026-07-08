import {
    buildSchemaFilterRegex,
    columnMatchesSchemaFilter,
    columnVisibleInSchemaFilter,
    matchesSchemaFilter,
    tableMatchesSchemaFilter,
} from '../providers/schemaFilterUtils';
import type { ColumnMetadata } from '../metadata/types';

describe('schemaFilterUtils', () => {
    describe('buildSchemaFilterRegex', () => {
        it('converts glob wildcards to regex', () => {
            const regex = buildSchemaFilterRegex('*sales*');
            expect(regex?.test('FACT_SALES')).toBe(true);
            expect(regex?.test('OTHER')).toBe(false);
        });

        it('returns undefined for empty filter', () => {
            expect(buildSchemaFilterRegex('')).toBeUndefined();
            expect(buildSchemaFilterRegex('   ')).toBeUndefined();
        });
    });

    describe('tableMatchesSchemaFilter', () => {
        const regex = buildSchemaFilterRegex('account');

        it('matches table name', () => {
            expect(
                tableMatchesSchemaFilter({
                    regex,
                    tableName: 'DIMACCOUNT',
                }),
            ).toBe(true);
        });

        it('matches table description', () => {
            expect(
                tableMatchesSchemaFilter({
                    regex,
                    tableName: 'DIM_X',
                    tableDescription: 'Account dimension table',
                }),
            ).toBe(true);
        });

        it('matches cached column comment', () => {
            const columns: ColumnMetadata[] = [
                {
                    ATTNAME: 'ID',
                    label: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    documentation: 'Surrogate account key',
                },
            ];
            expect(
                tableMatchesSchemaFilter({
                    regex,
                    tableName: 'DIM_X',
                    columns,
                }),
            ).toBe(true);
        });

        it('does not match unrelated table without cached columns', () => {
            expect(
                tableMatchesSchemaFilter({
                    regex,
                    tableName: 'DIM_PRODUCT',
                }),
            ).toBe(false);
        });
    });

    describe('columnVisibleInSchemaFilter', () => {
        const regex = buildSchemaFilterRegex('billing');

        const column: ColumnMetadata = {
            ATTNAME: 'AMOUNT',
            label: 'AMOUNT',
            FORMAT_TYPE: 'NUMERIC',
            documentation: 'Monthly billing total',
        };

        it('shows all columns when table name matches filter', () => {
            expect(
                columnVisibleInSchemaFilter({
                    regex,
                    tableName: 'BILLING_FACT',
                    column,
                }),
            ).toBe(true);
        });

        it('shows column when only column comment matches', () => {
            expect(
                columnVisibleInSchemaFilter({
                    regex,
                    tableName: 'FACT_X',
                    column,
                }),
            ).toBe(true);
        });

        it('hides column when nothing matches', () => {
            expect(
                columnVisibleInSchemaFilter({
                    regex,
                    tableName: 'FACT_X',
                    column: {
                        ATTNAME: 'ID',
                        label: 'ID',
                        FORMAT_TYPE: 'INTEGER',
                    },
                }),
            ).toBe(false);
        });
    });

    describe('columnMatchesSchemaFilter', () => {
        it('matches column name and data type', () => {
            const regex = buildSchemaFilterRegex('bigint');
            expect(
                columnMatchesSchemaFilter(regex, {
                    ATTNAME: 'ACCOUNTKEY',
                    label: 'ACCOUNTKEY',
                    FORMAT_TYPE: 'BIGINT',
                }),
            ).toBe(true);
        });

        it('matches DESCRIPTION field fallback', () => {
            const regex = buildSchemaFilterRegex('primary');
            expect(
                columnMatchesSchemaFilter(regex, {
                    ATTNAME: 'ID',
                    label: 'ID',
                    FORMAT_TYPE: 'INTEGER',
                    DESCRIPTION: 'Primary identifier',
                }),
            ).toBe(true);
        });
    });

    describe('matchesSchemaFilter', () => {
        it('returns true when regex is undefined', () => {
            expect(matchesSchemaFilter(undefined, 'anything')).toBe(true);
        });
    });
});

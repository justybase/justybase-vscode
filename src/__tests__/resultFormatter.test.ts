import { describe, expect, it } from '@jest/globals';
import { ResultFormatter } from '../core/streaming/ResultFormatter';

describe('ResultFormatter', () => {
    it('extracts unicode text metadata from the driver metadata contract', () => {
        const reader = {
            fieldCount: 4,
            getName: (index: number) => ['TEXT_COL', 'UNICODE_COL', 'NCHAR_COL', 'OTHER_COL'][index],
            getTypeName: (index: number) => ['VARCHAR', 'NVARCHAR', 'NCHAR', 'INT4'][index],
            getDeclaredTypeName: (index: number) => ['VARCHAR(25)', 'NVARCHAR(25)', 'NCHAR(12)', 'INT4'][index]
        };

        expect(ResultFormatter.extractColumns(reader)).toEqual([
            { name: 'TEXT_COL', type: 'VARCHAR(25)' },
            { name: 'UNICODE_COL', type: 'NVARCHAR(25)' },
            { name: 'NCHAR_COL', type: 'NCHAR(12)' },
            { name: 'OTHER_COL', type: 'INT4' }
        ]);
    });

    it('falls back to schema ProviderType metadata when raw driver type names are misleading', () => {
        const reader = {
            fieldCount: 3,
            getName: (index: number) => ['NVARCHAR_COL', 'NCHAR_COL', 'DATE_COL'][index],
            getTypeName: (index: number) => ['DATE', 'UNKNOWN(2522)', 'DATE'][index],
            getSchemaTable: () => [
                { ProviderType: 2530, ColumnSize: 32 },
                { ProviderType: 2522, ColumnSize: 8 },
                { ProviderType: 1082, ColumnSize: 8 }
            ]
        };

        expect(ResultFormatter.extractColumns(reader)).toEqual([
            { name: 'NVARCHAR_COL', type: 'NVARCHAR(32)' },
            { name: 'NCHAR_COL', type: 'NCHAR(8)' },
            { name: 'DATE_COL', type: 'DATE' }
        ]);
    });

    it('normalizes national character aliases without collapsing them to varchar', () => {
        expect(ResultFormatter.normalizeResultColumnType('national character varying(32)')).toBe('NVARCHAR(32)');
        expect(ResultFormatter.normalizeResultColumnType('national character(8)')).toBe('NCHAR(8)');
        expect(ResultFormatter.normalizeResultColumnType('varchar(32)')).toBe('VARCHAR(32)');
    });
});

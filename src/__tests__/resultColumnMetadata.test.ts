import { describe, expect, it } from '@jest/globals';
import {
    getEffectiveResultColumnType,
    getResultReaderNumericScale,
    getResultReaderColumnSize,
    normalizeResultColumnType,
    getResultReaderSchemaRow
} from '../core/streaming/resultColumnMetadata';

describe('resultColumnMetadata', () => {
    // =========================================================================
    // Type detection (declared type path)
    // =========================================================================

    it('prefers declared type metadata exposed by newer drivers', () => {
        const reader = {
            getTypeName: (index: number) => ['VARCHAR', 'NVARCHAR', 'NUMERIC'][index],
            getDeclaredTypeName: (index: number) => ['VARCHAR(25)', 'NATIONAL CHARACTER VARYING(32)', 'NUMERIC(18,4)'][index],
            getTypeLength: (index: number) => [25, 32, 0][index],
            getSchemaTable: () => [
                { NumericScale: 0 },
                { NumericScale: 0 },
                { NumericScale: 4 }
            ]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('VARCHAR(25)');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('NVARCHAR(32)');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('NUMERIC(18,4)');
        expect(getResultReaderNumericScale(reader, 2)).toBe(4);
    });

    // =========================================================================
    // Type detection (no declared type — fallback to getTypeName + length)
    // =========================================================================

    it('uses canonical driver type names together with reported lengths when declared types are absent', () => {
        const reader = {
            getTypeName: (index: number) => ['VARCHAR', 'NVARCHAR', 'NCHAR', 'DATE'][index],
            getTypeLength: (index: number) => [20, 40, 8, 0][index],
            getSchemaTable: () => [
                { ColumnSize: 20 },
                { ColumnSize: 40 },
                { ColumnSize: 8 },
                { ColumnSize: 0 }
            ]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('VARCHAR(20)');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('NVARCHAR(40)');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('NCHAR(8)');
        expect(getEffectiveResultColumnType(reader, 3)).toBe('DATE');
    });

    // =========================================================================
    // Type detection (column metadata object fallback)
    // =========================================================================

    it('prefers column metadata objects exposed by newer drivers', () => {
        const reader = {
            getTypeName: (index: number) => ['DATE', 'UNKNOWN(2522)', 'TIMESTAMPTZ'][index],
            getColumnMetadata: (index: number) => [
                { typeName: 'NVARCHAR', declaredTypeName: 'NVARCHAR(32)', declaredLength: 32, columnSize: 32 },
                { typeName: 'NCHAR', declaredTypeName: 'NCHAR(8)', declaredLength: 8, columnSize: 8 },
                { typeName: 'TIMESTAMPTZ', declaredTypeName: 'TIMESTAMPTZ', columnSize: 8 }
            ][index]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('NVARCHAR(32)');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('NCHAR(8)');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('TIMESTAMPTZ');
    });

    // =========================================================================
    // Type detection (raw type name normalization)
    // =========================================================================

    it('falls back to normalized raw metadata for non-Netezza unicode provider types', () => {
        const reader = {
            getTypeName: (index: number) => ['date', 'timestamp with time zone', 'numeric(18,4)'][index],
            getSchemaTable: () => [
                { ProviderType: 1082, NumericScale: 0 },
                { ProviderType: 1184, NumericScale: 0 },
                { ProviderType: 1700, NumericScale: 4 }
            ]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('DATE');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('TIMESTAMP WITH TIME ZONE');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('NUMERIC(18,4)');
        expect(getResultReaderNumericScale(reader, 2)).toBe(4);
    });

    // =========================================================================
    // NATIONAL CHARACTER normalization
    // =========================================================================

    it('normalizes national character aliases without changing other text types', () => {
        expect(normalizeResultColumnType('national character varying(32)')).toBe('NVARCHAR(32)');
        expect(normalizeResultColumnType('national character(8)')).toBe('NCHAR(8)');
        expect(normalizeResultColumnType('varchar(32)')).toBe('VARCHAR(32)');
    });

    it('normalizes NATIONAL CHARACTER VARYING with mixed case', () => {
        expect(normalizeResultColumnType('National Character Varying(64)')).toBe('NVARCHAR(64)');
        expect(normalizeResultColumnType('NATIONAL CHARACTER(16)')).toBe('NCHAR(16)');
    });

    it('normalizes NVARCHAR without length to bare NVARCHAR', () => {
        expect(normalizeResultColumnType('NVARCHAR')).toBe('NVARCHAR');
        expect(normalizeResultColumnType('nchar')).toBe('NCHAR');
    });

    it('returns undefined for empty or undefined input', () => {
        expect(normalizeResultColumnType(undefined)).toBeUndefined();
        expect(normalizeResultColumnType('')).toBeUndefined();
        expect(normalizeResultColumnType('  ')).toBeUndefined();
    });

    it('normalizes extra whitespace in type names', () => {
        // Multiple spaces should be collapsed
        expect(normalizeResultColumnType('national  character  varying(32)')).toBe('NVARCHAR(32)');
    });

    // =========================================================================
    // NVARCHAR / NCHAR specific edge cases
    // =========================================================================

    it('handles NVARCHAR(32) via getTypeName + getSchemaTable ColumnSize (driver 2.0.0 path)', () => {
        const reader = {
            getTypeName: (_index: number) => 'NVARCHAR',
            getSchemaTable: () => [{ ColumnSize: 32, NumericScale: 0 }]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('NVARCHAR(32)');
    });

    it('handles NCHAR(8) via getTypeName + getSchemaTable ColumnSize', () => {
        const reader = {
            getTypeName: (_index: number) => 'NCHAR',
            getSchemaTable: () => [{ ColumnSize: 8, NumericScale: 0 }]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('NCHAR(8)');
    });

    it('prefers schema ProviderType fallback when the live driver reports misleading raw types', () => {
        const reader = {
            getTypeName: (index: number) => ['DATE', 'UNKNOWN(2522)', 'DATE'][index],
            getSchemaTable: () => [
                { ProviderType: 2530, ColumnSize: 32, NumericScale: 0 },
                { ProviderType: 2522, ColumnSize: 8, NumericScale: 0 },
                { ProviderType: 1082, ColumnSize: 8, NumericScale: 0 }
            ]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('NVARCHAR(32)');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('NCHAR(8)');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('DATE');
    });

    it('handles CHAR(16) via getTypeName + typeMod fallback', () => {
        const reader = {
            getTypeName: (_index: number) => 'CHAR',
            columnDescriptions: [{ typeOid: 18, typeMod: 32 }] // 32 - 16 = 16
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('CHAR(16)');
    });

    it('returns bare VARCHAR when no length info is available', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR'
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('VARCHAR');
    });

    // =========================================================================
    // Numeric scale extraction
    // =========================================================================

    it('returns numeric scale for NUMERIC type from getSchemaTable', () => {
        const reader = {
            getTypeName: (_index: number) => 'NUMERIC',
            getSchemaTable: () => [{ NumericScale: 4 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBe(4);
    });

    it('returns numeric scale for INT type with zero scale', () => {
        const reader = {
            getTypeName: (_index: number) => 'INT',
            getSchemaTable: () => [{ NumericScale: 0 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBe(0);
    });

    it('returns numeric scale for DECIMAL type', () => {
        const reader = {
            getTypeName: (_index: number) => 'DECIMAL',
            getSchemaTable: () => [{ NumericScale: 2 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBe(2);
    });

    it('returns numeric scale for FLOAT type', () => {
        const reader = {
            getTypeName: (_index: number) => 'FLOAT',
            getSchemaTable: () => [{ NumericScale: 0 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBe(0);
    });

    it('returns numeric scale for BIGINT type', () => {
        const reader = {
            getTypeName: (_index: number) => 'BIGINT',
            getSchemaTable: () => [{ NumericScale: 0 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBe(0);
    });

    it('returns undefined scale for non-numeric types like VARCHAR', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR',
            getSchemaTable: () => [{ NumericScale: 0 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBeUndefined();
    });

    it('returns undefined scale for DATE type', () => {
        const reader = {
            getTypeName: (_index: number) => 'DATE',
            getSchemaTable: () => [{ NumericScale: 0 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBeUndefined();
    });

    it('returns undefined scale when no schema table is available', () => {
        const reader = {
            getTypeName: (_index: number) => 'NUMERIC'
        };

        expect(getResultReaderNumericScale(reader, 0)).toBeUndefined();
    });

    it('returns undefined scale for negative NumericScale', () => {
        const reader = {
            getTypeName: (_index: number) => 'NUMERIC',
            getSchemaTable: () => [{ NumericScale: -1 }]
        };

        expect(getResultReaderNumericScale(reader, 0)).toBeUndefined();
    });

    // =========================================================================
    // Column size fallback chain
    // =========================================================================

    it('getResultReaderColumnSize prefers getTypeLength over schemaTable', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR',
            getTypeLength: (_index: number) => 50,
            getSchemaTable: () => [{ ColumnSize: 100 }]
        };

        expect(getResultReaderColumnSize(reader, 0)).toBe(50);
    });

    it('getResultReaderColumnSize falls back to schemaTable ColumnSize', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR',
            getSchemaTable: () => [{ ColumnSize: 100 }]
        };

        expect(getResultReaderColumnSize(reader, 0)).toBe(100);
    });

    it('getResultReaderColumnSize falls back to typeMod when no other source', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR',
            columnDescriptions: [{ typeOid: 1043, typeMod: 66 }] // 66 - 16 = 50
        };

        expect(getResultReaderColumnSize(reader, 0)).toBe(50);
    });

    it('getResultReaderColumnSize returns undefined when no metadata available', () => {
        const reader = {
            getTypeName: (_index: number) => 'INT'
        };

        expect(getResultReaderColumnSize(reader, 0)).toBeUndefined();
    });

    it('getResultReaderColumnSize ignores zero and negative typeLength', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR',
            getTypeLength: (_index: number) => 0,
            getSchemaTable: () => [{ ColumnSize: 32 }]
        };

        expect(getResultReaderColumnSize(reader, 0)).toBe(32);
    });

    it('getResultReaderColumnSize ignores typeMod <= 16', () => {
        const reader = {
            getTypeName: (_index: number) => 'VARCHAR',
            columnDescriptions: [{ typeOid: 1043, typeMod: 16 }] // Would give 0
        };

        expect(getResultReaderColumnSize(reader, 0)).toBeUndefined();
    });

    // =========================================================================
    // Schema table access
    // =========================================================================

    it('getResultReaderSchemaRow returns correct row from array format', () => {
        const reader = {
            getTypeName: (_index: number) => 'INT',
            getSchemaTable: () => [
                { ColumnName: 'ID', NumericScale: 0 },
                { ColumnName: 'NAME', NumericScale: 0 }
            ]
        };

        expect(getResultReaderSchemaRow(reader, 0)?.ColumnName).toBe('ID');
        expect(getResultReaderSchemaRow(reader, 1)?.ColumnName).toBe('NAME');
    });

    it('getResultReaderSchemaRow returns correct row from object format', () => {
        const reader = {
            getTypeName: (_index: number) => 'INT',
            getSchemaTable: () => ({
                Rows: [
                    { ColumnName: 'ID', NumericScale: 0 },
                    { ColumnName: 'NAME', NumericScale: 0 }
                ]
            })
        };

        expect(getResultReaderSchemaRow(reader, 0)?.ColumnName).toBe('ID');
    });

    it('getResultReaderSchemaRow returns undefined when no getSchemaTable', () => {
        const reader = {
            getTypeName: (_index: number) => 'INT'
        };

        expect(getResultReaderSchemaRow(reader, 0)).toBeUndefined();
    });

    it('getResultReaderSchemaRow returns undefined for out-of-bounds index', () => {
        const reader = {
            getTypeName: (_index: number) => 'INT',
            getSchemaTable: () => [{ ColumnName: 'ID' }]
        };

        expect(getResultReaderSchemaRow(reader, 5)).toBeUndefined();
    });

    // =========================================================================
    // Zero-column/zero-row edge cases
    // =========================================================================

    it('handles reader with no columns gracefully', () => {
        const reader = {
            getTypeName: (_index: number) => '',
            getSchemaTable: () => []
        };

        // With empty type name the result should still be '' uppercased (empty string → undefined)
        expect(getEffectiveResultColumnType(reader, 0)).toBeUndefined();
    });

    // =========================================================================
    // Driver 2.0.0 path: getTypeName only, with getSchemaTable for sizes
    // =========================================================================

    it('handles driver 2.0.0 path: getTypeName + getSchemaTable only (no getDeclaredTypeName)', () => {
        const reader = {
            getTypeName: (index: number) => ['VARCHAR', 'NVARCHAR', 'NCHAR', 'INT4', 'TIMESTAMPTZ'][index],
            getSchemaTable: () => [
                { ColumnSize: 32, NumericScale: 0 },
                { ColumnSize: 32, NumericScale: 0 },
                { ColumnSize: 8, NumericScale: 0 },
                { ColumnSize: 4, NumericScale: 0 },
                { ColumnSize: 8, NumericScale: 0 }
            ]
        };

        expect(getEffectiveResultColumnType(reader, 0)).toBe('VARCHAR(32)');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('NVARCHAR(32)');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('NCHAR(8)');
        expect(getEffectiveResultColumnType(reader, 3)).toBe('INT4');
        expect(getEffectiveResultColumnType(reader, 4)).toBe('TIMESTAMPTZ');
    });

    it('handles numeric types without character formatting', () => {
        const reader = {
            getTypeName: (index: number) => ['INT', 'BIGINT', 'NUMERIC', 'FLOAT8'][index],
            getSchemaTable: () => [
                { NumericScale: 0 },
                { NumericScale: 0 },
                { NumericScale: 6 },
                { NumericScale: 0 }
            ]
        };

        // Non-character types should not get character formatting
        expect(getEffectiveResultColumnType(reader, 0)).toBe('INT');
        expect(getEffectiveResultColumnType(reader, 1)).toBe('BIGINT');
        expect(getEffectiveResultColumnType(reader, 2)).toBe('NUMERIC');
        expect(getEffectiveResultColumnType(reader, 3)).toBe('FLOAT8');
    });
});

import { fileDialect } from '../../../extensions/duckdb/src/fileDialect';
import { normalizeDatabaseKind, tryNormalizeDatabaseKind } from '../../contracts/database';
import { fileDialectStub } from '../../dialects/file';
import { getDatabaseDialectTraits } from '../../core/dialectTraits';

describe('file dialect (Excel/Access/CSV/Parquet/Avro via DuckDB)', () => {
    it('normalizes file kind aliases', () => {
        expect(normalizeDatabaseKind('file')).toBe('file');
        expect(tryNormalizeDatabaseKind('files')).toBe('file');
        expect(tryNormalizeDatabaseKind('xlsx')).toBe('file');
        expect(tryNormalizeDatabaseKind('xlsb')).toBe('file');
        expect(tryNormalizeDatabaseKind('csv')).toBe('file');
        expect(tryNormalizeDatabaseKind('parquet')).toBe('file');
        expect(tryNormalizeDatabaseKind('avro')).toBe('file');
    });

    it('exposes the file stub for the login panel', () => {
        expect(fileDialectStub.kind).toBe('file');
        expect(fileDialectStub.displayName).toContain('DuckDB');
        expect(() => fileDialectStub.createConnection({} as never)).toThrow(/Install the optional/);
    });

    it('exposes a file-picker field on the login panel stub', () => {
        const field = fileDialectStub.connectionForm?.fields[0];
        expect(field?.key).toBe('filePath');
        expect(field?.type).toBe('file');
        expect(field?.required).toBe(true);
    });

    it('registers a dialect with a file picker field', () => {
        expect(fileDialect.kind).toBe('file');
        expect(fileDialect.displayName).toBe('Excel (XLSX/XLSB) / CSV / Parquet / Avro / Access (DuckDB)');
        const field = fileDialect.connectionForm?.fields[0];
        expect(field?.key).toBe('filePath');
        expect(field?.type).toBe('file');
        expect(field?.required).toBe(true);
    });

    it('exposes traits for the file kind (regression: undefined.identifiers crash)', () => {
        const traits = getDatabaseDialectTraits('file');
        expect(traits).toBeDefined();
        expect(traits.identifiers).toBeDefined();
        expect(traits.identifiers.unquotedIdentifierPattern).toBeInstanceOf(RegExp);
    });

    it('shares duckdb traits, metadata provider and sql authoring', () => {
        expect(fileDialect.traits.identifiers).toBeDefined();
        expect(fileDialect.metadataProvider).toBeDefined();
        expect(fileDialect.sqlAuthoring).toBeDefined();
        expect(fileDialect.getConnectionConstructor).toBeDefined();
        const connection = fileDialect.createConnection({
            host: 'local',
            database: '/data/sales.csv',
            user: 'file',
        });
        expect(connection.constructor.name).toBe('FileDuckDbConnection');
    });
});

import { duckdbImportTypeMapper, DuckDbImportDataType } from '../../../../extensions/duckdb/src/duckdbImportTypeMapper';

describe('DuckDB Data Import Type Mapper', () => {
    describe('DuckDbImportDataType', () => {
        it('maps DATETIME to TIMESTAMP', () => {
            const type = new DuckDbImportDataType('DATETIME');
            expect(type.toString()).toBe('TIMESTAMP');
        });

        it('maps NUMERIC with precision and scale', () => {
            const type = new DuckDbImportDataType('NUMERIC', 10, 2);
            expect(type.toString()).toBe('DECIMAL(10,2)');
        });

        it('maps NUMERIC with precision only', () => {
            const type = new DuckDbImportDataType('NUMERIC', 10);
            expect(type.toString()).toBe('DECIMAL(10)');
        });

        it('maps NUMERIC without parameters', () => {
            const type = new DuckDbImportDataType('NUMERIC');
            expect(type.toString()).toBe('DECIMAL');
        });

        it('maps DECIMAL to DECIMAL', () => {
            const type = new DuckDbImportDataType('DECIMAL', 8, 4);
            expect(type.toString()).toBe('DECIMAL(8,4)');
        });

        it('maps VARCHAR with length', () => {
            const type = new DuckDbImportDataType('VARCHAR', undefined, undefined, 100);
            expect(type.toString()).toBe('VARCHAR(100)');
        });

        it('maps NVARCHAR with length', () => {
            const type = new DuckDbImportDataType('NVARCHAR', undefined, undefined, 50);
            expect(type.toString()).toBe('VARCHAR(50)');
        });

        it('maps VARCHAR without length to default 255', () => {
            const type = new DuckDbImportDataType('VARCHAR');
            expect(type.toString()).toBe('VARCHAR(255)');
        });

        it('maps CHAR to VARCHAR with length', () => {
            const type = new DuckDbImportDataType('CHAR', undefined, undefined, 10);
            expect(type.toString()).toBe('VARCHAR(10)');
        });

        it.each(['BIGINT', 'INTEGER', 'INT'])('maps %s to BIGINT', (typeName) => {
            const type = new DuckDbImportDataType(typeName);
            expect(type.toString()).toBe('BIGINT');
        });

        it('maps DATE to DATE', () => {
            const type = new DuckDbImportDataType('DATE');
            expect(type.toString()).toBe('DATE');
        });

        it('maps BOOLEAN to BOOLEAN', () => {
            const type = new DuckDbImportDataType('BOOLEAN');
            expect(type.toString()).toBe('BOOLEAN');
        });

        it('maps TEXT to VARCHAR', () => {
            const type = new DuckDbImportDataType('TEXT');
            expect(type.toString()).toBe('VARCHAR');
        });

        it('maps JSON to JSON', () => {
            const type = new DuckDbImportDataType('JSON');
            expect(type.toString()).toBe('JSON');
        });

        it('returns normalized type for unknown types', () => {
            const type = new DuckDbImportDataType('float ');
            expect(type.toString()).toBe('FLOAT');
        });
    });

    describe('duckdbImportTypeMapper', () => {
        it('creates correct data type instance', () => {
            const type = duckdbImportTypeMapper.createDataType('DATETIME', 10, 2, 100);
            expect(type).toBeInstanceOf(DuckDbImportDataType);
            expect(type.dbType).toBe('DATETIME');
            expect(type.precision).toBe(10);
            expect(type.scale).toBe(2);
            expect(type.length).toBe(100);
        });

        it('creates a ColumnTypeChooser', () => {
            const chooser = duckdbImportTypeMapper.createColumnTypeChooser(',');
            expect(chooser).toBeDefined();
            expect(typeof chooser.refreshCurrentType).toBe('function');
        });
    });
});

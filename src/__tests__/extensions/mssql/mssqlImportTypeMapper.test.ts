import { mssqlImportTypeMapper, MsSqlImportDataType } from '../../../../extensions/mssql/src/mssqlImportTypeMapper';

describe('MSSQL Data Import Type Mapper', () => {
    describe('MsSqlImportDataType', () => {
        it('maps DATETIME to DATETIME2', () => {
            const type = new MsSqlImportDataType('DATETIME');
            expect(type.toString()).toBe('DATETIME2');
        });

        it('maps NUMERIC with precision and scale', () => {
            const type = new MsSqlImportDataType('NUMERIC', 10, 2);
            expect(type.toString()).toBe('DECIMAL(10,2)');
        });

        it('maps NUMERIC with precision only', () => {
            const type = new MsSqlImportDataType('NUMERIC', 10);
            expect(type.toString()).toBe('DECIMAL(10)');
        });

        it('maps NUMERIC without parameters', () => {
            const type = new MsSqlImportDataType('NUMERIC');
            expect(type.toString()).toBe('DECIMAL');
        });

        it('maps DECIMAL to DECIMAL', () => {
            const type = new MsSqlImportDataType('DECIMAL', 8, 4);
            expect(type.toString()).toBe('DECIMAL(8,4)');
        });

        it('maps NVARCHAR with length', () => {
            const type = new MsSqlImportDataType('NVARCHAR', undefined, undefined, 100);
            expect(type.toString()).toBe('NVARCHAR(100)');
        });

        it('maps VARCHAR with length', () => {
            const type = new MsSqlImportDataType('VARCHAR', undefined, undefined, 50);
            expect(type.toString()).toBe('VARCHAR(50)');
        });

        it('maps VARCHAR without length to default 255', () => {
            const type = new MsSqlImportDataType('VARCHAR');
            expect(type.toString()).toBe('VARCHAR(255)');
        });

        it('maps CHAR with length', () => {
            const type = new MsSqlImportDataType('CHAR', undefined, undefined, 10);
            expect(type.toString()).toBe('CHAR(10)');
        });

        it('maps CHAR without length to default 1', () => {
            const type = new MsSqlImportDataType('CHAR');
            expect(type.toString()).toBe('CHAR(1)');
        });

        it.each(['BIGINT', 'INTEGER', 'INT'])('maps %s to BIGINT', (typeName) => {
            const type = new MsSqlImportDataType(typeName);
            expect(type.toString()).toBe('BIGINT');
        });

        it('maps BOOLEAN to BIT', () => {
            const type = new MsSqlImportDataType('BOOLEAN');
            expect(type.toString()).toBe('BIT');
        });

        it('maps DATE to DATE', () => {
            const type = new MsSqlImportDataType('DATE');
            expect(type.toString()).toBe('DATE');
        });

        it('maps TEXT to NVARCHAR(MAX)', () => {
            const type = new MsSqlImportDataType('TEXT');
            expect(type.toString()).toBe('NVARCHAR(MAX)');
        });

        it('returns normalized type for unknown types', () => {
            const type = new MsSqlImportDataType('float ');
            expect(type.toString()).toBe('FLOAT');
        });
    });

    describe('mssqlImportTypeMapper', () => {
        it('creates correct data type instance', () => {
            const type = mssqlImportTypeMapper.createDataType('DATETIME', 10, 2, 100);
            expect(type).toBeInstanceOf(MsSqlImportDataType);
            expect(type.dbType).toBe('DATETIME');
            expect(type.precision).toBe(10);
            expect(type.scale).toBe(2);
            expect(type.length).toBe(100);
        });

        it('creates a ColumnTypeChooser', () => {
            const chooser = mssqlImportTypeMapper.createColumnTypeChooser(',');
            expect(chooser).toBeDefined();
            expect(typeof chooser.refreshCurrentType).toBe('function');
        });
    });
});

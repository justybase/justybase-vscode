import { mysqlImportTypeMapper, MysqlImportDataType } from '../../../../extensions/mysql/src/mysqlImportTypeMapper';

describe('MySQL Data Import Type Mapper', () => {
    describe('MysqlImportDataType', () => {
        it('maps DATETIME to DATETIME', () => {
            const type = new MysqlImportDataType('DATETIME');
            expect(type.toString()).toBe('DATETIME');
        });

        it('maps NUMERIC with precision and scale', () => {
            const type = new MysqlImportDataType('NUMERIC', 10, 2);
            expect(type.toString()).toBe('DECIMAL(10,2)');
        });

        it('maps NUMERIC with precision only', () => {
            const type = new MysqlImportDataType('NUMERIC', 10);
            expect(type.toString()).toBe('DECIMAL(10)');
        });

        it('maps NUMERIC without parameters', () => {
            const type = new MysqlImportDataType('NUMERIC');
            expect(type.toString()).toBe('DECIMAL');
        });

        it('maps DECIMAL to DECIMAL', () => {
            const type = new MysqlImportDataType('DECIMAL', 8, 4);
            expect(type.toString()).toBe('DECIMAL(8,4)');
        });

        it('maps NVARCHAR with length', () => {
            const type = new MysqlImportDataType('NVARCHAR', undefined, undefined, 100);
            expect(type.toString()).toBe('VARCHAR(100)');
        });

        it('maps VARCHAR with length', () => {
            const type = new MysqlImportDataType('VARCHAR', undefined, undefined, 50);
            expect(type.toString()).toBe('VARCHAR(50)');
        });

        it('maps VARCHAR without length to default 255', () => {
            const type = new MysqlImportDataType('VARCHAR');
            expect(type.toString()).toBe('VARCHAR(255)');
        });

        it('maps CHAR with length', () => {
            const type = new MysqlImportDataType('CHAR', undefined, undefined, 10);
            expect(type.toString()).toBe('CHAR(10)');
        });

        it('maps CHAR without length to default 1', () => {
            const type = new MysqlImportDataType('CHAR');
            expect(type.toString()).toBe('CHAR(1)');
        });

        it.each(['BIGINT', 'INTEGER', 'INT'])('maps %s to BIGINT', (typeName) => {
            const type = new MysqlImportDataType(typeName);
            expect(type.toString()).toBe('BIGINT');
        });

        it('maps BOOLEAN to TINYINT(1)', () => {
            const type = new MysqlImportDataType('BOOLEAN');
            expect(type.toString()).toBe('TINYINT(1)');
        });

        it('maps DATE to DATE', () => {
            const type = new MysqlImportDataType('DATE');
            expect(type.toString()).toBe('DATE');
        });

        it('maps TEXT to LONGTEXT', () => {
            const type = new MysqlImportDataType('TEXT');
            expect(type.toString()).toBe('LONGTEXT');
        });

        it('maps CLOB to LONGTEXT', () => {
            const type = new MysqlImportDataType('CLOB');
            expect(type.toString()).toBe('LONGTEXT');
        });

        it('maps JSON to JSON', () => {
            const type = new MysqlImportDataType('JSON');
            expect(type.toString()).toBe('JSON');
        });

        it('returns normalized type for unknown types', () => {
            const type = new MysqlImportDataType('float ');
            expect(type.toString()).toBe('FLOAT');
        });
    });

    describe('mysqlImportTypeMapper', () => {
        it('creates correct data type instance', () => {
            const type = mysqlImportTypeMapper.createDataType('DATETIME', 10, 2, 100);
            expect(type).toBeInstanceOf(MysqlImportDataType);
            expect(type.dbType).toBe('DATETIME');
            expect(type.precision).toBe(10);
            expect(type.scale).toBe(2);
            expect(type.length).toBe(100);
        });

        it('creates a ColumnTypeChooser', () => {
            const chooser = mysqlImportTypeMapper.createColumnTypeChooser(',');
            expect(chooser).toBeDefined();
            expect(typeof chooser.refreshCurrentType).toBe('function');
        });
    });
});

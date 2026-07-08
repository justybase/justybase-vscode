import { db2ImportTypeMapper, Db2ImportDataType } from '../../../../extensions/db2/src/db2ImportTypeMapper';

describe('Db2 Data Import Type Mapper', () => {
    describe('Db2ImportDataType', () => {
        it('maps DATETIME to TIMESTAMP', () => {
            const type = new Db2ImportDataType('DATETIME');
            expect(type.toString()).toBe('TIMESTAMP');
        });

        it('maps NUMERIC with precision and scale', () => {
            const type = new Db2ImportDataType('NUMERIC', 10, 2);
            expect(type.toString()).toBe('DECIMAL(10,2)');
        });

        it('maps NUMERIC with precision only', () => {
            const type = new Db2ImportDataType('NUMERIC', 10);
            expect(type.toString()).toBe('DECIMAL(10)');
        });

        it('maps NUMERIC without parameters', () => {
            const type = new Db2ImportDataType('NUMERIC');
            expect(type.toString()).toBe('DECIMAL');
        });

        it('maps DECIMAL to DECIMAL', () => {
            const type = new Db2ImportDataType('DECIMAL', 8, 4);
            expect(type.toString()).toBe('DECIMAL(8,4)');
        });

        it('maps NVARCHAR with length', () => {
            const type = new Db2ImportDataType('NVARCHAR', undefined, undefined, 100);
            expect(type.toString()).toBe('NVARCHAR(100)');
        });

        it('maps VARCHAR with length', () => {
            const type = new Db2ImportDataType('VARCHAR', undefined, undefined, 50);
            expect(type.toString()).toBe('VARCHAR(50)');
        });

        it('maps VARCHAR without length to default 255', () => {
            const type = new Db2ImportDataType('VARCHAR');
            expect(type.toString()).toBe('VARCHAR(255)');
        });

        it('maps CHAR with length', () => {
            const type = new Db2ImportDataType('CHAR', undefined, undefined, 10);
            expect(type.toString()).toBe('CHAR(10)');
        });

        it('maps CHAR without length to default 1', () => {
            const type = new Db2ImportDataType('CHAR');
            expect(type.toString()).toBe('CHAR(1)');
        });

        it.each(['BIGINT', 'INTEGER', 'INT'])('maps %s to BIGINT', (typeName) => {
            const type = new Db2ImportDataType(typeName);
            expect(type.toString()).toBe('BIGINT');
        });

        it('maps BOOLEAN to BOOLEAN', () => {
            const type = new Db2ImportDataType('BOOLEAN');
            expect(type.toString()).toBe('BOOLEAN');
        });

        it('maps DATE to DATE', () => {
            const type = new Db2ImportDataType('DATE');
            expect(type.toString()).toBe('DATE');
        });

        it('maps TEXT to CLOB', () => {
            const type = new Db2ImportDataType('TEXT');
            expect(type.toString()).toBe('CLOB');
        });

        it('maps CLOB to CLOB', () => {
            const type = new Db2ImportDataType('CLOB');
            expect(type.toString()).toBe('CLOB');
        });

        it('maps BLOB to BLOB', () => {
            const type = new Db2ImportDataType('BLOB');
            expect(type.toString()).toBe('BLOB');
        });

        it('maps DECFLOAT to DECFLOAT', () => {
            const type = new Db2ImportDataType('DECFLOAT');
            expect(type.toString()).toBe('DECFLOAT');
        });

        it('returns normalized type for unknown types', () => {
            const type = new Db2ImportDataType('float ');
            expect(type.toString()).toBe('FLOAT');
        });
    });

    describe('db2ImportTypeMapper', () => {
        it('creates correct data type instance', () => {
            const type = db2ImportTypeMapper.createDataType('DATETIME', 10, 2, 100);
            expect(type).toBeInstanceOf(Db2ImportDataType);
            expect(type.dbType).toBe('DATETIME');
            expect(type.precision).toBe(10);
            expect(type.scale).toBe(2);
            expect(type.length).toBe(100);
        });

        it('creates a ColumnTypeChooser', () => {
            const chooser = db2ImportTypeMapper.createColumnTypeChooser(',');
            expect(chooser).toBeDefined();
            expect(typeof chooser.refreshCurrentType).toBe('function');
        });
    });
});

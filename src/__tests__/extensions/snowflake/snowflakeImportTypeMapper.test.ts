import { snowflakeImportTypeMapper, SnowflakeImportDataType } from '../../../../extensions/snowflake/src/snowflakeImportTypeMapper';

describe('Snowflake Data Import Type Mapper', () => {
    describe('SnowflakeImportDataType', () => {
        it('maps DATETIME to TIMESTAMP_NTZ', () => {
            const type = new SnowflakeImportDataType('DATETIME');
            expect(type.toString()).toBe('TIMESTAMP_NTZ');
        });

        it('maps NUMERIC with precision and scale', () => {
            const type = new SnowflakeImportDataType('NUMERIC', 10, 2);
            expect(type.toString()).toBe('NUMBER(10,2)');
        });

        it('maps NUMERIC with precision only', () => {
            const type = new SnowflakeImportDataType('NUMERIC', 10);
            expect(type.toString()).toBe('NUMBER(10)');
        });

        it('maps NUMERIC without parameters', () => {
            const type = new SnowflakeImportDataType('NUMERIC');
            expect(type.toString()).toBe('NUMBER');
        });

        it('maps DECIMAL to NUMBER', () => {
            const type = new SnowflakeImportDataType('DECIMAL', 8, 4);
            expect(type.toString()).toBe('NUMBER(8,4)');
        });

        it('maps VARCHAR with length', () => {
            const type = new SnowflakeImportDataType('VARCHAR', undefined, undefined, 100);
            expect(type.toString()).toBe('VARCHAR(100)');
        });

        it('maps NVARCHAR with length', () => {
            const type = new SnowflakeImportDataType('NVARCHAR', undefined, undefined, 50);
            expect(type.toString()).toBe('VARCHAR(50)');
        });

        it('maps VARCHAR without length to default 255', () => {
            const type = new SnowflakeImportDataType('VARCHAR');
            expect(type.toString()).toBe('VARCHAR(255)');
        });

        it('maps CHAR with length', () => {
            const type = new SnowflakeImportDataType('CHAR', undefined, undefined, 10);
            expect(type.toString()).toBe('CHAR(10)');
        });

        it('maps CHAR without length to default 1', () => {
            const type = new SnowflakeImportDataType('CHAR');
            expect(type.toString()).toBe('CHAR(1)');
        });

        it.each(['BIGINT', 'INTEGER', 'INT'])('maps %s to BIGINT', (type) => {
            const t = new SnowflakeImportDataType(type);
            expect(t.toString()).toBe('BIGINT');
        });

        it('maps DATE to DATE', () => {
            const type = new SnowflakeImportDataType('DATE');
            expect(type.toString()).toBe('DATE');
        });

        it('returns normalized type for unknown types', () => {
            const type = new SnowflakeImportDataType('boolean ');
            expect(type.toString()).toBe('BOOLEAN');
        });
    });

    describe('snowflakeImportTypeMapper', () => {
        it('creates correct data type instance', () => {
            const type = snowflakeImportTypeMapper.createDataType('DATETIME', 10, 2, 100);
            expect(type).toBeInstanceOf(SnowflakeImportDataType);
            expect(type.dbType).toBe('DATETIME');
            expect(type.precision).toBe(10);
            expect(type.scale).toBe(2);
            expect(type.length).toBe(100);
        });

        it('creates a ColumnTypeChooser', () => {
            const chooser = snowflakeImportTypeMapper.createColumnTypeChooser(',');
            expect(chooser).toBeDefined();
            expect(typeof chooser.refreshCurrentType).toBe('function');
        });
    });
});

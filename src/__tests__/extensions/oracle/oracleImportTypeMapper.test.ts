import { oracleImportTypeMapper, OracleImportDataType } from '../../../../extensions/oracle/src/oracleImportTypeMapper';

describe('Oracle Data Import Type Mapper', () => {
    describe('OracleImportDataType', () => {
        it('maps DATETIME to TIMESTAMP', () => {
            const type = new OracleImportDataType('DATETIME');
            expect(type.toString()).toBe('TIMESTAMP');
        });

        it('maps NUMERIC with precision and scale', () => {
            const type = new OracleImportDataType('NUMERIC', 10, 2);
            expect(type.toString()).toBe('NUMBER(10,2)');
        });

        it('maps NUMERIC with precision only', () => {
            const type = new OracleImportDataType('NUMERIC', 10);
            expect(type.toString()).toBe('NUMBER(10)');
        });

        it('maps NUMERIC without parameters', () => {
            const type = new OracleImportDataType('NUMERIC');
            expect(type.toString()).toBe('NUMBER');
        });

        it('maps DECIMAL to NUMBER', () => {
            const type = new OracleImportDataType('DECIMAL', 8, 4);
            expect(type.toString()).toBe('NUMBER(8,4)');
        });

        it('maps NVARCHAR to NVARCHAR2 with length', () => {
            const type = new OracleImportDataType('NVARCHAR', undefined, undefined, 100);
            expect(type.toString()).toBe('NVARCHAR2(100)');
        });

        it('maps VARCHAR to VARCHAR2 with length', () => {
            const type = new OracleImportDataType('VARCHAR', undefined, undefined, 50);
            expect(type.toString()).toBe('VARCHAR2(50)');
        });

        it('maps VARCHAR without length to default 255', () => {
            const type = new OracleImportDataType('VARCHAR');
            expect(type.toString()).toBe('VARCHAR2(255)');
        });

        it('maps CHAR with length', () => {
            const type = new OracleImportDataType('CHAR', undefined, undefined, 10);
            expect(type.toString()).toBe('CHAR(10)');
        });

        it('maps CHAR without length to default 1', () => {
            const type = new OracleImportDataType('CHAR');
            expect(type.toString()).toBe('CHAR(1)');
        });

        it.each(['BIGINT', 'INTEGER', 'INT'])('maps %s to NUMBER(19)', (typeName) => {
            const type = new OracleImportDataType(typeName);
            expect(type.toString()).toBe('NUMBER(19)');
        });

        it('maps BOOLEAN to NUMBER(1)', () => {
            const type = new OracleImportDataType('BOOLEAN');
            expect(type.toString()).toBe('NUMBER(1)');
        });

        it('maps DATE to DATE', () => {
            const type = new OracleImportDataType('DATE');
            expect(type.toString()).toBe('DATE');
        });

        it('maps TEXT to CLOB', () => {
            const type = new OracleImportDataType('TEXT');
            expect(type.toString()).toBe('CLOB');
        });

        it('maps CLOB to CLOB', () => {
            const type = new OracleImportDataType('CLOB');
            expect(type.toString()).toBe('CLOB');
        });

        it('maps BLOB to BLOB', () => {
            const type = new OracleImportDataType('BLOB');
            expect(type.toString()).toBe('BLOB');
        });

        it('returns normalized type for unknown types', () => {
            const type = new OracleImportDataType('float ');
            expect(type.toString()).toBe('FLOAT');
        });
    });

    describe('oracleImportTypeMapper', () => {
        it('creates correct data type instance', () => {
            const type = oracleImportTypeMapper.createDataType('DATETIME', 10, 2, 100);
            expect(type).toBeInstanceOf(OracleImportDataType);
            expect(type.dbType).toBe('DATETIME');
            expect(type.precision).toBe(10);
            expect(type.scale).toBe(2);
            expect(type.length).toBe(100);
        });

        it('creates a ColumnTypeChooser', () => {
            const chooser = oracleImportTypeMapper.createColumnTypeChooser(',');
            expect(chooser).toBeDefined();
            expect(typeof chooser.refreshCurrentType).toBe('function');
        });

        it('infers BOOLEAN values for Oracle imports but falls back to text for mixed values', () => {
            const booleanChooser = oracleImportTypeMapper.createColumnTypeChooser();
            expect(booleanChooser.refreshCurrentType('true').dbType).toBe('BOOLEAN');
            expect(booleanChooser.refreshCurrentType('false').dbType).toBe('BOOLEAN');

            const mixedChooser = oracleImportTypeMapper.createColumnTypeChooser();
            mixedChooser.refreshCurrentType('true');
            expect(mixedChooser.refreshCurrentType('unknown').dbType).toBe('NVARCHAR');
        });
    });
});

import { buildColumnTypeName } from '../../../../extensions/oracle/src/oracleConnection';

describe('Oracle result metadata type names', () => {
    it('preserves NUMBER precision and scale', () => {
        expect(buildColumnTypeName({
            dbTypeName: 'NUMBER',
            precision: 10,
            scale: 2,
        })).toBe('NUMBER(10,2)');
    });

    it('keeps unconstrained NUMBER distinguishable from a scaled NUMBER', () => {
        expect(buildColumnTypeName({
            dbTypeName: 'NUMBER',
            precision: 0,
            scale: -127,
        })).toBe('NUMBER');
    });

    it.each([
        ['VARCHAR2', 20, 'VARCHAR2(20)'],
        ['CHAR', 8, 'CHAR(8)'],
        ['RAW', 16, 'RAW(16)'],
    ])('preserves %s length metadata', (typeName, length, expected) => {
        expect(buildColumnTypeName({
            dbTypeName: typeName,
            byteSize: length,
        })).toBe(expected);
    });

    it('uses the native Oracle type name when dbTypeName is absent', () => {
        expect(buildColumnTypeName({
            dbType: {
                name: 'DB_TYPE_VARCHAR',
                columnTypeName: 'VARCHAR2',
            },
            byteSize: 30,
        })).toBe('VARCHAR2(30)');
    });

    it('preserves timestamp precision', () => {
        expect(buildColumnTypeName({
            dbTypeName: 'TIMESTAMP',
            precision: 6,
        })).toBe('TIMESTAMP(6)');
    });

    it('places precision before the time-zone suffix', () => {
        expect(buildColumnTypeName({
            dbTypeName: 'TIMESTAMP WITH TIME ZONE',
            precision: 6,
        })).toBe('TIMESTAMP(6) WITH TIME ZONE');
    });
});

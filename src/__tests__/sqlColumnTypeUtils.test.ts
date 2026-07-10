import { isNumericSqlColumnType } from '../results/sqlColumnTypeUtils';

describe('sqlColumnTypeUtils', () => {
    it('recognizes Netezza integer aliases as numeric', () => {
        expect(isNumericSqlColumnType('INT4')).toBe(true);
        expect(isNumericSqlColumnType('INT2')).toBe(true);
        expect(isNumericSqlColumnType('INT8')).toBe(true);
        expect(isNumericSqlColumnType('BYTEINT')).toBe(true);
    });

    it('does not treat text columns as numeric', () => {
        expect(isNumericSqlColumnType('VARCHAR')).toBe(false);
        expect(isNumericSqlColumnType('NVARCHAR(64)')).toBe(false);
    });
});

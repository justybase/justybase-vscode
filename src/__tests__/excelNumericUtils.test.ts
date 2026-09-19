import {
  shouldConvertToExcelNumber,
  convertToExcelNumberIfNumericString,
  convertRowExcelNumericStrings
} from '../export/excelNumericUtils';

describe('excelNumericUtils', () => {
  describe('shouldConvertToExcelNumber', () => {
    it('should return true for INT types', () => {
      expect(shouldConvertToExcelNumber('INT4')).toBe(true);
      expect(shouldConvertToExcelNumber('INT8')).toBe(true);
      expect(shouldConvertToExcelNumber('INTEGER')).toBe(true);
      expect(shouldConvertToExcelNumber('BIGINT')).toBe(true);
      expect(shouldConvertToExcelNumber('SMALLINT')).toBe(true);
    });

    it('should return true for NUMERIC with precision/scale', () => {
      expect(shouldConvertToExcelNumber('NUMERIC(20,4)')).toBe(true);
      expect(shouldConvertToExcelNumber('NUMERIC(18,0)')).toBe(true);
      expect(shouldConvertToExcelNumber('NUMERIC')).toBe(true);
    });

    it('should return true for DECIMAL with precision/scale', () => {
      expect(shouldConvertToExcelNumber('DECIMAL(10,2)')).toBe(true);
      expect(shouldConvertToExcelNumber('DECIMAL')).toBe(true);
    });

    it('should return true for FLOAT/DOUBLE types', () => {
      expect(shouldConvertToExcelNumber('FLOAT')).toBe(true);
      expect(shouldConvertToExcelNumber('FLOAT8')).toBe(true);
      expect(shouldConvertToExcelNumber('REAL')).toBe(true);
      expect(shouldConvertToExcelNumber('DOUBLE PRECISION')).toBe(true);
    });

    it('should return true for MONEY types', () => {
      expect(shouldConvertToExcelNumber('MONEY')).toBe(true);
      expect(shouldConvertToExcelNumber('SMALLMONEY')).toBe(true);
    });

    it('should return false for non-numeric types', () => {
      expect(shouldConvertToExcelNumber('VARCHAR')).toBe(false);
      expect(shouldConvertToExcelNumber('CHAR')).toBe(false);
      expect(shouldConvertToExcelNumber('TEXT')).toBe(false);
      expect(shouldConvertToExcelNumber('DATE')).toBe(false);
      expect(shouldConvertToExcelNumber('TIMESTAMP')).toBe(false);
    });

    it('should return false for undefined/empty', () => {
      expect(shouldConvertToExcelNumber(undefined)).toBe(false);
      expect(shouldConvertToExcelNumber('')).toBe(false);
    });

    it('should handle case-insensitive type names', () => {
      expect(shouldConvertToExcelNumber('numeric(20,4)')).toBe(true);
      expect(shouldConvertToExcelNumber('Numeric')).toBe(true);
      expect(shouldConvertToExcelNumber('int4')).toBe(true);
    });
  });

  describe('convertToExcelNumberIfNumericString', () => {
    describe('NUMERIC/DECIMAL types (rounded to Excel precision)', () => {
      it('should convert padded NUMERIC strings to number', () => {
        expect(convertToExcelNumberIfNumericString('0000000000000002.5000', 'NUMERIC(20,4)')).toBe(2.5);
      });

      it('should convert simple numeric string to number', () => {
        expect(convertToExcelNumberIfNumericString('2.5000', 'NUMERIC(20,4)')).toBe(2.5);
      });

      it('should convert DECIMAL string to number', () => {
        expect(convertToExcelNumberIfNumericString('123.45', 'DECIMAL(10,2)')).toBe(123.45);
      });

      it('should convert NUMERIC integer-like value', () => {
        expect(convertToExcelNumberIfNumericString('100', 'NUMERIC(10,0)')).toBe(100);
      });

      it('should convert NUMERIC zero value', () => {
        expect(convertToExcelNumberIfNumericString('0', 'NUMERIC(10,2)')).toBe(0);
      });

      it('should convert NUMERIC with leading zero decimal', () => {
        expect(convertToExcelNumberIfNumericString('0.1234', 'NUMERIC(10,4)')).toBe(0.1234);
      });

      it('should convert negative NUMERIC string', () => {
        expect(convertToExcelNumberIfNumericString('-2.5000', 'NUMERIC(20,4)')).toBe(-2.5);
      });

      it('should round long NUMERIC strings to 15 significant digits', () => {
        const longNum = '1234567890123.4567';
        expect(convertToExcelNumberIfNumericString(longNum, 'NUMERIC(20,4)')).toBe(1234567890123.46);
      });

      it('should round high-precision decimal values from Netezza', () => {
        expect(convertToExcelNumberIfNumericString(
          '123456789012345.678901234567890123',
          'NUMERIC(38,18)'
        )).toBe(123456789012346);
      });

      it('should round decimal text before binary conversion at a boundary', () => {
        expect(convertToExcelNumberIfNumericString(
          '0.9999999999999945',
          'NUMERIC(38,16)'
        )).toBe(0.999999999999995);
      });

      it('should convert NUMBER type padded string', () => {
        expect(convertToExcelNumberIfNumericString('0000000123.45', 'NUMBER(10,2)')).toBe(123.45);
      });

      it('should convert FIXED type padded string', () => {
        expect(convertToExcelNumberIfNumericString('0000000001.50', 'FIXED(10,2)')).toBe(1.5);
      });

      it('should convert MONEY type padded string', () => {
        expect(convertToExcelNumberIfNumericString('0000000123.45', 'MONEY')).toBe(123.45);
      });
    });

    describe('FLOAT/DOUBLE types (lossy - no length protection)', () => {
      it('should round float strings to Excel precision', () => {
        const longFloat = '12345678901234567.89';
        expect(convertToExcelNumberIfNumericString(longFloat, 'FLOAT8')).toBe(12345678901234600);
      });

      it('should convert REAL padded string', () => {
        expect(convertToExcelNumberIfNumericString('0000000000000002.5000', 'REAL')).toBe(2.5);
      });

      it('should convert DOUBLE padded string', () => {
        expect(convertToExcelNumberIfNumericString('0000000000000002.5000', 'DOUBLE PRECISION')).toBe(2.5);
      });

      it('should convert DECFLOAT padded string', () => {
        expect(convertToExcelNumberIfNumericString('0000000000000002.5000', 'DECFLOAT')).toBe(2.5);
      });
    });

    describe('INT types (exact - not lossy)', () => {
      it('should convert integer strings', () => {
        expect(convertToExcelNumberIfNumericString('123', 'INT4')).toBe(123);
      });

      it('should round long integer strings to Excel precision', () => {
        const longInt = '12345678901234567';
        expect(convertToExcelNumberIfNumericString(longInt, 'BIGINT')).toBe(12345678901234600);
      });

      it('should not convert leading-zero integer strings like "0123"', () => {
        expect(convertToExcelNumberIfNumericString('0123', 'INT4')).toBe(123);
      });
    });

    describe('non-string values', () => {
      it('should return numbers as-is', () => {
        expect(convertToExcelNumberIfNumericString(2.5, 'NUMERIC(20,4)')).toBe(2.5);
        expect(convertToExcelNumberIfNumericString(0, 'INT4')).toBe(0);
        expect(convertToExcelNumberIfNumericString(-1, 'INT4')).toBe(-1);
      });

      it('should convert bigint to an Excel-precision number for numeric types', () => {
        expect(convertToExcelNumberIfNumericString(BigInt(1), 'BIGINT')).toBe(1);
        expect(convertToExcelNumberIfNumericString(BigInt(0), 'INT4')).toBe(0);
        expect(convertToExcelNumberIfNumericString(BigInt(-1), 'BIGINT')).toBe(-1);
        expect(convertToExcelNumberIfNumericString(BigInt(9007199254740991), 'BIGINT')).toBe(9007199254740990);
        expect(convertToExcelNumberIfNumericString(BigInt(-9007199254740991), 'BIGINT')).toBe(-9007199254740990);
      });

      it('should round large bigint values for numeric types', () => {
        const large = BigInt('9007199254740992');
        expect(convertToExcelNumberIfNumericString(large, 'BIGINT')).toBe(9007199254740990);
        const small = BigInt('-9007199254740992');
        expect(convertToExcelNumberIfNumericString(small, 'BIGINT')).toBe(-9007199254740990);
      });

      it('should keep bigint as-is for non-numeric types', () => {
        const val = BigInt(42);
        expect(convertToExcelNumberIfNumericString(val, 'VARCHAR')).toBe(val);
        expect(convertToExcelNumberIfNumericString(val)).toBe(val);
      });

      it('should return null/undefined as-is', () => {
        expect(convertToExcelNumberIfNumericString(null, 'INT4')).toBeNull();
        expect(convertToExcelNumberIfNumericString(undefined, 'INT4')).toBeUndefined();
      });

      it('should return non-numeric strings as-is', () => {
        expect(convertToExcelNumberIfNumericString('hello', 'VARCHAR')).toBe('hello');
        expect(convertToExcelNumberIfNumericString('N/A', 'VARCHAR')).toBe('N/A');
        expect(convertToExcelNumberIfNumericString('123.45', 'VARCHAR')).toBe('123.45');
      });

      it('should return empty string as-is', () => {
        expect(convertToExcelNumberIfNumericString('', 'INT4')).toBe('');
        expect(convertToExcelNumberIfNumericString('  ', 'INT4')).toBe('  ');
      });

      it('should return boolean as-is', () => {
        expect(convertToExcelNumberIfNumericString(true, 'INT4')).toBe(true);
      });
    });

    describe('edge cases', () => {
      it('should handle scientific notation strings', () => {
        expect(convertToExcelNumberIfNumericString('1.5e10', 'FLOAT8')).toBe(1.5e10);
      });

      it('should handle negative scientific notation', () => {
        expect(convertToExcelNumberIfNumericString('-2.5E-3', 'FLOAT8')).toBe(-2.5e-3);
      });

      it('should handle string with only dot notation', () => {
        expect(convertToExcelNumberIfNumericString('.5', 'FLOAT8')).toBe(0.5);
      });

      it('should return NaN-producing strings as-is', () => {
        expect(convertToExcelNumberIfNumericString('Infinity', 'FLOAT8')).toBe('Infinity');
      });

      it('should keep non-zero values that underflow to zero as text', () => {
        expect(convertToExcelNumberIfNumericString('1e-324', 'NUMERIC(38,38)')).toBe('1e-324');
      });
    });
  });

  describe('convertRowExcelNumericStrings', () => {
    it('should convert all numeric strings in a row', () => {
      const result = convertRowExcelNumericStrings(['123', '456.78', 'text', '0']);
      expect(result).toEqual([123, 456.78, 'text', 0]);
    });

    it('should handle empty row', () => {
      expect(convertRowExcelNumericStrings([])).toEqual([]);
    });

    it('should handle row with mixed types', () => {
      const result = convertRowExcelNumericStrings([null, 42, 'hello', '3.14']);
      expect(result).toEqual([null, 42, 'hello', 3.14]);
    });
  });
});

import { validateImportCellValue } from '../import/wizard/importCellValidation';

describe('importCellValidation', () => {
    it('accepts empty values for every type', () => {
        expect(validateImportCellValue('', 'BIGINT')).toBeNull();
        expect(validateImportCellValue('   ', 'DATE')).toBeNull();
    });

    it('validates integer types', () => {
        expect(validateImportCellValue('42', 'INT')).toBeNull();
        expect(validateImportCellValue('-42', 'BIGINT')).toBeNull();
        expect(validateImportCellValue('4.2', 'SMALLINT')).toBe('Expected an integer value.');
        expect(validateImportCellValue('abc', 'INTEGER')).toBe('Expected an integer value.');
    });

    it('validates numeric types with dot or comma decimals', () => {
        expect(validateImportCellValue('12.5', 'NUMERIC(10,2)')).toBeNull();
        expect(validateImportCellValue('12,5', 'DECIMAL(10,2)')).toBeNull();
        // Scientific notation is accepted by design: parseFormattedImportNumber
        // expands exponents (bounded by MAX_IMPORT_EXPONENT), the SQL validator
        // accepts `SELECT 1.5e10`, and Excel pastes routinely produce `1E3`.
        expect(validateImportCellValue('1e3', 'FLOAT')).toBeNull();
        expect(validateImportCellValue('1E3', 'NUMERIC(10,2)')).toBeNull();
        // Currency-prefixed cells are accepted by design: the parser strips
        // `$`/wrapping-paren edges (wasCurrency) before digit validation.
        expect(validateImportCellValue('$12', 'MONEY')).toBeNull();
        expect(validateImportCellValue('abc', 'MONEY')).toBe('Expected a numeric value.');
    });

    it('validates boolean types', () => {
        expect(validateImportCellValue('true', 'BOOLEAN')).toBeNull();
        expect(validateImportCellValue('N', 'BIT')).toBeNull();
        expect(validateImportCellValue('maybe', 'BOOL')).toBe('Expected a boolean value.');
    });

    it('validates ISO and local date formats', () => {
        expect(validateImportCellValue('2024-02-03', 'DATE')).toBeNull();
        expect(validateImportCellValue('03.02.2024', 'DATE')).toBeNull();
        expect(validateImportCellValue('31.02.2024', 'DATE')).toBe('Expected a valid date value.');
        expect(validateImportCellValue('2024-13-01', 'DATE')).toBe('Expected a valid date value.');
        expect(validateImportCellValue('not-a-date', 'DATE')).toBe('Expected a valid date value.');
    });

    it('validates timestamps with optional time parts', () => {
        expect(validateImportCellValue('2024-02-03 09:00:00', 'TIMESTAMP')).toBeNull();
        expect(validateImportCellValue('2024-02-03T09:00', 'DATETIME')).toBeNull();
        expect(validateImportCellValue('03.02.2024 09:00:00', 'DATETIME2')).toBeNull();
        expect(validateImportCellValue('2024-02-03 25:00:00', 'TIMESTAMP_NTZ')).toBe('Expected a valid timestamp value.');
        expect(validateImportCellValue('nope', 'DATETIME')).toBe('Expected a valid timestamp value.');
    });

    it('accepts unconstrained text types', () => {
        expect(validateImportCellValue('anything', 'NVARCHAR(50)')).toBeNull();
        expect(validateImportCellValue('anything', 'TEXT')).toBeNull();
    });
});

import { validateCustomCreateTableDdl } from '../migration/ddlValidation';

describe('validateCustomCreateTableDdl', () => {
    const columns = ['ID', 'AMOUNT', 'CREATED_AT'];

    it('accepts DDL that keeps all target column names', () => {
        const ddl = 'CREATE TABLE ADMIN.SALES_COPY (ID BIGINT, AMOUNT NUMERIC(18,2), CREATED_AT TIMESTAMP)';
        const result = validateCustomCreateTableDdl(ddl, columns);
        expect(result.valid).toBe(true);
    });

    it('accepts adjusted types as long as column names remain', () => {
        const ddl = 'CREATE TABLE ADMIN.SALES_COPY (ID VARCHAR(50), AMOUNT DOUBLE PRECISION, CREATED_AT DATE)';
        const result = validateCustomCreateTableDdl(ddl, columns);
        expect(result.valid).toBe(true);
    });

    it('rejects empty DDL', () => {
        const result = validateCustomCreateTableDdl('   ', columns);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('empty');
    });

    it('rejects DDL without CREATE TABLE', () => {
        const result = validateCustomCreateTableDdl('DROP TABLE ADMIN.SALES_COPY', columns);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('CREATE TABLE');
    });

    it('rejects DDL missing a mapped column name', () => {
        const ddl = 'CREATE TABLE ADMIN.SALES_COPY (ID BIGINT, AMOUNT NUMERIC(18,2))';
        const result = validateCustomCreateTableDdl(ddl, columns);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('CREATED_AT');
    });

    it('rejects DDL where a column was renamed', () => {
        const ddl = 'CREATE TABLE ADMIN.SALES_COPY (ID BIGINT, TOTAL NUMERIC(18,2), CREATED_AT TIMESTAMP)';
        const result = validateCustomCreateTableDdl(ddl, columns);
        expect(result.valid).toBe(false);
        expect(result.message).toContain('AMOUNT');
    });

    it('accepts case-insensitive and quoted column names', () => {
        const result = validateCustomCreateTableDdl(
            'CREATE TABLE T (id bigint, "AMOUNT" numeric, created_at timestamp)',
            columns,
        );
        expect(result.valid).toBe(true);
    });

    it('rejects a custom DDL that changes the migration target', () => {
        const result = validateCustomCreateTableDdl(
            'CREATE TABLE ADMIN.OTHER_TABLE (ID BIGINT, AMOUNT NUMERIC(18,2), CREATED_AT TIMESTAMP)',
            columns,
            'ADMIN.SALES_COPY',
        );
        expect(result.valid).toBe(false);
        expect(result.message).toContain('ADMIN.SALES_COPY');
    });

    it('rejects a custom DDL with an additional CREATE TABLE statement', () => {
        const result = validateCustomCreateTableDdl(
            'CREATE TABLE ADMIN.PREPENDED (ID BIGINT); CREATE TABLE ADMIN.SALES_COPY (ID BIGINT, AMOUNT NUMERIC(18,2), CREATED_AT TIMESTAMP)',
            columns,
            'ADMIN.SALES_COPY',
        );
        expect(result.valid).toBe(false);
        expect(result.message).toContain('ADMIN.SALES_COPY');
    });
});

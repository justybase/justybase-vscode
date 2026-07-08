import {
    isQuotedIdentifier,
    unquoteIdentifier,
    quoteIdentifier,
    requiresIdentifierQuoting,
    formatIdentifierForSql,
    formatQualifiedObjectName,
    formatQualifiedObjectPathForDisplay
} from '../utils/identifierUtils';

describe('identifierUtils', () => {
    it('detects quoted identifiers', () => {
        expect(isQuotedIdentifier('"lower_case_name"')).toBe(true);
        expect(isQuotedIdentifier('LOWER_CASE_NAME')).toBe(false);
    });

    it('unquotes and unescapes quoted identifiers', () => {
        expect(unquoteIdentifier('"my""name"')).toBe('my"name');
    });

    it('quotes identifiers when needed', () => {
        expect(quoteIdentifier('lower_case_name')).toBe('"lower_case_name"');
    });

    it('detects identifiers that require quoting', () => {
        expect(requiresIdentifierQuoting('LOWER_CASE_NAME')).toBe(false);
        expect(requiresIdentifierQuoting('lower_case_name')).toBe(true);
        expect(requiresIdentifierQuoting('name with space')).toBe(true);
        expect(requiresIdentifierQuoting('PROC_NAME()')).toBe(false);
        expect(requiresIdentifierQuoting('lower_case_name()')).toBe(true);
    });

    it('uses SQLite case-insensitive quoting rules', () => {
        expect(requiresIdentifierQuoting('sales', 'sqlite')).toBe(false);
        expect(requiresIdentifierQuoting('Sales', 'sqlite')).toBe(false);
        expect(requiresIdentifierQuoting('select', 'sqlite')).toBe(true);
        expect(requiresIdentifierQuoting('name with space', 'sqlite')).toBe(true);
    });

    it('uses DuckDB case-insensitive quoting rules with reserved keyword checks', () => {
        expect(requiresIdentifierQuoting('orders', 'duckdb')).toBe(false);
        expect(requiresIdentifierQuoting('OrderItems', 'duckdb')).toBe(false);
        expect(requiresIdentifierQuoting('select', 'duckdb')).toBe(true);
        expect(formatIdentifierForSql('orders', 'duckdb')).toBe('orders');
        expect(formatIdentifierForSql('OrderItems', 'duckdb')).toBe('OrderItems');
        expect(formatIdentifierForSql('select', 'duckdb')).toBe('"select"');
    });

    it('formats identifiers for SQL', () => {
        expect(formatIdentifierForSql('LOWER_CASE_NAME')).toBe('LOWER_CASE_NAME');
        expect(formatIdentifierForSql('lower_case_name')).toBe('"lower_case_name"');
        expect(formatIdentifierForSql('"lower_case_name"')).toBe('"lower_case_name"');
        expect(formatIdentifierForSql('PROC_NAME()')).toBe('PROC_NAME()');
        expect(formatIdentifierForSql('lower_case_name()')).toBe('"lower_case_name"()');
        expect(formatIdentifierForSql('"lower_case_name"()')).toBe('"lower_case_name"()');
    });

    it('formats SQLite identifiers without preserving case via quotes', () => {
        expect(formatIdentifierForSql('sales', 'sqlite')).toBe('sales');
        expect(formatIdentifierForSql('Sales', 'sqlite')).toBe('Sales');
        expect(formatIdentifierForSql('order', 'sqlite')).toBe('"order"');
    });

    it('uses PostgreSQL lowercase-friendly quoting rules', () => {
        expect(requiresIdentifierQuoting('orders', 'postgresql')).toBe(false);
        expect(requiresIdentifierQuoting('"orders"', 'postgresql')).toBe(false);
        expect(requiresIdentifierQuoting('OrderItems', 'postgresql')).toBe(true);
        expect(requiresIdentifierQuoting('select', 'postgresql')).toBe(true);
        expect(formatIdentifierForSql('orders', 'postgresql')).toBe('orders');
        expect(formatIdentifierForSql('"orders"', 'postgresql')).toBe('orders');
        expect(formatIdentifierForSql('order_id', 'postgresql')).toBe('order_id');
        expect(formatIdentifierForSql('OrderItems', 'postgresql')).toBe('"OrderItems"');
        expect(formatIdentifierForSql('orders()', 'postgresql')).toBe('orders()');
    });

    it('uses MySQL case-insensitive backtick quoting rules', () => {
        expect(requiresIdentifierQuoting('orders', 'mysql')).toBe(false);
        expect(requiresIdentifierQuoting('OrderItems', 'mysql')).toBe(false);
        expect(requiresIdentifierQuoting('select', 'mysql')).toBe(true);
        expect(requiresIdentifierQuoting('name with space', 'mysql')).toBe(true);
        expect(formatIdentifierForSql('orders', 'mysql')).toBe('orders');
        expect(formatIdentifierForSql('OrderItems', 'mysql')).toBe('OrderItems');
        expect(formatIdentifierForSql('select', 'mysql')).toBe('`select`');
        expect(formatIdentifierForSql('`select`', 'mysql')).toBe('`select`');
        expect(formatIdentifierForSql('orders()', 'mysql')).toBe('orders()');
    });

    it('formats qualified SQLite object names with two-part notation', () => {
        expect(formatQualifiedObjectName('main', undefined, 'sales', 'sqlite')).toBe('main.sales');
        expect(formatQualifiedObjectName('main', 'analytics', 'sales', 'sqlite')).toBe('analytics.sales');
        expect(formatQualifiedObjectName(undefined, 'main', 'select', 'sqlite')).toBe('main."select"');
    });

    it('formats qualified MySQL object names with database-style notation', () => {
        expect(formatQualifiedObjectName('catalog', undefined, 'sales', 'mysql')).toBe('catalog.sales');
        expect(formatQualifiedObjectName('catalog', 'analytics', 'sales', 'mysql')).toBe('analytics.sales');
        expect(formatQualifiedObjectName(undefined, 'analytics', 'select', 'mysql')).toBe('analytics.`select`');
    });

    it('formats qualified PostgreSQL object names with schema-only two-part notation', () => {
        // PostgreSQL does not support 3-part references (database.schema.table)
        // It only supports 2-part notation (schema.table) within the current database
        expect(formatQualifiedObjectName('testdb', 'public', 'orders', 'postgresql')).toBe('public.orders');
        expect(formatQualifiedObjectName('testdb', 'myschema', 'users', 'postgresql')).toBe('myschema.users');
        expect(formatQualifiedObjectName(undefined, 'public', 'orders', 'postgresql')).toBe('public.orders');
        expect(formatQualifiedObjectName('testdb', 'public', 'select', 'postgresql')).toBe('public."select"');
    });

    it('formats qualified display paths with SQLite rules', () => {
        expect(formatQualifiedObjectPathForDisplay('main', undefined, 'sales', 'sqlite')).toBe('main.sales');
        expect(formatQualifiedObjectPathForDisplay('main', 'analytics', 'sales', 'sqlite')).toBe('analytics.sales');
        expect(formatQualifiedObjectPathForDisplay('DB1', 'ADMIN', 'USERS')).toBe('DB1.ADMIN.USERS');
    });

    it('formats qualified display paths with MySQL rules', () => {
        expect(formatQualifiedObjectPathForDisplay('catalog', undefined, 'sales', 'mysql')).toBe('catalog.sales');
        expect(formatQualifiedObjectPathForDisplay('catalog', 'analytics', 'sales', 'mysql')).toBe('analytics.sales');
    });
});

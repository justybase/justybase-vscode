import {
    alterColumnSql,
    callRoutineSql,
    countRowsSql,
    createIndexSql,
    createTableFromSql,
    duplicateRowsSql,
    isSafeSqlDataType,
    isSafeSqliteAddColumnDefault,
    postgresTableStorageSql,
    quoteIdentifierListForKind,
    schemaValueSearchSql,
    supportsSchemaValueSearch,
} from '../commands/schema/menuSql';

describe('schema menu SQL generators', () => {
    it('builds a count query and groups duplicate keys', () => {
        expect(countRowsSql('"sales"."orders"')).toBe('SELECT COUNT(*) AS row_count FROM "sales"."orders";');
        expect(duplicateRowsSql('"sales"."orders"', '"account_id", "order_no"')).toBe(
            'SELECT "account_id", "order_no", COUNT(*) AS duplicate_count\nFROM "sales"."orders"\nGROUP BY "account_id", "order_no"\nHAVING COUNT(*) > 1\nORDER BY duplicate_count DESC;',
        );
        expect(() => duplicateRowsSql('t', '  ')).toThrow('Choose at least one column');
    });

    it('builds PostgreSQL and Db2 column changes with dialect syntax', () => {
        expect(alterColumnSql('postgresql', '"public"."orders"', '"quantity"', {
            operation: 'setType', dataType: 'BIGINT', using: '"quantity"::bigint',
        })).toBe('ALTER TABLE "public"."orders" ALTER COLUMN "quantity" TYPE BIGINT USING "quantity"::bigint;');
        expect(alterColumnSql('db2', '"SALES"."ORDERS"', '"QUANTITY"', {
            operation: 'setType', dataType: 'DECIMAL(12,2)',
        })).toBe('ALTER TABLE "SALES"."ORDERS" ALTER COLUMN "QUANTITY" SET DATA TYPE DECIMAL(12,2);');
        expect(alterColumnSql('postgresql', 't', 'c', { operation: 'setNotNull' })).toBe('ALTER TABLE t ALTER COLUMN c SET NOT NULL;');
        expect(alterColumnSql('db2', 't', 'c', { operation: 'dropNotNull' })).toBe('ALTER TABLE t ALTER COLUMN c DROP NOT NULL;');
        expect(alterColumnSql('postgresql', 't', 'c', { operation: 'setDefault', expression: 'CURRENT_TIMESTAMP' }))
            .toBe('ALTER TABLE t ALTER COLUMN c SET DEFAULT CURRENT_TIMESTAMP;');
        expect(alterColumnSql('db2', 't', 'c', { operation: 'dropDefault' })).toBe('ALTER TABLE t ALTER COLUMN c DROP DEFAULT;');
        expect(() => alterColumnSql('postgresql', 't', 'c', { operation: 'setType', dataType: 'INTEGER; DROP TABLE t' })).toThrow('SQL type');
        expect(() => alterColumnSql('sqlite', 't', 'c', { operation: 'dropDefault' })).toThrow('available here for PostgreSQL, Db2, and DuckDB');
    });

    it('builds validated PostgreSQL fillfactor and tablespace changes', () => {
        expect(postgresTableStorageSql('"public"."orders"', { operation: 'setFillfactor', value: 75 }))
            .toBe('ALTER TABLE "public"."orders" SET (fillfactor = 75);');
        expect(postgresTableStorageSql('"public"."orders"', { operation: 'resetFillfactor' }))
            .toBe('ALTER TABLE "public"."orders" RESET (fillfactor);');
        expect(postgresTableStorageSql('"public"."orders"', { operation: 'setTablespace', name: 'fast_data' }))
            .toBe('ALTER TABLE "public"."orders" SET TABLESPACE "fast_data";');
        expect(() => postgresTableStorageSql('t', { operation: 'setFillfactor', value: 101 }))
            .toThrow('fillfactor must be a whole number from 10 to 100');
        expect(() => postgresTableStorageSql('t', { operation: 'setTablespace', name: 'fast; DROP TABLE t' }))
            .toThrow('valid PostgreSQL tablespace name');
    });

    it('limits SQLite ADD COLUMN defaults to literal values', () => {
        for (const expression of ['NULL', '0', '-12.5', "'active'", "'O''Brien'", "X'ABCD'", 'TRUE']) {
            expect(isSafeSqliteAddColumnDefault(expression)).toBe(true);
        }
        for (const expression of ['CURRENT_TIMESTAMP', '(1 + 2)', "'x'; DROP TABLE t", 'random()']) {
            expect(isSafeSqliteAddColumnDefault(expression)).toBe(false);
        }
    });

    it('validates SQL data type expressions', () => {
        expect(isSafeSqlDataType('VARCHAR(255)')).toBe(true);
        expect(isSafeSqlDataType('DECIMAL(12,2)')).toBe(true);
        expect(isSafeSqlDataType('DECIMAL(12, 2)')).toBe(false);
        expect(isSafeSqlDataType('INTEGER; DROP TABLE t')).toBe(false);
        expect(isSafeSqlDataType('')).toBe(false);
    });

    it('quotes column lists per dialect', () => {
        expect(quoteIdentifierListForKind('Account_Id, ORDER_NO', 'postgresql')).toBe('"Account_Id", "ORDER_NO"');
        expect(quoteIdentifierListForKind('account_id, order_no', 'postgresql')).toBe('account_id, order_no');
        expect(quoteIdentifierListForKind('  ', 'postgresql')).toBe('');
    });

    it('searches text literally and numeric columns by exact value across tables', () => {
        const targets = [
            { location: 'sales.orders.customer_name', qualifiedTableName: '"sales"."orders"', quotedColumnName: '"customer_name"', dataType: 'VARCHAR(80)' },
            { location: 'sales.orders.amount', qualifiedTableName: '"sales"."orders"', quotedColumnName: '"amount"', dataType: 'DECIMAL(12,2)' },
            { location: 'sales.orders.created_at', qualifiedTableName: '"sales"."orders"', quotedColumnName: '"created_at"', dataType: 'TIMESTAMP' },
        ];
        expect(schemaValueSearchSql('postgresql', "O'Neil_%!", targets)).toBe("-- Each match_value contains at most the first 16,000 characters.\nWITH search_input(search_text) AS (VALUES (LOWER(CAST('%O''Neil!_!%!!%' AS TEXT))))\nSELECT 'sales.orders.customer_name' AS match_location, SUBSTR(CAST(\"customer_name\" AS TEXT), 1, 16000) AS match_value\nFROM \"sales\".\"orders\"\nCROSS JOIN search_input\nWHERE LOWER(CAST(\"customer_name\" AS TEXT)) LIKE search_input.search_text ESCAPE '!';");
        const numericSearch = schemaValueSearchSql('postgresql', '12', targets);
        expect(numericSearch).toContain('WHERE "amount" = 12');
        expect(numericSearch).toContain("LOWER(CAST('%12%' AS TEXT))");
        expect(() => schemaValueSearchSql('postgresql', '', [])).toThrow('Enter text or a number');
        expect(() => schemaValueSearchSql('postgresql', 'needle', [{ location: 't.c', qualifiedTableName: 't', quotedColumnName: 'c', dataType: 'BLOB' }]))
            .toThrow('No text or numeric columns');
        expect(() => schemaValueSearchSql('db2', 'needle', [
            { location: 't.clob_col', qualifiedTableName: 't', quotedColumnName: 'clob_col', dataType: 'CLOB' },
            { location: 't.xml_col', qualifiedTableName: 't', quotedColumnName: 'xml_col', dataType: 'XML' },
        ])).toThrow('No text or numeric columns');
        expect(() => schemaValueSearchSql('netezza', 'needle', [
            { location: 't.nvarchar_col', qualifiedTableName: 't', quotedColumnName: 'nvarchar_col', dataType: 'NVARCHAR(80)' },
            { location: 't.json_col', qualifiedTableName: 't', quotedColumnName: 'json_col', dataType: 'JSON' },
        ])).toThrow('No text or numeric columns');
    });

    it('uses dialect-safe casts and Netezza string escaping, and hides unsupported dialects', () => {
        const text = [{ location: 'S.T.C', qualifiedTableName: '"S"."T"', quotedColumnName: '"C"', dataType: 'VARCHAR(80)' }];
        expect(schemaValueSearchSql('netezza', 'C:\\data', text)).toContain("'%C:\\\\data%'");
        expect(schemaValueSearchSql('db2', 'needle', text)).toContain('SUBSTR(CAST("C" AS VARCHAR(32672)), 1, 16000) AS match_value');
        expect(schemaValueSearchSql('sqlite', 'needle', [{ ...text[0], dataType: 'TEXT' }])).toContain('CAST("C" AS TEXT)');
        expect(schemaValueSearchSql('duckdb', 'needle', [{ ...text[0], dataType: 'JSON' }])).toContain('CAST("C" AS VARCHAR)');
        expect(supportsSchemaValueSearch('duckdb')).toBe(true);
        expect(supportsSchemaValueSearch('oracle')).toBe(false);
        expect(() => schemaValueSearchSql('oracle', 'needle', text)).toThrow('supported for Netezza, PostgreSQL, Db2, SQLite, and DuckDB');
    });

    it('uses the destination syntax for CTAS across supported dialects', () => {
        expect(createTableFromSql('postgresql', '"public"."copy"', '"public"."source"', 'id > 10;')).toBe(
            'CREATE TABLE "public"."copy" AS SELECT * FROM "public"."source" WHERE id > 10;',
        );
        expect(createTableFromSql('db2', '"S"."COPY"', '"S"."SOURCE"')).toBe(
            'CREATE TABLE "S"."COPY" AS (SELECT * FROM "S"."SOURCE") WITH DATA;',
        );
        expect(createTableFromSql('netezza', '"DB"."S"."COPY"', '"DB"."S"."SOURCE"')).toBe(
            'CREATE TABLE "DB"."S"."COPY" AS (SELECT * FROM "DB"."S"."SOURCE") DISTRIBUTE ON RANDOM;',
        );
        expect(createTableFromSql('sqlite', '"main"."copy"', '"main"."source"')).toBe(
            'CREATE TABLE "main"."copy" AS SELECT * FROM "main"."source";',
        );
        expect(createTableFromSql('duckdb', '"main"."copy"', '"main"."source"', 'id > 10')).toBe(
            'CREATE TABLE "main"."copy" AS SELECT * FROM "main"."source" WHERE id > 10;',
        );
    });

    it('builds DuckDB ART indexes and column changes without unsupported options', () => {
        expect(createIndexSql('duckdb', '"main"."employees_name_idx"', '"main"."employees"', '"name"'))
            .toBe('CREATE INDEX "main"."employees_name_idx" ON "main"."employees" ("name");');
        expect(createIndexSql('duckdb', '"main"."employees_id_idx"', '"main"."employees"', '"id"', { unique: true }))
            .toBe('CREATE UNIQUE INDEX "main"."employees_id_idx" ON "main"."employees" ("id");');
        expect(alterColumnSql('duckdb', '"main"."employees"', '"salary"', {
            operation: 'setType', dataType: 'DECIMAL(18,2)', using: 'salary::DECIMAL(18,2)',
        })).toBe('ALTER TABLE "main"."employees" ALTER COLUMN "salary" SET DATA TYPE DECIMAL(18,2) USING salary::DECIMAL(18,2);');
        expect(() => alterColumnSql('duckdb', 't', 'c', { operation: 'setDefault', expression: '1; DROP TABLE t' }))
            .toThrow('without a statement terminator');
    });

    it('applies PostgreSQL index method, include, partial and concurrent options', () => {
        expect(createIndexSql('postgresql', '"public"."ix_orders"', '"public"."orders"', '"customer_id"', {
            unique: true, method: 'btree', includeColumns: '"created_at"', predicate: 'deleted_at IS NULL;', concurrently: true,
        })).toBe('CREATE UNIQUE INDEX CONCURRENTLY "public"."ix_orders" ON "public"."orders" USING btree ("customer_id") INCLUDE ("created_at") WHERE deleted_at IS NULL;');
        expect(createIndexSql('postgresql', '"public"."ix_search"', '"public"."orders"', '"document"', { method: 'gin' }))
            .toBe('CREATE INDEX "public"."ix_search" ON "public"."orders" USING gin ("document");');
        expect(() => createIndexSql('postgresql', 'ix', 't', 'k', { method: 'bad' })).toThrow('supported PostgreSQL index method');
        expect(() => createIndexSql('postgresql', 'ix', 't', 'k', { method: 'gin', includeColumns: 'included' })).toThrow('do not support INCLUDE');
        expect(() => createIndexSql('postgresql', 'ix', 't', 'k', { method: 'hash', unique: true })).toThrow('unique indexes currently require the btree method');
    });

    it('applies Db2 unique/include/cluster/compression/PCTFREE options', () => {
        expect(createIndexSql('db2', '"S"."IX_ORDERS"', '"S"."ORDERS"', '"ID" DESC', {
            unique: true, includeColumns: '"LABEL"', clustered: true, compress: true, pctFree: 17,
        })).toBe('CREATE UNIQUE INDEX "S"."IX_ORDERS" ON "S"."ORDERS" ("ID" DESC) INCLUDE ("LABEL") CLUSTER COMPRESS YES PCTFREE 17;');
        expect(() => createIndexSql('db2', 'ix', 't', 'k', { pctFree: 100 })).toThrow('PCTFREE must be a whole number from 0 to 99');
    });

    it('builds calls and function selects using each dialect form', () => {
        expect(callRoutineSql('postgresql', 'PROCEDURE', '"public"."refresh"', '42')).toBe('CALL "public"."refresh"(42);');
        expect(callRoutineSql('oracle', 'PROCEDURE', '"APP"."REFRESH"')).toBe('BEGIN\n  "APP"."REFRESH"();\nEND;\n/');
        expect(callRoutineSql('db2', 'FUNCTION', '"S"."NEXT_VALUE"', '7')).toBe('VALUES "S"."NEXT_VALUE"(7);');
        expect(callRoutineSql('oracle', 'FUNCTION', '"APP"."TOTAL"', '1, 2')).toBe('SELECT "APP"."TOTAL"(1, 2) AS result FROM DUAL;');
        expect(() => callRoutineSql('sqlite', 'PROCEDURE', '"main"."refresh"')).toThrow('SQLite does not support stored procedures');
    });
});

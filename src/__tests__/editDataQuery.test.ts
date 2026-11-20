import {
    buildEditDataQualifiedTableName,
    buildEditDataQueryPlan,
    buildPrimaryKeyLocatorExpression,
    buildPrimaryKeyLocatorPredicate,
} from '../views/editDataQuery';

describe('edit data query planning', () => {
    describe('buildEditDataQualifiedTableName', () => {
        it('keeps the historical Netezza DB.SCHEMA.TABLE form', () => {
            expect(buildEditDataQualifiedTableName('TESTDB', 'PUBLIC', 'USERS', 'netezza'))
                .toBe('TESTDB.PUBLIC.USERS');
            expect(buildEditDataQualifiedTableName('TESTDB', '', 'USERS', 'netezza'))
                .toBe('TESTDB..USERS');
        });

        it('drops the database part for PostgreSQL', () => {
            expect(buildEditDataQualifiedTableName('testdb', 'public', 'users', 'postgresql'))
                .toBe('public.users');
            expect(buildEditDataQualifiedTableName('testdb', 'public', 'user table', 'postgresql'))
                .toBe('public."user table"');
        });

        it('uses the catalog container for schema-less SQLite tables', () => {
            expect(buildEditDataQualifiedTableName('main', '', 'users', 'sqlite'))
                .toBe('main.users');
        });

        it('keeps DuckDB catalog/schema qualification', () => {
            expect(buildEditDataQualifiedTableName('analytics', 'main', 'events', 'duckdb'))
                .toBe('analytics.main.events');
        });

        it.each([
            ['oracle', 'ORCL', 'HR', 'EMPLOYEES', 'HR.EMPLOYEES'],
            ['mssql', 'DB', 'dbo', 'orders', 'DB.dbo.orders'],
            ['mysql', 'shop', 'ignored', 'orders', 'shop.orders'],
            ['clickhouse', 'analytics', 'ignored', 'events', 'analytics.events'],
            ['snowflake', 'DB', 'PUBLIC', 'EVENTS', 'DB.PUBLIC.EVENTS'],
            ['vertica', 'DB', 'public', 'events', 'DB.public.events'],
        ])('qualifies %s tables without the Netezza three-part assumption', (
            kind,
            database,
            schema,
            table,
            expected,
        ) => {
            expect(buildEditDataQualifiedTableName(database, schema, table, kind)).toBe(expected);
        });
    });

    describe('buildEditDataQueryPlan', () => {
        it('selects ROWID and orders by it only when editing is enabled', () => {
            const plan = buildEditDataQueryPlan({
                database: 'testdb',
                schema: 'public',
                table: 'users',
                databaseKind: 'netezza',
                editable: true,
                rowLimit: 50000,
            });

            expect(plan.qualifiedTableName).toBe('testdb.public.users');
            expect(plan.sql).toBe('SELECT ROWID AS ROWID, * FROM testdb.public.users ORDER BY ROWID LIMIT 50000');
        });

        it('omits ROWID for PostgreSQL so View Data succeeds read-only', () => {
            const plan = buildEditDataQueryPlan({
                database: 'testdb',
                schema: 'public',
                table: 'users',
                databaseKind: 'postgresql',
                editable: false,
                rowLimit: 50000,
            });

            expect(plan.qualifiedTableName).toBe('public.users');
            expect(plan.sql).toBe('SELECT * FROM public.users LIMIT 50000');
        });

        it.each([
            [
                'mssql',
                'DB',
                'dbo',
                'orders',
                'SELECT TOP (50000) * FROM DB.dbo.orders',
            ],
            [
                'oracle',
                'ORCL',
                'HR',
                'EMPLOYEES',
                'SELECT * FROM HR.EMPLOYEES FETCH FIRST 50000 ROWS ONLY',
            ],
            [
                'db2',
                'DB1',
                'PUBLIC',
                'ORDERS',
                'SELECT * FROM DB1.PUBLIC.ORDERS FETCH FIRST 50000 ROWS ONLY',
            ],
        ] as const)('uses the %s row-limit syntax for read-only View Data', (
            kind,
            database,
            schema,
            table,
            expected,
        ) => {
            const plan = buildEditDataQueryPlan({
                database,
                schema,
                table,
                databaseKind: kind,
                editable: false,
                rowLimit: 50000,
            });

            expect(plan.sql).toBe(expected);
        });

        it('keeps user filters and columns for read-only dialects', () => {
            const plan = buildEditDataQueryPlan({
                database: 'testdb',
                schema: 'public',
                table: 'users',
                databaseKind: 'postgresql',
                editable: false,
                filters: {
                    whereClause: 'WHERE id > 10',
                    columns: 'id, name',
                    orderBy: 'ORDER BY name DESC',
                },
                rowLimit: 50000,
            });

            expect(plan.sql).toBe(
                'SELECT id, name FROM public.users WHERE id > 10 ORDER BY name DESC LIMIT 50000',
            );
        });

        it('prefixes ROWID for explicit editable projections', () => {
            const plan = buildEditDataQueryPlan({
                database: 'main',
                schema: '',
                table: 'users',
                databaseKind: 'sqlite',
                editable: true,
                filters: { columns: 'id, name' },
                rowLimit: 50000,
            });

            expect(plan.sql).toBe(
                'SELECT ROWID AS ROWID, id, name FROM main.users ORDER BY ROWID LIMIT 50000',
            );
        });

        it('encodes a PostgreSQL primary key instead of ROWID', () => {
            const plan = buildEditDataQueryPlan({
                database: 'testdb',
                schema: 'public',
                table: 'users',
                databaseKind: 'postgresql',
                editable: true,
                primaryKeyColumns: ['id'],
                rowLimit: 50000,
            });

            expect(plan.sql).toBe(
                'SELECT pg_catalog.jsonb_build_array(id::text)::text AS "ROWID", * FROM public.users ORDER BY id LIMIT 50000',
            );
        });

        it('keeps explicit columns and orders composite keys', () => {
            const plan = buildEditDataQueryPlan({
                database: 'testdb',
                schema: 'public',
                table: 'users',
                databaseKind: 'postgresql',
                editable: true,
                primaryKeyColumns: ['tenant_id', 'id'],
                filters: {
                    whereClause: 'WHERE active',
                    columns: 'id, name',
                },
                rowLimit: 50000,
            });

            expect(plan.sql).toBe(
                'SELECT pg_catalog.jsonb_build_array(tenant_id::text, id::text)::text AS "ROWID", id, name '
                + 'FROM public.users WHERE active ORDER BY tenant_id, id LIMIT 50000',
            );
        });

        it('builds primary-key predicates from the JSON locator', () => {
            expect(buildPrimaryKeyLocatorPredicate('["acme", 42]', ['tenant_id', 'id'], 'postgresql'))
                .toBe(`tenant_id = 'acme' AND id = 42`);
            expect(buildPrimaryKeyLocatorPredicate(`["O'Reilly"]`, ['name'], 'postgresql'))
                .toBe(`name = 'O''Reilly'`);
            expect(buildPrimaryKeyLocatorPredicate('["C:\\\\temp"]', ['path'], 'postgresql'))
                .toBe(`path = E'C:\\\\temp'`);
            expect(buildPrimaryKeyLocatorPredicate('[""]', ['code'], 'postgresql'))
                .toBe(`code = ''`);
            expect(buildPrimaryKeyLocatorPredicate('[null]', ['id'], 'postgresql'))
                .toBe('id IS NULL');
        });

        it('rejects malformed or unsupported primary-key locators', () => {
            expect(() => buildPrimaryKeyLocatorPredicate('not-json', ['id'], 'postgresql'))
                .toThrow('Invalid primary-key row locator');
            expect(() => buildPrimaryKeyLocatorPredicate('[1, 2]', ['id'], 'postgresql'))
                .toThrow('Invalid primary-key row locator');
            expect(() => buildPrimaryKeyLocatorPredicate('[[1]]', ['id'], 'postgresql'))
                .toThrow('Unsupported primary-key value');
        });

        it('limits primary-key locators to PostgreSQL', () => {
            expect(() => buildPrimaryKeyLocatorExpression(['id'], 'mysql'))
                .toThrow('only implemented for PostgreSQL');
            expect(() => buildPrimaryKeyLocatorExpression([], 'postgresql'))
                .toThrow('at least one column');
        });
    });
});

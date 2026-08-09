jest.unmock('chevrotain');

import * as fs from 'fs';
import { describe, expect, it } from '@jest/globals';
import { sqliteAdvancedFeatures } from '../../../dialects/sqlite/advancedFeatures';
import { sqliteMetadataProvider } from '../../../dialects/sqlite/metadata/provider';
import { normalizeSqliteExplainPlan } from '../../../dialects/sqlite/explainParser';
import { importDataToSqlite } from '../../../import/sqliteImporter';
import { exportQueryToStreamFile } from '../../../export/queryStreamExporter';
import { parseSqlStatements, SQLITE_SQL_PARSING_RUNTIME } from '../../../sqlParser/parsingRuntime';
import { createSqliteFixture, type SqliteFixture } from '../../fixtures/sqliteFixture';

describe('SQLite real-database fixture', () => {
    let fixture: SqliteFixture;

    beforeEach(async () => {
        fixture = await createSqliteFixture();
    });

    afterEach(async () => {
        await fixture.dispose();
    });

    it('executes native DML, literals, constraints, returning and transaction control', async () => {
        const literalRows = await fixture.query<{ customer_id: number }>(`INSERT INTO customers
            (email, display_name, score, active, created_at, notes)
            VALUES ('alice@example.test', 'Alice "A"', 99.9, 1, '2026-03-04 05:06:07', X'00FF')
            RETURNING customer_id`);
        const customerId = literalRows[0].customer_id;
        expect(customerId).toBeGreaterThan(0);

        const orderRows = await fixture.query<{ order_id: number; tax: number }>(`INSERT INTO orders
            (customer_id, status, amount, created_at)
            VALUES (${customerId}, 'PAID', 123.45, '2026-03-04T05:06:07Z')
            RETURNING order_id, tax`);
        const orderId = orderRows[0].order_id;
        expect(orderRows[0].tax).toBe(28.39);

        await fixture.execute(`INSERT INTO order_tags(order_id, tag) VALUES (${orderId}, 'priority'), (${orderId}, 'unicode-Ł')`);
        await fixture.execute(`INSERT INTO analytics.events(event_id, event_name, event_at)
            VALUES (1, 'login', '2026-03-04 05:06:07')`);

        const summary = await fixture.query<{ display_name: string; order_count: number; gross_total: number }>(
            'SELECT display_name, order_count, gross_total FROM customer_order_totals',
        );
        expect(summary).toEqual([{ display_name: 'Alice "A"', order_count: 1, gross_total: 151.84 }]);

        const audit = await fixture.query<{ event_type: string; payload: string }>(
            'SELECT event_type, payload FROM audit_log',
        );
        expect(audit[0].event_type).toBe('ORDER_CREATED');
        expect(JSON.parse(audit[0].payload)).toEqual({ order_id: orderId, amount: 123.45 });

        const windowRows = await fixture.query<{ order_id: number; position: number }>(`SELECT order_id,
            ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY amount DESC) AS position
            FROM orders`);
        expect(windowRows).toEqual([{ order_id: orderId, position: 1 }]);

        const recursiveRows = await fixture.query<{ N: number; LABEL: string }>(`WITH RECURSIVE numbers(n) AS (
            SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 5
        ) SELECT n AS N, CASE WHEN n % 2 = 0 THEN 'even' ELSE 'odd' END AS LABEL FROM numbers ORDER BY n`);
        expect(recursiveRows).toEqual([
            { N: 1, LABEL: 'odd' },
            { N: 2, LABEL: 'even' },
            { N: 3, LABEL: 'odd' },
            { N: 4, LABEL: 'even' },
            { N: 5, LABEL: 'odd' },
        ]);

        await fixture.execute('SAVEPOINT fixture_mutation');
        await fixture.execute(`UPDATE orders SET status = 'CANCELLED' WHERE order_id = ${orderId}`);
        await fixture.execute('ROLLBACK TO fixture_mutation');
        await fixture.execute('RELEASE fixture_mutation');
        expect((await fixture.query<{ status: string }>(`SELECT status FROM orders WHERE order_id = ${orderId}`))[0].status).toBe('PAID');

        const pragmas = await fixture.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
        expect(pragmas[0].foreign_keys).toBe(1);
        const blob = await fixture.query<{ notes: Uint8Array }>(`SELECT notes FROM customers WHERE customer_id = ${customerId}`);
        expect(Array.from(blob[0].notes)).toEqual([0, 255]);
    });

    it('runs EXPLAIN QUERY PLAN and validates complex/native SQL through the SQLite parser', async () => {
        const planRows = await fixture.query<{ id: number; parent: number; detail: string }>(
            'EXPLAIN QUERY PLAN SELECT * FROM orders WHERE customer_id = 1 ORDER BY created_at',
        );
        expect(planRows.length).toBeGreaterThan(0);
        expect(planRows.map(row => row.detail).join('\n')).toMatch(/SCAN|SEARCH/i);

        const rawPlan = planRows.map(row => `${row.id}\t${row.parent}\t0\t${row.detail}`).join('\n');
        expect(normalizeSqliteExplainPlan(rawPlan)).toContain('(cost=0..0 rows=0 width=0 conf=1)');

        const sql = `WITH paid AS (
            SELECT o.order_id, c.display_name, o.amount, o.tax
            FROM orders AS o JOIN customers AS c ON c.customer_id = o.customer_id
            WHERE o.status = 'PAID'
        )
        SELECT display_name, SUM(amount + tax) AS gross_total
        FROM paid GROUP BY display_name ORDER BY gross_total DESC`;
        const parsed = parseSqlStatements({ sql, runtime: SQLITE_SQL_PARSING_RUNTIME });
        expect(parsed.lexResult.errors).toHaveLength(0);
        expect(parsed.actionableParserErrors).toHaveLength(0);

        const unusualStatements = [
            "INSERT INTO customers(email, display_name, created_at) VALUES ('upsert@example.test', 'Upsert', '2026-04-01') ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name RETURNING customer_id",
            "INSERT OR IGNORE INTO customers(email, display_name, created_at) VALUES ('upsert@example.test', 'Ignored', '2026-04-01')",
            "SELECT NULLIF('', ''), COALESCE(NULL, 'fallback'), json_extract('{\"kind\":\"fixture\"}', '$.kind'), 'line\\nvalue', 'quote''value'",
            'PRAGMA table_xinfo(orders)',
            'PRAGMA index_list(orders)',
            'PRAGMA foreign_key_list(orders)',
        ];
        for (const statement of unusualStatements) {
            const result = parseSqlStatements({ sql: statement, runtime: SQLITE_SQL_PARSING_RUNTIME });
            expect(result.actionableParserErrors).toHaveLength(0);
        }
    });

    it('imports a CSV into the real fixture database and exports CSV, JSON and SQL', async () => {
        const importResult = await importDataToSqlite(
            fixture.csvPath,
            'imported_contacts',
            fixture.connectionDetails,
        );
        expect(importResult.success).toBe(true);
        expect(importResult.details?.rowsInserted).toBe(2);

        const importedRows = await fixture.query<{ CUSTOMER_NAME: string; SCORE: number; ACTIVE: number }>(
            'SELECT customer_name AS CUSTOMER_NAME, score AS SCORE, active AS ACTIVE FROM imported_contacts ORDER BY customer_name',
        );
        expect(importedRows).toHaveLength(2);
        expect(importedRows.map(row => row.CUSTOMER_NAME)).toEqual(['Import O\'Connor', 'Łukasz Żółć']);
        expect(importedRows.map(row => row.SCORE)).toEqual([42.5, 7.25]);

        const csvPath = `${fixture.rootPath}/export.csv`;
        const jsonPath = `${fixture.rootPath}/export.json`;
        const sqlPath = `${fixture.rootPath}/export.sql`;
        const query = 'SELECT customer_name, email, score, note FROM imported_contacts ORDER BY customer_name';

        expect(await exportQueryToStreamFile({ connection: fixture.connection, query, filePath: csvPath, format: 'csv' })).toBe(2);
        expect(fs.readFileSync(csvPath, 'utf8')).toContain("Import O'Connor,");
        expect(fs.readFileSync(csvPath, 'utf8')).toContain('"quoted, note"');

        expect(await exportQueryToStreamFile({ connection: fixture.connection, query, filePath: jsonPath, format: 'json' })).toBe(2);
        const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Array<Record<string, unknown>>;
        expect(json[0]).toMatchObject({ customer_name: 'Import O\'Connor', score: 42.5 });

        expect(await exportQueryToStreamFile({
            connection: fixture.connection,
            query,
            filePath: sqlPath,
            format: 'sql',
            sqlTargetTable: 'round_trip_contacts',
            sqlDialect: 'sqlite',
        })).toBe(2);
        expect(fs.readFileSync(sqlPath, 'utf8')).toContain("INSERT INTO round_trip_contacts");
        expect(fs.readFileSync(sqlPath, 'utf8')).toContain("'Import O''Connor'");
    });

    it('exposes attached-catalog metadata, keys, native DDL and maintenance-safe operations', async () => {
        const databases = await fixture.query<{ DATABASE: string }>(sqliteMetadataProvider.buildListDatabasesQuery());
        expect(databases.map(row => row.DATABASE)).toEqual(expect.arrayContaining(['main', 'temp', 'analytics']));

        const columns = await sqliteAdvancedFeatures.ddl!.getColumns!(fixture.connection, 'main', '', 'orders');
        expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['order_id', 'customer_id', 'amount', 'tax']));
        expect(columns.find(column => column.name === 'tax')?.fullTypeName).toBe('NUMERIC');

        const keys = await sqliteAdvancedFeatures.ddl!.getKeysInfo!(fixture.connection, 'main', '', 'orders');
        expect(keys.get('PRIMARY')?.columns).toEqual(['order_id']);
        expect(keys.get('FK_0')?.pkRelation).toBe('customers');

        const ddl = await sqliteAdvancedFeatures.ddl!.generateDDL(
            fixture.connectionDetails,
            'main',
            '',
            'orders',
            'TABLE',
        );
        expect(ddl.success).toBe(true);
        expect(ddl.ddlCode).toContain('GENERATED ALWAYS AS');

        await fixture.execute('ANALYZE orders');
        await fixture.execute('REINDEX orders_customer_created_idx');
        expect((await fixture.query<{ NAME: string }>("SELECT name AS NAME FROM main.sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")).map(row => row.NAME)).toContain('sqlite_stat1');
    });
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SqliteConnection } from '../../dialects/sqlite/runtime';
import type { ConnectionDetails } from '../../types';

export interface SqliteFixture {
    readonly rootPath: string;
    readonly databasePath: string;
    readonly csvPath: string;
    readonly connectionDetails: ConnectionDetails;
    readonly connection: SqliteConnection;
    execute(sql: string): Promise<void>;
    query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<T[]>;
    dispose(): Promise<void>;
}

async function readRows<T extends Record<string, unknown>>(
    connection: SqliteConnection,
    sql: string,
): Promise<T[]> {
    const reader = await connection.createCommand(sql).executeReader();
    const rows: T[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index += 1) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row as T);
        }
    } finally {
        await reader.close();
    }
    return rows;
}

/**
 * Creates a real, disposable SQLite database used by integration-style dialect tests.
 * The fixture intentionally exercises features that do not exist in the Netezza baseline:
 * generated columns, AUTOINCREMENT, WITHOUT ROWID, attached catalogs and triggers.
 */
export async function createSqliteFixture(): Promise<SqliteFixture> {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-sqlite-fixture-'));
    const databasePath = path.join(rootPath, 'fixture.sqlite');
    const csvPath = path.join(rootPath, 'contacts.csv');
    fs.writeFileSync(
        csvPath,
        [
            'customer_name,email,score,active,created_at,note',
            'Import O\'Connor,import.oconnor@example.test,42.5,1,2026-01-02 03:04:05,"quoted, note"',
            'Łukasz Żółć,lukasz@example.test,7.25,0,2026-02-03T04:05:06,"line one"',
        ].join('\n') + '\n',
        'utf8',
    );

    const connectionDetails: ConnectionDetails = {
        host: 'localhost',
        database: databasePath,
        user: 'sqlite-fixture',
        dbType: 'sqlite',
    };
    const connection = new SqliteConnection(connectionDetails);
    await connection.connect();

    const setupStatements = [
        'PRAGMA foreign_keys = ON',
        'CREATE TEMP TABLE temp_fixture_marker (marker TEXT)',
        `CREATE TABLE customers (
            customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            score REAL,
            active BOOLEAN NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            notes BLOB,
            CHECK (score IS NULL OR score >= 0)
        )`,
        `CREATE TABLE orders (
            order_id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'PAID', 'CANCELLED')),
            amount NUMERIC NOT NULL,
            tax NUMERIC GENERATED ALWAYS AS (ROUND(amount * 0.23, 2)) STORED,
            created_at TEXT NOT NULL
        )`,
        `CREATE TABLE order_tags (
            order_id INTEGER NOT NULL REFERENCES orders(order_id),
            tag TEXT NOT NULL,
            PRIMARY KEY (order_id, tag)
        ) WITHOUT ROWID`,
        `CREATE TABLE audit_log (
            event_id INTEGER PRIMARY KEY,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL
        )`,
        'CREATE INDEX orders_customer_created_idx ON orders(customer_id, created_at)',
        'CREATE UNIQUE INDEX customers_display_name_uq ON customers(display_name)',
        `CREATE VIEW customer_order_totals AS
            SELECT c.customer_id, c.display_name, COUNT(o.order_id) AS order_count,
                   COALESCE(SUM(o.amount + o.tax), 0) AS gross_total
            FROM customers AS c
            LEFT JOIN orders AS o ON o.customer_id = c.customer_id
            GROUP BY c.customer_id, c.display_name`,
        `CREATE TRIGGER orders_audit_after_insert
            AFTER INSERT ON orders
            BEGIN
                INSERT INTO audit_log(event_type, payload)
                VALUES ('ORDER_CREATED', json_object('order_id', NEW.order_id, 'amount', NEW.amount));
            END`,
        "ATTACH DATABASE ':memory:' AS analytics",
        `CREATE TABLE analytics.events (
            event_id INTEGER PRIMARY KEY,
            event_name TEXT NOT NULL,
            event_at TEXT NOT NULL
        )`,
    ];

    try {
        for (const statement of setupStatements) {
            await connection.createCommand(statement).execute();
        }
    } catch (error) {
        await connection.close();
        fs.rmSync(rootPath, { recursive: true, force: true });
        throw error;
    }

    return {
        rootPath,
        databasePath,
        csvPath,
        connectionDetails,
        connection,
        execute: async (sql: string): Promise<void> => {
            await connection.createCommand(sql).execute();
        },
        query: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string): Promise<T[]> =>
            readRows<T>(connection, sql),
        dispose: async (): Promise<void> => {
            await connection.close();
            fs.rmSync(rootPath, { recursive: true, force: true });
        },
    };
}

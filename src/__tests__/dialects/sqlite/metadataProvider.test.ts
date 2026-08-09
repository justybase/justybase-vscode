import { describe, expect, it } from '@jest/globals';
import { sqliteMetadataProvider } from '../../../dialects/sqlite/metadata/provider';
import { SqliteConnection } from '../../../dialects/sqlite/runtime';

async function executeRows(connection: SqliteConnection, sql: string): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    const rows: Record<string, unknown>[] = [];
    try {
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index++) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row);
        }
    } finally {
        await reader.close();
    }
    return rows;
}

describe('SQLite metadata provider', () => {
    it('discovers attached catalogs and native object types from an in-memory database', async () => {
        const connection = new SqliteConnection({
            host: '',
            database: ':memory:',
            user: '',
            password: '',
        });
        await connection.connect();

        try {
            const setupStatements = [
                `CREATE TABLE orders (
                    id INTEGER PRIMARY KEY,
                    name TEXT,
                    name_length INT GENERATED ALWAYS AS (length(name)) STORED
                )`,
                'CREATE TEMP TABLE temp_orders(id INTEGER)',
                'CREATE VIEW order_names AS SELECT id, name FROM orders',
                'CREATE UNIQUE INDEX orders_name_uq ON orders(name)',
                `CREATE TRIGGER orders_ai AFTER INSERT ON orders
                BEGIN
                    UPDATE orders SET name = name WHERE id = NEW.id;
                END`,
                "ATTACH ':memory:' AS analytics",
                'CREATE TABLE analytics.events(id INTEGER, event_name TEXT)',
            ];
            for (const statement of setupStatements) {
                await connection.createCommand(statement).execute();
            }

            const databases = await executeRows(connection, sqliteMetadataProvider.buildListDatabasesQuery());
            expect(databases.map(row => row.DATABASE)).toEqual(expect.arrayContaining(['main', 'temp', 'analytics']));

            const indexes = await executeRows(connection, sqliteMetadataProvider.buildObjectTypeQuery('main', 'INDEX'));
            expect(indexes.map(row => row.OBJNAME)).toContain('orders_name_uq');

            const triggers = await executeRows(connection, sqliteMetadataProvider.buildObjectTypeQuery('main', 'TRIGGER'));
            expect(triggers.map(row => row.OBJNAME)).toContain('orders_ai');

            const columns = await executeRows(connection, sqliteMetadataProvider.buildColumnsWithKeysQuery('main', {
                tableName: 'orders',
                objTypes: ['TABLE'],
            }));
            expect(columns.map(row => row.ATTNAME)).toEqual(expect.arrayContaining(['id', 'name', 'name_length']));
            expect(columns.find(row => row.ATTNAME === 'name_length')?.FORMAT_TYPE).toBe('INT');

            const attachedColumns = await executeRows(connection, sqliteMetadataProvider.buildColumnsWithKeysQuery('analytics', {
                tableName: 'events',
                objTypes: ['TABLE'],
            }));
            expect(attachedColumns.map(row => row.ATTNAME)).toEqual(['id', 'event_name']);
        } finally {
            await connection.close();
        }
    });
});

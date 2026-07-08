import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { DatabaseDataReader } from '../../contracts/database';
import { createDatabaseConnectionFromDetails } from '../../core/connectionFactory';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import { DuckDbConnection } from '../../../extensions/duckdb/src/duckdbConnection';
import { duckdbDialect } from '../../../extensions/duckdb/src/duckdbDialect';
import { duckdbMetadataProvider } from '../../../extensions/duckdb/src/duckdbSchemaProvider';

const extensionRequire = createRequire(path.join(process.cwd(), 'extensions', 'duckdb', 'package.json'));

function hasDuckDbRuntime(): boolean {
    try {
        extensionRequire.resolve('@duckdb/node-api');
        return true;
    } catch {
        return false;
    }
}

async function readRows(reader: DatabaseDataReader): Promise<unknown[][]> {
    const rows: unknown[][] = [];
    try {
        while (await reader.read()) {
            const values: unknown[] = [];
            for (let index = 0; index < reader.fieldCount; index += 1) {
                values.push(reader.getValue(index));
            }
            rows.push(values);
        }
        return rows;
    } finally {
        await reader.close();
    }
}

async function readScalar(connection: DuckDbConnection, sql: string): Promise<unknown> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        expect(await reader.read()).toBe(true);
        return reader.getValue(0);
    } finally {
        await reader.close();
    }
}

const duckdbRuntimeAvailable = hasDuckDbRuntime();
const describeIfInstalled = duckdbRuntimeAvailable ? describe : describe.skip;

if (duckdbRuntimeAvailable) {
    registerDatabaseDialect(duckdbDialect);
}

describeIfInstalled('duckdb integration', () => {
    const tempDir = path.join(
        os.tmpdir(),
        `duckdb-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    const schemaName = 'analytics';
    // DuckDB derives the catalog name from the file stem, so keep it distinct from the schema name.
    const databasePath = path.join(tempDir, 'duckdb_live_validation.duckdb');

    beforeAll(() => {
        fs.mkdirSync(tempDir, { recursive: true });
    });

    afterAll(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('connects, creates schema objects, and executes round-trip SQL against a local DuckDB file', async () => {
        const connection = new DuckDbConnection({
            host: '',
            database: databasePath,
            user: '',
            password: '',
            options: {
                mode: 'file'
            }
        });

        await connection.connect();
        try {
            await connection.createCommand(`CREATE SCHEMA ${schemaName}`).execute();
            await connection.createCommand(`CREATE TABLE ${schemaName}.orders (id INTEGER PRIMARY KEY, customer_name VARCHAR)`).execute();
            await connection.createCommand(`INSERT INTO ${schemaName}.orders VALUES (1, 'Alice'), (2, 'Bob')`).execute();
            await connection.createCommand(`CREATE VIEW ${schemaName}.order_names AS SELECT customer_name FROM ${schemaName}.orders`).execute();

            const currentCatalog = await readScalar(connection, 'SELECT current_catalog()');
            expect(String(currentCatalog ?? '').length).toBeGreaterThan(0);

            const rows = await readRows(
                await connection.createCommand(`SELECT id, customer_name FROM ${schemaName}.orders ORDER BY id`).executeReader()
            );
            expect(rows).toEqual([
                [1, 'Alice'],
                [2, 'Bob']
            ]);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('reopens the local file cleanly through the shared connection factory', async () => {
        const connection = createDatabaseConnectionFromDetails({
            host: '',
            database: databasePath,
            user: '',
            password: '',
            dbType: 'duckdb',
            options: {
                mode: 'file'
            }
        }) as DuckDbConnection;

        await connection.connect();
        try {
            const rowCount = await readScalar(connection, `SELECT COUNT(*) AS ROW_COUNT FROM ${schemaName}.orders`);
            expect(Number(rowCount)).toBe(2);

            const contextRows = await readRows(
                await connection
                    .createCommand('SELECT current_catalog() AS CURRENT_CATALOG, current_schema() AS CURRENT_SCHEMA')
                    .executeReader()
            );
            expect(String(contextRows[0]?.[0] ?? '').length).toBeGreaterThan(0);
            expect(String(contextRows[0]?.[1] ?? '').length).toBeGreaterThan(0);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('runs metadata discovery queries against the created DuckDB objects using the saved database path', async () => {
        const connection = new DuckDbConnection({
            host: '',
            database: databasePath,
            user: '',
            password: '',
            options: {
                mode: 'file'
            }
        });

        await connection.connect();
        try {
            const schemaRows = await readRows(
                await connection.createCommand(duckdbMetadataProvider.buildListSchemasQuery(databasePath)).executeReader()
            );
            expect(schemaRows.some(row => String(row[0]) === schemaName)).toBe(true);

            const tableRows = await readRows(
                await connection
                    .createCommand(duckdbMetadataProvider.buildListTablesQuery(databasePath, schemaName))
                    .executeReader()
            );
            expect(tableRows.some(row => String(row[0]) === 'orders')).toBe(true);

            const columnRows = await readRows(
                await connection
                    .createCommand(
                        duckdbMetadataProvider.buildColumnsWithKeysQuery(databasePath, {
                            schema: schemaName,
                            tableName: 'orders'
                        })
                    )
                    .executeReader()
            );
            expect(columnRows.some(row => String(row[2]) === 'orders' && String(row[3]) === 'id')).toBe(true);
            expect(columnRows.some(row => String(row[2]) === 'orders' && String(row[3]) === 'customer_name')).toBe(true);

            const viewRows = await readRows(
                await connection
                    .createCommand(duckdbMetadataProvider.buildListViewsQuery(databasePath, schemaName))
                    .executeReader()
            );
            expect(viewRows.some(row => String(row[0]) === 'order_names')).toBe(true);
        } finally {
            await connection.close();
        }
    }, 120000);
});

if (!duckdbRuntimeAvailable) {
    console.log('⚠️ DuckDB integration test skipped: run npm install in extensions/duckdb to provide @duckdb/node-api.');
}

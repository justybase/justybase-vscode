import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import * as vscode from 'vscode';
import type { DatabaseDataReader, DatabaseMaintenanceServices, DatabaseMaintenanceTarget } from '../../contracts/database';
import { createDatabaseConnectionFromDetails } from '../../core/connectionFactory';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import { DuckDbConnection } from '../../../extensions/duckdb/src/duckdbConnection';
import { duckdbDialect } from '../../../extensions/duckdb/src/duckdbDialect';
import { duckdbDdlProvider } from '../../../extensions/duckdb/src/duckdbDdlProvider';
import { duckdbMetadataProvider } from '../../../extensions/duckdb/src/duckdbSchemaProvider';
import { duckdbMaintenanceProvider } from '../../../extensions/duckdb/src/duckdbMaintenanceProvider';
import {
    buildDuckDbExplainQuery,
    parseDuckDbExplainJson,
    renderDuckDbExplainPlan
} from '../../../extensions/duckdb/src/duckdbExplainParser';
import { duckdbTuningAdvisor } from '../../../extensions/duckdb/src/duckdbTuningAdvisor';
import { importDataToDuckDb } from '../../import/duckdbImporter';
import type { ConnectionDetails } from '../../types';

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

    it('connects in memory mode and executes a round-trip without persisting to disk', async () => {
        const connection = new DuckDbConnection({
            host: '',
            database: ':memory:',
            user: '',
            password: '',
            options: {
                mode: 'memory'
            }
        });

        await connection.connect();
        try {
            await connection.createCommand('CREATE TABLE ephemeral (id INTEGER, label VARCHAR)').execute();
            await connection.createCommand("INSERT INTO ephemeral VALUES (1, 'ram'), (2, 'disk')").execute();

            const rows = await readRows(
                await connection.createCommand('SELECT id, label FROM ephemeral ORDER BY id').executeReader()
            );
            expect(rows).toEqual([
                [1, 'ram'],
                [2, 'disk']
            ]);

            expect(connection.getCurrentCatalog()).toBe('memory');
            expect(connection.getCurrentSid()).toMatch(/^duckdb-/);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('retrieves columns and generates table/view DDL through the shared DDL provider', async () => {
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
            const columns = await duckdbDdlProvider.getColumns(connection, databasePath, schemaName, 'orders');
            const columnNames = columns.map(column => column.name);
            expect(columnNames).toEqual(expect.arrayContaining(['id', 'customer_name']));
            const idColumn = columns.find(column => column.name === 'id');
            expect(idColumn?.notNull).toBe(true);

            const tableDdl = await duckdbDdlProvider.generateTableDDL(connection, databasePath, schemaName, 'orders');
            expect(tableDdl).toContain('CREATE TABLE');
            expect(tableDdl).toMatch(/orders/i);

            const viewDdl = await duckdbDdlProvider.generateViewDDL(connection, databasePath, schemaName, 'order_names');
            expect(viewDdl).toMatch(/CREATE\s+(OR REPLACE\s+)?VIEW/i);
            expect(viewDdl).toMatch(/order_names/i);

            const statsRows = await readRows(
                await connection.createCommand(duckdbDdlProvider.buildTableStatsQuery(databasePath, schemaName, 'orders')).executeReader()
            );
            expect(Number(statsRows[0][0])).toBe(2);

            const skewRows = await readRows(
                await connection.createCommand(duckdbDdlProvider.buildSkewCheckQuery(`${schemaName}.orders`)).executeReader()
            );
            expect(skewRows).toHaveLength(1);
            expect(Number(skewRows[0][1])).toBe(2);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('produces a parseable EXPLAIN JSON plan and tuning recommendations for a live query', async () => {
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
            const explainSql = buildDuckDbExplainQuery(
                `SELECT id, customer_name FROM ${schemaName}.orders WHERE id > 0`
            );
            const rows = await readRows(await connection.createCommand(explainSql).executeReader());
            const explainText = String(rows[0]?.[1] ?? '');

            expect(explainText.length).toBeGreaterThan(0);

            const plan = parseDuckDbExplainJson(explainText);
            expect(plan.root.nodeType.length).toBeGreaterThan(0);
            expect(renderDuckDbExplainPlan(plan).length).toBeGreaterThan(0);

            const report = duckdbTuningAdvisor.analyze({
                sql: `SELECT id, customer_name FROM ${schemaName}.orders WHERE id > 0`,
                explainPlanText: explainText
            });
            expect(Array.isArray(report.recommendations)).toBe(true);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('imports a CSV file into a DuckDB table through the shared importer', async () => {
        const csvPath = path.join(tempDir, 'import-source.csv');
        fs.writeFileSync(csvPath, 'id,name\n1,Alice\n2,Bob\n', 'utf8');

        const connectionDetails: ConnectionDetails = {
            host: '',
            database: databasePath,
            user: '',
            password: '',
            options: { mode: 'file' },
            dbType: 'duckdb',
        };

        const result = await importDataToDuckDb(csvPath, 'imported_orders', connectionDetails);
        expect(result.success).toBe(true);
        expect(result.details?.rowsInserted).toBe(2);

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
            const rows = await readRows(
                await connection.createCommand('SELECT id, name FROM imported_orders ORDER BY id').executeReader()
            );
            expect(rows).toEqual([
                [1n, 'Alice'],
                [2n, 'Bob']
            ]);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('cancels a long-running query and keeps the connection usable', async () => {
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
            const command = connection.createCommand(
                'SELECT count(*) FROM range(5000000) a, range(5000000) b'
            );
            const readerPromise = command.executeReader();
            await new Promise(resolve => setTimeout(resolve, 500));
            await command.cancel();

            let cancelError: unknown;
            try {
                const reader = await readerPromise;
                await reader.close();
            } catch (error: unknown) {
                cancelError = error;
            }
            expect(cancelError).toBeDefined();
            expect(String(cancelError)).toMatch(/cancel|interrupt/i);

            const controlRows = await readRows(
                await connection.createCommand('SELECT COUNT(*) FROM ' + schemaName + '.orders').executeReader()
            );
            expect(Number(controlRows[0][0])).toBe(2);
        } finally {
            await connection.close();
        }
    }, 120000);

    it('runs VACUUM and ANALYZE through the shared maintenance provider against live objects', async () => {
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

        const executedSql: string[] = [];
        const target: DatabaseMaintenanceTarget = {
            connectionName: 'duckdb-integration',
            databaseName: databasePath,
            schemaName,
            tableName: 'orders',
            qualifiedName: `${schemaName}.orders`,
        };
        const services: DatabaseMaintenanceServices = {
            context: {} as never,
            async executeSql(sql: string): Promise<void> {
                executedSql.push(sql);
                await connection.createCommand(sql).execute();
            },
            async getConnectionDetails(): Promise<ConnectionDetails | undefined> {
                return undefined;
            },
            async openSqlDocument(): Promise<void> {
                return undefined;
            },
            async executeWithProgress<T>(_title: string, task: () => Promise<T>): Promise<T> {
                return task();
            },
            async executeAndReport(_target: DatabaseMaintenanceTarget, sql: string): Promise<void> {
                executedSql.push(sql);
                await connection.createCommand(sql).execute();
            },
            async executeQuery<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
                const rows = await readRows(await connection.createCommand(sql).executeReader());
                return rows.map(row => Object.fromEntries(
                    row.map((value, index) => [`COL_${index}`, value])
                )) as T[];
            },
        };

        try {
            (vscode.window.showWarningMessage as unknown as jest.Mock).mockResolvedValue('Yes, vacuum');
            await duckdbMaintenanceProvider.vacuumTable!(target, services);
            expect(executedSql.some(sql => sql.includes('VACUUM'))).toBe(true);

            executedSql.length = 0;
            (vscode.window.showInformationMessage as unknown as jest.Mock).mockResolvedValue('Yes, generate');
            await duckdbMaintenanceProvider.generateStatistics!(target, services);
            expect(executedSql.some(sql => sql.includes('ANALYZE'))).toBe(true);
        } finally {
            await connection.close();
        }
    }, 120000);
});

if (!duckdbRuntimeAvailable) {
    console.log('⚠️ DuckDB integration test skipped: run npm install in extensions/duckdb to provide @duckdb/node-api.');
}

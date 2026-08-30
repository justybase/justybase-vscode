import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { ExtensionContext } from 'vscode';
import type {
    DatabaseConnectionConfig,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget,
} from '../../contracts/database';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import type { ConnectionManager } from '../../core/connectionManager';
import { importDataToClickHouse } from '../../import/clickhouseImporter';
import { ClickHouseConnection } from '../../../extensions/clickhouse/src/clickhouseConnection';
import { clickhouseAdvancedFeatures } from '../../../extensions/clickhouse/src/clickhouseDdlGenerator';
import {
    buildClickHouseExplainQuery,
    isClickHouseExplainOutput,
    normalizeClickHouseExplainOutput,
} from '../../../extensions/clickhouse/src/clickhouseExplainParser';
import { clickhouseDialect } from '../../../extensions/clickhouse/src/clickhouseDialect';
import { clickhouseMetadataProvider } from '../../../extensions/clickhouse/src/clickhouseSchemaProvider';
import {
    buildColumnMetadataQuery,
    buildListMaterializedViewsQuery,
} from '../../../extensions/clickhouse/src/clickhouseSystemQueries';
import type { ConnectionDetails } from '../../types';
import {
    cancelReaderExecution,
    expectConnectionCloseIsIdempotent,
    expectReaderCloseAndReuse,
} from './connectionLifecycleHelpers';

function readEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function buildConfig(): DatabaseConnectionConfig | undefined {
    const runFlag = (
        process.env.RUN_CLICKHOUSE_INTEGRATION
        || process.env.CLICKHOUSE_LIVE_TEST_ENABLED
        || ''
    ).trim().toLowerCase();
    if (!['1', 'true', 'yes'].includes(runFlag)) {
        return undefined;
    }

    const host = readEnv('CLICKHOUSE_LIVE_TEST_HOST');
    const database = readEnv('CLICKHOUSE_LIVE_TEST_DATABASE');
    const user = readEnv('CLICKHOUSE_LIVE_TEST_USER');
    const password = readEnv('CLICKHOUSE_LIVE_TEST_PASSWORD');
    if (!host || !database || !user || !password) {
        return undefined;
    }

    const protocol = readEnv('CLICKHOUSE_LIVE_TEST_PROTOCOL');
    const tlsMode = readEnv('CLICKHOUSE_LIVE_TEST_TLS_MODE');
    const options = Object.fromEntries(
        Object.entries({ protocol, tlsMode }).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );

    return {
        host,
        port: Number(process.env.CLICKHOUSE_LIVE_TEST_PORT || 8123),
        database,
        user,
        password,
        options: Object.keys(options).length > 0 ? options : undefined,
    };
}

function quoteIdentifier(value: string): string {
    return `\`${value.replace(/`/g, '``')}\``;
}

function toConnectionDetails(config: DatabaseConnectionConfig): ConnectionDetails {
    return {
        ...config,
        dbType: 'clickhouse',
    };
}

async function readRows(
    connection: ClickHouseConnection,
    sql: string,
): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        const columnNames = Array.from(
            { length: reader.fieldCount },
            (_value, index) => reader.getName(index) || `COLUMN_${index + 1}`,
        );
        const rows: Record<string, unknown>[] = [];
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            columnNames.forEach((name, index) => {
                row[name] = reader.getValue(index);
            });
            rows.push(row);
        }
        return rows;
    } finally {
        await reader.close();
    }
}

async function readScalar(connection: ClickHouseConnection, sql: string): Promise<unknown> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        expect(await reader.read()).toBe(true);
        return reader.getValue(0);
    } finally {
        await reader.close();
    }
}

async function tryExecute(connection: ClickHouseConnection, sql: string): Promise<void> {
    try {
        await connection.createCommand(sql).execute();
    } catch {
        // Cleanup should not hide the original integration failure.
    }
}

function createMaintenanceServices(
    connection: ClickHouseConnection,
): DatabaseMaintenanceServices {
    return {
        context: {},
        async executeSql(sql: string): Promise<void> {
            await connection.createCommand(sql).execute();
        },
        async getConnectionDetails(): Promise<ConnectionDetails | undefined> {
            return toConnectionDetails(config!);
        },
        async openSqlDocument(): Promise<void> {
            return undefined;
        },
        async executeWithProgress<T>(_title: string, task: () => Promise<T>): Promise<T> {
            return task();
        },
        async executeAndReport(
            _target: DatabaseMaintenanceTarget,
            sql: string,
        ): Promise<void> {
            await connection.createCommand(sql).execute();
        },
        async executeQuery<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
            return await readRows(connection, sql) as T[];
        },
    };
}

const config = buildConfig();
const describeIfConfigured = config ? describe : describe.skip;

if (config) {
    registerDatabaseDialect(clickhouseDialect);
}

describeIfConfigured('clickhouse integration', () => {
    const database = config?.database ?? 'clickhouse_test';
    const tableName = `jbl_clickhouse_live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const viewName = `${tableName}_view`;
    const materializedViewName = `${tableName}_mv`;
    const materializedTargetName = `${tableName}_mv_target`;
    let connection: ClickHouseConnection;

    beforeAll(async () => {
        connection = new ClickHouseConnection(config!);
        await connection.connect();
        await connection.createCommand(
            `CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(tableName)} (`
            + 'id UInt64, '
            + 'event_date Date, '
            + 'amount Decimal(12, 2), '
            + 'tags Array(String), '
            + 'note Nullable(String)'
            + `) ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY (id, event_date)`,
        ).execute();
        await connection.createCommand(
            `INSERT INTO ${quoteIdentifier(database)}.${quoteIdentifier(tableName)} `
            + "VALUES (1, '2024-01-01', 12.34, ['one', 'first'], 'Alice'), "
            + "(2, '2024-02-01', 56.78, ['two'], NULL)",
        ).execute();
        await connection.createCommand(
            `CREATE VIEW ${quoteIdentifier(database)}.${quoteIdentifier(viewName)} AS `
            + `SELECT id, amount FROM ${quoteIdentifier(database)}.${quoteIdentifier(tableName)}`,
        ).execute();
        await connection.createCommand(
            `CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(materializedTargetName)} (`
            + 'event_date Date, amount Decimal(12, 2)'
            + `) ENGINE = SummingMergeTree ORDER BY event_date`,
        ).execute();
        await connection.createCommand(
            `CREATE MATERIALIZED VIEW ${quoteIdentifier(database)}.${quoteIdentifier(materializedViewName)} `
            + `TO ${quoteIdentifier(database)}.${quoteIdentifier(materializedTargetName)} AS `
            + `SELECT event_date, sum(amount) AS amount FROM ${quoteIdentifier(database)}.${quoteIdentifier(tableName)} GROUP BY event_date`,
        ).execute();
    }, 60000);

    afterAll(async () => {
        if (connection) {
            await tryExecute(connection, `DROP VIEW IF EXISTS ${quoteIdentifier(database)}.${quoteIdentifier(viewName)}`);
            await tryExecute(connection, `DROP VIEW IF EXISTS ${quoteIdentifier(database)}.${quoteIdentifier(materializedViewName)}`);
            await tryExecute(connection, `DROP TABLE IF EXISTS ${quoteIdentifier(database)}.${quoteIdentifier(materializedViewName)}`);
            await tryExecute(connection, `DROP TABLE IF EXISTS ${quoteIdentifier(database)}.${quoteIdentifier(materializedTargetName)}`);
            await tryExecute(connection, `DROP TABLE IF EXISTS ${quoteIdentifier(database)}.${quoteIdentifier(tableName)}`);
            await connection.close();
        }
    });

    it('closes readers and connections idempotently', async () => {
        await expectReaderCloseAndReuse(
            connection,
            'SELECT 1 AS lifecycle_value',
            'SELECT 1 AS control_value',
        );
        await expectConnectionCloseIsIdempotent(
            connectionConfig => new ClickHouseConnection(connectionConfig),
            config!,
        );
    });

    it('cancels an in-flight HTTP query and allows a fresh connection', async () => {
        const cancellationConnection = new ClickHouseConnection(config!);
        await cancellationConnection.connect();
        try {
            const command = cancellationConnection.createCommand('SELECT sleep(10) AS cancelled_value');
            const outcome = await cancelReaderExecution(command, command.executeReader(), {
                cancelAfterMs: 100,
                settleTimeoutMs: 15000,
            });
            expect(['reader', 'error']).toContain(outcome.kind);
        } finally {
            await cancellationConnection.close();
        }

        const recoveredConnection = new ClickHouseConnection(config!);
        await recoveredConnection.connect();
        try {
            expect(await readScalar(recoveredConnection, 'SELECT 1')).toBe(1);
        } finally {
            await recoveredConnection.close();
        }
    }, 30000);

    it('connects, reports the current database, and streams rows', async () => {
        const version = String(await readScalar(connection, 'SELECT version()'));
        const currentDatabase = String(await readScalar(connection, 'SELECT currentDatabase()'));
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
        expect(currentDatabase).toBe(database);

        await connection.setCurrentDatabase('default');
        expect(connection.getCurrentDatabase()).toBe('default');
        expect(String(await readScalar(connection, 'SELECT currentDatabase()'))).toBe('default');
        await connection.setCurrentDatabase(database);
        expect(String(await readScalar(connection, 'SELECT currentDatabase()'))).toBe(database);

        const rows = await readRows(
            connection,
            `SELECT id, note FROM ${quoteIdentifier(database)}.${quoteIdentifier(tableName)} ORDER BY id`,
        );
        expect(rows).toEqual([
            { id: '1', note: 'Alice' },
            { id: '2', note: null },
        ]);
    });

    it('executes ClickHouse metadata queries for databases, tables, columns, and views', async () => {
        const databases = await readRows(connection, clickhouseMetadataProvider.buildListDatabasesQuery());
        expect(databases.some(row => row.DATABASE === database)).toBe(true);

        const schemas = await readRows(connection, clickhouseMetadataProvider.buildListSchemasQuery(database));
        expect(schemas.some(row => row.SCHEMA === database)).toBe(true);

        const tables = await readRows(
            connection,
            clickhouseMetadataProvider.buildListTablesQuery(database, database),
        );
        expect(tables.some(row => row.OBJNAME === tableName)).toBe(true);

        const views = await readRows(
            connection,
            clickhouseMetadataProvider.buildListViewsQuery(database, database),
        );
        expect(views.some(row => row.OBJNAME === viewName)).toBe(true);
        expect(views.some(row => row.OBJNAME === materializedViewName && row.OBJTYPE === 'MATERIALIZED VIEW')).toBe(true);
        const materializedViews = await readRows(
            connection,
            buildListMaterializedViewsQuery(database, database),
        );
        expect(materializedViews.some(row => row.OBJNAME === materializedViewName)).toBe(true);

        const columns = await readRows(
            connection,
            clickhouseMetadataProvider.buildColumnMetadataQuery(database, database, tableName),
        );
        expect(columns.map(row => row.ATTNAME)).toEqual(['id', 'event_date', 'amount', 'tags', 'note']);
        expect(columns.find(row => row.ATTNAME === 'amount')?.DATA_TYPE).toBe('Decimal(12, 2)');

        const searched = await readRows(
            connection,
            clickhouseMetadataProvider.buildObjectSearchQuery(database, `%${tableName}%`),
        );
        expect(searched.some(row => row.NAME === tableName)).toBe(true);

        const lookup = await readRows(
            connection,
            clickhouseMetadataProvider.buildLookupColumnsQuery({
                database,
                schema: database,
                tableName,
            }),
        );
        expect(lookup.some(row => row.COLUMN_NAME === 'amount')).toBe(true);

        const comment = await readRows(
            connection,
            clickhouseMetadataProvider.buildTableCommentQuery(database, database, tableName),
        );
        expect(comment).toHaveLength(1);

        const viewSources = await readRows(
            connection,
            clickhouseMetadataProvider.buildViewSourceSearchQuery(database, {
                rawTerm: viewName,
                likePattern: `%${viewName}%`,
                useServerSideFilter: true,
            }),
        );
        expect(viewSources.some(row => row.NAME === viewName)).toBe(true);

        await expect(readRows(
            connection,
            clickhouseMetadataProvider.buildProcedureSourceSearchQuery(database, {
                rawTerm: 'procedure',
                likePattern: '%procedure%',
                useServerSideFilter: true,
            }),
        )).resolves.toEqual([]);
    });

    it('reads ClickHouse DDL, keys, sorting, and table statistics', async () => {
        const ddl = clickhouseAdvancedFeatures.ddl!;
        const columns = await ddl.getColumns(connection, database, database, tableName);
        expect(columns).toHaveLength(5);
        expect(columns.find(column => column.name === 'id')?.notNull).toBe(true);
        expect(columns.find(column => column.name === 'note')?.notNull).toBe(false);

        const keys = await ddl.getKeysInfo(connection, database, database, tableName);
        expect(keys.get('PRIMARY')?.columns).toEqual(['id', 'event_date']);

        const organizeColumns = await ddl.getOrganizeInfo(connection, database, database, tableName);
        expect(organizeColumns).toEqual(['id', 'event_date']);

        const tableDefinition = await ddl.getTableDefinitionMetadata!(connection, database, database, tableName);
        expect(tableDefinition?.engine).toMatch(/MergeTree/i);
        expect(tableDefinition?.partitionBy).toContain('toYYYYMM');
        expect(tableDefinition?.orderBy).toContain('id');

        const stats = await readRows(connection, ddl.buildTableStatsQuery(database, database, tableName));
        expect(stats).toHaveLength(1);
        expect(Number(stats[0].ROW_COUNT)).toBeGreaterThanOrEqual(2);

        const tableDdl = await ddl.generateTableDDL(connection, database, database, tableName);
        expect(tableDdl).toMatch(/CREATE TABLE/i);
        expect(tableDdl).toContain(tableName);

        const viewDdl = await ddl.generateViewDDL(connection, database, database, viewName);
        expect(viewDdl).toMatch(/CREATE VIEW/i);
        const materializedViewDdl = await ddl.generateViewDDL(connection, database, database, materializedViewName);
        expect(materializedViewDdl).toMatch(/CREATE MATERIALIZED VIEW/i);
        const materializedViewDefinition = await ddl.getTableDefinitionMetadata!(
            connection,
            database,
            database,
            materializedViewName,
        );
        expect(materializedViewDefinition?.engine).toBe('MaterializedView');
        expect(materializedViewDefinition?.sourceDdl).toMatch(/CREATE MATERIALIZED VIEW/i);

        const cachedDdl = ddl.buildTableDDLFromCache(
            database,
            database,
            'cached_clickhouse_table',
            columns,
            [],
            organizeColumns,
            keys,
            undefined,
            undefined,
            tableDefinition ?? undefined,
        );
        expect(cachedDdl).toContain('ENGINE = MergeTree');
        expect(cachedDdl).toContain('PARTITION BY toYYYYMM');
        expect(cachedDdl).toContain('ORDER BY (id, event_date)');
    });

    it('builds and executes a textual EXPLAIN plan', async () => {
        const explainSql = buildClickHouseExplainQuery(
            `SELECT id FROM ${quoteIdentifier(database)}.${quoteIdentifier(tableName)} WHERE id = 1`,
        );
        const rows = await readRows(connection, explainSql);
        const text = normalizeClickHouseExplainOutput(rows.map(row => Object.values(row).join('\n')).join('\n'));
        expect(text.length).toBeGreaterThan(0);
        expect(isClickHouseExplainOutput(text)).toBe(true);
        expect(text).toMatch(/ReadFrom|MergeTree|Expression/i);
    });

    it('lists MergeTree partitions through the maintenance provider', async () => {
        const target: DatabaseMaintenanceTarget = {
            connectionName: 'clickhouse-live-test',
            databaseName: database,
            schemaName: database,
            tableName,
            qualifiedName: `${database}.${tableName}`,
        };
        const partitions = await clickhouseAdvancedFeatures.maintenance!.listPartitions!(
            target,
            createMaintenanceServices(connection),
        );
        expect(partitions.length).toBeGreaterThanOrEqual(2);
        expect(partitions.every(partition => partition.parentTable === tableName)).toBe(true);
    });

    it('runs ClickHouse session, query, and storage monitor queries', async () => {
        const provider = clickhouseAdvancedFeatures.sessionMonitor;
        expect(provider).toBeDefined();
        const context = {} as ExtensionContext;
        const manager = {
            getActiveConnectionName: () => 'clickhouse-live-test',
            getConnection: async () => ({
                ...config!,
                dbType: 'clickhouse',
            }),
        } as unknown as ConnectionManager;

        const sessions = await provider!.getSessions(context, manager, database);
        const queries = await provider!.getQueries(context, manager, database);
        const storage = await provider!.getStorage(context, manager);
        expect(Array.isArray(sessions)).toBe(true);
        expect(Array.isArray(queries)).toBe(true);
        expect(Array.isArray(storage)).toBe(true);
    });

    it('imports a CSV into a MergeTree table using the shared batching workflow', async () => {
        const sourceFile = path.join(
            os.tmpdir(),
            `clickhouse-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.csv`,
        );
        const importedTable = `jbl_clickhouse_import_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        fs.writeFileSync(sourceFile, 'id,name,amount\n10,Alice,12.34\n11,Bob,56.78\n12,,\n', 'utf8');
        try {
            const result = await importDataToClickHouse(
                sourceFile,
                importedTable,
                toConnectionDetails(config!),
            );
            expect(result.success).toBe(true);
            expect(result.details?.rowsInserted).toBe(3);

            const rows = await readRows(
                connection,
                `SELECT count() AS ROW_COUNT FROM ${quoteIdentifier(database)}.${quoteIdentifier(importedTable)}`,
            );
            expect(Number(rows[0].ROW_COUNT)).toBe(3);
            const nullRows = await readRows(
                connection,
                `SELECT count() AS NULL_COUNT FROM ${quoteIdentifier(database)}.${quoteIdentifier(importedTable)} WHERE name IS NULL AND amount IS NULL`,
            );
            expect(Number(nullRows[0].NULL_COUNT)).toBe(1);
        } finally {
            await tryExecute(connection, `DROP TABLE IF EXISTS ${quoteIdentifier(database)}.${quoteIdentifier(importedTable)}`);
            fs.rmSync(sourceFile, { force: true });
        }
    }, 180000);

    it('exposes ClickHouse advanced-feature capabilities without relational-only features', () => {
        expect(clickhouseDialect.capabilities.supportsExplainPlan).toBe(true);
        expect(clickhouseDialect.capabilities.supportsSessionMonitor).toBe(true);
        expect(clickhouseAdvancedFeatures.ddl).toBeDefined();
        expect(clickhouseAdvancedFeatures.maintenance).toBeDefined();
        expect(clickhouseAdvancedFeatures.sessionMonitor).toBeDefined();
        expect(clickhouseAdvancedFeatures.tuningAdvisor).toBeUndefined();
        expect(buildColumnMetadataQuery(database, database, tableName)).toContain('system.columns');
    });
});

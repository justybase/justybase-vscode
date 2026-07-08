import { SnowflakeConnection } from '../../../extensions/snowflake/src/snowflakeConnection';
import { snowflakeMetadataProvider } from '../../../extensions/snowflake/src/snowflakeSchemaProvider';
import { snowflakeDialect } from '../../../extensions/snowflake/src/snowflakeDialect';
import {
    buildSnowflakeExplainQuery,
    buildSnowflakeQueryOperatorStatsQuery,
    buildSnowflakeRecentQueryHistoryQuery,
    isSnowflakeExplainJson,
    parseSnowflakeExplainJson,
    renderSnowflakeQueryProfileMarkdown,
} from '../../../extensions/snowflake/src/snowflakeQueryProfile';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import type { DatabaseConnectionConfig } from '../../contracts/database';

function readEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function buildConfig(): DatabaseConnectionConfig | undefined {
    const explicitRunFlag = (process.env.RUN_SNOWFLAKE_INTEGRATION || process.env.SNOWFLAKE_LIVE_TEST_ENABLED || '')
        .trim()
        .toLowerCase();
    if (!['1', 'true', 'yes'].includes(explicitRunFlag)) {
        return undefined;
    }

    const host = readEnv('SNOWFLAKE_LIVE_TEST_ACCOUNT') || readEnv('SNOWFLAKE_LIVE_TEST_HOST');
    const database = readEnv('SNOWFLAKE_LIVE_TEST_DATABASE');
    const user = readEnv('SNOWFLAKE_LIVE_TEST_USER');
    const password = readEnv('SNOWFLAKE_LIVE_TEST_PASSWORD');

    if (!host || !database || !user || !password) {
        return undefined;
    }

    return {
        host,
        database,
        user,
        password,
        port: Number(process.env.SNOWFLAKE_LIVE_TEST_PORT || 443),
        options: {
            warehouse: readEnv('SNOWFLAKE_LIVE_TEST_WAREHOUSE') || '',
            role: readEnv('SNOWFLAKE_LIVE_TEST_ROLE') || '',
            schema: readEnv('SNOWFLAKE_LIVE_TEST_SCHEMA') || 'PUBLIC',
        },
    };
}

async function getSessionDatabase(connection: SnowflakeConnection): Promise<string | undefined> {
    const reader = await connection
        .createCommand('SELECT CURRENT_DATABASE() AS CURRENT_CATALOG')
        .executeReader();
    try {
        if (!(await reader.read())) {
            return undefined;
        }
        const value = reader.getValue(0);
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    } finally {
        await reader.close();
    }
}

function quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeStatement(connection: SnowflakeConnection, sql: string): Promise<void> {
    await connection.createCommand(sql).execute();
}

async function readRows(connection: SnowflakeConnection, sql: string): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        const rows: Record<string, unknown>[] = [];
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < reader.fieldCount; index += 1) {
                row[reader.getName(index)] = reader.getValue(index);
            }
            rows.push(row);
        }
        return rows;
    } finally {
        await reader.close();
    }
}

async function readShowResultRows(
    connection: SnowflakeConnection,
    showSql: string,
    selectSql: string
): Promise<Record<string, unknown>[]> {
    return readRows(connection, `${showSql}\n->> ${selectSql}`);
}

async function listAccessibleDatabases(connection: SnowflakeConnection): Promise<string[]> {
    const rows = await readRows(connection, snowflakeMetadataProvider.buildListDatabasesQuery());
    return rows
        .map((row) => (typeof row.DATABASE === 'string' ? row.DATABASE : undefined))
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

async function findProbeTable(
    connection: SnowflakeConnection
): Promise<{ database: string; schema: string; tableName: string; owner?: string; description?: string } | undefined> {
    const databases = await listAccessibleDatabases(connection);
    for (const database of databases) {
        const rows = await readRows(connection, snowflakeMetadataProvider.buildListTablesQuery(database));
        const row = rows.find(
            (candidate) =>
                typeof candidate.DATABASE === 'string'
                && typeof candidate.SCHEMA === 'string'
                && typeof candidate.OBJNAME === 'string'
        );
        if (!row) {
            continue;
        }

        return {
            database: String(row.DATABASE),
            schema: String(row.SCHEMA),
            tableName: String(row.OBJNAME),
            owner: typeof row.OWNER === 'string' ? row.OWNER : undefined,
            description: typeof row.DESCRIPTION === 'string' ? row.DESCRIPTION : undefined,
        };
    }

    return undefined;
}

async function findCommentedTable(
    connection: SnowflakeConnection
): Promise<{ database: string; schema: string; tableName: string; owner?: string; description?: string } | undefined> {
    const databases = await listAccessibleDatabases(connection);
    for (const database of databases) {
        const rows = await readRows(connection, snowflakeMetadataProvider.buildListTablesQuery(database));
        const row = rows.find(
            (candidate) =>
                typeof candidate.DATABASE === 'string'
                && typeof candidate.SCHEMA === 'string'
                && typeof candidate.OBJNAME === 'string'
                && typeof candidate.DESCRIPTION === 'string'
                && candidate.DESCRIPTION.trim().length > 0
        );
        if (!row) {
            continue;
        }

        return {
            database: String(row.DATABASE),
            schema: String(row.SCHEMA),
            tableName: String(row.OBJNAME),
            owner: typeof row.OWNER === 'string' ? row.OWNER : undefined,
            description: typeof row.DESCRIPTION === 'string' ? row.DESCRIPTION : undefined,
        };
    }

    return undefined;
}

async function findDynamicTable(
    connection: SnowflakeConnection,
): Promise<{ database: string; schema: string; tableName: string } | undefined> {
    const databases = await listAccessibleDatabases(connection);
    for (const database of databases) {
        const rows = await readRows(connection, snowflakeMetadataProvider.buildObjectTypeQuery(database, 'DYNAMIC TABLE'));
        const row = rows.find(
            (candidate) =>
                typeof candidate.DATABASE === 'string'
                && typeof candidate.SCHEMA === 'string'
                && typeof candidate.OBJNAME === 'string',
        );
        if (!row) {
            continue;
        }

        return {
            database: String(row.DATABASE),
            schema: String(row.SCHEMA),
            tableName: String(row.OBJNAME),
        };
    }

    return undefined;
}

async function findConstrainedTable(
    connection: SnowflakeConnection
): Promise<{ database: string; schema: string; tableName: string } | undefined> {
    const rows = await readShowResultRows(
        connection,
        'SHOW PRIMARY KEYS IN ACCOUNT',
        `
            SELECT
                "database_name" AS DATABASE_NAME,
                "schema_name" AS TABLE_SCHEMA,
                "table_name" AS TABLE_NAME
            FROM $1
            ORDER BY "database_name", "schema_name", "table_name"
            LIMIT 1
        `
    );
    const row = rows[0];
    const database = typeof row?.DATABASE_NAME === 'string' ? row.DATABASE_NAME : undefined;
    const schema = typeof row?.TABLE_SCHEMA === 'string' ? row.TABLE_SCHEMA : undefined;
    const tableName = typeof row?.TABLE_NAME === 'string' ? row.TABLE_NAME : undefined;
    return database && schema && tableName ? { database, schema, tableName } : undefined;
}

async function waitForQueryHistoryByMarker(
    connection: SnowflakeConnection,
    marker: string,
    attempts = 10
): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const rows = await readRows(connection, buildSnowflakeRecentQueryHistoryQuery(50));
        const match = rows.find((row) => typeof row.QUERY_TEXT === 'string' && row.QUERY_TEXT.includes(marker));
        if (match) {
            return match;
        }
        await wait(750);
    }

    throw new Error(`Timed out waiting for Snowflake query history marker: ${marker}`);
}

const config = buildConfig();
const describeIfConfigured = config ? describe : describe.skip;

if (config) {
    registerDatabaseDialect(snowflakeDialect);
}

describeIfConfigured('snowflake integration', () => {
    let connection: SnowflakeConnection;

    beforeAll(async () => {
        connection = new SnowflakeConnection(config!);
        await connection.connect();
    }, 120000);

    afterAll(async () => {
        await connection.close();
    });

    it('runs metadata discovery queries against the configured Snowflake account', async () => {
        const databasesReader = await connection
            .createCommand(snowflakeMetadataProvider.buildListDatabasesQuery())
            .executeReader();
        try {
            expect(await databasesReader.read()).toBe(true);
        } finally {
            await databasesReader.close();
        }
    });

    it('returns session context for the configured Snowflake account', async () => {
        const reader = await connection
            .createCommand(
                'SELECT CURRENT_DATABASE() AS CURRENT_CATALOG, CURRENT_SCHEMA() AS CURRENT_SCHEMA, CURRENT_WAREHOUSE() AS CURRENT_WAREHOUSE, CURRENT_ROLE() AS CURRENT_ROLE',
            )
            .executeReader();
        try {
            expect(await reader.read()).toBe(true);
            expect(String(reader.getValue(0)).length).toBeGreaterThan(0);
            expect(String(reader.getValue(1)).length).toBeGreaterThan(0);
            if (config!.options?.warehouse) {
                expect(String(reader.getValue(2)).length).toBeGreaterThan(0);
            }
            if (config!.options?.role) {
                expect(String(reader.getValue(3)).length).toBeGreaterThan(0);
            }
        } finally {
            await reader.close();
        }
    });

    it('runs schema discovery cleanly for the configured Snowflake database', async () => {
        const databaseForMetadata = (await getSessionDatabase(connection)) || config!.database;
        const reader = await connection
            .createCommand(snowflakeMetadataProvider.buildListSchemasQuery(databaseForMetadata))
            .executeReader();
        try {
            while (await reader.read()) {
                const schemaName = String(reader.getValue(0) ?? '');
                expect(schemaName.length).toBeGreaterThan(0);
            }
        } finally {
            await reader.close();
        }
    });

    it('discovers live dynamic tables and can script their DDL when present', async () => {
        const dynamicTable = await findDynamicTable(connection);
        if (!dynamicTable) {
            return;
        }

        const discoveryRows = await readRows(
            connection,
            snowflakeMetadataProvider.buildObjectTypeQuery(dynamicTable.database, 'DYNAMIC TABLE'),
        );
        const discoveredRow = discoveryRows.find(
            row =>
                row.DATABASE === dynamicTable.database
                && row.SCHEMA === dynamicTable.schema
                && row.OBJNAME === dynamicTable.tableName,
        );
        expect(discoveredRow).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(discoveredRow ?? {}, 'SCHEDULING_STATE')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(discoveredRow ?? {}, 'TARGET_LAG')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(discoveredRow ?? {}, 'WAREHOUSE')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(discoveredRow ?? {}, 'REFRESH_MODE')).toBe(true);

        const ddlRows = await readRows(
            connection,
            `SELECT GET_DDL('DYNAMIC TABLE', '${dynamicTable.database}.${dynamicTable.schema}.${dynamicTable.tableName}') AS DDL`,
        );
        expect(String(ddlRows[0]?.DDL ?? '')).toContain('DYNAMIC TABLE');
    }, 120000);

    it('returns parseable explain JSON for a simple query', async () => {
        const reader = await connection.createCommand(buildSnowflakeExplainQuery('SELECT 1 AS SAMPLE_VALUE')).executeReader();
        try {
            expect(await reader.read()).toBe(true);
            const rawValue = reader.getValue(0);
            const explainText = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
            expect(isSnowflakeExplainJson(explainText)).toBe(true);
            expect(parseSnowflakeExplainJson(explainText).root.operation.length).toBeGreaterThan(0);
        } finally {
            await reader.close();
        }
    });

    it('retrieves recent query history for the current Snowflake session', async () => {
        const metadataTable = await findProbeTable(connection);
        expect(metadataTable).toBeDefined();
        await executeStatement(
            connection,
            `USE SCHEMA ${quoteIdentifier(metadataTable!.database)}.INFORMATION_SCHEMA`
        );
        const marker = `JBL_SNOWFLAKE_HISTORY_${Date.now()}`;
        await readRows(connection, `SELECT ${quoteLiteral(marker)} AS HISTORY_MARKER`);

        const historyRow = await waitForQueryHistoryByMarker(connection, marker);

        expect(typeof historyRow.QUERY_ID).toBe('string');
        expect(String(historyRow.QUERY_TEXT)).toContain(marker);
        expect(String(historyRow.EXECUTION_STATUS).length).toBeGreaterThan(0);
        expect(String(historyRow.DATABASE_NAME).length).toBeGreaterThan(0);
    }, 120000);

    it('profiles operator statistics for a recent read-only query', async () => {
        const metadataTable = await findProbeTable(connection);
        expect(metadataTable).toBeDefined();
        await executeStatement(
            connection,
            `USE SCHEMA ${quoteIdentifier(metadataTable!.database)}.INFORMATION_SCHEMA`
        );
        const marker = `JBL_SNOWFLAKE_OPERATOR_${Date.now()}`;
        await readRows(
            connection,
            `SELECT ${quoteLiteral(marker)} AS OPERATOR_MARKER, TABLE_NAME FROM ${quoteIdentifier(metadataTable!.database)}.INFORMATION_SCHEMA.TABLES LIMIT 1`
        );

        const historyRow = await waitForQueryHistoryByMarker(connection, marker);
        const queryId = String(historyRow.QUERY_ID ?? '');
        expect(queryId.length).toBeGreaterThan(0);

        const operatorRows = await readRows(
            connection,
            buildSnowflakeQueryOperatorStatsQuery(quoteLiteral(queryId))
        );

        expect(operatorRows.length).toBeGreaterThan(0);
        expect(renderSnowflakeQueryProfileMarkdown(operatorRows)).toContain('# Snowflake Query Profile');
    }, 120000);

    it('reads Snowflake column metadata and table statistics for a discovered base table', async () => {
        const tableRef = await findProbeTable(connection);
        expect(tableRef).toBeDefined();

        const columns = await snowflakeDialect.advancedFeatures!.ddl!.getColumns(
            connection,
            tableRef!.database,
            tableRef!.schema,
            tableRef!.tableName,
        );
        expect(columns.length).toBeGreaterThan(0);
        expect(columns[0].name.length).toBeGreaterThan(0);

        const statsRows = await readRows(
            connection,
            snowflakeDialect.advancedFeatures!.ddl!.buildTableStatsQuery(
                tableRef!.database,
                tableRef!.schema,
                tableRef!.tableName,
            )
        );
        expect(statsRows.length).toBeGreaterThan(0);
        expect(statsRows[0]).toHaveProperty('ROW_COUNT');
        expect(statsRows[0]).toHaveProperty('BYTES');
    }, 120000);

    it('looks up Snowflake table comments, owner, and keys using information_schema metadata', async () => {
        const probeTable = await findProbeTable(connection);
        expect(probeTable).toBeDefined();

        const commentedTable = await findCommentedTable(connection);
        const owner = await snowflakeDialect.advancedFeatures!.ddl!.getTableOwner(
            connection,
            (commentedTable ?? probeTable)!.database,
            (commentedTable ?? probeTable)!.schema,
            (commentedTable ?? probeTable)!.tableName,
        );
        const expectedOwner = (commentedTable ?? probeTable)!.owner?.trim();
        if (expectedOwner && expectedOwner.length > 0) {
            expect(owner).toBe(expectedOwner);
        } else {
            expect(owner === null || typeof owner === 'string').toBe(true);
        }

        const comment = await snowflakeDialect.advancedFeatures!.ddl!.getTableComment(
            connection,
            (commentedTable ?? probeTable)!.database,
            (commentedTable ?? probeTable)!.schema,
            (commentedTable ?? probeTable)!.tableName,
        );
        expect(comment === null || typeof comment === 'string').toBe(true);
        if (typeof comment === 'string') {
            expect(comment.length).toBeGreaterThan(0);
        }

        const constrainedTable = await findConstrainedTable(connection);
        if (constrainedTable) {
            try {
                const keysInfo = await snowflakeDialect.advancedFeatures!.ddl!.getKeysInfo(
                    connection,
                    constrainedTable.database,
                    constrainedTable.schema,
                    constrainedTable.tableName,
                );
                expect(keysInfo).toBeInstanceOf(Map);
                expect(keysInfo.size).toBeGreaterThan(0);
                expect([...keysInfo.values()][0].columns.length).toBeGreaterThan(0);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                expect(message).toMatch(/KEY_COLUMN_USAGE|not authorized|does not exist/i);
            }
        } else {
            const keysInfo = await snowflakeDialect.advancedFeatures!.ddl!.getKeysInfo(
                connection,
                probeTable!.database,
                probeTable!.schema,
                probeTable!.tableName,
            );
            expect(keysInfo).toBeInstanceOf(Map);
        }
    }, 120000);
});

if (!config) {
    console.log(
        '⚠️ Snowflake integration test skipped: set RUN_SNOWFLAKE_INTEGRATION=1 (or SNOWFLAKE_LIVE_TEST_ENABLED=1) with SNOWFLAKE_LIVE_TEST_* env vars for an explicit live-account run.',
    );
}

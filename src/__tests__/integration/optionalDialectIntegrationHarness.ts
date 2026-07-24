import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type {
    DatabaseConnection,
    DatabaseConnectionConfig,
    DatabaseDataReader,
    DatabaseMetadataProvider,
} from '../../contracts/database';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import type { ConnectionDetails } from '../../types';
import { Db2Connection, ensureClidriverOnPath } from '../../../extensions/db2/src/db2Connection';
import { db2Dialect } from '../../../extensions/db2/src/db2Dialect';
import { db2MetadataProvider } from '../../../extensions/db2/src/db2SchemaProvider';
import { MsSqlConnection } from '../../../extensions/mssql/src/mssqlConnection';
import { mssqlDialect } from '../../../extensions/mssql/src/mssqlDialect';
import { mssqlMetadataProvider } from '../../../extensions/mssql/src/mssqlSchemaProvider';
import { OracleConnection } from '../../../extensions/oracle/src/oracleConnection';
import { oracleDialect } from '../../../extensions/oracle/src/oracleDialect';
import { oracleMetadataProvider } from '../../../extensions/oracle/src/oracleSchemaProvider';
import { PostgreSqlConnection } from '../../../extensions/postgresql/src/postgresqlConnection';
import { postgresqlDialect } from '../../../extensions/postgresql/src/postgresqlDialect';
import { postgresqlMetadataProvider } from '../../../extensions/postgresql/src/postgresqlSchemaProvider';
import { VerticaConnection } from '../../../extensions/vertica/src/verticaConnection';
import { verticaDialect } from '../../../extensions/vertica/src/verticaDialect';
import { verticaMetadataProvider } from '../../../extensions/vertica/src/verticaSchemaProvider';
import { importDataToDb2 } from '../../import/db2Importer';
import { importDataToMsSql } from '../../import/mssqlImporter';
import { importDataToOracle } from '../../import/oracleImporter';
import { importDataToPostgreSql } from '../../import/postgresqlImporter';
import { importDataToVertica } from '../../import/verticaImporter';

registerDatabaseDialect(db2Dialect);
registerDatabaseDialect(mssqlDialect);
registerDatabaseDialect(oracleDialect);
registerDatabaseDialect(postgresqlDialect);
registerDatabaseDialect(verticaDialect);

const db2RuntimeRequire = createRequire(
    path.join(process.cwd(), 'extensions', 'db2', 'package.json'),
);
const db2ClidriverHome = path.join(
    process.cwd(),
    'extensions',
    'db2',
    'node_modules',
    'ibm_db',
    'installer',
    'clidriver',
);

function hasDb2NodeRuntime(): boolean {
    try {
        if (fs.existsSync(db2ClidriverHome)) {
            process.env.IBM_DB_HOME = db2ClidriverHome;
            ensureClidriverOnPath(db2ClidriverHome);
        }
        db2RuntimeRequire('ibm_db');
        return true;
    } catch {
        return false;
    }
}

type LivePrefix = 'DB2' | 'MSSQL' | 'ORACLE' | 'POSTGRES' | 'PG' | 'VERTICA';
type LiveDbType = 'db2' | 'mssql' | 'oracle' | 'postgresql' | 'vertica';

function readRequiredEnv(name: string, allowEmpty = false): string | undefined {
    const rawValue = process.env[name];
    if (rawValue === undefined) {
        return undefined;
    }

    const value = rawValue.trim();
    if (value.length > 0) {
        return value;
    }

    return allowEmpty ? '' : undefined;
}

function readRequiredEnvFromPrefixes(
    prefixes: readonly LivePrefix[],
    suffix: string,
    allowEmpty = false,
): string | undefined {
    for (const prefix of prefixes) {
        const value = readRequiredEnv(`${prefix}_LIVE_TEST_${suffix}`, allowEmpty);
        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
}

function readOptionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : undefined;
}

function readOptionalEnvFromPrefixes(
    prefixes: readonly LivePrefix[],
    suffix: string,
): string | undefined {
    for (const prefix of prefixes) {
        const value = readOptionalEnv(`${prefix}_LIVE_TEST_${suffix}`);
        if (value !== undefined) {
            return value;
        }
    }

    return undefined;
}

function readOptionalPortFromPrefixes(
    prefixes: readonly LivePrefix[],
    fallback: number,
): number {
    for (const prefix of prefixes) {
        const raw = process.env[`${prefix}_LIVE_TEST_PORT`]?.trim();
        if (!raw) {
            continue;
        }

        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    return fallback;
}

function buildLiveConfig(
    prefix: LivePrefix | readonly LivePrefix[],
    defaultPort: number,
    optionEnvMap: Readonly<Record<string, string>> = {},
    configOptions: { allowEmptyPassword?: boolean } = {},
): DatabaseConnectionConfig | undefined {
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    const host = readRequiredEnvFromPrefixes(prefixes, 'HOST');
    const database = readRequiredEnvFromPrefixes(prefixes, 'DATABASE');
    const user = readRequiredEnvFromPrefixes(prefixes, 'USER');
    const password = readRequiredEnvFromPrefixes(
        prefixes,
        'PASSWORD',
        configOptions.allowEmptyPassword === true,
    );

    if (!host || !database || !user || password === undefined) {
        return undefined;
    }

    const connectionOptions = Object.fromEntries(
        Object.entries(optionEnvMap)
            .map(([key, envSuffix]) => [key, readOptionalEnvFromPrefixes(prefixes, envSuffix)])
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );

    return {
        host,
        port: readOptionalPortFromPrefixes(prefixes, defaultPort),
        database,
        user,
        password,
        options: Object.keys(connectionOptions).length > 0 ? connectionOptions : undefined,
    };
}

function toConnectionDetails(config: DatabaseConnectionConfig, dbType: LiveDbType): ConnectionDetails {
    return {
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        options: config.options,
        dbType,
    };
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
}

function buildSmokeTableName(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

function createSmokeCsv(prefix: string): { filePath: string; cleanup(): void } {
    const filePath = path.join(
        os.tmpdir(),
        `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.csv`,
    );
    fs.writeFileSync(
        filePath,
        'id,created_at,amount,name\n'
            + '1,2024-02-01 10:20:30,12.34,Alice\n'
            + '2,2024-03-04 11:22:33,56.78,Bob\n',
        'utf8',
    );

    return {
        filePath,
        cleanup(): void {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        },
    };
}

const LIVE_SOURCE_SEARCH_OPTIONS = {
    rawTerm: 'JBL_LIVE_SMOKE',
    likePattern: '%JBL_LIVE_SMOKE%',
    useServerSideFilter: true,
} as const;

function resolveVerticaSchema(
    config: DatabaseConnectionConfig,
    connection: DatabaseConnection,
): string | undefined {
    const searchPath = config.options?.searchPath;
    if (typeof searchPath === 'string' && searchPath.trim().length > 0) {
        const [firstSchema] = searchPath.split(',');
        if (firstSchema && firstSchema.trim().length > 0) {
            return firstSchema.trim().replace(/^"|"$/g, '');
        }
    }

    return (connection as VerticaConnection).getCurrentSchema();
}

async function expectReaderHasShape(
    reader: DatabaseDataReader,
    requireRow: boolean,
): Promise<void> {
    try {
        expect(reader.fieldCount).toBeGreaterThan(0);
        if (requireRow) {
            expect(await reader.read()).toBe(true);
        }
    } finally {
        await reader.close();
    }
}

async function expectQueryHasShape(
    connection: DatabaseConnection,
    sql: string,
    requireRow = false,
): Promise<void> {
    const reader = await connection.createCommand(sql).executeReader();
    await expectReaderHasShape(reader, requireRow);
}

async function readScalarValue(connection: DatabaseConnection, sql: string): Promise<unknown> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        expect(await reader.read()).toBe(true);
        return reader.getValue(0);
    } finally {
        await reader.close();
    }
}

async function readRows(
    connection: DatabaseConnection,
    sql: string,
    limit = 10,
): Promise<Record<string, unknown>[]> {
    const reader = await connection.createCommand(sql).executeReader();
    try {
        const columnNames = Array.from(
            { length: reader.fieldCount },
            (_value, index) => reader.getName(index) || `COL_${index}`,
        );
        const rows: Record<string, unknown>[] = [];

        while (rows.length < limit && await reader.read()) {
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

async function tryExecute(connection: DatabaseConnection, sql: string): Promise<void> {
    try {
        await connection.createCommand(sql).execute();
    } catch {
        // Best-effort cleanup for smoke tables.
    }
}

interface LiveImportSmokeResult {
    tableName: string;
    expectedRows: number;
}

export interface LiveDialectHarness {
    name: string;
    config: DatabaseConnectionConfig | undefined;
    createConnection(config: DatabaseConnectionConfig): DatabaseConnection;
    metadataProvider: DatabaseMetadataProvider;
    smokeSql: string;
    resolveSchema(config: DatabaseConnectionConfig, connection: DatabaseConnection): string | undefined;
    runMetadataSmoke?(connection: DatabaseConnection, config: DatabaseConnectionConfig): Promise<void>;
    runImportSmoke?(config: DatabaseConnectionConfig): Promise<LiveImportSmokeResult>;
    buildImportRowCountQuery?(tableName: string): string;
    buildImportDropTableSql?(tableName: string): string;
}

export const db2Harness: LiveDialectHarness = {
    name: 'Db2',
    config: hasDb2NodeRuntime()
        ? buildLiveConfig('DB2', 50000, {
            currentSchema: 'CURRENT_SCHEMA',
            security: 'SECURITY',
            sslServerCertificate: 'SSL_SERVER_CERTIFICATE',
            connectTimeout: 'CONNECT_TIMEOUT',
            clientCodepage: 'CLIENT_CODEPAGE',
        })
        : undefined,
    createConnection: config => new Db2Connection(config),
    metadataProvider: db2MetadataProvider,
    smokeSql: 'SELECT 1 AS TEST_VALUE FROM SYSIBM.SYSDUMMY1',
    resolveSchema: config => {
        const currentSchema = config.options?.currentSchema;
        return typeof currentSchema === 'string' && currentSchema.trim().length > 0
            ? currentSchema.trim()
            : undefined;
    },
    runImportSmoke: async config => {
        const sourceFile = createSmokeCsv('db2-import-smoke');
        const tableName = buildSmokeTableName('JBL_SMOKE_DB2');
        try {
            const result = await importDataToDb2(
                sourceFile.filePath,
                tableName,
                toConnectionDetails(config, 'db2'),
            );
            expect(result.success).toBe(true);
            expect(result.details?.rowsInserted).toBe(2);
            return { tableName, expectedRows: 2 };
        } finally {
            sourceFile.cleanup();
        }
    },
    buildImportRowCountQuery: tableName => `SELECT COUNT(*) AS ROW_COUNT FROM ${quoteIdentifier(tableName)}`,
    buildImportDropTableSql: tableName => `DROP TABLE ${quoteIdentifier(tableName)}`,
};

export const oracleHarness: LiveDialectHarness = {
    name: 'Oracle',
    config: buildLiveConfig('ORACLE', 1521, {
        currentSchema: 'CURRENT_SCHEMA',
        connectString: 'CONNECT_STRING',
        configDir: 'CONFIG_DIR',
        connectTimeout: 'CONNECT_TIMEOUT',
    }),
    createConnection: config => new OracleConnection(config),
    metadataProvider: oracleMetadataProvider,
    smokeSql: 'SELECT 1 AS TEST_VALUE FROM DUAL',
    resolveSchema: (config, connection) => {
        const currentSchema = config.options?.currentSchema;
        if (typeof currentSchema === 'string' && currentSchema.trim().length > 0) {
            return currentSchema.trim();
        }

        return (connection as OracleConnection).getCurrentSchema();
    },
    runImportSmoke: async config => {
        const sourceFile = createSmokeCsv('oracle-import-smoke');
        const tableName = buildSmokeTableName('JBL_SMOKE_ORACLE');
        try {
            const result = await importDataToOracle(
                sourceFile.filePath,
                tableName,
                toConnectionDetails(config, 'oracle'),
            );
            expect(result.success).toBe(true);
            expect(result.details?.rowsInserted).toBe(2);
            return { tableName, expectedRows: 2 };
        } finally {
            sourceFile.cleanup();
        }
    },
    buildImportRowCountQuery: tableName => `SELECT COUNT(*) AS ROW_COUNT FROM ${quoteIdentifier(tableName)}`,
    buildImportDropTableSql: tableName => `DROP TABLE ${quoteIdentifier(tableName)}`,
};

export const mssqlHarness: LiveDialectHarness = {
    name: 'MS SQL Server',
    config: buildLiveConfig('MSSQL', 1433, {
        domain: 'DOMAIN',
        encrypt: 'ENCRYPT',
        trustServerCertificate: 'TRUST_SERVER_CERTIFICATE',
        connectTimeout: 'CONNECT_TIMEOUT',
        requestTimeout: 'REQUEST_TIMEOUT',
    }),
    createConnection: config => new MsSqlConnection(config),
    metadataProvider: mssqlMetadataProvider,
    smokeSql: 'SELECT DB_NAME() AS DATABASE_NAME, SCHEMA_NAME() AS SCHEMA_NAME, @@SPID AS CURRENT_SID',
    resolveSchema: (_config, connection) => (connection as MsSqlConnection).getCurrentSchemaName(),
    runMetadataSmoke: async (connection, config) => {
        const provider = mssqlMetadataProvider;
        const schema = (connection as MsSqlConnection).getCurrentSchemaName();

        await expectQueryHasShape(connection, provider.buildListProceduresQuery(config.database, schema));
        await expectQueryHasShape(connection, provider.buildObjectTypeQuery(config.database, 'FUNCTION'));
        await expectQueryHasShape(connection, provider.buildObjectSearchQuery(config.database, LIVE_SOURCE_SEARCH_OPTIONS.likePattern));
        await expectQueryHasShape(connection, provider.buildViewSourceSearchQuery(config.database, LIVE_SOURCE_SEARCH_OPTIONS));
        await expectQueryHasShape(connection, provider.buildProcedureSourceSearchQuery(config.database, LIVE_SOURCE_SEARCH_OPTIONS));

        const tableRows = await readRows(connection, provider.buildListTablesQuery(config.database, schema), 1);
        const firstTable = tableRows[0];
        const tableName = typeof firstTable?.OBJNAME === 'string' ? firstTable.OBJNAME : '';
        const tableSchema = typeof firstTable?.SCHEMA === 'string' ? firstTable.SCHEMA : schema;

        if (!tableName || !tableSchema) {
            return;
        }

        await expectQueryHasShape(connection, provider.buildColumnMetadataQuery(config.database, tableSchema, tableName), true);
        await expectQueryHasShape(
            connection,
            provider.buildLookupColumnsQuery({
                database: config.database,
                schema: tableSchema,
                tableName,
            }),
            true,
        );
        await expectQueryHasShape(connection, provider.buildTableCommentQuery(config.database, tableSchema, tableName));
    },
    runImportSmoke: async config => {
        const sourceFile = createSmokeCsv('mssql-import-smoke');
        const tableName = buildSmokeTableName('JBL_SMOKE_MSSQL');
        try {
            const result = await importDataToMsSql(
                sourceFile.filePath,
                tableName,
                toConnectionDetails(config, 'mssql'),
            );
            expect(result.success).toBe(true);
            expect(result.details?.rowsInserted).toBe(2);
            return { tableName, expectedRows: 2 };
        } finally {
            sourceFile.cleanup();
        }
    },
    buildImportRowCountQuery: tableName => `SELECT COUNT(*) AS ROW_COUNT FROM ${quoteIdentifier(tableName)}`,
    buildImportDropTableSql: tableName => `DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`,
};

export const postgresqlHarness: LiveDialectHarness = {
    name: 'PostgreSQL',
    config: buildLiveConfig(['POSTGRES', 'PG'], 5432),
    createConnection: config => new PostgreSqlConnection(config),
    metadataProvider: postgresqlMetadataProvider,
    smokeSql: 'SELECT current_database() AS database_name, current_schema AS schema_name',
    resolveSchema: (_config, connection) => (connection as PostgreSqlConnection).getCurrentSchemaName(),
    runImportSmoke: async config => {
        const sourceFile = createSmokeCsv('postgresql-import-smoke');
        const tableName = buildSmokeTableName('JBL_SMOKE_POSTGRES');
        try {
            const result = await importDataToPostgreSql(
                sourceFile.filePath,
                tableName,
                toConnectionDetails(config, 'postgresql'),
            );
            expect(result.success).toBe(true);
            expect(result.details?.rowsInserted).toBe(2);
            return { tableName, expectedRows: 2 };
        } finally {
            sourceFile.cleanup();
        }
    },
    buildImportRowCountQuery: tableName => `SELECT COUNT(*) AS ROW_COUNT FROM ${quoteIdentifier(tableName)}`,
    buildImportDropTableSql: tableName => `DROP TABLE IF EXISTS ${quoteIdentifier(tableName)}`,
};

export const verticaHarness: LiveDialectHarness = {
    name: 'Vertica',
    config: buildLiveConfig(
        'VERTICA',
        5433,
        {
            searchPath: 'SEARCH_PATH',
            tlsMode: 'TLS_MODE',
            trustedCertsPath: 'TRUSTED_CERTS_PATH',
            clientLabel: 'CLIENT_LABEL',
            workload: 'WORKLOAD',
        },
        { allowEmptyPassword: true },
    ),
    createConnection: config => new VerticaConnection(config),
    metadataProvider: verticaMetadataProvider,
    smokeSql: 'SELECT CURRENT_DATABASE() AS DATABASE_NAME, CURRENT_SCHEMA() AS SCHEMA_NAME',
    resolveSchema: resolveVerticaSchema,
    runMetadataSmoke: async (connection, config) => {
        const provider = verticaMetadataProvider;
        await expectQueryHasShape(connection, provider.buildListProceduresQuery(config.database));
        await expectQueryHasShape(connection, provider.buildObjectTypeQuery(config.database, 'PROJECTION'));
        await expectQueryHasShape(connection, provider.buildObjectTypeQuery(config.database, 'FUNCTION'));
        await expectQueryHasShape(connection, provider.buildObjectSearchQuery(config.database, LIVE_SOURCE_SEARCH_OPTIONS.likePattern));
        await expectQueryHasShape(connection, provider.buildViewSourceSearchQuery(config.database, LIVE_SOURCE_SEARCH_OPTIONS));
        await expectQueryHasShape(connection, provider.buildProcedureSourceSearchQuery(config.database, LIVE_SOURCE_SEARCH_OPTIONS));

        const schema = resolveVerticaSchema(config, connection);
        const tableRows = await readRows(connection, provider.buildListTablesQuery(config.database, schema), 1);
        const firstTable = tableRows[0];
        const tableName = typeof firstTable?.OBJNAME === 'string' ? firstTable.OBJNAME : '';
        const tableSchema = typeof firstTable?.SCHEMA === 'string' ? firstTable.SCHEMA : schema;

        if (!tableName || !tableSchema) {
            return;
        }

        await expectQueryHasShape(connection, provider.buildColumnMetadataQuery(config.database, tableSchema, tableName), true);
        await expectQueryHasShape(connection, provider.buildTableCommentQuery(config.database, tableSchema, tableName));

        const objectId = firstTable.OBJID;
        if (typeof objectId === 'number' || typeof objectId === 'string') {
            const numericObjectId = Number(objectId);
            if (Number.isFinite(numericObjectId)) {
                await expectQueryHasShape(
                    connection,
                    provider.buildLookupColumnsQuery({
                        database: config.database,
                        schema: tableSchema,
                        tableName,
                        objectId: numericObjectId,
                    }),
                    true,
                );
            }
        }
    },
    runImportSmoke: async config => {
        const sourceFile = createSmokeCsv('vertica-import-smoke');
        const tableName = buildSmokeTableName('JBL_SMOKE_VERTICA');
        try {
            const result = await importDataToVertica(
                sourceFile.filePath,
                tableName,
                toConnectionDetails(config, 'vertica'),
            );
            expect(result.success).toBe(true);
            expect(result.details?.rowsInserted).toBe(2);
            return { tableName, expectedRows: 2 };
        } finally {
            sourceFile.cleanup();
        }
    },
    buildImportRowCountQuery: tableName => `SELECT COUNT(*) AS ROW_COUNT FROM ${quoteIdentifier(tableName)}`,
    buildImportDropTableSql: tableName => `DROP TABLE ${quoteIdentifier(tableName)}`,
};

export function registerLiveIntegrationSuite(harness: LiveDialectHarness): void {
    const describeIfConfigured = harness.config ? describe : describe.skip;
    const itIfConfigured = harness.config ? it : it.skip;
    const itImportIfConfigured = harness.config && harness.runImportSmoke ? it : it.skip;

    describeIfConfigured(`${harness.name} local live integration`, () => {
        let connection: DatabaseConnection;

        beforeAll(async () => {
            if (!harness.config) {
                return;
            }

            connection = harness.createConnection(harness.config);
            await connection.connect();
        }, 60000);

        afterAll(async () => {
            if (connection) {
                await connection.close();
            }
        });

        itIfConfigured('connects and executes a smoke query', async () => {
            await expectQueryHasShape(connection, harness.smokeSql, true);
        });

        itIfConfigured('executes metadata database and schema discovery queries', async () => {
            await expectQueryHasShape(connection, harness.metadataProvider.buildListDatabasesQuery(), true);
            await expectQueryHasShape(connection, harness.metadataProvider.buildListSchemasQuery(harness.config!.database), true);
        });

        itIfConfigured('executes metadata table and view discovery queries', async () => {
            const schema = harness.resolveSchema(harness.config!, connection);
            await expectQueryHasShape(
                connection,
                harness.metadataProvider.buildListTablesQuery(harness.config!.database, schema),
            );
            await expectQueryHasShape(
                connection,
                harness.metadataProvider.buildListViewsQuery(harness.config!.database, schema),
            );
        });

        itIfConfigured('executes dialect-specific metadata smoke queries', async () => {
            if (harness.runMetadataSmoke) {
                await harness.runMetadataSmoke(connection, harness.config!);
            }
        });

        itImportIfConfigured('imports a small CSV file through the live importer', async () => {
            const smokeResult = await harness.runImportSmoke!(harness.config!);
            try {
                const importedRowCount = await readScalarValue(
                    connection,
                    harness.buildImportRowCountQuery!(smokeResult.tableName),
                );
                expect(Number(importedRowCount)).toBe(smokeResult.expectedRows);
            } finally {
                await tryExecute(connection, harness.buildImportDropTableSql!(smokeResult.tableName));
            }
        }, 180000);
    });
}

export function logSkippedHarnesses(
    harnesses: readonly LiveDialectHarness[],
    message: string,
): void {
    if (harnesses.every(harness => !harness.config)) {
        console.log(message);
    }
}

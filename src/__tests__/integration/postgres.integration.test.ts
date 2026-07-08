jest.unmock('chevrotain');

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionContext } from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { PostgreSqlConnection } from '../../../extensions/postgresql/src/postgresqlConnection';
import { postgresqlMetadataProvider } from '../../../extensions/postgresql/src/postgresqlSchemaProvider';
import { postgresqlDialect } from '../../../extensions/postgresql/src/postgresqlDialect';
import { postgresqlMaintenanceProvider } from '../../../extensions/postgresql/src/postgresqlMaintenanceProvider';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import { importDataToPostgreSql } from '../../import/postgresqlImporter';
import type { ConnectionManager } from '../../core/connectionManager';
import { registerDatabaseDialect } from '../../core/factories/databaseDialectRegistry';
import type {
    DatabaseConnectionConfig,
    DatabaseMaintenanceServices,
    DatabaseMaintenanceTarget,
} from '../../contracts/database';
import { LspCompletionEngine, type CompletionMetadataProvider } from '../../server/completionEngine';
import type { MetadataColumnItem, MetadataObjectItem } from '../../lsp/protocol';
import type { ConnectionDetails } from '../../types';

function readEnv(names: string | readonly string[]): string | undefined {
    const candidates = Array.isArray(names) ? names : [names];
    for (const name of candidates) {
        const value = process.env[name]?.trim();
        if (value && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function buildConfig(): DatabaseConnectionConfig | undefined {
    const host = readEnv(['POSTGRES_LIVE_TEST_HOST', 'PG_LIVE_TEST_HOST']);
    const database = readEnv(['POSTGRES_LIVE_TEST_DATABASE', 'PG_LIVE_TEST_DATABASE']);
    const user = readEnv(['POSTGRES_LIVE_TEST_USER', 'PG_LIVE_TEST_USER']);
    const password = readEnv(['POSTGRES_LIVE_TEST_PASSWORD', 'PG_LIVE_TEST_PASSWORD']);

    if (!host || !database || !user || !password) {
        return undefined;
    }

    return {
        host,
        database,
        user,
        password,
        port: Number(readEnv(['POSTGRES_LIVE_TEST_PORT', 'PG_LIVE_TEST_PORT']) || 5432),
    };
}

function toConnectionDetails(config: DatabaseConnectionConfig): ConnectionDetails {
    return {
        ...config,
        dbType: 'postgresql',
    };
}

function createSmokeCsv(): { filePath: string; cleanup(): void } {
    const filePath = path.join(
        os.tmpdir(),
        `postgres-integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.csv`,
    );
    fs.writeFileSync(filePath, 'id,name\n1,Alice\n2,Bob\n', 'utf8');

    return {
        filePath,
        cleanup(): void {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        },
    };
}

function wait(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function readRows(
    connection: PostgreSqlConnection,
    sql: string,
): Promise<Record<string, unknown>[]> {
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

function createMaintenanceTarget(tableName: string): DatabaseMaintenanceTarget {
    return {
        connectionName: 'postgres-live-test',
        databaseName: config!.database,
        schemaName: 'public',
        tableName,
        qualifiedName: `public.${tableName}`,
    };
}

function createLiveMaintenanceServices(connection: PostgreSqlConnection): DatabaseMaintenanceServices {
    return {
        context: {} as ExtensionContext,
        async executeSql(sql: string): Promise<void> {
            await connection.createCommand(sql).execute();
        },
        async getConnectionDetails(): Promise<ConnectionDetails | undefined> {
            return toConnectionDetails(config!);
        },
        async openSqlDocument(): Promise<void> {
            return;
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

function createDocumentWithCursor(sqlWithCursor: string): {
    document: TextDocument;
    cursorOffset: number;
} {
    const cursorOffset = sqlWithCursor.indexOf('|');
    if (cursorOffset < 0) {
        throw new Error('Missing cursor marker "|"');
    }

    const sql = `${sqlWithCursor.slice(0, cursorOffset)}${sqlWithCursor.slice(cursorOffset + 1)}`;
    return {
        document: TextDocument.create('file:///postgres-live-completion.sql', 'sql', 1, sql),
        cursorOffset,
    };
}

class LivePostgreSqlCompletionMetadataProvider implements CompletionMetadataProvider {
    public readonly lookupRequests: Array<{
        database: string;
        table: string;
        schema?: string;
    }> = [];

    public constructor(
        private readonly connection: PostgreSqlConnection,
        private readonly database: string,
        private readonly schema: string,
    ) {}

    public async getContext(_documentUri: string): Promise<{
        effectiveDatabase?: string;
        effectiveSchema?: string;
        databaseKind?: 'postgresql';
    }> {
        return {
            effectiveDatabase: this.database,
            effectiveSchema: this.schema,
            databaseKind: 'postgresql',
        };
    }

    public async getDatabases(_documentUri: string): Promise<MetadataObjectItem[]> {
        return [];
    }

    public async getSchemas(
        _documentUri: string,
        _database: string,
    ): Promise<MetadataObjectItem[]> {
        return [];
    }

    public async getTables(
        _documentUri: string,
        _database: string,
        _schema?: string,
    ): Promise<MetadataObjectItem[]> {
        return [];
    }

    public async getViews(
        _documentUri: string,
        _database: string,
        _schema?: string,
    ): Promise<MetadataObjectItem[]> {
        return [];
    }

    public async getProcedures(
        _documentUri: string,
        _database: string,
        _schema?: string,
    ): Promise<MetadataObjectItem[]> {
        return [];
    }

    public async getColumns(
        _documentUri: string,
        database: string,
        table: string,
        schema?: string,
    ): Promise<MetadataColumnItem[]> {
        this.lookupRequests.push({
            database,
            table,
            schema: schema || this.schema,
        });

        const rows = await readRows(
            this.connection,
            postgresqlMetadataProvider.buildLookupColumnsQuery({
                schema: schema || this.schema,
                tableName: table,
            }),
        );

        const columns: MetadataColumnItem[] = [];
        for (const row of rows) {
            const name = row.ATTNAME;
            if (typeof name !== 'string' || name.trim().length === 0) {
                continue;
            }

            const type = row.FORMAT_TYPE;
            columns.push({
                name,
                type: typeof type === 'string' && type.trim().length > 0 ? type : 'TEXT',
            });
        }

        return columns;
    }
}

const config = buildConfig();
const describeIfConfigured = config ? describe : describe.skip;
const showWarningMessage = vscode.window.showWarningMessage as jest.Mock;
const showInformationMessage = vscode.window.showInformationMessage as jest.Mock;

if (config) {
    ensureBuiltInDialectsRegistered();
    registerDatabaseDialect(postgresqlDialect);
}

describeIfConfigured('postgres integration', () => {
    let connection: PostgreSqlConnection;

    beforeAll(async () => {
        connection = new PostgreSqlConnection(config!);
        await connection.connect();
    }, 60000);

    beforeEach(() => {
        showWarningMessage.mockReset();
        showInformationMessage.mockReset();
        showWarningMessage.mockImplementation(async (_message, _options, ...items) => items[0]);
        showInformationMessage.mockImplementation(async (_message, _options, ...items) => items[0]);
    });

    afterAll(async () => {
        await connection.close();
    });

    it('runs metadata discovery queries against the configured PostgreSQL instance', async () => {
        const schemasReader = await connection
            .createCommand(postgresqlMetadataProvider.buildListSchemasQuery(config!.database))
            .executeReader();
        try {
            expect(await schemasReader.read()).toBe(true);
        } finally {
            await schemasReader.close();
        }
    });

    it('imports a small CSV file with COPY when integration env vars are present', async () => {
        const sourceFile = createSmokeCsv();
        const tableName = `jbl_postgres_ci_${Date.now()}`;

        try {
            const result = await importDataToPostgreSql(
                sourceFile.filePath,
                `public.${tableName}`,
                toConnectionDetails(config!),
            );
            expect(result.success).toBe(true);

            const countReader = await connection
                .createCommand(`SELECT COUNT(*) FROM "public"."${tableName}"`)
                .executeReader();
            try {
                expect(await countReader.read()).toBe(true);
                expect(Number(countReader.getValue(0))).toBe(2);
            } finally {
                await countReader.close();
            }
        } finally {
            await connection.createCommand(`DROP TABLE IF EXISTS "public"."${tableName}"`).execute();
            sourceFile.cleanup();
        }
    }, 120000);

    it('extracts materialized view DDL against the configured PostgreSQL instance', async () => {
        const sourceTableName = `jbl_postgres_mv_src_${Date.now()}`;
        const materializedViewName = `jbl_postgres_mv_${Date.now()}`;

        try {
            await connection.createCommand(
                `CREATE TABLE "public"."${sourceTableName}" (id INTEGER NOT NULL, name TEXT NOT NULL)`
            ).execute();
            await connection.createCommand(
                `INSERT INTO "public"."${sourceTableName}" (id, name) VALUES (1, 'Alice'), (2, 'Bob')`
            ).execute();
            await connection.createCommand(
                `CREATE MATERIALIZED VIEW "public"."${materializedViewName}" AS SELECT id, name FROM "public"."${sourceTableName}"`
            ).execute();

            const ddl = await postgresqlDialect.advancedFeatures!.ddl!.generateViewDDL(
                connection,
                config!.database,
                'public',
                materializedViewName,
            );

            expect(ddl).toContain(`CREATE MATERIALIZED VIEW public.${materializedViewName} AS`);
            expect(ddl).toMatch(/SELECT id,\s+name/i);
        } finally {
            await connection
                .createCommand(`DROP MATERIALIZED VIEW IF EXISTS "public"."${materializedViewName}"`)
                .execute();
            await connection.createCommand(`DROP TABLE IF EXISTS "public"."${sourceTableName}"`).execute();
        }
    }, 120000);

    it('resolves uppercase unquoted alias completion against lowercase PostgreSQL catalogs', async () => {
        const tableName = `jbl_completion_${Date.now()}`;

        try {
            await connection.createCommand(
                `CREATE TABLE public.${tableName} (id INTEGER NOT NULL, customer_name TEXT NOT NULL)`
            ).execute();

            const completionProvider = new LivePostgreSqlCompletionMetadataProvider(
                connection,
                config!.database,
                'public',
            );
            const engine = new LspCompletionEngine(completionProvider);
            const { document, cursorOffset } = createDocumentWithCursor(
                `SELECT o.| FROM PUBLIC.${tableName.toUpperCase()} o`,
            );
            const items = await engine.provideCompletionItems(
                document,
                document.positionAt(cursorOffset),
            );
            const itemLabels = items.map(item => item.label);

            expect(completionProvider.lookupRequests).toEqual([
                {
                    database: config!.database,
                    table: tableName.toUpperCase(),
                    schema: 'PUBLIC',
                },
                {
                    database: config!.database.toLowerCase(),
                    table: tableName,
                    schema: 'public',
                },
            ]);
            expect(itemLabels).toEqual(expect.arrayContaining(['id', 'customer_name']));
        } finally {
            await connection.createCommand(`DROP TABLE IF EXISTS public.${tableName}`).execute();
        }
    }, 120000);

    it('fetches sessions and queries using postgresqlSessionMonitorProvider', async () => {
        const provider = postgresqlDialect.advancedFeatures?.sessionMonitor;
        expect(provider).toBeDefined();

        const mockContext = {} as unknown as ExtensionContext;
        const mockManager = {
            getActiveConnectionName: () => 'test-postgres-conn',
            getConnection: async () => toConnectionDetails(config!),
        } as unknown as ConnectionManager;

        const sessions = await provider!.getSessions(mockContext, mockManager, config!.database);

        expect(Array.isArray(sessions)).toBe(true);
        expect(sessions.length).toBeGreaterThan(0);
        expect(sessions[0]).toHaveProperty('ID');
        expect(sessions[0]).toHaveProperty('USERNAME');
        expect(sessions[0]).toHaveProperty('DBNAME');
        expect(sessions[0]).toHaveProperty('STATUS');

        const runningQueryConnection = new PostgreSqlConnection(config!);
        await runningQueryConnection.connect();
        let sleepPromise: Promise<void> | undefined;
        try {
            sleepPromise = runningQueryConnection.createCommand('SELECT pg_sleep(2)').execute();
            await wait(250);

            const queries = await provider!.getQueries(mockContext, mockManager, config!.database);
            expect(Array.isArray(queries)).toBe(true);
            expect(queries.length).toBeGreaterThan(0);
            expect(
                queries.some(query =>
                    typeof query.QS_SQL === 'string' && query.QS_SQL.toLowerCase().includes('pg_sleep')
                )
            ).toBe(true);
        } finally {
            await sleepPromise?.catch(() => undefined);
            await runningQueryConnection.close();
        }

        const storage = await provider!.getStorage(mockContext, mockManager);
        expect(Array.isArray(storage)).toBe(true);
        expect(storage.length).toBeGreaterThanOrEqual(1);
        expect(storage[0]).toHaveProperty('DATABASE');
        expect(storage[0]).toHaveProperty('USED_MB');

        const resources = await provider!.getResources(mockContext, mockManager);
        expect(resources).toHaveProperty('gra');
        expect(resources).toHaveProperty('systemUtil');
        expect(Array.isArray(resources.gra)).toBe(true);
    }, 60000);

    it('manages partitions through the PostgreSQL maintenance provider against a live database', async () => {
        const parentTableName = `jbl_pg_part_parent_${Date.now()}`;
        const partitionTableName = `${parentTableName}_p202401`;
        const partitionBound = "FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')";
        const services = createLiveMaintenanceServices(connection);
        const target = createMaintenanceTarget(parentTableName);

        try {
            await connection.createCommand(
                `CREATE TABLE "public"."${parentTableName}" (
                    id INTEGER NOT NULL,
                    created_at DATE NOT NULL
                ) PARTITION BY RANGE (created_at)`
            ).execute();

            await postgresqlMaintenanceProvider.createPartition!(
                target,
                {
                    partitionName: partitionTableName,
                    partitionBound,
                },
                services
            );

            let partitions = await postgresqlMaintenanceProvider.listPartitions!(target, services);
            expect(partitions.some(partition => partition.name === partitionTableName)).toBe(true);

            await postgresqlMaintenanceProvider.detachPartition!(
                target,
                partitionTableName,
                services,
                false,
                'public'
            );

            partitions = await postgresqlMaintenanceProvider.listPartitions!(target, services);
            expect(partitions.some(partition => partition.name === partitionTableName)).toBe(false);

            await postgresqlMaintenanceProvider.attachPartition!(
                target,
                {
                    tableName: partitionTableName,
                    schema: 'public',
                    partitionBound,
                },
                services
            );

            partitions = await postgresqlMaintenanceProvider.listPartitions!(target, services);
            expect(partitions.some(partition => partition.name === partitionTableName)).toBe(true);

            await postgresqlMaintenanceProvider.dropPartition!(
                target,
                partitionTableName,
                services,
                false,
                'public'
            );

            partitions = await postgresqlMaintenanceProvider.listPartitions!(target, services);
            expect(partitions.some(partition => partition.name === partitionTableName)).toBe(false);
        } finally {
            await connection.createCommand(`DROP TABLE IF EXISTS "public"."${parentTableName}" CASCADE`).execute();
            await connection.createCommand(`DROP TABLE IF EXISTS "public"."${partitionTableName}" CASCADE`).execute();
        }
    }, 120000);

    it('manages indexes through the PostgreSQL maintenance provider against a live database', async () => {
        const tableName = `jbl_pg_index_${Date.now()}`;
        const indexName = `${tableName}_created_at_idx`;
        const services = createLiveMaintenanceServices(connection);
        const target = createMaintenanceTarget(tableName);

        try {
            await connection.createCommand(
                `CREATE TABLE "public"."${tableName}" (
                    id INTEGER NOT NULL,
                    created_at TIMESTAMP NOT NULL,
                    status TEXT NOT NULL
                )`
            ).execute();
            await connection.createCommand(
                `INSERT INTO "public"."${tableName}" (id, created_at, status)
                 VALUES (1, NOW(), 'active'), (2, NOW(), 'inactive')`
            ).execute();

            await postgresqlMaintenanceProvider.createIndex!(
                target,
                {
                    columns: ['created_at'],
                    indexName,
                },
                services
            );

            let indexes = await postgresqlMaintenanceProvider.listIndexes!(target, services);
            const createdIndex = indexes.find(index => index.name === indexName);
            expect(createdIndex).toBeDefined();
            expect(createdIndex?.columns).toContain('created_at');

            await postgresqlMaintenanceProvider.reindexIndex!(
                target,
                indexName,
                {},
                services,
                'public'
            );

            await postgresqlMaintenanceProvider.dropIndex!(
                target,
                indexName,
                services,
                false,
                false
            );

            indexes = await postgresqlMaintenanceProvider.listIndexes!(target, services);
            expect(indexes.some(index => index.name === indexName)).toBe(false);
        } finally {
            await connection.createCommand(`DROP TABLE IF EXISTS "public"."${tableName}" CASCADE`).execute();
        }
    }, 120000);
});

if (!config) {
    console.log(
        '⚠️ PostgreSQL integration test skipped: set POSTGRES_LIVE_TEST_* or PG_LIVE_TEST_* env vars, or use the optional docker-compose workflow.',
    );
}

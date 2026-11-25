/**
 * Live Netezza: prefetch → disk → process restart → code completion.
 *
 * Verifies the durability contract end to end against a real NPS instance:
 *   1. a complete metadata prefetch persists databases, schemas, tables, views,
 *      procedures, columns and their catalog comments to disk;
 *   2. a brand-new `MetadataCache` (simulated VS Code restart) hydrates that
 *      snapshot without a single catalog query;
 *   3. LSP completion driven only by the restored snapshot still offers
 *      database/schema/table/column names, types and comments.
 *
 * Read-only: the suite never creates, alters or drops a database object.
 *
 * Required:
 *   NZ_DEV_PASSWORD
 *
 * Optional:
 *   NZ_DEV_HOST, NZ_DEV_PORT, NZ_DEV_DATABASE, NZ_DEV_USER
 *   NZ_DEV_PREFETCH_DB              - database exercised by the restart tests
 *   NZ_DEV_RESTART_TEST_TIMEOUT_MS  - per-test timeout, default 600000
 *
 * Run:
 *   NZ_DEV_PASSWORD=... npx jest --config jest.live.config.js --runInBand \
 *     src/__tests__/integration/netezzaMetadataRestartCompletion.live.integration.test.ts
 */

// Alias binding (`T.|`) comes from the real Chevrotain parse; the shared
// manual mock cannot produce a semantic scope.
jest.unmock('chevrotain');

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { NzConnection } from '@justybase/netezza-driver';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem } from 'vscode-languageserver/node';
import { handleMetadataRequest } from '../../activation/lspRegistration';
import type { ConnectionManager } from '../../core/connectionManager';
import {
    runQueryRaw,
    type QueryResult,
    type RunQueryRawOptions,
} from '../../core/queryRunner';
import { ensureBuiltInDialectsRegistered } from '../../dialects';
import { NZ_QUERIES } from '../../dialects/netezza/metadata/systemQueries';
import { MetadataCache } from '../../metadata/cache/MetadataCache';
import { createConnectionScopedMetadataQueryRunner } from '../../metadata/connectionScopedMetadataQueryRunner';
import type { DisposableQueryRunnerRawFn, MetadataPrefetchRefreshDetails } from '../../metadata/prefetch';
import type { MetadataProvider } from '../../providers/providers/metadataProvider';
import { LspCompletionEngine } from '../../server/completionEngine';
import { MetadataBridge } from '../../server/metadataBridge';
import { DocumentParseSession } from '../../sqlParser/documentParseSession';
import type { ConnectionDetails } from '../../types';
import { Logger } from '../../utils/logger';

jest.mock('vscode');
jest.mock('../../dialects/netezza/metadata/netezzaSchemaContext', () => ({
    resolveNetezzaSchemasEnabled: jest.fn(async () => true),
    resolveNetezzaDefaultSchema: jest.fn(async () => 'ADMIN'),
}));

const skipLive = !process.env.NZ_DEV_PASSWORD;
const describeIfLive = skipLive ? describe.skip : describe;

const DB_CONFIG = {
    host: process.env.NZ_DEV_HOST || 'localhost',
    port: process.env.NZ_DEV_PORT ? Number(process.env.NZ_DEV_PORT) : 5480,
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password: process.env.NZ_DEV_PASSWORD || '',
};

const CONNECTION_NAME = 'NZ_RESTART_COMPLETION';
const QUERY_TIMEOUT_SECONDS = 180;
const TEST_TIMEOUT_MS = Number(process.env.NZ_DEV_RESTART_TEST_TIMEOUT_MS || '600000');
const DOCUMENT_URI = 'file:///nz-restart-completion.sql';
const EXPAND_COLUMNS_LABEL = '* (Expand Columns)';

let monitorConnection: NzConnection | undefined;
let connectionManager: ConnectionManager;
let targetDatabase: string;
let storageDir: string;

interface TableWithComments {
    schema: string;
    table: string;
    tableComment?: string;
    column: string;
    columnComment?: string;
}

function openLiveConnection(database: string): NzConnection {
    return new NzConnection({
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
    });
}

async function queryRows<T extends Record<string, unknown>>(
    connection: NzConnection,
    sql: string,
): Promise<T[]> {
    const command = connection.createCommand(sql);
    command.commandTimeout = QUERY_TIMEOUT_SECONDS;
    const reader = await command.executeReader();
    const rows: Record<string, unknown>[] = [];
    try {
        const fieldCount = reader.fieldCount;
        while (await reader.read()) {
            const row: Record<string, unknown> = {};
            for (let index = 0; index < fieldCount; index += 1) {
                row[reader.getName(index) ?? `COL_${index}`] = reader.getValue(index);
            }
            rows.push(row);
        }
    } finally {
        await reader.close();
    }
    return rows as T[];
}

function createLiveConnectionManager(): ConnectionManager {
    const details: ConnectionDetails = {
        name: CONNECTION_NAME,
        host: DB_CONFIG.host,
        port: DB_CONFIG.port,
        database: DB_CONFIG.database,
        user: DB_CONFIG.user,
        password: DB_CONFIG.password,
        dbType: 'netezza',
    };
    return {
        getConnection: async (name: string) => (name === CONNECTION_NAME ? details : undefined),
        getConnectionMetadata: (name: string) => (name === CONNECTION_NAME ? details : undefined),
        getConnectionDatabaseKind: (name: string) => (name === CONNECTION_NAME ? 'netezza' : undefined),
        getConnectionNames: () => [CONNECTION_NAME],
        ensureFullyLoaded: async () => undefined,
        getEffectiveDatabase: async () => targetDatabase,
        getEffectiveSchema: async () => process.env.NZ_DEV_SCHEMA || 'ADMIN',
        getExecutionDatabaseKind: () => 'netezza',
        getConnectionForExecution: () => CONNECTION_NAME,
    } as unknown as ConnectionManager;
}

function createCache(): MetadataCache {
    return new MetadataCache(
        {
            globalStorageUri: vscode.Uri.file(storageDir),
        } as unknown as vscode.ExtensionContext,
        connectionManager,
    );
}

function createRunner(): DisposableQueryRunnerRawFn {
    return createConnectionScopedMetadataQueryRunner({
        context: {} as vscode.ExtensionContext,
        connectionManager,
        connectionName: CONNECTION_NAME,
        maxRows: 1_000_000,
        timeoutSeconds: QUERY_TIMEOUT_SECONDS,
        queryExecutor: async (options: RunQueryRawOptions): Promise<QueryResult> => runQueryRaw(options),
    });
}

async function waitForTerminalRefresh(
    cache: MetadataCache,
    runner: DisposableQueryRunnerRawFn,
    manual = true,
): Promise<MetadataPrefetchRefreshDetails> {
    return new Promise<MetadataPrefetchRefreshDetails>((resolve, reject) => {
        let settled = false;
        const subscription = cache.onDidPrefetchRefreshDetails(details => {
            if (details.completedAt === undefined || (details.stage !== 'complete' && details.stage !== 'error')) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            subscription.dispose();
            resolve(details);
        });
        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            subscription.dispose();
            reject(new Error(`Timed out waiting for the Netezza prefetch after ${TEST_TIMEOUT_MS}ms`));
        }, TEST_TIMEOUT_MS);
        try {
            cache.triggerConnectionPrefetch(CONNECTION_NAME, runner, { manual });
        } catch (error: unknown) {
            clearTimeout(timeout);
            subscription.dispose();
            reject(error);
        }
    });
}

async function prefetchAndRestart(): Promise<MetadataCache> {
    const writer = createCache();
    const runner = createRunner();
    try {
        const details = await waitForTerminalRefresh(writer, runner);
        expect(details.stage).toBe('complete');
        expect(details.snapshot?.complete).toBe(true);
    } finally {
        await runner.dispose?.();
    }
    // `dispose()` persists the whole connection snapshot (same path VS Code
    // takes on exit) and releases the disk lock.
    await writer.dispose();

    const restarted = createCache();
    await restarted.initialize();
    await restarted.whenConnectionMetadataHydrated(CONNECTION_NAME);
    return restarted;
}

function createCompletionHarness(cache: MetadataCache): (sqlWithCursor: string) => Promise<CompletionItem[]> {
    // Cache-only contract: any live metadata call is a test failure, which
    // proves completion is served by the persisted snapshot alone.
    const forbidden = (surface: string) => () => {
        throw new Error(`live ${surface} must not run after a disk restart`);
    };
    const metadataProvider = {
        getDatabases: forbidden('getDatabases'),
        getSchemas: forbidden('getSchemas'),
        getTables: forbidden('getTables'),
        getViews: forbidden('getViews'),
        getProcedures: forbidden('getProcedures'),
        getTableColumnsMetadata: forbidden('getTableColumnsMetadata'),
        warmDatabaseColumns: forbidden('warmDatabaseColumns'),
    } as unknown as MetadataProvider;
    const bridge = new MetadataBridge(async params => handleMetadataRequest(
        params,
        { subscriptions: [] } as unknown as vscode.ExtensionContext,
        metadataProvider,
        cache,
        connectionManager,
    ));
    const engine = new LspCompletionEngine(bridge, new DocumentParseSession());
    return async (sqlWithCursor: string): Promise<CompletionItem[]> => {
        const cursor = sqlWithCursor.indexOf('|');
        if (cursor < 0) {
            throw new Error('completion probe is missing the cursor marker');
        }
        const text = `${sqlWithCursor.slice(0, cursor)}${sqlWithCursor.slice(cursor + 1)}`;
        const document = TextDocument.create(DOCUMENT_URI, 'sql', 1, text);
        return engine.provideCompletionItems(document, document.positionAt(cursor));
    };
}

function labelOf(item: CompletionItem): string {
    return item.label;
}

function documentationOf(item: CompletionItem | undefined): string | undefined {
    if (!item) {
        return undefined;
    }
    const documentation = item.documentation;
    if (typeof documentation === 'string') {
        return documentation;
    }
    if (documentation && 'value' in documentation) {
        return documentation.value;
    }
    return undefined;
}

function findItem(items: readonly CompletionItem[], expected: string): CompletionItem | undefined {
    const upper = expected.toUpperCase();
    return items.find(item => {
        const label = labelOf(item);
        return label.toUpperCase() === upper || label.toUpperCase().endsWith(`.${upper}`);
    });
}

async function findTableWithComments(
    connection: NzConnection,
    database: string,
): Promise<TableWithComments> {
    const rows = await queryRows<{
        SCHEMA: string;
        TABLENAME: string;
        TABLECOMMENT?: string | null;
        ATTNAME: string;
        COLUMNCOMMENT?: string | null;
    }>(
        connection,
        `
        SELECT O.SCHEMA,
               O.OBJNAME AS TABLENAME,
               O.DESCRIPTION AS TABLECOMMENT,
               C.ATTNAME,
               C.DESCRIPTION AS COLUMNCOMMENT
        FROM ${database}.._V_OBJECT_DATA O
        JOIN ${database}.._V_RELATION_COLUMN C ON C.OBJID = O.OBJID
        WHERE O.OBJTYPE = 'TABLE'
          AND (C.DESCRIPTION IS NOT NULL OR O.DESCRIPTION IS NOT NULL)
        ORDER BY CASE WHEN O.DESCRIPTION IS NOT NULL AND C.DESCRIPTION IS NOT NULL THEN 0 ELSE 1 END,
                 O.SCHEMA, O.OBJNAME, C.ATTNUM
        `,
    );
    const rich = rows.find(row => row.TABLECOMMENT && row.COLUMNCOMMENT) ?? rows[0];
    if (!rich) {
        throw new Error(
            `Database '${database}' has no commented table/column; the live restart test needs one. `
            + 'Add a COMMENT ON TABLE/COLUMN to a fixture table first.',
        );
    }
    return {
        schema: String(rich.SCHEMA),
        table: String(rich.TABLENAME),
        tableComment: rich.TABLECOMMENT ? String(rich.TABLECOMMENT) : undefined,
        column: String(rich.ATTNAME),
        columnComment: rich.COLUMNCOMMENT ? String(rich.COLUMNCOMMENT) : undefined,
    };
}

describeIfLive('Netezza metadata restart → completion - live', () => {
    beforeAll(async () => {
        ensureBuiltInDialectsRegistered();
        Logger.initialize({
            appendLine: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        } as unknown as vscode.OutputChannel);
        storageDir = fs.mkdtempSync(
            `${process.env.TEMP || process.env.TMPDIR || '.'}${require('path').sep}nz-restart-metadata-`,
        );

        monitorConnection = openLiveConnection(DB_CONFIG.database);
        await monitorConnection.connect();

        const databaseRows = await queryRows<{ DATABASE: string }>(
            monitorConnection,
            NZ_QUERIES.LIST_DATABASES,
        );
        const available = databaseRows
            .map(row => String(row.DATABASE))
            .filter(name => name.length > 0 && !['SYSTEM', 'MASTER_DB'].includes(name.toUpperCase()));
        const requested = process.env.NZ_DEV_PREFETCH_DB?.trim();
        targetDatabase = requested
            ? available.find(name => name.toUpperCase() === requested.toUpperCase()) ?? requested
            : available[0];
        if (!targetDatabase) {
            throw new Error('Netezza returned no user database to exercise');
        }

        connectionManager = createLiveConnectionManager();
    }, TEST_TIMEOUT_MS);

    afterAll(async () => {
        await monitorConnection?.close();
        monitorConnection = undefined;
        Logger.tryGetInstance()?.dispose();
        if (storageDir) {
            fs.rmSync(storageDir, { recursive: true, force: true });
        }
    });

    it(
        'hydrates the persisted connection snapshot without catalog SQL',
        async () => {
            const restarted = await prefetchAndRestart();
            try {
                const databases = restarted.getDatabases(CONNECTION_NAME);
                expect(databases?.map(database => String(database.DATABASE)))
                    .toEqual(expect.arrayContaining([targetDatabase]));

                const schemas = restarted.getSchemas(CONNECTION_NAME, targetDatabase);
                expect(schemas?.length).toBeGreaterThan(0);

                const tables = restarted.getTablesAllSchemas(CONNECTION_NAME, targetDatabase);
                expect(tables?.length).toBeGreaterThan(0);
                expect(tables?.every(table => typeof table.OBJNAME === 'string')).toBe(true);

                const procedures = restarted.getProceduresAllSchemas(CONNECTION_NAME, targetDatabase);
                expect(Array.isArray(procedures)).toBe(true);

                // Columns intentionally stay on disk until a scope asks for them.
                const firstTable = tables?.find(table => table.OBJNAME && table.SCHEMA);
                expect(firstTable).toBeDefined();
                const columnKey = `${targetDatabase}.${firstTable!.SCHEMA}.${firstTable!.OBJNAME}`;
                expect(restarted.getColumns(CONNECTION_NAME, columnKey)).toBeUndefined();
                await restarted.ensureColumnsLoadedForTableKey(CONNECTION_NAME, columnKey);
                expect(restarted.getColumns(CONNECTION_NAME, columnKey)?.length).toBeGreaterThan(0);
            } finally {
                await restarted.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'completes databases, schemas, tables and columns from the restored snapshot',
        async () => {
            const restarted = await prefetchAndRestart();
            try {
                const complete = createCompletionHarness(restarted);

                const databasePrefix = targetDatabase.slice(0, Math.max(2, Math.ceil(targetDatabase.length / 2)));
                expect(labelsOf(await complete(`SELECT * FROM ${databasePrefix}|`)))
                    .toEqual(expect.arrayContaining([targetDatabase]));

                const tables = restarted.getTablesAllSchemas(CONNECTION_NAME, targetDatabase) ?? [];
                const sample = tables.find(table => table.OBJNAME && table.SCHEMA);
                expect(sample).toBeDefined();
                const schema = String(sample!.SCHEMA);
                const tableName = String(sample!.OBJNAME);

                expect(labelsOf(await complete(`SELECT * FROM ${targetDatabase}.${schema}.|`)))
                    .toEqual(expect.arrayContaining([tableName]));

                const columnItems = await complete(
                    `SELECT * FROM ${targetDatabase}..${tableName} T WHERE T.|`,
                );
                expect(columnItems.length).toBeGreaterThan(0);

                // The wildcard expansion entry is a pseudo-column, not a real
                // column name, so only assert the prefix filter for a real one.
                const firstColumnLabel = columnItems
                    .map(labelOf)
                    .find(label => label !== EXPAND_COLUMNS_LABEL);
                expect(firstColumnLabel).toBeDefined();
                const filtered = await complete(
                    `SELECT * FROM ${targetDatabase}..${tableName} T WHERE T.${firstColumnLabel}|`,
                );
                expect(labelsOf(filtered)).toEqual(expect.arrayContaining([firstColumnLabel!]));
            } finally {
                await restarted.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'keeps catalog comments for tables and columns after the restart',
        async () => {
            const commented = await findTableWithComments(monitorConnection!, targetDatabase);
            const restarted = await prefetchAndRestart();
            try {
                const completeSql = createCompletionHarness(restarted);
                let asserted = 0;

                if (commented.tableComment) {
                    const tableItem = findItem(
                        await completeSql(`SELECT * FROM ${commented.table.slice(0, Math.max(2, commented.table.length - 1))}|`),
                        commented.table,
                    );
                    expect(tableItem).toBeDefined();
                    expect(`${tableItem!.detail ?? ''} ${documentationOf(tableItem) ?? ''}`)
                        .toContain(commented.tableComment);
                    asserted += 1;
                }

                if (commented.columnComment) {
                    const columnItems = await completeSql(
                        `SELECT * FROM ${targetDatabase}..${commented.table} T WHERE T.|`,
                    );
                    const columnItem = findItem(columnItems, commented.column);
                    expect(columnItem).toBeDefined();
                    expect(documentationOf(columnItem)).toBe(commented.columnComment);
                    asserted += 1;
                }

                expect(asserted).toBeGreaterThan(0);
            } finally {
                await restarted.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );

    it(
        'serves join completion for a foreign-key pair from the restored snapshot',
        async () => {
            const restarted = await prefetchAndRestart();
            try {
                const slices = restarted.getForeignKeyRelationshipSlices(CONNECTION_NAME);
                const reference = slices
                    .flatMap(slice => slice.references ?? [])
                    .find(candidate => candidate.fromTable && candidate.toTable);
                if (!reference) {
                    // Netezza exposes FK metadata only when constraints exist.
                    return;
                }
                expect(reference.fromTable).toBeTruthy();
                expect(reference.toTable).toBeTruthy();
                expect(reference.toColumn).toBeTruthy();

                const complete = createCompletionHarness(restarted);
                const items = await complete(
                    `SELECT * FROM ${targetDatabase}..${reference.fromTable} A JOIN |`,
                );
                const fkTarget = items.find(item => item.detail === 'JOIN with declared foreign key');
                expect(fkTarget).toBeDefined();
                expect(labelOf(fkTarget!)).toContain(reference.toTable!);
                expect(String(fkTarget!.insertText ?? '')).toContain(reference.toColumn!);
            } finally {
                await restarted.dispose();
            }
        },
        TEST_TIMEOUT_MS,
    );
});

function labelsOf(items: readonly CompletionItem[]): string[] {
    return items.map(labelOf);
}

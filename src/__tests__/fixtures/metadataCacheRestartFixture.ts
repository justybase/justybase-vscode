/**
 * Shared helpers for metadata disk restart integration tests.
 * Simulates: full prefetch → dispose (disk save) → new MetadataCache → initialize.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/connectionManager';
import { MetadataCache } from '../../metadataCache';
import { SchemaItem } from '../../providers/schemaProvider';
import type { ColumnMetadata } from '../../metadata/types';

export const RESTART_CONN = 'RESTART_TEST_CONN';
export const SMALL_DB = 'SMALLDB';
export const LARGE_DB = 'BIGDB';
export const SCHEMA = 'ADMIN';
export const LARGE_DB_TABLE_COUNT = 501;

const COLUMN_ROW = (
    name: string,
    overrides?: Partial<ColumnMetadata>,
): ColumnMetadata => ({
    ATTNAME: name,
    FORMAT_TYPE: 'INTEGER',
    label: name,
    kind: 5,
    detail: 'INTEGER',
    documentation: '',
    isPk: false,
    isFk: false,
    isDistributionKey: false,
    ...overrides,
});

export function installDiskPersistenceConfigMock(): void {
    jest.spyOn(
        require('../../compatibility/configuration'),
        'getExtensionConfiguration',
    ).mockReturnValue({
        get: (key: string, defaultValue?: unknown) => {
            if (key === 'metadataCache.diskPersistence') {
                return true;
            }
            if (key === 'metadataCache.crossWindowSync') {
                return false;
            }
            return defaultValue;
        },
    });
}

export function createTempStorageDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-restart-int-'));
}

export function createMockConnectionManager(): ConnectionManager {
    return {
        getConnectionMetadata: () => ({
            host: 'nz.host',
            port: 5480,
            database: 'SYSTEM',
            user: 'admin',
            dbType: 'netezza' as const,
        }),
        getConnectionNames: () => [RESTART_CONN],
        getConnectionDatabaseKind: () => 'netezza' as const,
        ensureFullyLoaded: jest.fn(async () => undefined),
        onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    } as unknown as ConnectionManager;
}

export function createMockExtensionContext(storageDir: string): vscode.ExtensionContext {
    return {
        globalStorageUri: vscode.Uri.file(storageDir),
        extensionUri: vscode.Uri.file(storageDir),
        subscriptions: [],
        asAbsolutePath: (relativePath: string) => `${storageDir}/${relativePath}`,
    } as unknown as vscode.ExtensionContext;
}

export function createTableSchemaItem(
    tableName: string,
    dbName: string,
    schema: string,
    connectionName: string,
    objId = 1,
): SchemaItem {
    return new SchemaItem(
        tableName,
        vscode.TreeItemCollapsibleState.Collapsed,
        'netezza:TABLE',
        dbName,
        'TABLE',
        schema,
        objId,
        `${tableName} table`,
        connectionName,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tableName,
    );
}

export function createMetadataCache(
    storageDir: string,
    connectionManager?: ConnectionManager,
): MetadataCache {
    return new MetadataCache(
        { globalStorageUri: vscode.Uri.file(storageDir) } as vscode.ExtensionContext,
        connectionManager ?? createMockConnectionManager(),
    );
}

export function stampPrefetchFresh(cache: MetadataCache, connectionName = RESTART_CONN): void {
    cache['prefetcher'].restorePrefetchTimestamps(
        new Map([[connectionName, Date.now()]]),
    );
}

/**
 * Persist current in-memory cache to disk and open a fresh MetadataCache (VS Code restart).
 */
export async function restartFromDisk(
    cache: MetadataCache,
    storageDir: string,
    connectionName = RESTART_CONN,
): Promise<MetadataCache> {
    stampPrefetchFresh(cache, connectionName);
    await cache.dispose();
    const restarted = createMetadataCache(storageDir);
    await restarted.initialize();
    await restarted.whenConnectionMetadataHydrated(connectionName);
    return restarted;
}

export function populateSmallCatalog(cache: MetadataCache, connectionName = RESTART_CONN): void {
    cache.setDatabases(connectionName, [
        { DATABASE: SMALL_DB, label: SMALL_DB, kind: 9 },
    ]);
    cache.setSchemas(connectionName, SMALL_DB, [
        { SCHEMA, label: SCHEMA, kind: 19 },
    ]);
    const idMap = new Map<string, number>([
        [`${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`, 101],
        [`${SMALL_DB}.${SCHEMA}.SEQ_ACCOUNT`, 102],
        [`${SMALL_DB}.${SCHEMA}.SYN_ACCOUNT`, 103],
        [`${SMALL_DB}.${SCHEMA}.MV_ACCOUNT`, 104],
        [`${SMALL_DB}.${SCHEMA}.SV_ACCOUNT`, 105],
    ]);
    cache.setTables(
        connectionName,
        `${SMALL_DB}.${SCHEMA}`,
        [
            {
                OBJNAME: 'DIM_ACCOUNT',
                OBJID: 101,
                SCHEMA,
                label: 'DIM_ACCOUNT',
                objType: 'TABLE',
                kind: 6,
            },
            {
                OBJNAME: 'SEQ_ACCOUNT',
                OBJID: 102,
                SCHEMA,
                label: 'SEQ_ACCOUNT',
                objType: 'SEQUENCE',
                kind: 6,
            },
            {
                OBJNAME: 'SYN_ACCOUNT',
                OBJID: 103,
                SCHEMA,
                label: 'SYN_ACCOUNT',
                objType: 'SYNONYM',
                kind: 6,
                REFOBJNAME: `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`,
            },
            {
                OBJNAME: 'MV_ACCOUNT',
                OBJID: 104,
                SCHEMA,
                label: 'MV_ACCOUNT',
                objType: 'MATERIALIZED VIEW',
                kind: 18,
            },
            {
                OBJNAME: 'SV_ACCOUNT',
                OBJID: 105,
                SCHEMA,
                label: 'SV_ACCOUNT',
                objType: 'SYSTEM VIEW',
                kind: 18,
            },
        ],
        idMap,
    );
    cache.setProcedures(connectionName, `${SMALL_DB}..`, [
        {
            PROCEDURE: 'P1',
            PROCEDURESIGNATURE: 'P1()',
            SCHEMA,
            label: 'P1()',
        },
    ]);
    cache.setTypeGroups(connectionName, SMALL_DB, [
        'TABLE',
        'PROCEDURE',
        'SEQUENCE',
        'SYNONYM',
        'MATERIALIZED VIEW',
        'SYSTEM VIEW',
    ]);
    cache.setColumns(connectionName, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`, [
        COLUMN_ROW('ACCOUNT_ID', { isPk: true }),
        COLUMN_ROW('ACCOUNT_NAME'),
    ]);
}

export function createTypeGroupSchemaItem(
    objType: string,
    dbName: string,
    connectionName: string,
): SchemaItem {
    return new SchemaItem(
        objType,
        vscode.TreeItemCollapsibleState.Collapsed,
        `typeGroup:${objType}`,
        dbName,
        objType,
        undefined,
        undefined,
        undefined,
        connectionName,
    );
}

export function populateLargeTablesOnlyCatalog(
    cache: MetadataCache,
    connectionName = RESTART_CONN,
): void {
    const tables = Array.from({ length: LARGE_DB_TABLE_COUNT }, (_, index) => ({
        OBJNAME: `T${index}`,
        OBJID: index + 1,
        SCHEMA,
        label: `T${index}`,
        objType: 'TABLE',
        kind: 6,
    }));

    cache.setDatabases(connectionName, [
        { DATABASE: LARGE_DB, label: LARGE_DB, kind: 9 },
    ]);
    cache.setSchemas(connectionName, LARGE_DB, [
        { SCHEMA, label: SCHEMA, kind: 19 },
    ]);
    cache.setTables(connectionName, `${LARGE_DB}.${SCHEMA}`, tables, new Map());
    cache.setProcedures(connectionName, `${LARGE_DB}..`, [
        { PROCEDURE: 'P1', SCHEMA, label: 'P1' },
    ]);
    cache.setTypeGroups(connectionName, LARGE_DB, ['TABLE']);
}

export function populateLargeCatalogColumnLayers(
    cache: MetadataCache,
    connectionName = RESTART_CONN,
): void {
    populateLargeTablesOnlyCatalog(cache, connectionName);
    cache.setColumns(connectionName, `${LARGE_DB}.${SCHEMA}.TARGET`, [
        COLUMN_ROW('TARGET_ID', { isPk: true }),
        COLUMN_ROW('TARGET_NAME'),
    ]);
    cache.setColumns(connectionName, `${LARGE_DB}.${SCHEMA}.T0`, [
        COLUMN_ROW('ID', { isPk: true }),
    ]);
}

export function countColumnLayersInRam(
    cache: MetadataCache,
    connectionName: string,
    dbName: string,
): number {
    const prefix = `${connectionName}|${dbName.toUpperCase()}.`;
    let count = 0;
    for (const key of cache.columnCache.keys()) {
        if (key.startsWith(prefix)) {
            count += 1;
        }
    }
    return count;
}

export function isDatabaseColumnsFullyLoaded(
    cache: MetadataCache,
    connectionName: string,
    dbName: string,
): boolean {
    const loaded = cache['_columnLoaderState'].columnsLoadedDatabases.get(connectionName);
    if (!loaded) {
        return false;
    }
    const upperDb = dbName.toUpperCase();
    for (const name of loaded) {
        if (name.toUpperCase() === upperDb) {
            return true;
        }
    }
    return false;
}

/**
 * Disk persistence restart integration tests.
 *
 * Guards against historical regressions:
 * - columns not restored from disk after VS Code restart (full or per-layer load)
 * - large catalogs hydrating entire column files into RAM on first tree expand
 * - "Fetching views" when views catalog was already enumerated during prefetch/hydrate
 * - SchemaProvider.getChildren column expand after restart (tree path)
 *
 * Runs in default `npm run test` (no live Netezza required).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { runQueryRaw } from '../../core/queryRunner';
import { MetadataCache } from '../../metadataCache';
import { MetadataProvider } from '../../providers/providers/metadataProvider';
import { SchemaProvider } from '../../providers/schemaProvider';
import { Logger } from '../../utils/logger';
import {
    countColumnLayersInRam,
    createMetadataCache,
    createMockConnectionManager,
    createMockExtensionContext,
    createTableSchemaItem,
    createTempStorageDir,
    installDiskPersistenceConfigMock,
    isDatabaseColumnsFullyLoaded,
    LARGE_DB,
    LARGE_DB_TABLE_COUNT,
    populateLargeCatalogColumnLayers,
    populateSmallCatalog,
    restartFromDisk,
    RESTART_CONN,
    SCHEMA,
    SMALL_DB,
    createTypeGroupSchemaItem,
} from '../fixtures/metadataCacheRestartFixture';

jest.mock('vscode');

jest.mock('../../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn((result: { data?: unknown[][]; columns?: { name: string }[] }) => {
        if (!result?.data || !result.columns) {
            return [];
        }
        return result.data.map((row) => {
            const obj: Record<string, unknown> = {};
            result.columns!.forEach((col, index) => {
                obj[col.name] = row[index];
            });
            return obj;
        });
    }),
}));

describe('MetadataCache disk restart integration', () => {
    let tempDir: string;
    const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;

    beforeEach(() => {
        tempDir = createTempStorageDir();
        runQueryRawMock.mockReset();

        const mockOutputChannel = {
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        } as unknown as vscode.OutputChannel;
        Logger.initialize(mockOutputChannel);
        installDiskPersistenceConfigMock();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('restores small-catalog columns from disk after restart without SQL', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);

        const restarted = await restartFromDisk(cache1, tempDir);

        expect(restarted.getColumns(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`)).toBeUndefined();
        expect(restarted.isLargeTableCatalog(RESTART_CONN, SMALL_DB)).toBe(false);

        await restarted.ensureColumnsLoadedForTableKey(
            RESTART_CONN,
            `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`,
        );

        expect(restarted.getColumns(RESTART_CONN, `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ATTNAME: 'ACCOUNT_ID', isPk: true }),
                expect.objectContaining({ ATTNAME: 'ACCOUNT_NAME' }),
            ]),
        );
        expect(runQueryRawMock).not.toHaveBeenCalled();
        expect(countColumnLayersInRam(restarted, RESTART_CONN, SMALL_DB)).toBe(1);
    });

    it('loads only one table column layer after restart for large catalogs (no full DB hydrate)', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateLargeCatalogColumnLayers(cache1);

        expect(cache1.isLargeTableCatalog(RESTART_CONN, LARGE_DB)).toBe(true);

        const restarted = await restartFromDisk(cache1, tempDir);

        expect(restarted.getTables(RESTART_CONN, `${LARGE_DB}.${SCHEMA}`)?.length).toBe(
            LARGE_DB_TABLE_COUNT,
        );
        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(0);
        expect(isDatabaseColumnsFullyLoaded(restarted, RESTART_CONN, LARGE_DB)).toBe(false);

        await restarted.ensureColumnsLoadedForTableKey(
            RESTART_CONN,
            `${LARGE_DB}.${SCHEMA}.TARGET`,
        );

        expect(restarted.getColumns(RESTART_CONN, `${LARGE_DB}.${SCHEMA}.TARGET`)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ ATTNAME: 'TARGET_ID', isPk: true }),
            ]),
        );
        expect(restarted.getColumns(RESTART_CONN, `${LARGE_DB}.${SCHEMA}.T0`)).toBeUndefined();
        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(1);
        expect(isDatabaseColumnsFullyLoaded(restarted, RESTART_CONN, LARGE_DB)).toBe(false);
        expect(runQueryRawMock).not.toHaveBeenCalled();

        await restarted.ensureColumnsLoadedForTableKey(
            RESTART_CONN,
            `${LARGE_DB}.${SCHEMA}.T0`,
        );
        expect(restarted.getColumns(RESTART_CONN, `${LARGE_DB}.${SCHEMA}.T0`)).toEqual(
            expect.arrayContaining([expect.objectContaining({ ATTNAME: 'ID' })]),
        );
        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(2);
        expect(isDatabaseColumnsFullyLoaded(restarted, RESTART_CONN, LARGE_DB)).toBe(false);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('marks views catalog complete per schema after disk hydrate (tables-only database)', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateLargeCatalogColumnLayers(cache1);

        const restarted = await restartFromDisk(cache1, tempDir);

        expect(
            restarted.areViewsCatalogLoadedForDatabase(RESTART_CONN, LARGE_DB),
        ).toBe(true);
        expect(
            restarted.isViewsCatalogLoaded(RESTART_CONN, `${LARGE_DB}.${SCHEMA}`),
        ).toBe(true);
    });

    it('skips views SQL for DB.. after restart when views catalog is complete', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateLargeCatalogColumnLayers(cache1);

        const restarted = await restartFromDisk(cache1, tempDir);
        const connectionManager = createMockConnectionManager();

        const provider = new MetadataProvider(
            { globalStorageUri: vscode.Uri.file(tempDir) } as vscode.ExtensionContext,
            restarted,
            connectionManager,
        );

        jest.spyOn(
            provider as unknown as {
                mergeMirroredSystemCatalogObjects: (
                    connectionName: string,
                    dbName: string,
                    tables: unknown[],
                ) => Promise<unknown[]>;
            },
            'mergeMirroredSystemCatalogObjects',
        ).mockImplementation(async (_connectionName, _dbName, tables) => tables);

        const views = await provider.getViews(RESTART_CONN, LARGE_DB);

        expect(views).toEqual([]);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('second expand after restart reuses RAM without additional disk reads', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);

        const restarted = await restartFromDisk(cache1, tempDir);
        await restarted.whenEagerPreloadComplete();

        const diskStorage = restarted['_diskStorage'] as {
            loadColumnFileForDatabase: (
                connectionName: string,
                databaseName: string,
            ) => Promise<unknown>;
        };
        const loadSpy = jest.spyOn(diskStorage, 'loadColumnFileForDatabase');

        const columnKey = `${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`;
        const diskReadsBefore = loadSpy.mock.calls.length;

        await restarted.ensureColumnsLoadedForTableKey(RESTART_CONN, columnKey);
        const diskReadsAfterFirst = loadSpy.mock.calls.length;

        await restarted.ensureColumnsLoadedForTableKey(RESTART_CONN, columnKey);

        expect(restarted.getColumns(RESTART_CONN, columnKey)).toBeDefined();
        expect(diskReadsAfterFirst).toBe(diskReadsBefore);
        expect(loadSpy.mock.calls.length).toBe(diskReadsAfterFirst);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });
});

describe('SchemaProvider.getChildren after disk restart', () => {
    let tempDir: string;
    const runQueryRawMock = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;

    beforeEach(() => {
        tempDir = createTempStorageDir();
        runQueryRawMock.mockReset();

        const mockOutputChannel = {
            appendLine: jest.fn(),
            show: jest.fn(),
            dispose: jest.fn(),
        } as unknown as vscode.OutputChannel;
        Logger.initialize(mockOutputChannel);
        installDiskPersistenceConfigMock();
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function createSchemaProvider(cache: MetadataCache): SchemaProvider {
        return new SchemaProvider(
            createMockExtensionContext(tempDir),
            createMockConnectionManager(),
            cache,
        );
    }

    it('waits for disk initialization before expanding a type group', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        await cache1.dispose();

        const restarted = createMetadataCache(tempDir);
        const diskStorage = restarted['_diskStorage'] as {
            loadAllConnectionManifests: () => Promise<unknown>;
        };
        const loadManifests = diskStorage.loadAllConnectionManifests.bind(diskStorage);
        let releaseDiskRead!: () => void;
        const diskReadGate = new Promise<void>((resolve) => {
            releaseDiskRead = resolve;
        });
        jest.spyOn(diskStorage, 'loadAllConnectionManifests').mockImplementation(async () => {
            await diskReadGate;
            return loadManifests();
        });

        const initPromise = restarted.initialize();
        const schemaProvider = createSchemaProvider(restarted);
        let requestSettled = false;
        const childrenPromise = schemaProvider.getChildren(
            createTypeGroupSchemaItem('TABLE', SMALL_DB, RESTART_CONN),
        ).then((children) => {
            requestSettled = true;
            return children;
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(requestSettled).toBe(false);
        expect(runQueryRawMock).not.toHaveBeenCalled();

        releaseDiskRead();
        const [children] = await Promise.all([childrenPromise, initPromise]);

        expect(children.length).toBeGreaterThan(0);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('expands table columns from disk after restart without SQL', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        const restarted = await restartFromDisk(cache1, tempDir);
        const schemaProvider = createSchemaProvider(restarted);

        const children = await schemaProvider.getChildren(
            createTableSchemaItem('DIM_ACCOUNT', SMALL_DB, SCHEMA, RESTART_CONN, 101),
        );

        expect(children.map((child) => child.label)).toEqual(
            expect.arrayContaining(['ACCOUNT_ID', 'ACCOUNT_NAME']),
        );
        expect(children.find((child) => child.label === 'ACCOUNT_ID')?.isPk).toBe(true);
        expect(children.every((child) => child.contextValue === 'column')).toBe(true);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('expands one large-catalog table at a time from disk without SQL', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateLargeCatalogColumnLayers(cache1);
        const restarted = await restartFromDisk(cache1, tempDir);
        const schemaProvider = createSchemaProvider(restarted);

        const targetChildren = await schemaProvider.getChildren(
            createTableSchemaItem('TARGET', LARGE_DB, SCHEMA, RESTART_CONN, 9001),
        );

        expect(targetChildren.map((child) => child.label)).toEqual(
            expect.arrayContaining(['TARGET_ID', 'TARGET_NAME']),
        );
        expect(restarted.getColumns(RESTART_CONN, `${LARGE_DB}.${SCHEMA}.T0`)).toBeUndefined();
        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(1);
        expect(runQueryRawMock).not.toHaveBeenCalled();

        const t0Children = await schemaProvider.getChildren(
            createTableSchemaItem('T0', LARGE_DB, SCHEMA, RESTART_CONN, 1),
        );

        expect(t0Children.map((child) => child.label)).toEqual(['ID']);
        expect(countColumnLayersInRam(restarted, RESTART_CONN, LARGE_DB)).toBe(2);
        expect(isDatabaseColumnsFullyLoaded(restarted, RESTART_CONN, LARGE_DB)).toBe(false);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it.each([
        'TABLE',
        'PROCEDURE',
        'SEQUENCE',
        'SYNONYM',
        'MATERIALIZED VIEW',
        'SYSTEM VIEW',
    ])('expands typeGroup:%s from disk after restart without SQL', async (objType) => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        const restarted = await restartFromDisk(cache1, tempDir);
        const schemaProvider = createSchemaProvider(restarted);

        const children = await schemaProvider.getChildren(
            createTypeGroupSchemaItem(objType, SMALL_DB, RESTART_CONN),
        );

        expect(children.length).toBeGreaterThan(0);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('restores getSchemas from disk after restart without SQL', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        const restarted = await restartFromDisk(cache1, tempDir);
        const provider = new MetadataProvider(
            createMockExtensionContext(tempDir),
            restarted,
            createMockConnectionManager(),
        );

        const schemas = await provider.getSchemas(RESTART_CONN, SMALL_DB);

        expect(schemas.map((item) => item.label)).toEqual([SCHEMA]);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('waits for disk initialization before treating a startup cache as missing', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        await cache1.dispose();

        const restarted = createMetadataCache(tempDir);
        const diskStorage = restarted['_diskStorage'] as {
            loadAllConnectionManifests: () => Promise<unknown>;
        };
        const loadManifests = diskStorage.loadAllConnectionManifests.bind(diskStorage);
        let releaseDiskRead!: () => void;
        const diskReadGate = new Promise<void>((resolve) => {
            releaseDiskRead = resolve;
        });
        jest.spyOn(diskStorage, 'loadAllConnectionManifests').mockImplementation(async () => {
            await diskReadGate;
            return loadManifests();
        });

        const initPromise = restarted.initialize();
        const provider = new MetadataProvider(
            createMockExtensionContext(tempDir),
            restarted,
            createMockConnectionManager(),
        );
        let requestSettled = false;
        const schemasPromise = provider.getSchemas(RESTART_CONN, SMALL_DB).then((schemas) => {
            requestSettled = true;
            return schemas;
        });

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(requestSettled).toBe(false);
        expect(runQueryRawMock).not.toHaveBeenCalled();

        releaseDiskRead();
        const [schemas] = await Promise.all([schemasPromise, initPromise]);

        expect(schemas.map((item) => item.label)).toEqual([SCHEMA]);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });

    it('preserves SYNONYM REFOBJNAME through disk roundtrip', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        const restarted = await restartFromDisk(cache1, tempDir);

        const tables = restarted.getTables(RESTART_CONN, `${SMALL_DB}.${SCHEMA}`);
        const synonym = tables?.find((item) => item.OBJNAME === 'SYN_ACCOUNT');

        expect(synonym?.REFOBJNAME).toBe(`${SMALL_DB}.${SCHEMA}.DIM_ACCOUNT`);
    });

    it('reuses column RAM on second getChildren without SQL or extra disk reads', async () => {
        const cache1 = createMetadataCache(tempDir);
        populateSmallCatalog(cache1);
        const restarted = await restartFromDisk(cache1, tempDir);
        await restarted.whenEagerPreloadComplete();

        const diskStorage = restarted['_diskStorage'] as {
            loadColumnFileForDatabase: (
                connectionName: string,
                databaseName: string,
            ) => Promise<unknown>;
        };
        const loadSpy = jest.spyOn(diskStorage, 'loadColumnFileForDatabase');
        const schemaProvider = createSchemaProvider(restarted);
        const tableItem = createTableSchemaItem('DIM_ACCOUNT', SMALL_DB, SCHEMA, RESTART_CONN, 101);

        const diskReadsBefore = loadSpy.mock.calls.length;
        await schemaProvider.getChildren(tableItem);
        const diskReadsAfterFirst = loadSpy.mock.calls.length;
        await schemaProvider.getChildren(tableItem);

        expect(diskReadsAfterFirst).toBe(diskReadsBefore);
        expect(loadSpy.mock.calls.length).toBe(diskReadsAfterFirst);
        expect(runQueryRawMock).not.toHaveBeenCalled();
    });
});

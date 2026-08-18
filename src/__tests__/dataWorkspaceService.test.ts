import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    DATA_WORKSPACE_OPTION,
    DATA_WORKSPACE_VERSION,
    type DataWorkspaceConfig,
    DataWorkspaceService,
    applyDataWorkspaceParameters,
    defaultDataWorkspaceTableName,
    extractDataWorkspaceParameters,
    parseDataWorkspace,
    parseDataWorkspaceProfileExport,
    serializeDataWorkspace,
    serializeDataWorkspaceProfileExport,
    validateReadOnlyQuery,
} from '../services/dataWorkspaceService';
import { streamingManager } from '../core/queryCancellation';
import { readParquetFile } from '../export/parquetHyparquet';

async function immediateProgress<T>(
    _options: vscode.ProgressOptions,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Thenable<T> | PromiseLike<T> | T,
): Promise<T> {
    return task(
        { report: () => undefined },
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
    );
}

describe('Data Workspace v2 profile', () => {
    const sourceConfig: DataWorkspaceConfig = {
        version: DATA_WORKSPACE_VERSION,
        workspaceId: 'workspace-source-1234',
        sources: [{
            id: 'source-1234',
            kind: 'external' as const,
            connectionName: 'Netezza production',
            sourceKind: 'query' as const,
            queryTemplate: "SELECT * FROM sales WHERE created_at >= '$from' AND owner = '${owner}'",
            tableName: 'sales',
            lastRefresh: { status: 'success' as const, completedAt: '2026-08-14T10:00:00.000Z', rowCount: 12 },
        }],
    };

    it('serializes only portable source definitions', () => {
        const json = serializeDataWorkspaceProfileExport([{ name: 'Reporting', workspace: sourceConfig }]);
        expect(json).toContain('workspace-source-1234');
        expect(json).toContain('Netezza production');
        expect(json).not.toContain('/globalStorage');
        expect(json).not.toContain('password');

        expect(parseDataWorkspaceProfileExport(json)).toEqual([{ name: 'Reporting', workspace: sourceConfig }]);
    });

    it('redacts refresh messages because database errors can echo parameter values', () => {
        const json = serializeDataWorkspaceProfileExport([{
            name: 'Reporting',
            workspace: {
                ...sourceConfig,
                sources: [{
                    ...sourceConfig.sources[0],
                    lastRefresh: { status: 'error', message: "SELECT * FROM t WHERE token = 'not-exported'" },
                }],
            },
        }]);
        expect(json).not.toContain('not-exported');
    });

    it('rejects duplicate local source names during profile serialization', () => {
        expect(() => serializeDataWorkspace({
            ...sourceConfig,
            sources: [sourceConfig.sources[0], { ...sourceConfig.sources[0], id: 'source-5678' }],
        })).toThrow('already used');
    });

    it('uses unique, valid local DuckDB table names', () => {
        expect(defaultDataWorkspaceTableName('Netezza Production / SALES.ORDERS')).toBe('Netezza_Production_SALES_ORDERS');
        expect(defaultDataWorkspaceTableName('2026-orders.csv')).toBe('orders');
    });
});

describe('Data Workspace source SQL safety and parameters', () => {
    it('allows one SELECT/WITH statement and rejects writing or multiple statements', () => {
        expect(validateReadOnlyQuery('WITH x AS (SELECT 1) SELECT * FROM x;')).toBe('WITH x AS (SELECT 1) SELECT * FROM x');
        expect(() => validateReadOnlyQuery('DELETE FROM x')).toThrow('read-only');
        expect(() => validateReadOnlyQuery('SELECT 1; SELECT 2')).toThrow('exactly one');
        expect(() => validateReadOnlyQuery('SELECT * INTO target FROM x')).toThrow('read-only');
        expect(() => validateReadOnlyQuery("SELECT 'DELETE FROM x' AS note")).not.toThrow();
    });

    it('finds and replaces both macro spellings without persisting their values', () => {
        const template = "SELECT * FROM t WHERE d >= '$from' AND owner = '${owner}'";
        expect(extractDataWorkspaceParameters(template)).toEqual(['from', 'owner']);
        expect(applyDataWorkspaceParameters(template, { from: '2026-01-01', owner: 'ana' }))
            .toBe("SELECT * FROM t WHERE d >= '2026-01-01' AND owner = 'ana'");
    });
});

describe('DataWorkspaceService creation and import', () => {
    function createService() {
        const saved: Array<Record<string, unknown>> = [];
        const manager = {
            getConnections: jest.fn().mockResolvedValue([]),
            getConnection: jest.fn(),
            saveConnection: jest.fn(async (details: Record<string, unknown>) => saved.push(details)),
        };
        const createConnection = jest.fn().mockResolvedValue({ close: jest.fn().mockResolvedValue(undefined) });
        const ids = ['workspace-imported-1', 'workspace-imported-2'];
        const service = new DataWorkspaceService(
            { globalStorageUri: vscode.Uri.file('/tmp/data-workspace-service-test') },
            manager as never,
            { createConnection, createId: () => ids.shift() ?? 'workspace-overflow-3' },
        );
        return { service, manager, saved, createConnection };
    }

    it('creates a real DuckDB profile below private globalStorage', async () => {
        const { service, saved, createConnection } = createService();
        const details = await service.createWorkspace('Reporting');

        expect(details.database).toBe('/tmp/data-workspace-service-test/data-workspaces/workspace-imported-1.duckdb');
        expect(details.dbType).toBe('duckdb');
        expect(parseDataWorkspace(details.options?.[DATA_WORKSPACE_OPTION])).toEqual({
            version: DATA_WORKSPACE_VERSION,
            workspaceId: 'workspace-imported-1',
            sources: [],
        });
        expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ database: details.database, dbType: 'duckdb' }));
        expect(saved).toHaveLength(1);
    });

    it('imports a portable definition with a new workspace id and no local data path', async () => {
        const { service, saved } = createService();
        const sourceConfig: DataWorkspaceConfig = {
            version: DATA_WORKSPACE_VERSION,
            workspaceId: 'workspace-source-1234',
            sources: [{
                id: 'source-1234', kind: 'external' as const, connectionName: 'Netezza production',
                sourceKind: 'table' as const, objectName: 'ADMIN.SALES', tableName: 'sales',
            }],
        };
        const imported = await service.importProfile({ name: 'Imported', workspace: sourceConfig });
        const config = parseDataWorkspace(imported.options?.[DATA_WORKSPACE_OPTION]);

        expect(config?.workspaceId).toBe('workspace-imported-1');
        expect(config?.workspaceId).not.toBe(sourceConfig.workspaceId);
        expect(config?.sources[0]).toMatchObject({ connectionName: 'Netezza production' });
        expect(saved).toHaveLength(2);
    });
});

describe('Data Workspace materialization', () => {
    const storagePath = '/tmp/data-workspace-materializer-test';
    const sourceId = 'source-materializer-1234';
    const workspaceId = 'workspace-materializer-1234';

    function createWorkspaceDetails() {
        return {
            name: 'Workspace', host: 'local', database: path.join(storagePath, 'data-workspaces', `${workspaceId}.duckdb`),
            user: 'duckdb', dbType: 'duckdb' as const,
            options: {
                mode: 'file',
                [DATA_WORKSPACE_OPTION]: JSON.stringify({
                    version: DATA_WORKSPACE_VERSION,
                    workspaceId,
                    sources: [{
                        id: sourceId, kind: 'external', connectionName: 'Netezza', sourceKind: 'query',
                        queryTemplate: 'SELECT id, name FROM ADMIN.SALES', tableName: 'sales',
                    }],
                }),
            },
        };
    }

    beforeEach(async () => {
        await fs.promises.mkdir(path.join(storagePath, 'data-workspaces'), { recursive: true });
    });

    afterEach(async () => {
        await fs.promises.rm(storagePath, { recursive: true, force: true });
        jest.restoreAllMocks();
    });

    it('uses Parquet staging and replaces only the source table after a bounded stream', async () => {
        const workspace = createWorkspaceDetails();
        const sourceConnection = { close: jest.fn().mockResolvedValue(undefined) };
        const localSql: string[] = [];
        const localConnection = {
            close: jest.fn().mockResolvedValue(undefined),
            createCommand: jest.fn((sql: string) => ({ execute: jest.fn(async () => { localSql.push(sql); }) })),
        };
        const connections: Record<string, typeof workspace | { name: string; host: string; database: string; user: string; dbType: 'netezza' }> = {
            Workspace: workspace,
            Netezza: { name: 'Netezza', host: 'nps', database: 'NZ', user: 'admin', dbType: 'netezza' },
        };
        const manager = {
            getConnection: jest.fn(async (name: string) => connections[name]),
            getConnections: jest.fn(async () => Object.values(connections)),
            saveConnection: jest.fn(async (details: typeof workspace) => { connections.Workspace = details; }),
            refreshDataWorkspaceConnection: jest.fn(),
        };
        const stream = jest.spyOn(streamingManager, 'executeWithStreaming')
            .mockResolvedValueOnce({ totalRows: 2, limitReached: false, status: 'success' })
            .mockImplementationOnce(async (_connection, _sql, _limit, _chunkSize, _timeout, _uri, onChunk) => {
                await onChunk({
                    columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'VARCHAR' }],
                    rows: [[1, 'Ada'], [2, 'Lin']], isFirstChunk: true, isLastChunk: true,
                    totalRowsSoFar: 2, limitReached: false,
                });
                return { totalRows: 2, limitReached: false, status: 'success' };
            });
        const service = new DataWorkspaceService(
            { globalStorageUri: vscode.Uri.file(storagePath) },
            manager as never,
            {
                createConnection: jest.fn(async (details: { dbType?: string }) => details.dbType === 'netezza' ? sourceConnection : localConnection) as never,
                createId: () => 'staging-1234',
                now: () => new Date('2026-08-14T12:00:00.000Z'),
                withProgress: immediateProgress as never,
            },
        );

        await expect(service.refreshSource('Workspace', sourceId)).resolves.toMatchObject({ status: 'success', rowCount: 2 });

        expect(stream.mock.calls[0]?.[1]).toContain('LIMIT 2000001');
        expect(localSql).toEqual(expect.arrayContaining([
            expect.stringContaining('read_parquet'),
            'BEGIN TRANSACTION',
            expect.stringContaining('CREATE OR REPLACE TABLE "sales"'),
            'COMMIT',
        ]));
        expect(manager.refreshDataWorkspaceConnection).toHaveBeenCalledWith('Workspace');
    });

    it('materializes an Access file source as the selected local table and refreshes Schema', async () => {
        const accessSourceId = 'access-source-1234';
        const workspace = {
            ...createWorkspaceDetails(),
            options: {
                mode: 'file',
                [DATA_WORKSPACE_OPTION]: JSON.stringify({
                    version: DATA_WORKSPACE_VERSION,
                    workspaceId,
                    sources: [{
                        id: accessSourceId,
                        kind: 'file' as const,
                        path: '/data/sample_database.accdb',
                        tableName: 'sample_database',
                    }],
                }),
            },
        };
        const sourceConnection = { close: jest.fn().mockResolvedValue(undefined) };
        const localSql: string[] = [];
        const localConnection = {
            close: jest.fn().mockResolvedValue(undefined),
            createCommand: jest.fn((sql: string) => ({ execute: jest.fn(async () => { localSql.push(sql); }) })),
        };
        const manager = {
            getConnection: jest.fn().mockResolvedValue(workspace),
            getConnections: jest.fn().mockResolvedValue([workspace]),
            saveConnection: jest.fn().mockResolvedValue(undefined),
            refreshDataWorkspaceConnection: jest.fn().mockResolvedValue(undefined),
        };
        const stream = jest.spyOn(streamingManager, 'executeWithStreaming')
            .mockResolvedValueOnce({ totalRows: 3, limitReached: false, status: 'success' })
            .mockImplementationOnce(async (_connection, _sql, _limit, _chunkSize, _timeout, _uri, onChunk) => {
                await onChunk({
                    columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'VARCHAR' }],
                    rows: [[1, 'Anna'], [2, 'Jan'], [3, 'Ewa']],
                    isFirstChunk: true,
                    isLastChunk: true,
                    totalRowsSoFar: 3,
                    limitReached: false,
                });
                return { totalRows: 3, limitReached: false, status: 'success' };
            });
        const service = new DataWorkspaceService(
            { globalStorageUri: vscode.Uri.file(storagePath) },
            manager as never,
            {
                createConnection: jest.fn(async (details: { dbType?: string }) =>
                    details.dbType === 'file' ? sourceConnection : localConnection) as never,
                createId: () => 'access-stage-1234',
                now: () => new Date('2026-08-14T12:00:00.000Z'),
                withProgress: immediateProgress as never,
            },
        );

        await expect(service.refreshSource('Workspace', accessSourceId)).resolves.toMatchObject({
            status: 'success',
            rowCount: 3,
        });

        expect(stream.mock.calls[0]?.[1]).toContain('SELECT * FROM "sample_database"');
        expect(stream.mock.calls[1]?.[1]).toBe('SELECT * FROM "sample_database"');
        expect(localSql).toEqual(expect.arrayContaining([
            expect.stringContaining('CREATE OR REPLACE TABLE "sample_database"'),
        ]));
        expect(manager.refreshDataWorkspaceConnection).toHaveBeenCalledWith('Workspace');
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
            'netezza.refreshSchema',
            'Workspace',
        );
    });

    it('coalesces simultaneous refreshes of the same source', async () => {
        const workspace = createWorkspaceDetails();
        const sourceConnection = { close: jest.fn().mockResolvedValue(undefined) };
        const localConnection = {
            close: jest.fn().mockResolvedValue(undefined),
            createCommand: jest.fn(() => ({ execute: jest.fn().mockResolvedValue(undefined) })),
        };
        const connections: Record<string, typeof workspace | { name: string; host: string; database: string; user: string; dbType: 'netezza' }> = {
            Workspace: workspace,
            Netezza: { name: 'Netezza', host: 'nps', database: 'NZ', user: 'admin', dbType: 'netezza' },
        };
        const manager = {
            getConnection: jest.fn(async (name: string) => connections[name]),
            getConnections: jest.fn(async () => Object.values(connections)),
            saveConnection: jest.fn(async (details: typeof workspace) => { connections.Workspace = details; }),
            refreshDataWorkspaceConnection: jest.fn(),
        };
        let releaseStream: (() => void) | undefined;
        const stream = jest.spyOn(streamingManager, 'executeWithStreaming')
            .mockResolvedValueOnce({ totalRows: 1, limitReached: false, status: 'success' })
            .mockImplementationOnce(async (_connection, _sql, _limit, _chunkSize, _timeout, _uri, onChunk) => {
                await new Promise<void>(resolve => { releaseStream = resolve; });
                await onChunk({
                    columns: [{ name: 'amount', type: 'DECIMAL(38, 0)' }],
                    rows: [['12345678901234567890123456789012345678']],
                    isFirstChunk: true,
                    isLastChunk: true,
                    totalRowsSoFar: 1,
                    limitReached: false,
                });
                return { totalRows: 1, limitReached: false, status: 'success' };
            });
        const dependencies = {
            createConnection: jest.fn(async (details: { dbType?: string }) => details.dbType === 'netezza' ? sourceConnection : localConnection) as never,
            createId: () => 'refresh-1234',
            withProgress: immediateProgress as never,
        };
        const firstService = new DataWorkspaceService({ globalStorageUri: vscode.Uri.file(storagePath) }, manager as never, dependencies);
        const secondService = new DataWorkspaceService({ globalStorageUri: vscode.Uri.file(storagePath) }, manager as never, dependencies);
        const stagedParquetPath = path.join(storagePath, 'data-workspaces', `.staging-${sourceId}-refresh_1234.parquet`);
        jest.spyOn(fs.promises, 'unlink').mockResolvedValue(undefined);

        const first = firstService.refreshSource('Workspace', sourceId);
        await new Promise(resolve => setImmediate(resolve));
        const second = secondService.refreshSource('Workspace', sourceId);

        expect(second).toBe(first);
        expect(stream).toHaveBeenCalledTimes(2);
        releaseStream?.();
        await expect(first).resolves.toMatchObject({ status: 'success', rowCount: 1 });
        await expect(readParquetFile(stagedParquetPath)).resolves.toMatchObject({
            rows: [['12345678901234567890123456789012345678']],
        });
    });

    it('blocks a source at 2,000,001 rows before the local table is touched', async () => {
        const workspace = createWorkspaceDetails();
        const sourceConnection = { close: jest.fn().mockResolvedValue(undefined) };
        const localConnection = { close: jest.fn(), createCommand: jest.fn() };
        const manager = {
            getConnection: jest.fn(async (name: string) => name === 'Workspace'
                ? workspace
                : { name: 'Netezza', host: 'nps', database: 'NZ', user: 'admin', dbType: 'netezza' as const }),
            getConnections: jest.fn().mockResolvedValue([]),
            saveConnection: jest.fn(),
        };
        jest.spyOn(streamingManager, 'executeWithStreaming')
            .mockResolvedValue({ totalRows: 2_000_001, limitReached: true, status: 'success' });
        const service = new DataWorkspaceService(
            { globalStorageUri: vscode.Uri.file(storagePath) }, manager as never,
            {
                createConnection: jest.fn(async (details: { dbType?: string }) => details.dbType === 'netezza' ? sourceConnection : localConnection) as never,
                withProgress: immediateProgress as never,
            },
        );

        await expect(service.refreshSource('Workspace', sourceId)).rejects.toThrow('2,000,000 row limit');
        expect(localConnection.createCommand).not.toHaveBeenCalled();
        expect(manager.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ options: expect.any(Object) }));
    });
});

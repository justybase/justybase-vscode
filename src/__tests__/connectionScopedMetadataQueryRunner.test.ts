import { describe, expect, it, jest } from '@jest/globals';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { RunQueryRawOptions } from '../core/queryRunner';
import type { ConnectionDetails, NzConnection, QueryResult } from '../types';

const mockCreateConnectedDatabaseConnectionFromDetails = jest.fn<
    (details: ConnectionDetails) => Promise<NzConnection>
>();

jest.mock('../core/connectionFactory', () => ({
    createConnectedDatabaseConnectionFromDetails: mockCreateConnectedDatabaseConnectionFromDetails,
}));

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
}));

jest.mock('../utils/logger', () => ({
    logWithFallback: jest.fn(),
}));

import {
    createConnectionScopedMetadataQueryRunner,
} from '../metadata/connectionScopedMetadataQueryRunner';

describe('connection-scoped metadata query runner', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses one serial physical session and closes it after the refresh', async () => {
        const connection = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as NzConnection;
        const connectionManager = {
            getConnection: jest.fn<(name: string) => Promise<ConnectionDetails | undefined>>().mockResolvedValue({
                host: 'nz.example',
                port: 5480,
                database: 'SYSTEM',
                user: 'admin',
                dbType: 'netezza',
            }),
        } as unknown as ConnectionManager;
        mockCreateConnectedDatabaseConnectionFromDetails.mockResolvedValue(connection);

        let releaseFirst!: () => void;
        const firstQueryStarted = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        let allowFirstQueryToFinish!: () => void;
        const firstQueryGate = new Promise<void>((resolve) => {
            allowFirstQueryToFinish = resolve;
        });
        const queryExecutor = jest.fn(async (options: RunQueryRawOptions): Promise<QueryResult> => {
            if (options.query === 'SELECT one') {
                options.metadataSession!.sessionId = '12345';
                releaseFirst();
                await firstQueryGate;
            }
            options.onMetadataExecutionComplete?.({
                totalMs: options.query === 'SELECT one' ? 10 : 20,
            });
            return { columns: [], data: [] };
        });

        const runner = createConnectionScopedMetadataQueryRunner({
            context: {} as never,
            connectionManager,
            connectionName: 'NZ',
            queryExecutor,
        });

        const firstObserver = {
            onExecutionStarted: jest.fn(),
            onExecutionCompleted: jest.fn(),
        };
        const secondObserver = {
            onExecutionStarted: jest.fn(),
            onExecutionCompleted: jest.fn(),
        };
        const first = runner('SELECT one', {
            source: 'connection-prefetch',
            kind: 'databases',
            connectionName: 'NZ',
        }, firstObserver);
        await firstQueryStarted;
        const second = runner('SELECT two', {
            source: 'connection-prefetch',
            kind: 'schemas',
            connectionName: 'NZ',
        }, secondObserver);

        expect(queryExecutor).toHaveBeenCalledTimes(1);
        expect(secondObserver.onExecutionStarted).not.toHaveBeenCalled();
        allowFirstQueryToFinish();
        await Promise.all([first, second]);

        expect(connectionManager.getConnection).toHaveBeenCalledTimes(1);
        expect(mockCreateConnectedDatabaseConnectionFromDetails).toHaveBeenCalledTimes(1);
        expect(queryExecutor).toHaveBeenCalledTimes(2);
        const [firstOptions, secondOptions] = queryExecutor.mock.calls.map(([options]) => options);
        expect(firstOptions.connectionOverride).toBe(connection);
        expect(secondOptions.connectionOverride).toBe(connection);
        expect(firstOptions.metadataSession).toBe(secondOptions.metadataSession);
        expect(secondOptions.metadataSession?.sessionId).toBe('12345');
        expect(firstObserver.onExecutionStarted).toHaveBeenCalledTimes(1);
        expect(secondObserver.onExecutionStarted).toHaveBeenCalledTimes(1);
        expect(firstObserver.onExecutionCompleted).toHaveBeenCalledWith({ totalMs: 10 });
        expect(secondObserver.onExecutionCompleted).toHaveBeenCalledWith({ totalMs: 20 });

        await runner.dispose?.();
        expect(connection.close).toHaveBeenCalledTimes(1);
    });

    it('exposes two independent lazy column sessions and closes both', async () => {
        const firstConnection = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as NzConnection;
        const secondConnection = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as NzConnection;
        const connectionManager = {
            getConnection: jest.fn<(name: string) => Promise<ConnectionDetails | undefined>>().mockResolvedValue({
                host: 'nz.example',
                port: 5480,
                database: 'SYSTEM',
                user: 'admin',
                dbType: 'netezza',
            }),
        } as unknown as ConnectionManager;
        mockCreateConnectedDatabaseConnectionFromDetails
            .mockResolvedValueOnce(firstConnection)
            .mockResolvedValueOnce(secondConnection);
        const queryExecutor = jest.fn(async (options: RunQueryRawOptions): Promise<QueryResult> => {
            options.onMetadataExecutionComplete?.({ totalMs: 1 });
            return { columns: [], data: [] };
        });

        const runner = createConnectionScopedMetadataQueryRunner({
            context: {} as never,
            connectionManager,
            connectionName: 'NZ',
            columnConnectionCount: 2,
            queryExecutor,
        });
        const slots = runner.getColumnQueryRunners?.() ?? [];

        expect(slots).toHaveLength(2);
        expect(mockCreateConnectedDatabaseConnectionFromDetails).not.toHaveBeenCalled();

        await slots[0]!.ensureConnected?.();
        expect(mockCreateConnectedDatabaseConnectionFromDetails).toHaveBeenCalledTimes(1);
        await Promise.all([
            slots[0]!('SELECT primary'),
            slots[1]!('SELECT secondary'),
        ]);

        expect(mockCreateConnectedDatabaseConnectionFromDetails).toHaveBeenCalledTimes(2);
        expect(queryExecutor).toHaveBeenCalledTimes(2);
        expect(queryExecutor.mock.calls[0]![0].connectionOverride).toBe(firstConnection);
        expect(queryExecutor.mock.calls[1]![0].connectionOverride).toBe(secondConnection);

        await runner.dispose?.();
        expect(firstConnection.close).toHaveBeenCalledTimes(1);
        expect(secondConnection.close).toHaveBeenCalledTimes(1);
    });

    it('clamps the configured column session count to eight', async () => {
        const connection = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as NzConnection;
        const connectionManager = {
            getConnection: jest.fn<(name: string) => Promise<ConnectionDetails | undefined>>().mockResolvedValue({
                host: 'nz.example', database: 'SYSTEM', user: 'admin', dbType: 'netezza',
            }),
        } as unknown as ConnectionManager;
        mockCreateConnectedDatabaseConnectionFromDetails.mockResolvedValue(connection);

        const runner = createConnectionScopedMetadataQueryRunner({
            context: {} as never,
            connectionManager,
            connectionName: 'NZ',
            columnConnectionCount: 99,
        });

        expect(runner.getColumnQueryRunners?.()).toHaveLength(8);
        await runner.dispose?.();
    });

    it('reads the full-refresh column session count from VS Code configuration', async () => {
        const connection = {
            close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
        } as unknown as NzConnection;
        const connectionManager = {
            getConnection: jest.fn<(name: string) => Promise<ConnectionDetails | undefined>>().mockResolvedValue({
                host: 'nz.example', database: 'SYSTEM', user: 'admin', dbType: 'netezza',
            }),
        } as unknown as ConnectionManager;
        mockCreateConnectedDatabaseConnectionFromDetails.mockResolvedValue(connection);
        const get = jest.fn((_key: string, defaultValue?: unknown) =>
            _key === 'fullRefreshColumnConnections' ? 4 : defaultValue);
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({ get });

        const runner = createConnectionScopedMetadataQueryRunner({
            context: {} as never,
            connectionManager,
            connectionName: 'NZ',
        });

        expect(runner.getColumnQueryRunners?.()).toHaveLength(4);
        await runner.dispose?.();
    });
});

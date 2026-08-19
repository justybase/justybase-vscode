import { describe, expect, it, jest } from '@jest/globals';
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
            return { columns: [], data: [] };
        });

        const runner = createConnectionScopedMetadataQueryRunner({
            context: {} as never,
            connectionManager,
            connectionName: 'NZ',
            queryExecutor,
        });

        const first = runner('SELECT one', {
            source: 'connection-prefetch',
            kind: 'databases',
            connectionName: 'NZ',
        });
        await firstQueryStarted;
        const second = runner('SELECT two', {
            source: 'connection-prefetch',
            kind: 'schemas',
            connectionName: 'NZ',
        });

        expect(queryExecutor).toHaveBeenCalledTimes(1);
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

        await runner.dispose?.();
        expect(connection.close).toHaveBeenCalledTimes(1);
    });
});

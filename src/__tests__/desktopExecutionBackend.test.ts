import { ExecutionBackendError } from '@justybase/database-runtime/execution';
import type { DatabaseQueryCallbacks } from '@justybase/contracts';

import {
    DesktopExecutionBackend,
    type DesktopExecutionTarget,
    type DesktopStreamingExecutionPort,
} from '../core/execution/desktopExecutionBackend';
import type { NzConnection } from '../types';

function connection(): NzConnection {
    return {
        on: jest.fn(),
        removeListener: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
    } as unknown as NzConnection;
}

function callbacks(): jest.Mocked<DatabaseQueryCallbacks> {
    return {
        onColumns: jest.fn(),
        onRows: jest.fn(),
        onCommand: jest.fn(),
    };
}

function port(overrides: Partial<DesktopStreamingExecutionPort> = {}): DesktopStreamingExecutionPort {
    return {
        executeAndFetch: jest.fn().mockResolvedValue({
            results: [],
            status: 'success',
        }),
        executeWithStreaming: jest.fn().mockResolvedValue({
            totalRows: 0,
            limitReached: false,
            status: 'success',
        }),
        abortQuery: jest.fn().mockReturnValue(true),
        ...overrides,
    };
}

function target(activeConnection: NzConnection): DesktopExecutionTarget {
    return {
        connection: activeConnection,
        shouldCloseConnection: false,
        keepConnectionOpen: true,
        documentUri: 'file:///query.sql',
        chunkSize: 100,
    };
}

describe('DesktopExecutionBackend', () => {
    it('forwards every buffered result set and removes its notice listener', async () => {
        const activeConnection = connection();
        const notice = jest.fn();
        const executionPort = port({
            executeAndFetch: jest.fn().mockResolvedValue({
                results: [
                    { columns: [{ name: 'A' }], rows: [[1]], limitReached: false },
                    { columns: [{ name: 'B' }], rows: [[2], [3]], limitReached: true },
                ],
                recordsAffected: 4,
                status: 'success',
            }),
        });
        const sink = callbacks();
        const executionTarget = { ...target(activeConnection), onNotice: notice };

        const result = await new DesktopExecutionBackend({ streamingManager: executionPort }).execute(
            executionTarget,
            'SELECT 1',
            { maxRows: 10, timeoutSeconds: 5 },
            sink,
        );

        expect(sink.onColumns.mock.calls).toEqual([[[{ name: 'A' }]], [[{ name: 'B' }]]]);
        expect(sink.onRows.mock.calls).toEqual([[[[1]], 1], [[[2], [3]], 3]]);
        expect(result).toEqual({ totalRows: 3, limitReached: true, rowsAffected: 4 });
        expect(activeConnection.on).toHaveBeenCalledWith('notice', notice);
        expect(activeConnection.removeListener).toHaveBeenCalledWith('notice', notice);
    });

    it('retains streamed partial progress when the runtime returns an error', async () => {
        const activeConnection = connection();
        const deliveredChunk = {
            columns: [{ name: 'A' }],
            rows: [[1], [2]],
            isFirstChunk: true,
            isLastChunk: false,
            totalRowsSoFar: 2,
            limitReached: false,
        };
        const executionPort = port({
            executeWithStreaming: jest.fn().mockImplementation(async (...args: unknown[]) => {
                const deliver = args[6] as (chunk: typeof deliveredChunk) => Promise<void>;
                await deliver(deliveredChunk);
                return {
                    totalRows: 2,
                    limitReached: false,
                    error: new Error('socket closed'),
                    status: 'error' as const,
                };
            }),
        });
        const sink = callbacks();
        const onChunk = jest.fn().mockResolvedValue(undefined);

        await expect(new DesktopExecutionBackend({ streamingManager: executionPort }).execute(
            { ...target(activeConnection), onChunk },
            'SELECT 1',
            { maxRows: 10, timeoutSeconds: 5 },
            sink,
            undefined,
            { delivery: 'streaming' } as never,
        )).rejects.toEqual(expect.objectContaining<Partial<ExecutionBackendError>>({
            message: 'socket closed',
            metadata: { totalRows: 2, limitReached: false, rowsAffected: undefined },
        }));
        expect(sink.onColumns).toHaveBeenCalledWith([{ name: 'A' }]);
        expect(sink.onRows).toHaveBeenCalledWith([[1], [2]], 2);
        expect(onChunk).toHaveBeenCalledWith(deliveredChunk);
    });

    it('reconnects a persistent document through its connection manager and reacquires lazily', async () => {
        const firstConnection = connection();
        const secondConnection = connection();
        const closePersistent = jest.fn().mockResolvedValue(undefined);
        const openConnection = jest.fn().mockResolvedValue({
            connection: secondConnection,
            shouldCloseConnection: false,
        });
        const onConnectionAcquired = jest.fn().mockResolvedValue('42');
        const executionPort = port();
        const backend = new DesktopExecutionBackend({ streamingManager: executionPort });
        const executionTarget: DesktopExecutionTarget = {
            ...target(firstConnection),
            connectionManager: { closeDocumentPersistentConnection: closePersistent },
            openConnection,
            onConnectionAcquired,
        };

        await backend.reconnect(executionTarget);
        await backend.execute(
            executionTarget,
            'SELECT 1',
            { maxRows: 10, timeoutSeconds: 5 },
            callbacks(),
        );

        expect(closePersistent).toHaveBeenCalledWith('file:///query.sql');
        expect(firstConnection.close).not.toHaveBeenCalled();
        expect(openConnection).toHaveBeenCalledTimes(1);
        expect(onConnectionAcquired).toHaveBeenCalledWith(secondConnection);
        expect(executionTarget.sessionId).toBe('42');
    });

    it('closes a transient connection once and routes cancellation by document identity', async () => {
        const activeConnection = connection();
        const executionPort = port();
        const backend = new DesktopExecutionBackend({ streamingManager: executionPort });
        const executionTarget: DesktopExecutionTarget = {
            ...target(activeConnection),
            shouldCloseConnection: true,
        };

        await backend.cancel(executionTarget, {} as never, 'user request');
        await backend.cleanup(executionTarget);
        await backend.cleanup(executionTarget);

        expect(executionPort.abortQuery).toHaveBeenCalledWith('file:///query.sql', 'user request');
        expect(activeConnection.close).toHaveBeenCalledTimes(1);
    });
});

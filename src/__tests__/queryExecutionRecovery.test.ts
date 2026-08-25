import type { ConnectionManager } from '../core/connectionManager';

jest.mock('../core/queryRunner', () => ({
    cancelQueryByUri: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../core/queryRunnerHelpers', () => ({
    executeDropSession: jest.fn().mockResolvedValue(true),
}));

const clearAborted = jest.fn();
jest.mock('../core/queryCancellation', () => ({
    streamingManager: { clearAborted },
}));

import { createQueryExecutionRecovery } from '../commands/query/queryExecutionRecovery';
import { executeDropSession } from '../core/queryRunnerHelpers';

describe('queryExecutionRecovery', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('bounds a persistent connection reset that never settles', async () => {
        jest.useFakeTimers();
        try {
            const connectionManager = {
                closeDocumentPersistentConnection: jest.fn(() => new Promise<void>(() => undefined)),
            } as unknown as ConnectionManager;
            const recovery = createQueryExecutionRecovery(
                connectionManager,
                'file:///query.sql',
                'warehouse',
            );

            const resetResult = recovery.resetConnection!();
            await jest.advanceTimersByTimeAsync(5_000);

            await expect(resetResult).resolves.toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    it('drops through a separate control connection without reconnecting the stuck tab', async () => {
        const connectionManager = {} as ConnectionManager;
        const recovery = createQueryExecutionRecovery(
            connectionManager,
            'file:///query.sql',
            'warehouse',
        );

        await expect(recovery.dropSession!('16454')).resolves.toBe(true);
        expect(executeDropSession).toHaveBeenCalledWith(
            '16454',
            connectionManager,
            'file:///query.sql',
            'warehouse',
            { reconnectDocument: false },
        );
    });

    it('refuses forced recovery while a caller-owned transient connection may still be live', async () => {
        const abandonAndRecreateDocumentPersistentConnection = jest.fn().mockResolvedValue(undefined);
        const closeDocumentPersistentConnection = jest.fn().mockResolvedValue(undefined);
        const connectionManager = {
            getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(false),
            abandonAndRecreateDocumentPersistentConnection,
            closeDocumentPersistentConnection,
        } as unknown as ConnectionManager;
        const recovery = createQueryExecutionRecovery(
            connectionManager,
            'file:///query.sql',
            'warehouse',
        );

        expect(recovery.allowForcedRecovery).toBe(false);
        expect(recovery.forcedRecoveryUnavailableMessage).toContain('transient connections');
        await expect(recovery.resetConnection!()).resolves.toBe(false);
        await expect(recovery.openFreshConnection!()).resolves.toBe(false);
        expect(closeDocumentPersistentConnection).not.toHaveBeenCalled();
        expect(abandonAndRecreateDocumentPersistentConnection).not.toHaveBeenCalled();
    });
});

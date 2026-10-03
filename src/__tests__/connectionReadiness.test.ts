import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
    isConnectionRecoveryError,
    isTimeoutLikeError,
    reestablishPersistentConnectionAfterBrokenError,
    waitForPersistentConnectionReady,
} from '../core/connectionReadiness';
import type { ConnectionManager } from '../core/connectionManager';

describe('connectionReadiness', () => {
    describe('isTimeoutLikeError', () => {
        it('detects timeout messages', () => {
            expect(isTimeoutLikeError(new Error('Command execution timeout'))).toBe(true);
            expect(isTimeoutLikeError(new Error('Timed out waiting'))).toBe(true);
            expect(isTimeoutLikeError(new Error('Socket closed'))).toBe(false);
        });
    });

    describe('isConnectionRecoveryError', () => {
        it('includes busy and timeout errors', () => {
            expect(isConnectionRecoveryError(new Error('Connection is already executing a command'))).toBe(true);
            expect(isConnectionRecoveryError(new Error('Query timeout expired'))).toBe(true);
            expect(isConnectionRecoveryError(new Error('Syntax error'))).toBe(false);
        });
    });

    describe('waitForPersistentConnectionReady', () => {
        let connManager: ConnectionManager;
        let attempt = 0;

        beforeEach(() => {
            attempt = 0;
            connManager = {
                getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
                getDocumentPersistentConnection: jest.fn().mockImplementation(async () => ({
                    createCommand: () => ({
                        executeReader: async () => {
                            attempt += 1;
                            if (attempt < 3) {
                                throw new Error('Connection is already executing a command');
                            }
                            return {
                                read: async () => true,
                                close: async () => undefined,
                            };
                        },
                    }),
                })),
            } as unknown as ConnectionManager;
        });

        it('polls until the connection accepts a probe query', async () => {
            await waitForPersistentConnectionReady(
                connManager,
                'file:///test.sql',
                'conn',
                { maxWaitMs: 5_000, pollIntervalMs: 1 },
            );
            expect(attempt).toBe(3);
        });

        it('skips waiting when keep-connection-open is disabled', async () => {
            (connManager.getDocumentKeepConnectionOpen as jest.Mock).mockReturnValue(false);
            await waitForPersistentConnectionReady(connManager, 'file:///test.sql');
            expect(connManager.getDocumentPersistentConnection).not.toHaveBeenCalled();
        });
    });

    describe('reestablishPersistentConnectionAfterBrokenError', () => {
        function createManager(): ConnectionManager {
            return {
                getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
                closeDocumentPersistentConnection: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
                getDocumentPersistentConnection: jest.fn().mockResolvedValue({} as never),
            } as unknown as ConnectionManager;
        }

        it('closes and reopens the persistent connection', async () => {
            const manager = createManager();
            const messages: string[] = [];
            const reset = await reestablishPersistentConnectionAfterBrokenError(
                manager,
                'file:///test.sql',
                { connectionName: 'testConn', onMessage: message => messages.push(message) },
            );

            expect(reset).toBe(true);
            expect(manager.closeDocumentPersistentConnection).toHaveBeenCalledWith('file:///test.sql');
            expect(manager.getDocumentPersistentConnection).toHaveBeenCalledWith('file:///test.sql', 'testConn');
            expect(messages.join(' ')).toMatch(/Resetting connection/);
        });

        it('skips reset without a document or when keep-open is disabled', async () => {
            const manager = createManager();

            await expect(reestablishPersistentConnectionAfterBrokenError(manager, undefined)).resolves.toBe(false);
            await expect(reestablishPersistentConnectionAfterBrokenError(
                manager,
                'file:///test.sql',
                { keepConnectionOpen: false },
            )).resolves.toBe(false);
            expect(manager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
        });

        it('skips reset after the execution lease was superseded', async () => {
            const manager = createManager();

            await expect(reestablishPersistentConnectionAfterBrokenError(
                manager,
                'file:///test.sql',
                { isExecutionCurrent: () => false },
            )).resolves.toBe(false);
            expect(manager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
        });

        it('never throws when reopen fails', async () => {
            const manager = createManager();
            (manager.getDocumentPersistentConnection as unknown as jest.Mock<() => Promise<unknown>>).mockRejectedValueOnce(new Error('offline'));
            const messages: string[] = [];

            await expect(reestablishPersistentConnectionAfterBrokenError(
                manager,
                'file:///test.sql',
                { onMessage: message => messages.push(message) },
            )).resolves.toBe(false);
            expect(messages.join(' ')).toMatch(/manually/);
        });
    });
});

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import {
    isConnectionRecoveryError,
    isTimeoutLikeError,
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
});

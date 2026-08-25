import * as vscode from 'vscode';

import {
    clearQueryExecutionGateForTests,
    isQueryExecutionRunning,
    retireQueryExecutionForDocument,
    tryAcquireQueryExecution,
} from '../commands/query/queryExecutionGate';

jest.mock('vscode', () => ({
    window: {
        showWarningMessage: jest.fn(),
        showErrorMessage: jest.fn(),
    },
}));

const provider = {
    getActiveSource: jest.fn(),
    log: jest.fn(),
};

function createDocument(sourceUri: string): vscode.TextDocument {
    return {
        uri: { toString: () => sourceUri },
    } as vscode.TextDocument;
}

describe('queryExecutionGate', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (vscode.window.showWarningMessage as jest.Mock).mockReset();
        (vscode.window.showErrorMessage as jest.Mock).mockReset();
        clearQueryExecutionGateForTests();
    });

    it('does not carry a closed untitled document lease into a new document with the same URI', async () => {
        const sourceUri = 'untitled:Untitled-1';
        const closedDocument = createDocument(sourceUri);
        const newDocument = createDocument(sourceUri);
        const requestCancel = jest.fn().mockResolvedValue(undefined);

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            document: closedDocument,
            recovery: { requestCancel },
        });
        expect(firstLease).toBeDefined();

        retireQueryExecutionForDocument(closedDocument);

        const secondLease = await tryAcquireQueryExecution(sourceUri, provider, {
            document: newDocument,
        });
        expect(secondLease).toBeDefined();
        expect(secondLease?.executionId).not.toBe(firstLease?.executionId);
        expect(firstLease?.isCurrent()).toBe(false);
        expect(requestCancel).toHaveBeenCalledTimes(1);

        secondLease?.dispose();
    });

    it('does not let a superseded lease release its forced retry', async () => {
        const sourceUri = 'file:///query.sql';
        const resetConnection = jest.fn().mockResolvedValue(true);
        (vscode.window.showWarningMessage as jest.Mock)
            .mockResolvedValueOnce('Force unlock & retry')
            .mockResolvedValueOnce('Force unlock & retry');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: { resetConnection },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(firstLease).toBeDefined();
        expect(retryLease).toBeDefined();
        expect(firstLease?.isCurrent()).toBe(false);
        expect(resetConnection).toHaveBeenCalledTimes(1);
        expect(isQueryExecutionRunning(sourceUri)).toBe(true);

        firstLease?.dispose();
        expect(isQueryExecutionRunning(sourceUri)).toBe(true);

        retryLease?.dispose();
        expect(isQueryExecutionRunning(sourceUri)).toBe(false);
    });

    it('drops the recorded session and resets the connection before retrying', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        const dropSession = jest.fn().mockResolvedValue(true);
        const resetConnection = jest.fn().mockResolvedValue(true);
        const clearCancellation = jest.fn();
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Drop session & retry');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: {
                requestCancel,
                getSessionId: () => '12345',
                dropSession,
                resetConnection,
                clearCancellation,
            },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeDefined();
        expect(requestCancel).toHaveBeenCalledTimes(1);
        expect(dropSession).toHaveBeenCalledWith('12345');
        expect(resetConnection).toHaveBeenCalledTimes(1);
        expect(clearCancellation).toHaveBeenCalledTimes(1);
        expect(firstLease?.isCurrent()).toBe(false);

        retryLease?.dispose();
    });

    it('resets a killed persistent connection even when DROP SESSION retires the old lease', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        const resetConnection = jest.fn().mockResolvedValue(true);
        const clearCancellation = jest.fn();
        const leaseHolder: {
            value?: Awaited<ReturnType<typeof tryAcquireQueryExecution>>;
        } = {};
        const dropSession = jest.fn().mockImplementation(async () => {
            leaseHolder.value?.dispose();
            return true;
        });
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Drop session & retry');

        leaseHolder.value = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: {
                requestCancel,
                getSessionId: () => '12345',
                dropSession,
                resetConnection,
                clearCancellation,
            },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeDefined();
        expect(dropSession).toHaveBeenCalledTimes(1);
        expect(resetConnection).toHaveBeenCalledTimes(1);
        expect(clearCancellation).toHaveBeenCalledTimes(1);
        expect(dropSession.mock.invocationCallOrder[0]).toBeLessThan(
            resetConnection.mock.invocationCallOrder[0],
        );

        retryLease?.dispose();
    });

    it('clears the pending abort when resetting the connection retires the old lease', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        const clearCancellation = jest.fn();
        const leaseHolder: {
            value?: Awaited<ReturnType<typeof tryAcquireQueryExecution>>;
        } = {};
        const resetConnection = jest.fn().mockImplementation(async () => {
            leaseHolder.value?.dispose();
            return true;
        });
        (vscode.window.showWarningMessage as jest.Mock)
            .mockResolvedValueOnce('Force unlock & retry')
            .mockResolvedValueOnce('Force unlock & retry');

        leaseHolder.value = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: { requestCancel, resetConnection, clearCancellation },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeDefined();
        expect(resetConnection).toHaveBeenCalledTimes(1);
        expect(clearCancellation).toHaveBeenCalledTimes(1);

        retryLease?.dispose();
    });

    it('keeps the existing lease when a forced reset cannot make the session safe', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        const resetConnection = jest.fn().mockResolvedValue(false);
        (vscode.window.showWarningMessage as jest.Mock)
            .mockResolvedValueOnce('Force unlock & retry')
            .mockResolvedValueOnce('Force unlock & retry');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: { requestCancel, resetConnection },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeUndefined();
        expect(firstLease?.isCurrent()).toBe(true);
        expect(isQueryExecutionRunning(sourceUri)).toBe(true);
        expect(requestCancel).toHaveBeenCalledTimes(1);
        expect(resetConnection).toHaveBeenCalledTimes(1);
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            'Could not reset the previous SQL execution safely and no session is available to drop. Reconnect this tab manually before retrying.',
        );

        firstLease?.dispose();
    });

    it('offers DROP SESSION after Force unlock cannot reset the old execution', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        const dropSession = jest.fn().mockResolvedValue(true);
        const resetConnection = jest.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        (vscode.window.showWarningMessage as jest.Mock)
            .mockResolvedValueOnce('Force unlock & retry')
            .mockResolvedValueOnce('Force unlock & retry')
            .mockResolvedValueOnce('Drop session & retry');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: {
                requestCancel,
                getSessionId: () => '12345',
                dropSession,
                resetConnection,
            },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeDefined();
        expect(dropSession).toHaveBeenCalledWith('12345');
        expect(requestCancel).toHaveBeenCalledTimes(2);
        expect(resetConnection).toHaveBeenCalledTimes(2);
        expect(firstLease?.isCurrent()).toBe(false);

        retryLease?.dispose();
    });

    it('offers a fresh tab connection after DROP SESSION fails', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        const dropSession = jest.fn().mockResolvedValue(false);
        const resetConnection = jest.fn().mockResolvedValue(true);
        const openFreshConnection = jest.fn().mockResolvedValue(true);
        (vscode.window.showWarningMessage as jest.Mock)
            .mockResolvedValueOnce('Drop session & retry')
            .mockResolvedValueOnce('Open new connection & retry')
            .mockResolvedValueOnce('Open new connection & retry');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: {
                requestCancel,
                getSessionId: () => '12345',
                dropSession,
                resetConnection,
                openFreshConnection,
            },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeDefined();
        expect(dropSession).toHaveBeenCalledWith('12345');
        expect(openFreshConnection).toHaveBeenCalledTimes(1);
        expect(firstLease?.isCurrent()).toBe(false);

        retryLease?.dispose();
    });

    it('aborts a stale prompted acquisition and lets a later request acquire normally', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        let resolveFirstPrompt!: (selection: string) => void;
        const firstPrompt = new Promise<string>(resolve => {
            resolveFirstPrompt = resolve;
        });
        (vscode.window.showWarningMessage as jest.Mock)
            .mockImplementationOnce(() => firstPrompt)
            .mockResolvedValueOnce('Keep Waiting');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: { requestCancel },
        });
        const promptedAcquire = tryAcquireQueryExecution(sourceUri, provider);
        await Promise.resolve();

        firstLease?.dispose();
        const queuedAcquire = tryAcquireQueryExecution(sourceUri, provider);
        await Promise.resolve();
        expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);

        resolveFirstPrompt('Force unlock & retry');
        const staleLease = await promptedAcquire;
        const laterLease = await queuedAcquire;

        expect(staleLease).toBeUndefined();
        expect(laterLease).toBeDefined();
        expect(requestCancel).not.toHaveBeenCalled();
        expect(laterLease?.isCurrent()).toBe(true);

        laterLease?.dispose();
    });

    it('does not acquire from a stale prompt after its document closes', async () => {
        const sourceUri = 'file:///query.sql';
        const document = createDocument(sourceUri);
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        let resolvePrompt!: (selection: string | undefined) => void;
        const prompt = new Promise<string | undefined>(resolve => {
            resolvePrompt = resolve;
        });
        (vscode.window.showWarningMessage as jest.Mock).mockImplementationOnce(() => prompt);

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            document,
            recovery: { requestCancel },
        });
        const promptedAcquire = tryAcquireQueryExecution(sourceUri, provider, { document });
        await Promise.resolve();

        retireQueryExecutionForDocument(document);
        resolvePrompt('Keep Waiting');

        await expect(promptedAcquire).resolves.toBeUndefined();
        await expect(
            tryAcquireQueryExecution(sourceUri, provider, { document }),
        ).resolves.toBeUndefined();
        expect(firstLease?.isCurrent()).toBe(false);
        expect(requestCancel).toHaveBeenCalledTimes(1);

        const reopenedLease = await tryAcquireQueryExecution(sourceUri, provider, {
            document: createDocument(sourceUri),
        });
        expect(reopenedLease).toBeDefined();
        reopenedLease?.dispose();
    });

    it('does not offer forced recovery for an indivisible local operation', async () => {
        const sourceUri = 'file:///query.sql';
        const requestCancel = jest.fn().mockResolvedValue(undefined);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Cancel current operation');

        const firstLease = await tryAcquireQueryExecution(sourceUri, provider, {
            recovery: {
                requestCancel,
                allowForcedRecovery: false,
                forcedRecoveryUnavailableMessage: 'Local load is still active.',
            },
        });
        const retryLease = await tryAcquireQueryExecution(sourceUri, provider);

        expect(retryLease).toBeUndefined();
        expect(requestCancel).toHaveBeenCalledTimes(1);
        expect(firstLease?.isCurrent()).toBe(true);
        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
            expect.stringContaining('Local load is still active.'),
            'Keep Waiting',
            'Cancel current operation',
        );

        firstLease?.dispose();
    });
});

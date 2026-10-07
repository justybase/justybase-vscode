import * as vscode from 'vscode';
import { QueryExecutionCoordinator, type QueryQueueOutcome } from '../commands/query/queryExecutionGate';
import { QueryQueueView } from '../views/queryQueueView';

jest.mock('vscode', () => {
    const original = jest.requireActual('./__mocks__/vscode');
    return { ...original, window: { ...original.window, createTreeView: jest.fn(() => ({ dispose: jest.fn() })) } };
});

function lastSqlQueueAction(): (input: unknown) => Promise<void> {
    const registrations = (vscode.commands.registerCommand as jest.Mock).mock.calls.filter(call => call[0] === 'netezza.sqlQueueAction');
    return registrations[registrations.length - 1][1] as (input: unknown) => Promise<void>;
}

async function waitForRunning(coordinator: QueryExecutionCoordinator): Promise<void> {
    if (coordinator.getSnapshot()[0]?.runningExecutions.length === 1) return;
    await new Promise<void>(resolve => {
        const sub = coordinator.onDidChange(() => {
            if (coordinator.getSnapshot()[0]?.runningExecutions.length === 1) { sub.dispose(); resolve(); }
        });
    });
}

describe('Logs queue Cancel dispatched from the result panel webview', () => {
    it('routes a webview-shaped cancel (sourceKey/jobId) to backend cancellation', async () => {
        const coordinator = new QueryExecutionCoordinator();
        (vscode.commands.registerCommand as jest.Mock).mockReturnValue({ dispose: jest.fn() });
        const doc = { uri: { toString: () => 'untitled:Untitled-3' } } as vscode.TextDocument;
        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = { document: doc } as vscode.TextEditor;
        const panel = { getActiveSource: () => undefined, log: () => undefined, cancelExecution: jest.fn() };
        const view = new QueryQueueView(coordinator, panel);

        const requestCancel = jest.fn(async () => undefined);
        let release!: (value: QueryQueueOutcome) => void;
        const gate = new Promise<QueryQueueOutcome>(resolve => { release = resolve; });
        const outcome = coordinator.enqueue(
            { sourceUri: doc.uri.toString(), executionUri: 'untitled:Untitled-3#execution:1', sql: 'SELECT * FROM FACTPRODUCTINVENTORY' },
            { document: doc, recovery: { requestCancel } },
            async () => async () => gate,
        );
        await waitForRunning(coordinator);

        // Payload shaped exactly like the Logs webview message forwarded by
        // ResultPanelMessageHandler: { command, sourceKey, action, jobId }.
        const lane = coordinator.getSnapshot()[0];
        await lastSqlQueueAction()({ command: 'sqlQueueAction', sourceKey: lane.sourceKey, action: 'cancel', jobId: lane.runningExecutions[0].id });

        expect(requestCancel).toHaveBeenCalledTimes(1);
        expect(panel.cancelExecution).toHaveBeenCalledWith('untitled:Untitled-3#execution:1');

        release('cancelled');
        await expect(outcome).resolves.toBe('cancelled');
        view.dispose();
        coordinator.dispose();
    });

    it('still cancels the backend when result-panel bookkeeping throws', async () => {
        const coordinator = new QueryExecutionCoordinator();
        (vscode.commands.registerCommand as jest.Mock).mockReturnValue({ dispose: jest.fn() });
        const doc = { uri: { toString: () => 'untitled:Untitled-3' } } as vscode.TextDocument;
        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = { document: doc } as vscode.TextEditor;
        const panel = { getActiveSource: () => undefined, log: () => undefined, cancelExecution: jest.fn(() => { throw new Error('bookkeeping boom'); }) };
        const view = new QueryQueueView(coordinator, panel);

        const requestCancel = jest.fn(async () => undefined);
        let release!: (value: QueryQueueOutcome) => void;
        const gate = new Promise<QueryQueueOutcome>(resolve => { release = resolve; });
        const outcome = coordinator.enqueue(
            { sourceUri: doc.uri.toString(), executionUri: 'untitled:Untitled-3#execution:1', sql: 'SELECT * FROM FACTPRODUCTINVENTORY' },
            { document: doc, recovery: { requestCancel } },
            async () => async () => gate,
        );
        await waitForRunning(coordinator);

        const lane = coordinator.getSnapshot()[0];
        await lastSqlQueueAction()({ command: 'sqlQueueAction', sourceKey: lane.sourceKey, action: 'cancel', jobId: lane.runningExecutions[0].id });

        // Regression: bookkeeping used to run first and its throw skipped the
        // backend cancel, leaving a visibly dead Cancel button in Logs.
        expect(requestCancel).toHaveBeenCalledTimes(1);

        release('cancelled');
        await expect(outcome).resolves.toBe('cancelled');
        view.dispose();
        coordinator.dispose();
    });

    it('routes a webview-shaped remove for a queued job behind a running one', async () => {
        const coordinator = new QueryExecutionCoordinator();
        (vscode.commands.registerCommand as jest.Mock).mockReturnValue({ dispose: jest.fn() });
        const doc = { uri: { toString: () => 'untitled:Untitled-3' } } as vscode.TextDocument;
        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = { document: doc } as vscode.TextEditor;
        const panel = { getActiveSource: () => undefined, log: () => undefined };
        const view = new QueryQueueView(coordinator, panel);

        let releaseRunning!: (value: QueryQueueOutcome) => void;
        const runningGate = new Promise<QueryQueueOutcome>(resolve => { releaseRunning = resolve; });
        const running = coordinator.enqueue(
            { sourceUri: doc.uri.toString(), sql: 'SELECT 1' },
            { document: doc },
            async () => async () => runningGate,
        );
        const queued = coordinator.enqueue(
            { sourceUri: doc.uri.toString(), sql: 'SELECT 2' },
            { document: doc },
            async () => async () => 'completed',
        );
        await waitForRunning(coordinator);
        expect(coordinator.getSnapshot()[0].queued).toHaveLength(1);

        const lane = coordinator.getSnapshot()[0];
        await lastSqlQueueAction()({ command: 'sqlQueueAction', sourceKey: lane.sourceKey, action: 'remove', jobId: lane.queued[0].id });

        await expect(queued).resolves.toBe('cancelled');
        expect(coordinator.getSnapshot()[0].queued).toHaveLength(0);

        releaseRunning('completed');
        await expect(running).resolves.toBe('completed');
        view.dispose();
        coordinator.dispose();
    });
});

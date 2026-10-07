import * as vscode from 'vscode';
import { QueryExecutionCoordinator, type QueryQueueOutcome } from '../commands/query/queryExecutionGate';
import { QueryQueueView } from '../views/queryQueueView';

jest.mock('vscode', () => {
    const original = jest.requireActual('./__mocks__/vscode');
    return { ...original, window: { ...original.window, createTreeView: jest.fn(() => ({ dispose: jest.fn() })) } };
});

describe('native SQL queue view', () => {
    it('renders pending previews, updates status immediately, removes without execution, and disposes subscriptions', async () => {
        const coordinator = new QueryExecutionCoordinator();
        (vscode.commands.registerCommand as jest.Mock).mockReturnValue({ dispose: jest.fn() });
        const doc = { uri: { toString: () => 'untitled:Queue-1' } } as vscode.TextDocument;
        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = { document: doc } as vscode.TextEditor;
        const view = new QueryQueueView(coordinator, { getActiveSource: () => undefined, log: () => undefined });
        const run = jest.fn(async (): Promise<QueryQueueOutcome> => 'completed');
        const result = coordinator.enqueue({ sourceUri: doc.uri.toString(), sql: 'SELECT\n1;' }, { document: doc }, async () => run);
        const root = view.getChildren()[0];
        const item = view.getTreeItem(root);
        expect(item.description).toContain('1 queued');
        const rows = view.getChildren(root);
        const pending = rows.find(row => row.action === 'remove')!;
        expect(view.getTreeItem(pending).label).toContain('SELECT 1;');
        const status = (vscode.window.createStatusBarItem as jest.Mock).mock.results.slice(-1)[0].value;
        expect(status.text).toContain('1 queued');
        expect(status.command).toBe('netezza.showSqlQueue');
        const action = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(call => call[0] === 'netezza.sqlQueueAction')[1];
        await action(pending);
        expect(await result).toBe('cancelled');
        expect(run).not.toHaveBeenCalled();
        expect(status.hide).toHaveBeenCalled();
        view.dispose();
        expect(status.dispose).toHaveBeenCalledTimes(1);
        coordinator.dispose();
    });
});

it('renders failure/recovery states and dispatches pause, resume, cancel, clear and recovery actions', async () => {
    const job = { id: 'running', sourceUri: 'file:///query.sql', sourceKey: 'lane', sql: 'SELECT 1', queuedAt: 1,
        status: 'cancelling' as const, connectionName: 'Netezza', database: 'DB' };
    const lane = { sourceKey: 'lane', sourceUri: job.sourceUri, paused: true, running: job, runningExecutions: [job], maxConcurrency: 1,
        queued: [{ ...job, id: 'next', status: 'queued' as const }],
        last: { ...job, id: 'failed', status: 'failed' as const, error: 'Database error' } };
    const coordinator = { getSnapshot: jest.fn(() => [lane]), onDidChange: () => ({ dispose: jest.fn() }),
        setPaused: jest.fn(), cancelRunning: jest.fn(async () => undefined), recoverRunning: jest.fn(async () => undefined),
        clearQueued: jest.fn(), removeQueued: jest.fn() };
    const panel = { getActiveSource: () => undefined, log: () => undefined, cancelExecution: jest.fn() };
    (vscode.commands.registerCommand as jest.Mock).mockClear().mockReturnValue({ dispose: jest.fn() });
    const view = new QueryQueueView(coordinator as unknown as QueryExecutionCoordinator, panel);
    const action = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(call => call[0] === 'netezza.sqlQueueAction')[1];
    const show = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(call => call[0] === 'netezza.showSqlQueue')[1];
    const root = view.getChildren()[0];
    expect(view.getTreeItem(root).description).toContain('Paused');
    const children = view.getChildren(root);
    expect(children.some(child => child.action === 'recover')).toBe(true);
    for (const child of children) {
        const item = view.getTreeItem(child);
        expect(item.tooltip).toBeDefined();
        expect(view.getChildren(child)).toEqual([]);
    }
    const failed = children.find(child => child.job?.status === 'failed')!;
    expect(view.getTreeItem(failed).tooltip).toContain('Database error');
    for (const name of ['cancel', 'recover', 'clear', 'pause', 'resume', 'remove']) {
        await action({ lane, action: name, job: lane.queued[0] });
    }
    expect(coordinator.setPaused.mock.calls).toEqual([['lane', true], ['lane', false]]);
    expect(coordinator.cancelRunning).toHaveBeenCalledWith('lane', 'next');
    expect(coordinator.recoverRunning).toHaveBeenCalledWith('lane', panel, 'next');
    expect(panel.cancelExecution).toHaveBeenCalledWith('file:///query.sql');
    await show();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.sqlQueue.focus');
    lane.paused = false;
    expect(view.getTreeItem(view.getChildren()[0]).description).toContain('1 running');
    expect(view.getTreeItem(view.getChildren(view.getChildren()[0]).find(child => child.action === 'pause')!).label).toBe('Pause queue');
    view.dispose();
});

it('lists every independent running request and displays its per-tab concurrency limit', async () => {
    const coordinator = new QueryExecutionCoordinator();
    const doc = { uri: { toString: () => 'file:///parallel.sql' } } as vscode.TextDocument;
    Object.assign(vscode.window, { activeTextEditor: { document: doc } });
    const view = new QueryQueueView(coordinator, { getActiveSource: () => undefined, log: () => undefined });
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    const jobs = [1, 2].map(i => coordinator.enqueue({ sourceUri: doc.uri.toString(), executionUri: `execution:${i}`, sql: `SELECT ${i}` },
        { document: doc, independentConnection: true }, async () => async () => { await completion; return 'completed'; }));
    await new Promise<void>(resolve => {
        const listener = coordinator.onDidChange(() => {
            if (coordinator.getSnapshot()[0]?.runningExecutions.length === 2) { listener.dispose(); resolve(); }
        });
    });
    const root = view.getChildren()[0];
    expect(view.getTreeItem(root).description).toContain('2 running / 4');
    expect(view.getChildren(root).filter(row => row.action === 'cancel')).toHaveLength(2);
    const status = (vscode.window.createStatusBarItem as jest.Mock).mock.results.slice(-1)[0].value;
    expect(status.text).toContain('2 running / 4');
    finish(); await Promise.all(jobs); view.dispose(); coordinator.dispose();
});

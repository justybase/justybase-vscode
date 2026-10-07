import * as vscode from 'vscode';
import { getQueryExecutionCoordinator } from '../commands/query/queryExecutionGate';
import type { ResultPanelView } from '../views/resultPanelView';

/** Production command, document edit, coordinator and result-panel boundary regression. */
export async function runQueryQueueRegression(document: vscode.TextDocument, provider: ResultPanelView, independent = false): Promise<void> {
    const coordinator = getQueryExecutionCoordinator();
    const sourceUri = document.uri.toString();
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    let reserved = false;
    const completed = new Set<string>();
    const previousExecution = coordinator.getSnapshot().find(lane => lane.sourceUri === sourceUri)?.last;
    if (previousExecution) completed.add(previousExecution.id);
    const values: number[] = [];
    let peakRunning = 0;
    let ready!: () => void;
    const prepared = new Promise<void>(resolve => { ready = resolve; });
    const listener = coordinator.onDidChange(() => {
        const lane = coordinator.getSnapshot().find(item => item.sourceUri === sourceUri);
        if (!lane) return;
        peakRunning = Math.max(peakRunning, lane.runningExecutions.length);
        if (!reserved) {
            reserved = true;
            coordinator.setPaused(lane.sourceKey, true);
        }
        if (lane.queued.length === 2 && lane.queued.every(job => job.status === 'queued')) ready();
        if (lane.last?.status === 'completed' && !completed.has(lane.last.id)) {
            completed.add(lane.last.id);
            const result = provider.getResultsForSource(lane.last.executionUri ?? sourceUri)?.filter(item => !item.isLog && !item.isError && item.data.length).slice(-1)[0];
            if (result) values.push(Number(result.data[0][0]));
        }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replace = async (sql: string) => {
        const changed = await editor.edit(builder => builder.replace(
            new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), sql));
        if (!changed) throw new Error('Could not edit queue fixture.');
        editor.selection = new vscode.Selection(document.positionAt(0), document.positionAt(sql.length));
    };
    try {
        await vscode.commands.executeCommand('netezza.showSqlQueue');
        await vscode.window.showTextDocument(document, { preview: false });
        await replace('SELECT 101;');
        const first = vscode.commands.executeCommand('netezza.runQuery');
        await replace('SELECT 202;');
        const second = vscode.commands.executeCommand('netezza.runQueryBatch');
        await Promise.race([prepared, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Queue fixture did not prepare two requests.')), 30_000);
        })]);
        if (timer) clearTimeout(timer);
        await replace('SELECT 303;');
        const lane = coordinator.getSnapshot().find(item => item.sourceUri === sourceUri)!;
        if (lane.running || lane.queued[0].sql.trim().replace(/;$/, '') !== 'SELECT 101' || lane.queued[1].sql.trim().replace(/;$/, '') !== 'SELECT 202') {
            throw new Error('Queue did not retain submitted SQL snapshots while paused.');
        }
        coordinator.setPaused(lane.sourceKey, false);
        await Promise.all([first, second]);
        if ((independent ? [...values].sort((a,b) => a-b) : values).join(',') !== '101,202') throw new Error('Queued production commands did not return captured SQL results in FIFO order.');
        if (independent && peakRunning < 2) throw new Error('Transient requests did not overlap in the production lane.');
        const done = coordinator.getSnapshot().find(item => item.sourceUri === sourceUri)!;
        if (done.running || done.queued.length || done.paused) throw new Error('Queue did not drain cleanly.');
        if (independent) {
            provider.setActiveSource(sourceUri);
            const workspace = provider.getResultsForSource(sourceUri) ?? [];
            if (workspace.filter(result => !result.isLog).length !== 2 || workspace.filter(result => result.isLog).length !== 1) {
                throw new Error('Concurrent results did not form one document workspace with two data tabs and one Logs tab.');
            }
            await provider.ensureResultPanelTestBridgeReady();
            const rendered = await provider.runResultPanelTestBridge('snapshot') as { sourceUri: string; resultSetCount: number };
            if (rendered.sourceUri !== sourceUri || rendered.resultSetCount !== 3) throw new Error('Renderer exposed execution sources instead of the document Results workspace.');
        }
    } finally {
        if (timer) clearTimeout(timer);
        listener.dispose();
        const lane = coordinator.getSnapshot().find(item => item.sourceUri === sourceUri);
        if (lane) coordinator.clearQueued(lane.sourceKey);
    }
}

/** Real renderer selection survives new requests in both document connection modes. */
export async function runQueryQueueLogsRegression(document: vscode.TextDocument, provider: ResultPanelView, setKeepOpen: (keepOpen: boolean) => void): Promise<void> {
    try {
        for (const keepOpen of [true, false]) {
            setKeepOpen(keepOpen);
            provider.setActiveSource(document.uri.toString());
            await provider.runResultPanelTestBridge('switchResultSet', { resultSetIndex: 0 });
            await vscode.window.showTextDocument(document, { preview: false });
            await vscode.commands.executeCommand('netezza.runQuery');
            const logs = await provider.runResultPanelTestBridge('snapshot') as { activeResultSetIndex: number };
            if (logs.activeResultSetIndex !== 0) throw new Error('New queued results displaced manually selected Logs.');
            await provider.runResultPanelTestBridge('switchResultSet', { resultSetIndex: 1 });
            await vscode.window.showTextDocument(document, { preview: false });
            await vscode.commands.executeCommand('netezza.runQuery');
            const results = await provider.runResultPanelTestBridge('snapshot') as { activeResultSetIndex: number };
            if (results.activeResultSetIndex < 1) throw new Error('Automatic result activation did not resume after leaving Logs.');
        }
    } finally { setKeepOpen(true); }
}

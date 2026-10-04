import * as vscode from 'vscode';
import { normalizeUriKey } from '../core/queryRunnerUtils';
import type { QueryExecutionCoordinator, QueryExecutionResultPanel, QueryLaneSnapshot, QueryQueueSnapshot } from '../commands/query/queryExecutionGate';

type QueueNode = { lane: QueryLaneSnapshot; job?: QueryQueueSnapshot; action?: string };

/** Native tree UI: ephemeral coordinator state only, with VS Code's own theme and accessibility. */
export class QueryQueueView implements vscode.TreeDataProvider<QueueNode>, vscode.Disposable {
    private readonly emitter = new vscode.EventEmitter<QueueNode | undefined>();
    public readonly onDidChangeTreeData = this.emitter.event;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);

    public constructor(private readonly coordinator: QueryExecutionCoordinator, panel: QueryExecutionResultPanel) {
        const view = vscode.window.createTreeView('netezza.sqlQueue', { treeDataProvider: this });
        this.status.command = 'netezza.showSqlQueue';
        this.status.tooltip = 'Show SQL execution queue';
        const refresh = () => {
            this.emitter.fire(undefined);
            panel.updateSqlQueue?.(JSON.stringify(coordinator.getSnapshot().map(lane => ({
                sourceKey: lane.sourceKey, sourceUri: lane.sourceUri, lastExecutionUri: lane.last?.executionUri, paused: lane.paused, maxConcurrency: lane.maxConcurrency,
                running: lane.runningExecutions.map(job => ({ id: job.id, executionUri: job.executionUri,
                    sql: job.sql.slice(0, 4000), status: job.status, database: job.database })),
                queued: lane.queued.map(job => ({ id: job.id, sql: job.sql.slice(0, 4000),
                    status: job.status, database: job.database })),
            }))));
            const document = vscode.window.activeTextEditor?.document;
            const source = document?.uri?.toString();
            const lane = coordinator.getSnapshot().find(item => source && normalizeUriKey(item.sourceUri) === normalizeUriKey(source));
            if (!lane || (!lane.runningExecutions.length && !lane.queued.length && !lane.paused)) {
                this.status.hide();
                return;
            }
            this.status.text = `$(list-ordered) ${lane.paused ? 'Queue paused | ' : ''}${lane.runningExecutions.length ? `${lane.runningExecutions.length} running${lane.maxConcurrency > 1 ? ' / 20' : ''}` : 'Preparing'} | ${lane.queued.length} queued`;
            this.status.show();
        };
        this.disposables.push(view, this.status, this.emitter,
            coordinator.onDidChange(refresh), vscode.window.onDidChangeActiveTextEditor(refresh),
            vscode.commands.registerCommand('netezza.showSqlQueue', async () => {
                await vscode.commands.executeCommand('netezza.sqlQueue.focus');
            }),
            vscode.commands.registerCommand('netezza.sqlQueueAction', async (input: QueueNode | { sourceKey: string; action: string; jobId?: string }) => {
                const lane = coordinator.getSnapshot().find(item => item.sourceKey === ('lane' in input ? input.lane.sourceKey : input.sourceKey));
                if (!lane) return;
                const jobId = 'lane' in input ? input.job?.id : input.jobId;
                const job = [...lane.runningExecutions, ...lane.queued].find(item => item.id === jobId);
                const node: QueueNode = { lane, job, action: input.action };
                if (['cancel', 'remove', 'recover'].includes(node.action ?? '') && !job) return;
                const key = lane.sourceKey;
                switch (node.action) {
                    case 'remove': coordinator.removeQueued(key, node.job!.id); break;
                    case 'clear': coordinator.clearQueued(key); break;
                    case 'pause': coordinator.setPaused(key, true); break;
                    case 'resume': coordinator.setPaused(key, false); break;
                    case 'cancel': panel.cancelExecution?.(node.job?.executionUri ?? node.lane.sourceUri); await coordinator.cancelRunning(key, node.job?.id); break;
                    case 'recover': await coordinator.recoverRunning(key, panel, node.job?.id); break;
                }
            }));
        refresh();
    }

    public getChildren(node?: QueueNode): QueueNode[] {
        if (!node) return this.coordinator.getSnapshot().filter(lane => lane.runningExecutions.length || lane.queued.length || lane.paused || lane.last)
            .map(lane => ({ lane }));
        if (node.job || node.action) return [];
        const { lane } = node;
        return [
            ...lane.runningExecutions.flatMap(job => [{ lane, job, action: 'cancel' }, { lane, job, action: 'recover' }]),
            ...lane.queued.map(job => ({ lane, job, action: 'remove' })),
            ...(lane.last ? [{ lane, job: lane.last }] : []),
            { lane, action: lane.paused ? 'resume' : 'pause' },
            { lane, action: 'clear' },
        ];
    }

    public getTreeItem(node: QueueNode): vscode.TreeItem {
        const { lane, job, action } = node;
        if (!job && !action) {
            const item = new vscode.TreeItem(lane.sourceUri.split(/[\\/]/).pop() ?? lane.sourceUri, vscode.TreeItemCollapsibleState.Expanded);
            item.id = lane.sourceKey;
            item.description = `${lane.paused ? 'Paused | ' : ''}${lane.runningExecutions.length ? `${lane.runningExecutions.length} running${lane.maxConcurrency > 1 ? ' / 20' : ''}` : 'Idle'} | ${lane.queued.length} queued`;
            item.tooltip = lane.sourceUri;
            return item;
        }
        const labels: Record<string, string> = {
            pause: 'Pause queue', resume: 'Resume queue', clear: 'Clear queued', recover: 'Recover running execution…',
        };
        const label = action === 'recover' && job ? `Recover: ${job.sql.replace(/\s+/g, ' ').trim().slice(0, 80)}` : job ? `${job.status.toUpperCase()}: ${job.sql.replace(/\s+/g, ' ').trim().slice(0, 120)}` : labels[action!];
        const item = new vscode.TreeItem(label);
        item.id = `${lane.sourceKey}:${job?.id ?? action}:${action ?? 'status'}`;
        item.tooltip = job ? `${job.connectionName ?? ''}${job.database ? ` / ${job.database}` : ''}\n${job.error ?? ''}\n${job.sql}` : label;
        item.description = action === 'cancel' ? 'Click to cancel' : action === 'remove' ? 'Click to remove' : undefined;
        item.iconPath = new vscode.ThemeIcon(job ? job.status === 'failed' ? 'error' : action === 'cancel' ? 'loading~spin' : 'file-code' : action === 'pause' ? 'debug-pause' : action === 'resume' ? 'play' : 'clear-all');
        if (action) item.command = { command: 'netezza.sqlQueueAction', title: label, arguments: [node] };
        return item;
    }

    public dispose(): void {
        for (const disposable of this.disposables.splice(0)) disposable.dispose();
    }
}

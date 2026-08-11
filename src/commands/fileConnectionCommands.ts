import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { FileConnectionPanelView } from '../views/fileConnectionPanelView';

export interface FileConnectionCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
}

interface FileConnectionTreeItem {
    connectionName?: string;
}

export function registerFileConnectionCommands(
    deps: FileConnectionCommandsDependencies,
): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand(
            'netezza.openFileConnectionPanel',
            (item?: FileConnectionTreeItem) => {
                FileConnectionPanelView.createOrShow(deps.context, deps.connectionManager, {
                    connectionName: item?.connectionName,
                });
            },
        ),
    ];
}

import * as vscode from 'vscode';
import { NetezzaSqlNotebookSerializer } from '../notebook/serializer';
import { NetezzaSqlNotebookController } from '../notebook/controller';
import {
    FullGridPanel,
    getStashedResult,
    getLastStashedResult,
    getCellResultId,
    onDidChangeCellResults,
} from '../notebook/fullGridPanel';
import { Logger } from '../utils/logger';
import type { ConnectionManager } from '../core/connectionManager';

export function activateNotebookRegistration(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    logger: Logger,
): void {
    try {
        const notebookSerializer = new NetezzaSqlNotebookSerializer();
        const notebookController = new NetezzaSqlNotebookController(context, connectionManager);
        context.subscriptions.push(
            vscode.workspace.registerNotebookSerializer('netezza-sql-notebook', notebookSerializer, {
                transientOutputs: false,
                transientCellMetadata: {
                    inputCollapsed: true,
                    outputCollapsed: false,
                },
            }),
            notebookController,
            vscode.commands.registerCommand('netezza.notebook.createNew', async () => {
                const document = await vscode.workspace.openNotebookDocument(
                    'netezza-sql-notebook',
                    new vscode.NotebookData([
                        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '-- Write your SQL here\nSELECT 1;', 'sql'),
                    ]),
                );
                await vscode.commands.executeCommand('vscode.open', document.uri);
            }),
            vscode.notebooks.registerNotebookCellStatusBarItemProvider('netezza-sql-notebook', {
                provideCellStatusBarItems(cell, _token) {
                    const resultId = getCellResultId(cell.document.uri.toString());
                    if (!resultId) {
                        return [];
                    }
                    const item = new vscode.NotebookCellStatusBarItem(
                        '$(list-tree) Full Grid',
                        vscode.NotebookCellStatusBarAlignment.Right,
                    );
                    item.command = {
                        command: 'netezza.notebook.openFullGrid',
                        arguments: [resultId],
                        title: 'Open in Full Grid',
                    };
                    item.tooltip = 'Open results in Full Grid — sort, filter & export to XLSB';
                    return [item];
                },
                onDidChangeCellStatusBarItems: onDidChangeCellResults,
            }),
            vscode.commands.registerCommand('netezza.notebook.openFullGrid', async (args?: string) => {
                let resultId = typeof args === 'string' ? args : undefined;
                if (!resultId) {
                    const entries = getStashedResult();
                    const keys = Object.keys(entries);
                    if (keys.length === 0) {
                        vscode.window.showWarningMessage('No notebook results available. Run a cell first.');
                        return;
                    }
                    const pick = await vscode.window.showQuickPick(
                        keys.map(k => ({
                            label: `${entries[k].columns.length} columns, ${entries[k].rows.length} rows`,
                            description: entries[k].sql.slice(0, 80),
                            detail: k,
                        })),
                        { placeHolder: 'Select a notebook result to open in Full Grid' },
                    );
                    if (!pick) {
                        return;
                    }
                    resultId = pick.detail;
                }

                const result = getStashedResult(resultId);
                if (!result) {
                    vscode.window.showWarningMessage('Result data no longer available. Re-run the cell.');
                    return;
                }
                new FullGridPanel(context.extensionUri, result).reveal();
            }),
            vscode.commands.registerCommand('netezza.notebook.openInFullGrid', () => {
                const result = getLastStashedResult();
                if (!result) {
                    vscode.window.showWarningMessage('No notebook results available. Run a cell first.');
                    return;
                }
                new FullGridPanel(context.extensionUri, result).reveal();
            }),
        );
        logger.info('Netezza extension: Notebook support registered.');
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Netezza extension: Notebook registration failed: ${errorMessage}`);
    }
}

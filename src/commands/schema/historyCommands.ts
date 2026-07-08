/**
 * Schema Commands - History Commands
 * Commands: showQueryHistory, clearQueryHistory
 */

import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';

export function registerHistoryCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context } = deps;

    return [
        vscode.commands.registerCommand('netezza.showQueryHistory', () => {
            vscode.commands.executeCommand('netezza.queryHistory.focus');
        }),

        vscode.commands.registerCommand('netezza.clearQueryHistory', async () => {
            const { QueryHistoryManager } = await import('../../core/queryHistoryManager');
            const historyManager = QueryHistoryManager.getInstance(context);

            const confirm = await vscode.window.showWarningMessage(
                'Are you sure you want to clear all query history?',
                { modal: true },
                'Clear All'
            );

            if (confirm === 'Clear All') {
                await historyManager.clearHistory();
                vscode.window.showInformationMessage('Query history cleared');
            }
        })
    ];
}

/**
 * Debug configuration provider for SQL execution.
 * Executes SQL through existing extension commands before the debug adapter starts.
 */

import * as vscode from 'vscode';
import { SqlParser } from '../sql/sqlParser';

export class SqlDebugConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type) {
            config.type = 'netezza-sql';
        }
        if (!config.request) {
            config.request = 'launch';
        }
        if (!config.name) {
            config.name = 'Run SQL';
        }
        if (!config.mode) {
            config.mode = 'run';
        }
        return config;
    }

    resolveDebugConfigurationWithSubstitutedVariables(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        const query = (config.query as string) || '';
        const mode = (config.mode as string) || 'run';

        let sqlToExecute = query.trim();

        if (!sqlToExecute) {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active SQL editor');
                return null;
            }
            const selection = editor.selection;
            if (!selection.isEmpty) {
                sqlToExecute = editor.document.getText(selection).trim();
            } else {
                const text = editor.document.getText();
                const offset = editor.document.offsetAt(selection.active);
                const stmt = SqlParser.getStatementAtPosition(text, offset);
                if (stmt) {
                    sqlToExecute = stmt.sql.trim();
                } else {
                    sqlToExecute = text.trim();
                }
            }
        }

        if (!sqlToExecute) {
            vscode.window.showWarningMessage('No SQL query to execute');
            return null;
        }

        const finalQuery = sqlToExecute;
        const finalMode = mode;

        // Execute SQL through existing extension commands, then cancel debug session
        setTimeout(async () => {
            try {
                if (finalMode === 'explain') {
                    await vscode.commands.executeCommand('netezza.explainQuery');
                } else if (finalMode === 'batch') {
                    await vscode.commands.executeCommand('netezza.runQueryBatch');
                } else {
                    const editor = vscode.window.activeTextEditor;
                    if (editor && !editor.selection.isEmpty) {
                        await vscode.commands.executeCommand('netezza.runQuery');
                    } else if (editor) {
                        const text = editor.document.getText();
                        const offset = editor.document.offsetAt(editor.selection.active);
                        const stmt = SqlParser.getStatementAtPosition(text, offset);
                        if (stmt) {
                            await vscode.commands.executeCommand(
                                'netezza.runStatementFromLens',
                                editor.document.uri,
                                stmt.sql
                            );
                        } else {
                            await vscode.commands.executeCommand('netezza.runQuery');
                        }
                    }
                }
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`SQL execution failed: ${msg}`);
            }
        }, 100);

        // Return the config so the debug adapter starts (it will show query in Debug Console)
        config.query = finalQuery;
        return config;
    }
}

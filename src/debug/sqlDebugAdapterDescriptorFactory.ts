/**
 * Debug adapter factory for SQL execution.
 * Spawns the DAP server script that handles debug sessions for SQL files.
 */

import * as vscode from 'vscode';
import * as path from 'path';

export class SqlDebugAdapterDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const scriptPath = path.join(__dirname, 'sqlDebugAdapter.js');
        return new vscode.DebugAdapterExecutable('node', [scriptPath]);
    }
}

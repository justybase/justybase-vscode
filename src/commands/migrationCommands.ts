import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import { MigrationWizardView } from '../views/migrationWizardView';

export interface MigrationCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
}

interface MigrationTreeItem {
    contextValue?: string;
    connectionName?: string;
    dbName?: string;
    schema?: string;
    rawLabel?: string;
    label?: string;
    objType?: string;
}

function isTableLikeItem(item: MigrationTreeItem | undefined): boolean {
    if (!item) return false;
    const objectType = item.objType?.toUpperCase();
    return Boolean(
        (item.contextValue?.startsWith('netezza:') || item.contextValue?.startsWith('favoritesObject:'))
        && (objectType === 'TABLE' || objectType === 'VIEW' || objectType === 'EXTERNAL TABLE'),
    );
}

async function openMigrationWizard(
    deps: MigrationCommandsDependencies,
    item?: MigrationTreeItem,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const documentUri = editor?.document.uri.toString();
    let source: Parameters<typeof MigrationWizardView.createOrShow>[2]['source'];

    if (item && isTableLikeItem(item) && item.connectionName) {
        source = {
            mode: 'table',
            connectionName: item.connectionName,
            database: item.dbName,
            schema: item.schema,
            table: item.rawLabel || item.label || '',
        };
    } else {
        const connectionName = deps.connectionManager.getConnectionForExecution(documentUri);
        if (!editor || !connectionName) {
            vscode.window.showErrorMessage('Select a schema table/view or open a SQL editor with an active connection.');
            return;
        }
        const selectedSql = editor.document.getText(editor.selection).trim();
        const sql = selectedSql || editor.document.getText().trim();
        if (!sql) {
            vscode.window.showErrorMessage('The SQL editor does not contain a query to migrate.');
            return;
        }
        source = { mode: 'sql', connectionName, sql };
    }

    const targetConnectionName = deps.connectionManager.getConnectionForExecution(documentUri) || source.connectionName;
    const targetDetails = await deps.connectionManager.getConnection(targetConnectionName);
    await MigrationWizardView.createOrShow(deps.context, deps.connectionManager, {
        source,
        targetConnectionName,
        targetDatabase: targetDetails?.database,
        targetSchema: targetDetails?.schema,
    });
}

export function registerMigrationCommands(deps: MigrationCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.migrateData', (item?: MigrationTreeItem) => openMigrationWizard(deps, item)),
    ];
}

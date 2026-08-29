import * as vscode from 'vscode';
import { activateCoreExtension } from '../../../src/api/companionActivation';
import { formatQualifiedObjectName } from '../../../src/utils/identifierUtils';
import { clickhouseDialect } from './clickhouseDialect';

interface ClickHouseSchemaItem {
    connectionName?: string;
    dbName?: string;
    schema?: string;
    label?: string;
    rawLabel?: string;
}

const disposables: vscode.Disposable[] = [];

async function optimizeTable(
    api: Awaited<ReturnType<typeof activateCoreExtension>>,
    item: ClickHouseSchemaItem,
): Promise<void> {
    const tableName = item.rawLabel || item.label;
    if (!tableName) {
        return;
    }

    const active = await api.getActiveConnectionDetails();
    const connectionName = item.connectionName || active?.name;
    const database = item.dbName || active?.details.database || '';
    const qualifiedName = formatQualifiedObjectName(database, undefined, tableName, 'clickhouse');
    const action = await vscode.window.showWarningMessage(
        `Optimize ClickHouse table "${qualifiedName}"?`,
        { modal: true },
        'Background merge',
        'Force FINAL merge',
        'Cancel',
    );
    if (action === 'Cancel' || !action) {
        return;
    }

    const sql = `OPTIMIZE TABLE ${qualifiedName}${action === 'Force FINAL merge' ? ' FINAL' : ''};`;
    if (connectionName && api.executeConnectionSql) {
        await api.executeConnectionSql(sql, connectionName);
        vscode.window.showInformationMessage(`ClickHouse OPTIMIZE TABLE started: ${qualifiedName}`);
        return;
    }
    await api.executeActiveConnectionSql(sql, active?.documentUri);
    vscode.window.showInformationMessage(`ClickHouse OPTIMIZE TABLE started: ${qualifiedName}`);
}

export async function activate(): Promise<void> {
    const api = await activateCoreExtension();
    api.registerDatabaseDialect(clickhouseDialect);
    disposables.push(vscode.commands.registerCommand(
        'justybase.clickhouse.optimizeTable',
        async (item: ClickHouseSchemaItem) => optimizeTable(api, item ?? {}),
    ));
}

export function deactivate(): void {
    for (const disposable of disposables.splice(0)) {
        disposable.dispose();
    }
}

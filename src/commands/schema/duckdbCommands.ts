/**
 * Schema Commands - DuckDB Index Diagnostics
 *
 * Mirrors the SQLite index commands: list indexes through the
 * duckdb_indexes() table function and drop indexes by name. Index creation
 * for DuckDB is covered by the shared netezza.createIndex command.
 */

import * as vscode from 'vscode';
import { runQuery } from '../../core/queryRunner';
import { formatIdentifierForSql } from '../../utils/identifierUtils';
import type { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getFullName, getItemObjectName, requireConnection, executeWithProgress, isValidIdentifier } from './helpers';

async function resolveDuckdbTable(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData | undefined
): Promise<{ connectionName: string; schema: string; table: string } | undefined> {
    if (!item || !item.label || !item.dbName || item.objType !== 'TABLE') {
        vscode.window.showErrorMessage('Select a DuckDB table.');
        return undefined;
    }
    const connectionName = deps.connectionManager.resolveConnectionName(undefined, item.connectionName);
    if (!connectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect first.');
        return undefined;
    }
    if (deps.connectionManager.getConnectionDatabaseKind(connectionName) !== 'duckdb') {
        vscode.window.showErrorMessage('This action is only available for DuckDB connections.');
        return undefined;
    }
    return { connectionName, schema: item.schema || 'main', table: getItemObjectName(item) };
}

export function registerDuckdbCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.duckdb.listIndexes', async (item: SchemaItemData) => {
            const selection = await resolveDuckdbTable(deps, item);
            if (!selection) {
                return;
            }
            const schemaLiteral = selection.schema.replace(/'/g, "''");
            const tableLiteral = selection.table.replace(/'/g, "''");
            const sql = `SELECT index_name AS NAME, sql AS DEFINITION FROM duckdb_indexes() WHERE schema_name = '${schemaLiteral}' AND table_name = '${tableLiteral}' ORDER BY index_name;`;
            const doc = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: `-- DuckDB: List Indexes for ${selection.table}\n${sql}`
            });
            await vscode.window.showTextDocument(doc, { preview: false });
            deps.connectionManager.setDocumentConnection(doc.uri.toString(), selection.connectionName);
            if (item.dbName) {
                await deps.connectionManager.setDocumentDatabase(doc.uri.toString(), item.dbName);
            }
            await vscode.commands.executeCommand('netezza.runQuery');
        }),

        vscode.commands.registerCommand('netezza.duckdb.dropIndex', async (item: SchemaItemData) => {
            const selection = await resolveDuckdbTable(deps, item);
            if (!selection) {
                return;
            }
            const indexName = await vscode.window.showInputBox({
                prompt: 'Enter the DuckDB index name to drop',
                validateInput: value => (value && isValidIdentifier(value.trim()) ? null : 'Enter a valid index name.')
            });
            if (!indexName) {
                return;
            }
            const indexPath = selection.schema
                ? `${formatIdentifierForSql(selection.schema, 'duckdb')}.${formatIdentifierForSql(indexName.trim(), 'duckdb')}`
                : formatIdentifierForSql(indexName.trim(), 'duckdb');
            const sql = `DROP INDEX ${indexPath};`;
            const confirmation = await vscode.window.showWarningMessage(
                `Drop index "${indexPath}" from table "${getFullName(item, deps.connectionManager)}"?\n\n${sql}`,
                { modal: true },
                'Yes, drop',
                'Cancel'
            );
            if (confirmation !== 'Yes, drop') {
                return;
            }
            if (!await requireConnection(deps.connectionManager)) {
                return;
            }
            try {
                await executeWithProgress(`Dropping index ${indexName.trim()}...`, async () => {
                    await runQuery(deps.context, sql, true, selection.connectionName, deps.connectionManager);
                });
                vscode.window.showInformationMessage(`Index dropped: ${indexName.trim()}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Error dropping index: ${error instanceof Error ? error.message : String(error)}`);
            }
        }),
    ];
}

import * as vscode from 'vscode';
import type { DatabaseKind } from '../../contracts/database';
import type { SchemaCommandsDependencies, SchemaItemData } from './types';
import { getItemObjectName } from './helpers';
import {
    columnIdentifierSql,
    filterColumnByValueSql,
    profileColumnSql,
    qualifiedColumnSql,
    selectDistinctColumnSql,
    sortColumnSql,
    type MenuObjectRef,
} from './menuSql';

interface ColumnCommandContext {
    column: string;
    table: MenuObjectRef;
    databaseKind: DatabaseKind | undefined;
}

function resolveColumnContext(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData | undefined,
): ColumnCommandContext | undefined {
    if (!item?.parentName?.trim()) {
        return undefined;
    }
    const column = getItemObjectName(item).trim();
    if (!column) {
        return undefined;
    }
    return {
        column,
        table: {
            database: item.dbName,
            schema: item.schema,
            name: item.parentName.trim(),
        },
        databaseKind: deps.connectionManager.getConnectionDatabaseKind?.(item.connectionName),
    };
}

async function openSqlInEditor(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData,
    sql: string,
): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
        content: sql,
        language: 'sql',
    });
    if (item.connectionName) {
        deps.connectionManager.setDocumentConnection(document.uri.toString(), item.connectionName);
        if (item.dbName) {
            await deps.connectionManager.setDocumentDatabase(document.uri.toString(), item.dbName);
        }
    }
    await vscode.window.showTextDocument(document);
}

async function insertIntoActiveEditor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('Open a SQL editor before adding a column to SELECT.');
        return;
    }
    const position = editor.selection.active;
    const inserted = await editor.edit(editBuilder => {
        editBuilder.insert(position, text);
    });
    if (!inserted) {
        return;
    }
    const end = position.translate(0, text.length);
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end));
}

function requireColumnContext(
    deps: SchemaCommandsDependencies,
    item: SchemaItemData | undefined,
): ColumnCommandContext | undefined {
    const context = resolveColumnContext(deps, item);
    if (!context) {
        vscode.window.showWarningMessage('This action is only available for table or view columns.');
    }
    return context;
}

/** Column-level actions shared by table and view nodes in the schema tree. */
export function registerColumnCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('netezza.copyColumnName', (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context) return;
            void vscode.env.clipboard.writeText(context.column);
            vscode.window.showInformationMessage('Copied column name to clipboard');
        }),

        vscode.commands.registerCommand('netezza.copyQualifiedColumnName', (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context) return;
            const qualified = qualifiedColumnSql(
                context.databaseKind,
                context.table,
                context.column,
            );
            void vscode.env.clipboard.writeText(qualified);
            vscode.window.showInformationMessage('Copied qualified column name to clipboard');
        }),

        vscode.commands.registerCommand('netezza.addColumnToSelect', async (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context) return;
            await insertIntoActiveEditor(
                columnIdentifierSql(context.databaseKind, context.column),
            );
        }),

        vscode.commands.registerCommand('netezza.filterColumnByValue', async (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context || !item) return;
            const value = await vscode.window.showInputBox({
                prompt: `Filter ${context.table.name}.${context.column} by value`,
                placeHolder: 'Value to match (use NULL for IS NULL)',
            });
            if (value === undefined) return;
            await openSqlInEditor(
                deps,
                item,
                filterColumnByValueSql(
                    context.databaseKind,
                    context.table,
                    context.column,
                    value,
                ),
            );
        }),

        vscode.commands.registerCommand('netezza.sortColumnAscending', async (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context || !item) return;
            await openSqlInEditor(
                deps,
                item,
                sortColumnSql(context.databaseKind, context.table, context.column, false),
            );
        }),

        vscode.commands.registerCommand('netezza.sortColumnDescending', async (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context || !item) return;
            await openSqlInEditor(
                deps,
                item,
                sortColumnSql(context.databaseKind, context.table, context.column, true),
            );
        }),

        vscode.commands.registerCommand('netezza.selectDistinctColumn', async (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context || !item) return;
            await openSqlInEditor(
                deps,
                item,
                selectDistinctColumnSql(context.databaseKind, context.table, context.column),
            );
        }),

        vscode.commands.registerCommand('netezza.profileColumn', async (item: SchemaItemData) => {
            const context = requireColumnContext(deps, item);
            if (!context || !item) return;
            await openSqlInEditor(
                deps,
                item,
                profileColumnSql(
                    context.databaseKind,
                    context.table,
                    context.column,
                    item.dataType,
                ),
            );
        }),

        vscode.commands.registerCommand('netezza.toggleColumnFavorite', async (item: SchemaItemData) => {
            const context = resolveColumnContext(deps, item);
            if (!context || !item) {
                vscode.window.showWarningMessage('This action is only available for table or view columns.');
                return;
            }
            const { SchemaItem } = await import('../../providers/schemaProvider');
            const parent = new SchemaItem(
                context.table.name,
                vscode.TreeItemCollapsibleState.None,
                `netezza:${item.objType || 'TABLE'}`,
                item.dbName,
                item.objType || 'TABLE',
                item.schema,
                undefined,
                undefined,
                item.connectionName,
            );
            const { FavoritesManager } = await import('../../core/favoritesManager');
            const favoritesManager = FavoritesManager.getInstance(deps.context);
            const isNowFavorite = await favoritesManager.toggleFavorite(parent);
            vscode.window.showInformationMessage(
                isNowFavorite
                    ? `Added ${context.table.name} to Favorites`
                    : `Removed ${context.table.name} from Favorites`,
            );
        }),
    ];
}

/**
 * Schema Commands - Go to Database Object (QuickPick)
 */

import * as vscode from 'vscode';
import type { SchemaSearchResultItem } from '../../contracts/webviews/schemaSearchContracts';
import { SchemaObjectSearchService } from '../../services/schemaObjectSearchService';
import { SchemaRecentObjectsService } from '../../services/schemaRecentObjects';
import {
    buildQualifiedSearchObjectName,
    buildSchemaObjectPreview,
} from '../../services/schemaObjectPreview';
import { formatIdentifierForSql } from '../../utils/identifierUtils';
import { SchemaCommandsDependencies } from './types';

interface GoToObjectQuickPickItem extends vscode.QuickPickItem {
    result: SchemaSearchResultItem;
    isRecent?: boolean;
}

function resultLabel(item: SchemaSearchResultItem): string {
    if (item.TYPE === 'COLUMN' && item.PARENT) {
        return `${item.PARENT}.${item.NAME}`;
    }
    return item.NAME;
}

function resultDescription(item: SchemaSearchResultItem): string {
    const parts = [item.TYPE, item.DATABASE, item.SCHEMA].filter(Boolean);
    if (item.MATCH_TYPE && item.MATCH_TYPE !== 'NAME' && item.MATCH_TYPE !== 'RECENT') {
        parts.push(item.MATCH_TYPE);
    }
    if (item.DESCRIPTION && item.DESCRIPTION !== 'Result from Cache' && item.DESCRIPTION !== 'Recent object') {
        parts.push(item.DESCRIPTION);
    }
    return parts.join(' · ');
}

function toQuickPickItem(item: SchemaSearchResultItem, isRecent = false): GoToObjectQuickPickItem {
    return {
        label: isRecent ? `$(history) ${resultLabel(item)}` : resultLabel(item),
        description: resultDescription(item),
        detail: item.DESCRIPTION === 'Result from Cache' ? 'Cached result' : undefined,
        result: item,
        isRecent,
    };
}

function mergeSearchResults(
    primary: SchemaSearchResultItem[],
    secondary: SchemaSearchResultItem[],
    service: SchemaObjectSearchService,
): SchemaSearchResultItem[] {
    const merged = [...primary];
    const seen = new Set(
        primary
            .map((item) => service.buildResultDedupKey(item, item.TYPE))
            .filter((key): key is string => Boolean(key)),
    );

    for (const item of secondary) {
        const key = service.buildResultDedupKey(item, item.TYPE);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        merged.push(item);
    }

    return merged;
}

export function registerGoToObjectCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const searchService = new SchemaObjectSearchService(
        deps.context,
        deps.metadataCache,
        deps.connectionManager,
    );
    const recentObjects = new SchemaRecentObjectsService(deps.context);

    return [
        vscode.commands.registerCommand('netezza.schema.goToObject', async () => {
            const connectionName = await searchService.resolveSearchConnectionOrNotify();
            if (!connectionName) {
                return;
            }

            const quickPick = vscode.window.createQuickPick<GoToObjectQuickPickItem>();
            quickPick.title = 'Go to Database Object';
            quickPick.placeholder = 'Search tables, columns, views by name, type, or comment…';
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.ignoreFocusOut = true;

            let searchGeneration = 0;

            const updatePreview = (item: GoToObjectQuickPickItem | undefined) => {
                if (!item) {
                    return;
                }

                const databaseKind = deps.connectionManager.getConnectionDatabaseKind(item.result.connectionName || connectionName);
                const preview = buildSchemaObjectPreview(deps.metadataCache, item.result, {
                    connectionName: item.result.connectionName || connectionName,
                    databaseKind,
                });
                const detail =
                    preview
                    ?? (item.result.DESCRIPTION === 'Result from Cache' ? 'Cached result' : undefined);
                quickPick.items = quickPick.items.map((entry) =>
                    entry.result === item.result ? { ...entry, detail } : entry,
                );
            };

            const showRecents = () => {
                const recents = recentObjects
                    .getRecents(connectionName)
                    .map((entry) => toQuickPickItem(recentObjects.toSearchResultItem(entry), true));
                quickPick.items = recents;
                updatePreview(recents[0]);
            };

            showRecents();

            quickPick.onDidChangeActive((items) => {
                updatePreview(items[0]);
            });

            quickPick.onDidChangeValue(async (value) => {
                const term = value.trim();
                if (term.length < 2) {
                    showRecents();
                    return;
                }

                const generation = ++searchGeneration;
                const cacheResults = searchService.searchCacheResults(term, connectionName, undefined, connectionName);
                quickPick.items = cacheResults.map((item) => toQuickPickItem(item));
                updatePreview(quickPick.items[0]);

                searchService.maybeTriggerPrefetch(connectionName);

                const databaseResults = await searchService.searchDatabase(term, connectionName, {
                    isCancelled: () => generation !== searchGeneration,
                });

                if (generation !== searchGeneration) {
                    return;
                }

                const merged = mergeSearchResults(cacheResults, databaseResults, searchService);
                quickPick.items = merged.map((item) => toQuickPickItem(item));
                updatePreview(quickPick.items[0]);
            });

            const accepted = await new Promise<GoToObjectQuickPickItem | undefined>((resolve) => {
                quickPick.onDidAccept(() => {
                    resolve(quickPick.activeItems[0] ?? quickPick.selectedItems[0]);
                });
                quickPick.onDidHide(() => resolve(undefined));
                quickPick.show();
            });

            quickPick.dispose();
            if (!accepted) {
                return;
            }

            const result = accepted.result;
            recentObjects.addFromSearchResult(result, connectionName);

            const action = await vscode.window.showQuickPick(
                [
                    { label: 'Reveal in Schema Explorer', value: 'reveal' },
                    { label: 'Insert qualified name', value: 'insert' },
                    { label: 'View Data', value: 'viewData' },
                ],
                { placeHolder: `Action for ${resultLabel(result)}` },
            );

            if (!action) {
                return;
            }

            if (action.value === 'reveal') {
                await vscode.commands.executeCommand('netezza.revealInSchema', {
                    database: result.DATABASE,
                    schema: result.SCHEMA,
                    name: result.NAME,
                    objType: result.TYPE,
                    parent: result.PARENT,
                    connectionName: result.connectionName || connectionName,
                });
                return;
            }

            if (action.value === 'viewData') {
                const tableTypes = new Set(['TABLE', 'VIEW', 'EXTERNAL TABLE', 'SYNONYM']);
                const objectType = result.TYPE === 'COLUMN' ? 'TABLE' : result.TYPE;
                const objectName = result.TYPE === 'COLUMN' ? result.PARENT : result.NAME;
                if (!tableTypes.has(result.TYPE) && result.TYPE !== 'COLUMN') {
                    vscode.window.showInformationMessage('View Data is available for tables and views only.');
                    return;
                }

                await vscode.commands.executeCommand('netezza.viewData', {
                    label: objectName,
                    rawLabel: objectName,
                    dbName: result.DATABASE,
                    schema: result.SCHEMA,
                    objType: objectType,
                    connectionName: result.connectionName || connectionName,
                    contextValue: `netezza:${objectType}`,
                });
                return;
            }

            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No active text editor to insert into.');
                return;
            }

            const databaseKind = deps.connectionManager.getConnectionDatabaseKind(result.connectionName || connectionName);
            const qualifiedName = buildQualifiedSearchObjectName(result, databaseKind);
            const insertText =
                result.TYPE === 'COLUMN'
                    ? formatIdentifierForSql(result.NAME, databaseKind)
                    : qualifiedName;

            await editor.edit((editBuilder) => {
                editBuilder.insert(editor.selection.active, insertText);
            });
        }),
    ];
}

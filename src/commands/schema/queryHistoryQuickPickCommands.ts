/**
 * Schema Commands - Query History QuickPick (keyboard-first reverse search)
 * Command: netezza.searchQueryHistory
 *
 * Reuses QueryHistoryManager storage (active + archive). Enter inserts the
 * SQL at the cursor and never executes it. Macro variables go through the
 * existing resolveQueryVariables flow.
 */

import * as vscode from 'vscode';
import type { QueryHistoryEntry } from '../../core/history/types';
import { isSqlAuthoringLanguageId } from '../../utils/sqlLanguage';
import {
    QUERY_HISTORY_QUICK_PICK_DEBOUNCE_MS,
    QUERY_HISTORY_QUICK_PICK_LIMIT,
    mergeHistorySearchResults,
    rankHistoryEntries,
    toHistoryQuickPickDescription,
    toHistoryQuickPickDetail,
    toHistoryQuickPickLabel,
} from '../../utils/queryHistoryQuickPick';
import { resolveQueryVariables } from '../../core/variableResolver';
import { SchemaCommandsDependencies } from './types';

interface HistoryQuickPickItem extends vscode.QuickPickItem {
    entryId: string;
    entry: QueryHistoryEntry;
}

function toQuickPickItem(entry: QueryHistoryEntry): HistoryQuickPickItem {
    return {
        label: toHistoryQuickPickLabel(entry),
        description: toHistoryQuickPickDescription(entry),
        detail: toHistoryQuickPickDetail(entry),
        entryId: entry.id,
        entry,
    };
}

async function insertResolvedSql(resolvedSql: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit((editBuilder) => {
            editBuilder.insert(editor.selection.active, resolvedSql);
        });
        return;
    }
    const doc = await vscode.workspace.openTextDocument({
        content: resolvedSql,
        language: 'sql',
    });
    await vscode.window.showTextDocument(doc);
}

export function registerQueryHistoryQuickPickCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context } = deps;

    return [
        vscode.commands.registerCommand('netezza.searchQueryHistory', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
                vscode.window.showWarningMessage('Search Query History is only available for SQL files.');
                return;
            }

            const { QueryHistoryManager } = await import('../../core/queryHistoryManager');
            const historyManager = QueryHistoryManager.getInstance(context);

            const quickPick = vscode.window.createQuickPick<HistoryQuickPickItem>();
            quickPick.title = 'Search Query History';
            quickPick.placeholder = 'Search query history — e.g. customer orders…';
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.ignoreFocusOut = true;

            let searchGeneration = 0;
            let debounceTimer: ReturnType<typeof setTimeout> | undefined;

            const clearDebounce = (): void => {
                if (debounceTimer !== undefined) {
                    clearTimeout(debounceTimer);
                    debounceTimer = undefined;
                }
            };

            const showRecents = (entries: QueryHistoryEntry[]): void => {
                quickPick.items = rankHistoryEntries(entries).map(toQuickPickItem);
            };

            const runSearch = async (term: string, generation: number): Promise<void> => {
                try {
                    const [active, archive] = await Promise.all([
                        historyManager.filterEntries({ searchTerm: term }),
                        historyManager.searchArchive(term),
                    ]);
                    if (generation !== searchGeneration) {
                        return;
                    }
                    quickPick.items = rankHistoryEntries(
                        mergeHistorySearchResults(active, archive),
                    ).map(toQuickPickItem);
                } catch (error) {
                    if (generation !== searchGeneration) {
                        return;
                    }
                    const message = error instanceof Error ? error.message : String(error);
                    quickPick.items = [];
                    quickPick.placeholder = `History search failed: ${message}`;
                } finally {
                    if (generation === searchGeneration) {
                        quickPick.busy = false;
                    }
                }
            };

            quickPick.onDidChangeActive((items) => {
                const active = items[0];
                if (!active) {
                    return;
                }
                const fullDetail = toHistoryQuickPickDetail(active.entry);
                if (active.detail !== fullDetail) {
                    quickPick.items = quickPick.items.map((item) =>
                        item.entryId === active.entryId ? { ...item, detail: fullDetail } : item,
                    );
                }
            });

            quickPick.onDidChangeValue((value) => {
                clearDebounce();
                const term = value.trim();
                if (term.length === 0) {
                    quickPick.busy = true;
                    const generation = ++searchGeneration;
                    void historyManager
                        .getHistory(QUERY_HISTORY_QUICK_PICK_LIMIT, 0)
                        .then((entries) => {
                            if (generation === searchGeneration) {
                                showRecents(entries);
                            }
                        })
                        .finally(() => {
                            if (generation === searchGeneration) {
                                quickPick.busy = false;
                            }
                        });
                    return;
                }

                quickPick.busy = true;
                const generation = ++searchGeneration;
                debounceTimer = setTimeout(() => {
                    debounceTimer = undefined;
                    void runSearch(term, generation);
                }, QUERY_HISTORY_QUICK_PICK_DEBOUNCE_MS);
            });

            quickPick.busy = true;
            let initialEntries: QueryHistoryEntry[] = [];
            try {
                initialEntries = await historyManager.getHistory(QUERY_HISTORY_QUICK_PICK_LIMIT, 0);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                quickPick.placeholder = `History unavailable: ${message}`;
            }
            showRecents(initialEntries);
            quickPick.busy = false;

            const accepted = await new Promise<HistoryQuickPickItem | undefined>((resolve) => {
                quickPick.onDidAccept(() => {
                    resolve(quickPick.activeItems[0] ?? quickPick.selectedItems[0]);
                });
                quickPick.onDidHide(() => resolve(undefined));
                quickPick.show();
            });

            clearDebounce();
            quickPick.dispose();
            if (!accepted) {
                return;
            }

            const entry = await historyManager.getEntryById(accepted.entryId);
            if (!entry) {
                vscode.window.showErrorMessage('Selected query history entry is no longer available.');
                return;
            }

            let resolvedSql: string;
            try {
                resolvedSql = await resolveQueryVariables(entry.query, false, context);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                if (message === 'Variable input cancelled by user') {
                    return;
                }
                vscode.window.showErrorMessage(`Failed to resolve query parameters: ${message}`);
                return;
            }

            await insertResolvedSql(resolvedSql);
        }),
    ];
}

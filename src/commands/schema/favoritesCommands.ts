/**
 * Schema Commands - Favorites Commands
 * Commands: toggle favorites, folders, notes, Copilot include flags
 */

import * as vscode from 'vscode';
import { SchemaItem } from '../../providers/schemaProvider';
import { getLogger } from '../../utils/logger';
import { createPerformanceTimer, formatPerformanceEvent } from '../../services/perf/performanceEvents';
import { SchemaCommandsDependencies } from './types';

function resolveLogger() {
    try {
        return getLogger();
    } catch {
        return undefined;
    }
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function registerFavoritesCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    const { context } = deps;
    const logger = resolveLogger();

    const emitFavoritesTelemetry = (
        operation: string,
        result: 'ok' | 'error' | 'cancelled',
        options?: { errorCode?: string; metadata?: Record<string, string | number | boolean | null> }
    ): void => {
        const event = createPerformanceTimer(operation).finish({
            result,
            errorCode: options?.errorCode,
            metadata: options?.metadata
        });
        console.log(formatPerformanceEvent(event));
    };

    const handleFavoritesError = (operation: string, code: string, action: string, error: unknown): void => {
        const detail = toErrorMessage(error);
        logger?.error(`[${code}] ${action}`, error);
        emitFavoritesTelemetry(operation, 'error', {
            errorCode: code,
            metadata: {
                action
            }
        });
        vscode.window.showErrorMessage(`${action} (${code}): ${detail}`);
    };

    return [
        vscode.commands.registerCommand('netezza.toggleSchemaFavorite', async (item: SchemaItem) => {
            try {
                if (!item) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const favoritesManager = FavoritesManager.getInstance(context);
                const isNowFavorite = await favoritesManager.toggleFavorite(item);
                vscode.window.showInformationMessage(
                    isNowFavorite
                        ? `Added ${item.label} to Favorites`
                        : `Removed ${item.label} from Favorites`
                );
            } catch (error) {
                handleFavoritesError('schema.favorite.toggle', 'CQ01-FAV-001', 'Failed to toggle favorite', error);
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.addFolder', async (item?: SchemaItem) => {
            try {
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                const folderName = await vscode.window.showInputBox({
                    prompt: 'Enter folder name',
                    placeHolder: 'My Folder'
                });

                if (folderName) {
                    const parentId = item?.contextValue === 'favoritesFolder' ? item.id : undefined;
                    await manager.addFolder(folderName, parentId);
                }
            } catch (error) {
                handleFavoritesError('schema.favorite.add_folder', 'CQ01-FAV-002', 'Failed to add favorites folder', error);
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.editNote', async (item: SchemaItem) => {
            try {
                if (!item || !item.id) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                const existingFav = manager.getFavoriteById(item.id);
                const currentNote = existingFav?.customNote || '';

                const newNote = await vscode.window.showInputBox({
                    prompt: `Enter note for ${item.label}`,
                    value: currentNote,
                    placeHolder: 'Brief description or warning'
                });

                if (newNote !== undefined) {
                    await manager.updateNote(item.id, newNote);
                }
            } catch (error) {
                handleFavoritesError('schema.favorite.edit_note', 'CQ01-FAV-003', 'Failed to update favorite note', error);
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.moveToFolder', async (item: SchemaItem) => {
            try {
                if (!item || !item.id) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                const allFavs = await manager.getFavorites();
                // Find all folders except the current item itself (cannot move a folder into itself)
                const folders = allFavs.filter(f => f.type === 'folder' && f.id !== item.id);

                const quickPickItems: vscode.QuickPickItem[] = [
                    { label: '$(star-full) (Root)', description: 'Move to top level Favorites' },
                    ...folders.map(f => ({
                        label: `$(folder) ${f.label}`,
                        description: f.customNote || '',
                        id: f.id
                    }))
                ];

                const selected = await vscode.window.showQuickPick(quickPickItems, {
                    placeHolder: `Move "${item.label}" to...`
                });

                if (selected) {
                    // If it's Root, id is undefined
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const targetId = (selected as any).id as string | undefined;
                    await manager.moveItem(item.id, targetId);
                }
            } catch (error) {
                handleFavoritesError('schema.favorite.move_to_folder', 'CQ01-FAV-004', 'Failed to move favorite to folder', error);
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.delete', async (item: SchemaItem) => {
            try {
                if (!item || !item.id) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                await manager.removeFavoriteById(item.id);
            } catch (error) {
                handleFavoritesError('schema.favorite.delete', 'CQ01-FAV-005', 'Failed to delete favorite', error);
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.addSqlSnippet', async () => {
            try {
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;

                let sql = editor.document.getText(editor.selection);
                if (!sql) sql = editor.document.getText();
                if (!sql.trim()) return;

                const label = await vscode.window.showInputBox({
                    prompt: 'Enter a name for this SQL snippet',
                    placeHolder: 'e.g. Find Active Users'
                });

                if (label) {
                    const { FavoritesManager } = await import('../../core/favoritesManager');
                    const manager = FavoritesManager.getInstance(context);
                    await manager.addSqlSnippet(label, sql);
                    vscode.window.showInformationMessage(`Saved snippet "${label}" to Favorites`);
                }
            } catch (error) {
                handleFavoritesError('schema.favorite.add_sql_snippet', 'CQ01-FAV-006', 'Failed to add SQL snippet to favorites', error);
            }
        }),

        // ========== Copilot Integration Commands ==========
        vscode.commands.registerCommand('netezza.favorites.toggleCopilotAutoInclude', async (item: SchemaItem) => {
            try {
                if (!item || !item.id) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                const existingFav = manager.getFavoriteById(item.id);
                if (!existingFav) {
                    logger?.warn('[CQ01-FAV-007] Favorite not found while toggling Copilot auto-include', { favoriteId: item.id });
                    emitFavoritesTelemetry('schema.favorite.toggle_copilot_auto_include', 'cancelled', {
                        errorCode: 'CQ01-FAV-007',
                        metadata: { favorite_id: item.id }
                    });
                    vscode.window.showWarningMessage('Favorite not found');
                    return;
                }

                const newAutoInclude = existingFav.autoInclude !== false ? false : true;
                await manager.setCopilotSettings(item.id, { autoInclude: newAutoInclude });
                vscode.window.showInformationMessage(
                    `Copilot auto-include ${newAutoInclude ? 'enabled' : 'disabled'} for ${item.label}`
                );
            } catch (error) {
                handleFavoritesError(
                    'schema.favorite.toggle_copilot_auto_include',
                    'CQ01-FAV-008',
                    'Failed to toggle Copilot auto-include for favorite',
                    error
                );
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.toggleCopilotEnabled', async (item: SchemaItem) => {
            try {
                if (!item || !item.id) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                const existingFav = manager.getFavoriteById(item.id);
                if (!existingFav) {
                    logger?.warn('[CQ01-FAV-009] Favorite not found while toggling Copilot context', { favoriteId: item.id });
                    emitFavoritesTelemetry('schema.favorite.toggle_copilot_enabled', 'cancelled', {
                        errorCode: 'CQ01-FAV-009',
                        metadata: { favorite_id: item.id }
                    });
                    vscode.window.showWarningMessage('Favorite not found');
                    return;
                }

                const newEnabled = existingFav.enabled !== false ? false : true;
                await manager.setCopilotSettings(item.id, { enabled: newEnabled });
                vscode.window.showInformationMessage(
                    `Copilot context ${newEnabled ? 'enabled' : 'disabled'} for ${item.label}`
                );
            } catch (error) {
                handleFavoritesError(
                    'schema.favorite.toggle_copilot_enabled',
                    'CQ01-FAV-010',
                    'Failed to toggle Copilot context for favorite',
                    error
                );
            }
        }),

        vscode.commands.registerCommand('netezza.favorites.includeNow', async (item: SchemaItem) => {
            try {
                if (!item || !item.id) return;
                const { FavoritesManager } = await import('../../core/favoritesManager');
                const manager = FavoritesManager.getInstance(context);

                const success = await manager.includeNow(item.id);
                if (success) {
                    vscode.window.showInformationMessage(
                        `${item.label} will be included in the next Copilot request`
                    );
                } else {
                    logger?.warn('[CQ01-FAV-011] includeNow returned false', { favoriteId: item.id });
                    emitFavoritesTelemetry('schema.favorite.include_now', 'cancelled', {
                        errorCode: 'CQ01-FAV-011',
                        metadata: { favorite_id: item.id }
                    });
                    vscode.window.showWarningMessage('Failed to include favorite');
                }
            } catch (error) {
                handleFavoritesError(
                    'schema.favorite.include_now',
                    'CQ01-FAV-012',
                    'Failed to include favorite for next Copilot request',
                    error
                );
            }
        })
    ];
}

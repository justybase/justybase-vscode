/**
 * Schema Commands - Utility Commands (Aggregator)
 *
 * Split into focused modules:
 * - revealCommands.ts
 * - historyCommands.ts
 * - favoritesCommands.ts
 * - editorInsertCommands.ts
 */

import * as vscode from 'vscode';
import { SchemaCommandsDependencies } from './types';
import { registerCatalogDdlCommands } from './catalogDdlCommands';
import { registerRevealCommands } from './revealCommands';
import { registerHistoryCommands } from './historyCommands';
import { registerFavoritesCommands } from './favoritesCommands';
import { registerEditorInsertCommands } from './editorInsertCommands';
import { registerFilterCommands } from './filterCommands';
import { registerGoToObjectCommands } from './goToObjectCommands';
import { registerRefreshMetadataCommands } from './refreshMetadataCommands';

/**
 * Register utility commands.
 *
 * This function is kept as the compatibility entry point used by schema aggregation
 * and existing tests/imports.
 */
export function registerUtilityCommands(deps: SchemaCommandsDependencies): vscode.Disposable[] {
    return [
        ...registerCatalogDdlCommands(deps),
        ...registerRevealCommands(deps),
        ...registerHistoryCommands(deps),
        ...registerFavoritesCommands(deps),
        ...registerEditorInsertCommands(deps),
        ...registerFilterCommands(deps),
        ...registerGoToObjectCommands(deps),
        ...registerRefreshMetadataCommands(deps),
    ];
}

import * as path from 'path';
import * as vscode from 'vscode';
import type { ConnectionDetails } from '@justybase/contracts';
import type { ConnectionManager } from '../core/connectionManager';
import type { MetadataCache } from '../metadataCache';
import type { SchemaProvider } from '../providers/schemaProvider';

export const SAVE_ACCESS_FILE_AS_CONNECTION_COMMAND = 'netezza.saveAccessFileAsConnection';

const ACCESS_FILE_EXTENSIONS = new Set(['.mdb', '.accdb']);
const OVERWRITE_ACTION = 'Overwrite';

export interface SaveAccessFileAsConnectionDependencies {
    connectionManager: Pick<ConnectionManager, 'getConnection' | 'saveConnection' | 'setActiveConnection'>;
    metadataCache: Pick<MetadataCache, 'clearConnectionMetadata'>;
    schemaProvider: Pick<SchemaProvider, 'clearConnectionError' | 'refresh'>;
}

export function isAccessDatabasePath(filePath: string | undefined): boolean {
    if (!filePath || filePath.trim().length === 0) {
        return false;
    }
    return ACCESS_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function getAccessConnectionName(filePath: string): string {
    // Normalize both separators so a URI produced on another platform still
    // yields the file name rather than a name containing its parent folders.
    const baseName = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const extension = path.posix.extname(baseName);
    return baseName.slice(0, extension ? -extension.length : undefined);
}

export function registerSaveAccessFileAsConnectionCommand(
    dependencies: SaveAccessFileAsConnectionDependencies,
): vscode.Disposable {
    return vscode.commands.registerCommand(
        SAVE_ACCESS_FILE_AS_CONNECTION_COMMAND,
        async (resourceUri?: vscode.Uri): Promise<void> => {
            const filePath = resourceUri?.fsPath;
            if (!filePath || !isAccessDatabasePath(filePath)) {
                vscode.window.showErrorMessage('Select a Microsoft Access .mdb or .accdb file.');
                return;
            }

            const name = getAccessConnectionName(filePath);
            if (!name) {
                vscode.window.showErrorMessage('The selected Access file has no usable connection name.');
                return;
            }

            try {
                const existing = await dependencies.connectionManager.getConnection(name);
                if (existing) {
                    const confirmation = await vscode.window.showWarningMessage(
                        `A connection named '${name}' already exists. Overwrite it?`,
                        { modal: true },
                        OVERWRITE_ACTION,
                    );
                    if (confirmation !== OVERWRITE_ACTION) {
                        return;
                    }
                }

                const profile: ConnectionDetails = {
                    name,
                    host: '',
                    database: filePath,
                    user: '',
                    // The command intentionally does not prompt for a password.
                    // Keep the existing secret when replacing a profile.
                    password: existing?.password,
                    dbType: 'access',
                };

                await dependencies.connectionManager.saveConnection(profile);
                await dependencies.connectionManager.setActiveConnection(name);
                dependencies.metadataCache.clearConnectionMetadata(name);
                dependencies.schemaProvider.clearConnectionError(name);
                dependencies.schemaProvider.refresh();
                vscode.window.showInformationMessage(`Access connection '${name}' saved and activated.`);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Failed to save Access connection: ${message}`);
            }
        },
    );
}

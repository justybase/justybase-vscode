/**
 * Connection Capsule menu - the QuickPick opened by clicking the capsule.
 * Orchestrates the existing per-tab connection / database / keep-connection
 * flows; it owns no execution logic itself.
 */

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import { createConnectionQuickPickItems } from '../utils/connectionQuickPick';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import {
    SHOW_CONNECTION_CAPSULE_COMMAND,
    collectConnectionCapsuleSnapshot,
    getCapsuleHeaderInfo,
    type ConnectionCapsuleSnapshot,
} from '../services/connectionCapsule';

export type GetCapsuleDatabaseList = (
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    connectionName: string,
    metadataCache?: MetadataCache,
) => Promise<string[]>;

export interface ConnectionCapsuleCommandsContext {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    metadataCache: MetadataCache;
    getDatabaseList: GetCapsuleDatabaseList;
    refreshConnectionCapsule: () => void | Promise<void>;
}

type CapsuleAction = 'change-connection' | 'change-database' | 'toggle-keep' | 'reconnect' | 'connect' | 'manage';

export interface CapsuleMenuItem extends vscode.QuickPickItem {
    action?: CapsuleAction;
}

/**
 * Pure menu layout for the capsule popup, unit-testable without VS Code.
 */
export function buildConnectionCapsuleMenu(snapshot: ConnectionCapsuleSnapshot): CapsuleMenuItem[] {
    const separator = vscode.QuickPickItemKind.Separator;
    const connectionLabel = snapshot.connectionName ?? 'No connection';
    const databaseLabel = snapshot.database ?? 'default';
    const sessionLabel = snapshot.keepOpen ? '$(plug) Persistent · Keep ON' : '$(debug-disconnect) Transient · Keep OFF';
    const statusLabel = snapshot.connected ? '$(circle-filled) Connected' : '$(circle-outline) Not connected';

    return [
        { label: 'Connection', kind: separator },
        {
            label: `$(database) ${connectionLabel}`,
            description: snapshot.isPinned ? 'assigned to this SQL tab' : 'global active connection',
            detail: 'Change connection for this SQL tab',
            action: 'change-connection',
        },
        { label: 'Database', kind: separator },
        {
            label: `$(server) ${databaseLabel}`,
            description: 'change database (will reconnect)',
            detail: 'Change database for this SQL tab',
            action: 'change-database',
        },
        { label: 'Schema', kind: separator },
        {
            // Read-only row: selecting it is a no-op (no action attached).
            label: `$(symbol-namespace) ${snapshot.schema ?? '—'}`,
            description: 'read-only',
        },
        { label: 'Session', kind: separator },
        {
            label: sessionLabel,
            description: snapshot.keepOpen ? 'connection stays open' : 'connection closes after each query',
            detail: 'Click to toggle',
            action: 'toggle-keep',
        },
        {
            // Read-only row: selecting it is a no-op (no action attached).
            label: statusLabel,
            description: snapshot.keepOpen ? undefined : 'enable Keep ON for a persistent session',
        },
        {
            label: '$(refresh) Reconnect...',
            description: 'close and reopen the tab session',
            action: 'reconnect',
        },
        { label: 'Actions', kind: separator },
        { label: '$(plug) Connect...', action: 'connect' },
        { label: '$(gear) Manage connections...', action: 'manage' },
    ];
}

export function registerConnectionCapsuleCommands(ctx: ConnectionCapsuleCommandsContext): vscode.Disposable[] {
    const { context, connectionManager, metadataCache, getDatabaseList, refreshConnectionCapsule } = ctx;

    const refresh = (): void => {
        void refreshConnectionCapsule();
    };

    const pickConnectionForTab = async (documentUri: string): Promise<void> => {
        try {
            const connections = await connectionManager.getConnections();
            if (connections.length === 0) {
                void vscode.window.showWarningMessage('No connections configured. Please connect first.');
                return;
            }

            const currentConnection =
                connectionManager.getDocumentConnection(documentUri) || connectionManager.getActiveConnectionName();
            const selected = await vscode.window.showQuickPick(
                createConnectionQuickPickItems(connections, currentConnection),
                { placeHolder: 'Select connection for this SQL tab' },
            );

            if (selected) {
                await connectionManager.setDocumentConnection(documentUri, selected.name);
                void vscode.window.showInformationMessage(`Connection for this tab set to: ${selected.name}`);
                refresh();
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to select connection: ${msg}`);
        }
    };

    const pickDatabaseForTab = async (documentUri: string): Promise<void> => {
        const connectionName = connectionManager.getConnectionForExecution(documentUri);
        if (!connectionName) {
            void vscode.window.showWarningMessage('No connection selected. Please select a connection first.');
            return;
        }

        try {
            const databases = await getDatabaseList(context, connectionManager, connectionName, metadataCache);
            if (databases.length === 0) {
                void vscode.window.showWarningMessage('No databases found on server.');
                return;
            }

            const currentDatabase = await connectionManager.getEffectiveDatabase(documentUri);
            const selected = await vscode.window.showQuickPick(
                databases.map((db) => ({
                    label: db,
                    description: db === currentDatabase ? '$(check) Currently selected' : '',
                    database: db,
                })),
                { placeHolder: `Select database for this SQL tab (current: ${currentDatabase || 'default'})` },
            );

            if (selected) {
                await connectionManager.setDocumentDatabase(documentUri, selected.database);
                void vscode.window.showInformationMessage(
                    `Database for this tab set to: ${selected.database} (reconnecting...)`,
                );
                refresh();
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to get database list: ${msg}`);
        }
    };

    const toggleKeepForTab = (documentUri: string): void => {
        const newState = connectionManager.toggleDocumentKeepConnectionOpen(documentUri);
        void vscode.window.showInformationMessage(
            newState
                ? 'Keep connection: ENABLED for this tab - connection will remain open after queries'
                : 'Keep connection: DISABLED for this tab - connection will be closed after each query',
        );
        refresh();
    };

    const reconnectTabSession = async (documentUri: string): Promise<void> => {
        const connectionName = connectionManager.getConnectionForExecution(documentUri);
        if (!connectionName) {
            void vscode.window.showWarningMessage('No connection selected. Please select a connection first.');
            return;
        }

        try {
            await connectionManager.closeDocumentPersistentConnection(documentUri);
            if (connectionManager.getDocumentKeepConnectionOpen(documentUri)) {
                await connectionManager.getDocumentPersistentConnection(documentUri);
                void vscode.window.showInformationMessage(`Reconnected: ${connectionName}`);
            } else {
                void vscode.window.showInformationMessage(
                    `Disconnected: ${connectionName} (Keep is OFF — no persistent session to reopen)`,
                );
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to reconnect ${connectionName}: ${msg}`);
        } finally {
            refresh();
        }
    };

    const showCapsule = async (): Promise<void> => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
            void vscode.window.showWarningMessage('This command is only available for SQL files');
            return;
        }

        const documentUri = editor.document.uri.toString();
        const snapshot = await collectConnectionCapsuleSnapshot(connectionManager, documentUri);

        // The snapshot await can outlive an editor switch; never act on a stale tab.
        if (vscode.window.activeTextEditor?.document.uri.toString() !== documentUri) {
            return;
        }

        const header = snapshot.connectionName
            ? getCapsuleHeaderInfo(connectionManager, snapshot.connectionName)
            : undefined;
        const placeHolder = snapshot.connectionName
            ? `${snapshot.connectionName} / ${snapshot.database ?? 'default'}${header ? ` — ${header.dbLabel}` : ''}`
            : 'Connection capsule';
        const selected = await vscode.window.showQuickPick(buildConnectionCapsuleMenu(snapshot), {
            placeHolder,
        });

        if (!selected) {
            return;
        }

        if (!selected.action) {
            // Read-only info row: keep the menu open instead of dismissing it.
            return showCapsule();
        }

        switch (selected.action) {
            case 'change-connection':
                await pickConnectionForTab(documentUri);
                break;
            case 'change-database':
                await pickDatabaseForTab(documentUri);
                break;
            case 'toggle-keep':
                toggleKeepForTab(documentUri);
                break;
            case 'reconnect':
                await reconnectTabSession(documentUri);
                break;
            case 'connect':
            case 'manage':
                await vscode.commands.executeCommand('netezza.openLogin');
                break;
        }
    };

    return [vscode.commands.registerCommand(SHOW_CONNECTION_CAPSULE_COMMAND, showCapsule)];
}

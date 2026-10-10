/**
 * Connection Capsule - a single status bar item on the bottom bar replacing
 * the three separate connection / database / keep-connection items.
 *
 * The capsule always previews the current tab connection (`NZ / JUST_DATA`)
 * and opens the capsule QuickPick menu (`netezza.showConnectionCapsule`) on
 * click. Hovering shows the full card (connection, database, schema, session,
 * status). Schema is display-only; transaction modes and latency are out of
 * scope.
 */

import * as vscode from 'vscode';
import { DATABASE_KIND_DISPLAY_NAMES } from '@justybase/contracts';
import { ConnectionManager } from '../core/connectionManager';
import { formatConnectionTarget } from '../utils/connectionQuickPick';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

export const SHOW_CONNECTION_CAPSULE_COMMAND = 'netezza.showConnectionCapsule';

export interface ConnectionCapsuleSnapshot {
    documentUri: string;
    /** Execution connection for the tab; undefined when nothing is selected. */
    connectionName: string | undefined;
    /** True when the tab-pinned connection no longer exists. */
    isMissing: boolean;
    /** True when the tab pins its own connection or database override. */
    isPinned: boolean;
    database: string | null;
    schema: string | null;
    keepOpen: boolean;
    connected: boolean;
}

export interface CapsuleHeaderInfo {
    dbLabel: string;
    target: string;
    user?: string;
}

export interface CapsulePresentation {
    text: string;
    tooltip: string;
}

function getActiveSqlAuthoringEditor(): vscode.TextEditor | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && isSqlAuthoringLanguageId(editor.document.languageId)) {
        return editor;
    }
    return undefined;
}

/**
 * Collect the capsule state for an explicit document URI. Takes the URI as a
 * parameter (instead of reading the active editor) so the caller can discard
 * stale async completions after an editor switch.
 */
export async function collectConnectionCapsuleSnapshot(
    connectionManager: ConnectionManager,
    documentUri: string,
): Promise<ConnectionCapsuleSnapshot> {
    const connectionName = connectionManager.getConnectionForExecution(documentUri);
    const keepOpen = connectionManager.getDocumentKeepConnectionOpen(documentUri);

    if (!connectionName) {
        return {
            documentUri,
            connectionName: undefined,
            isMissing: false,
            isPinned: false,
            database: null,
            schema: null,
            keepOpen,
            connected: false,
        };
    }

    const effectiveDatabase = await connectionManager.getEffectiveDatabase(documentUri);
    const schema = connectionManager.getEffectiveSchemaSync(documentUri, effectiveDatabase ?? undefined) ?? null;
    const documentConnection = connectionManager.getDocumentConnection?.(documentUri);
    const availability = connectionManager.isConnectionAvailable?.(connectionName);
    const hasDbOverride = connectionManager.getDocumentDatabase(documentUri) !== undefined;
    const connected = typeof connectionManager.hasDocumentPersistentConnection === 'function'
        ? connectionManager.hasDocumentPersistentConnection(documentUri)
        : false;

    return {
        documentUri,
        connectionName,
        isMissing: documentConnection === connectionName && availability === false,
        isPinned: documentConnection === connectionName || hasDbOverride,
        database: effectiveDatabase,
        schema,
        keepOpen,
        connected,
    };
}

/**
 * Synchronous header info for the capsule detail line. Uses cached metadata
 * only so the UI path never forces a Secrets API load.
 */
export function getCapsuleHeaderInfo(
    connectionManager: ConnectionManager,
    connectionName: string,
): CapsuleHeaderInfo | undefined {
    const details = connectionManager.getConnectionMetadata(connectionName);
    if (!details) {
        return undefined;
    }
    const kind = connectionManager.getConnectionDatabaseKind(connectionName);
    const user = details.user?.trim();
    return {
        dbLabel: (kind && DATABASE_KIND_DISPLAY_NAMES[kind]) || kind || 'Database',
        target: formatConnectionTarget(details),
        user: user ? user : undefined,
    };
}

/**
 * Pure presentation mapping, unit-testable without a VS Code item.
 */
export function renderConnectionCapsule(
    snapshot: ConnectionCapsuleSnapshot,
    header?: CapsuleHeaderInfo,
): CapsulePresentation {
    if (!snapshot.connectionName) {
        return {
            text: '$(circle-outline) Select connection',
            tooltip: 'No connection for this SQL tab\nClick to connect or manage connections',
        };
    }

    if (snapshot.isMissing) {
        return {
            text: `$(warning) ${snapshot.connectionName} (missing)`,
            tooltip: `Connection '${snapshot.connectionName}' assigned to this SQL tab is no longer available\nClick to select another connection`,
        };
    }

    const pin = snapshot.isPinned ? '📌 ' : '';
    const dot = snapshot.connected ? '$(circle-filled)' : '$(circle-outline)';
    const db = snapshot.database ?? 'default';
    const session = snapshot.keepOpen ? 'Persistent · Keep ON' : 'Transient · Keep OFF';
    const headerParts = [header?.dbLabel, header?.target, header?.user].filter((part): part is string => !!part);
    const tooltip = [
        `${snapshot.connectionName}${header ? ` — ${[...headerParts].join(' · ')}` : ''}`,
        `Connection: ${snapshot.connectionName}${snapshot.isPinned ? ' (assigned to this SQL tab)' : ' (global active connection)'}`,
        `Database: ${db}`,
        `Schema: ${snapshot.schema ?? '—'}`,
        `Session: ${session}`,
        `Status: ${snapshot.connected ? 'Connected' : 'Not connected'}`,
        'Click to open the connection menu',
    ].join('\n');

    return {
        text: `${pin}${dot} ${snapshot.connectionName} / ${db}`,
        tooltip,
    };
}

/**
 * Create the capsule status bar item on the bottom bar. It stays visible for
 * SQL tabs and previews the current connection; clicking opens the menu.
 */
export function createConnectionCapsule(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
): { statusBarItem: vscode.StatusBarItem; updateFn: () => Promise<void> } {
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = SHOW_CONNECTION_CAPSULE_COMMAND;
    statusBarItem.tooltip = 'Connection capsule — click to open the connection menu';
    context.subscriptions.push(statusBarItem);

    const updateFn = () => updateConnectionCapsule(statusBarItem, connectionManager);

    return { statusBarItem, updateFn };
}

/**
 * Refresh the capsule for the active SQL tab. Hidden outside SQL tabs.
 * Stale async completions after an editor switch are discarded, mirroring
 * the previous database bar guard.
 */
export async function updateConnectionCapsule(
    statusBarItem: vscode.StatusBarItem,
    connectionManager: ConnectionManager,
): Promise<void> {
    const editor = getActiveSqlAuthoringEditor();
    if (!editor) {
        statusBarItem.hide();
        return;
    }

    const documentUri = editor.document.uri.toString();
    let snapshot: ConnectionCapsuleSnapshot;
    try {
        snapshot = await collectConnectionCapsuleSnapshot(connectionManager, documentUri);
    } catch {
        // Keep the last rendered state instead of failing the single
        // refresh funnel with an unhandled rejection.
        return;
    }

    const current = getActiveSqlAuthoringEditor();
    if (!current || current.document.uri.toString() !== documentUri) {
        return;
    }

    const header = snapshot.connectionName
        ? getCapsuleHeaderInfo(connectionManager, snapshot.connectionName)
        : undefined;
    const presentation = renderConnectionCapsule(snapshot, header);

    statusBarItem.text = presentation.text;
    statusBarItem.tooltip = presentation.tooltip;
    statusBarItem.show();
}

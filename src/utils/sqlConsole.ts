import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { QueryHistoryManager } from '../core/queryHistoryManager';
import { normalizeUriKey } from '../core/queryRunnerUtils';
import { SchemaItemData } from '../commands/schema/types';

export const SQL_CONSOLE_HISTORY_TAG = 'console';
export const SQL_CONSOLE_HEADER_PREFIX = '-- SQL Console |';

const WORKSPACE_STATE_KEY = 'sqlConsoleDocuments';

export interface SqlConsoleDocumentMeta {
    connectionName: string;
    database?: string;
    openedAt: number;
}

export interface OpenSqlConsoleOptions {
    connectionName?: string;
    database?: string;
    promptForRecent?: boolean;
}

function readRegistry(context: vscode.ExtensionContext): Record<string, SqlConsoleDocumentMeta> {
    return context.workspaceState.get<Record<string, SqlConsoleDocumentMeta>>(WORKSPACE_STATE_KEY, {});
}

async function writeRegistry(
    context: vscode.ExtensionContext,
    registry: Record<string, SqlConsoleDocumentMeta>,
): Promise<void> {
    await context.workspaceState.update(WORKSPACE_STATE_KEY, registry);
}

export function sanitizeSqlConsoleLabel(value: string): string {
    return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'connection';
}

export function buildSqlConsoleUntitledUri(connectionName: string): vscode.Uri {
    const label = sanitizeSqlConsoleLabel(connectionName);
    return vscode.Uri.parse(`untitled:Console-${label}.sql`);
}

export function buildUniqueSqlConsoleUri(connectionName: string): vscode.Uri {
    const label = sanitizeSqlConsoleLabel(connectionName);
    const baseUri = vscode.Uri.parse(`untitled:Console-${label}.sql`);

    const openUris = new Set(
        vscode.workspace.textDocuments
            .filter((doc) => !doc.isClosed)
            .map((doc) => doc.uri.toString()),
    );

    if (!openUris.has(baseUri.toString())) {
        return baseUri;
    }

    let counter = 2;
    while (true) {
        const candidate = vscode.Uri.parse(`untitled:Console-${label}-${counter}.sql`);
        if (!openUris.has(candidate.toString())) {
            return candidate;
        }
        counter++;
    }
}

export function buildSqlConsoleHeader(connectionName: string, database?: string): string {
    if (database) {
        return `${SQL_CONSOLE_HEADER_PREFIX} ${connectionName} | ${database}\n-- Ephemeral session (not saved to disk)\n\n`;
    }

    return `${SQL_CONSOLE_HEADER_PREFIX} ${connectionName}\n-- Ephemeral session (not saved to disk)\n\n`;
}

export function isSqlConsoleHeader(text: string): boolean {
    return text.startsWith(SQL_CONSOLE_HEADER_PREFIX);
}

export async function registerSqlConsoleDocument(
    context: vscode.ExtensionContext,
    documentUri: string,
    meta: SqlConsoleDocumentMeta,
): Promise<void> {
    const registry = readRegistry(context);
    registry[normalizeUriKey(documentUri)] = meta;
    await writeRegistry(context, registry);
}

export function getSqlConsoleDocumentMeta(
    context: vscode.ExtensionContext,
    documentUri: string,
): SqlConsoleDocumentMeta | undefined {
    return readRegistry(context)[normalizeUriKey(documentUri)];
}

export function isSqlConsoleDocument(
    context: vscode.ExtensionContext,
    documentUri: string,
    documentText?: string,
): boolean {
    if (getSqlConsoleDocumentMeta(context, documentUri)) {
        return true;
    }

    const uri = vscode.Uri.parse(documentUri);
    if (uri.scheme === 'untitled' && uri.path.includes('Console-')) {
        return true;
    }

    if (documentText !== undefined && isSqlConsoleHeader(documentText)) {
        return true;
    }

    return false;
}

export function resolveSqlConsoleContextFromTreeItem(
    item?: SchemaItemData,
): { connectionName?: string; database?: string } {
    if (!item?.connectionName) {
        return {};
    }

    if (item.contextValue === 'database' && item.dbName) {
        return { connectionName: item.connectionName, database: item.dbName };
    }

    return { connectionName: item.connectionName };
}

export async function resolveSqlConsoleConnectionName(
    connectionManager: ConnectionManager,
    preferredName?: string,
): Promise<string | undefined> {
    if (preferredName) {
        return preferredName;
    }

    const active = connectionManager.getActiveConnectionName();
    if (active) {
        return active;
    }

    const connections = await connectionManager.getConnections();
    if (connections.length === 0) {
        return undefined;
    }

    const pick = await vscode.window.showQuickPick(
        connections.map((connection) => connection.name),
        { placeHolder: 'Select connection for SQL Console' },
    );
    return pick ?? undefined;
}

async function promptRecentConsoleQuery(
    context: vscode.ExtensionContext,
    connectionName: string,
    document: vscode.TextDocument,
    header: string,
): Promise<void> {
    const historyManager = QueryHistoryManager.getInstance(context);
    const history = await historyManager.getHistory(100);
    const forConnection = history.filter((entry) => entry.connectionName === connectionName);
    const consoleTagged = forConnection.filter((entry) => entry.tags?.includes(SQL_CONSOLE_HISTORY_TAG));
    const other = forConnection.filter((entry) => !entry.tags?.includes(SQL_CONSOLE_HISTORY_TAG));
    const recent = [...consoleTagged, ...other]
        .slice(0, 5)
        .map((entry) => entry.query.trim())
        .filter((sql) => sql.length > 0);

    if (recent.length === 0) {
        return;
    }

    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(add) New blank query', sql: '' },
            ...recent.map((queryText, index) => ({
                label: `$(history) Recent query ${index + 1}`,
                description: queryText.split('\n')[0]?.slice(0, 80),
                sql: queryText,
            })),
        ],
        {
            placeHolder: `Load recent query for ${connectionName}?`,
            ignoreFocusOut: true,
        },
    );

    if (!pick?.sql) {
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) {
        return;
    }

    await editor.edit((editBuilder) => {
        editBuilder.insert(editor.document.positionAt(header.length), pick.sql);
    });
}

export async function openSqlConsole(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    options: OpenSqlConsoleOptions = {},
): Promise<vscode.TextDocument | undefined> {
    const connectionName = await resolveSqlConsoleConnectionName(
        connectionManager,
        options.connectionName,
    );
    if (!connectionName) {
        vscode.window.showInformationMessage(
            'Connect to a database first, or select a connection for the SQL Console.',
        );
        return undefined;
    }

    const database =
        options.database ?? (await connectionManager.getCurrentDatabase(connectionName)) ?? undefined;
    const header = buildSqlConsoleHeader(connectionName, database);

    const document = await vscode.workspace.openTextDocument(buildUniqueSqlConsoleUri(connectionName));

    const documentUri = document.uri.toString();

    await registerSqlConsoleDocument(context, documentUri, {
        connectionName,
        database,
        openedAt: Date.now(),
    });

    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: vscode.ViewColumn.Active,
    });

    connectionManager.setDocumentConnection(documentUri, connectionName);
    if (database) {
        await connectionManager.setDocumentDatabase(documentUri, database);
    }

    await editor.edit((editBuilder) => {
        editBuilder.insert(document.positionAt(0), header);
    });

    if (options.promptForRecent !== false) {
        await promptRecentConsoleQuery(context, connectionName, document, header);
    }

    return document;
}

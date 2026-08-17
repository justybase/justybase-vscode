import * as vscode from 'vscode';
import * as path from 'path';
import type { DatabaseDialect } from '../contracts/database';
import { ensureBuiltInDialectsRegistered } from '../dialects';
import {
    listRegisteredDatabaseDialects,
    registerDatabaseDialect
} from '../core/factories/databaseDialectRegistry';
import type { ConnectionManager } from '../core/connectionManager';
import type { ConnectionDetails } from '../types';
import { ensurePersistentConnectionReadyForQuery } from '../core/connectionReadiness';

export interface OpenFileSqlSessionOptions {
    /** Optional initial SQL content of the opened document. */
    content?: string;
    /** Save the connection profile under this name (defaults to a generated name). */
    connectionName?: string;
}

export interface OpenFileSqlWorkspaceSessionOptions {
    /** Optional initial SQL content of the opened document. */
    content?: string;
    /** Save the workspace profile under this name. */
    connectionName?: string;
}

export interface SavedConnectionSummary {
    name: string;
    details: Omit<ConnectionDetails, 'password'>;
}

export interface JustyBaseLiteApi {
    readonly version: 1;
    registerDatabaseDialect(dialect: DatabaseDialect): DatabaseDialect;
    listRegisteredDatabaseDialects(): readonly DatabaseDialect[];
    /**
     * Save (or reuse) a connection profile and open a SQL editor bound to it.
     * Used by companion extensions such as DuckDB + Files ("Query file with SQL").
     */
    openFileSqlSession(details: ConnectionDetails, options?: OpenFileSqlSessionOptions): Promise<void>;
    /** Save (or reuse) a read-only File SQL profile containing multiple files. */
    openFileSqlWorkspaceSession(
        filePaths: readonly string[],
        options?: OpenFileSqlWorkspaceSessionOptions,
    ): Promise<void>;
    /** List saved connection profiles without exposing passwords. */
    listSavedConnections(): Promise<readonly SavedConnectionSummary[]>;
    /** Details of the active connection (document-bound first, else active). */
    getActiveConnectionDetails(): Promise<{
        name: string;
        details: ConnectionDetails;
        documentUri?: string;
        documentBound: boolean;
    } | undefined>;
    /** Execute SQL on the active editor's persistent connection. */
    executeActiveConnectionSql(sql: string, documentUri?: string): Promise<void>;
    /**
     * Execute SQL on the active editor's persistent connection and return the
     * full result set. Used by companion extensions for client-side write-back
     * (e.g. XLSB edits through @justybase/spreadsheet-tasks XlsbUpdater).
     */
    executeActiveConnectionSqlQuery?(sql: string, documentUri?: string): Promise<{
        columns: string[];
        rows: unknown[][];
    }>;
}

export function createJustyBaseLiteApi(
    context?: vscode.ExtensionContext,
    connectionManager?: ConnectionManager,
): JustyBaseLiteApi {
    ensureBuiltInDialectsRegistered();

    return {
        version: 1,
        registerDatabaseDialect,
        listRegisteredDatabaseDialects,
        openFileSqlSession: (details, options) =>
            openFileSqlSession(context, connectionManager, details, options),
        openFileSqlWorkspaceSession: (filePaths, options) =>
            openFileSqlWorkspaceSession(context, connectionManager, filePaths, options),
        listSavedConnections: () => listSavedConnections(connectionManager),
        getActiveConnectionDetails: () => getActiveConnectionDetails(connectionManager),
        executeActiveConnectionSql: (sql, documentUri) =>
            executeActiveConnectionSql(connectionManager, sql, documentUri),
        executeActiveConnectionSqlQuery: (sql, documentUri) =>
            executeActiveConnectionSqlQuery(connectionManager, sql, documentUri),
    };
}

async function listSavedConnections(
    connectionManager: ConnectionManager | undefined,
): Promise<readonly SavedConnectionSummary[]> {
    if (!connectionManager) {
        return [];
    }
    const connections = await connectionManager.getConnections();
    return connections.map(connection => ({
        name: connection.name,
        details: { ...connection, password: undefined },
    }));
}

async function getActiveConnectionDetails(
    connectionManager: ConnectionManager | undefined,
): Promise<{
    name: string;
    details: ConnectionDetails;
    documentUri?: string;
    documentBound: boolean;
} | undefined> {
    if (!connectionManager) {
        return undefined;
    }
    const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
    const documentConnection = documentUri
        ? connectionManager.getDocumentConnection(documentUri)
        : undefined;
    const name = documentConnection ?? connectionManager.getConnectionForExecution(undefined);
    if (!name) {
        return undefined;
    }
    const details = await connectionManager.getConnection(name);
    return details ? { name, details, documentUri, documentBound: Boolean(documentConnection) } : undefined;
}

async function executeActiveConnectionSql(
    connectionManager: ConnectionManager | undefined,
    sql: string,
    requestedDocumentUri?: string,
): Promise<void> {
    if (!connectionManager) {
        throw new Error('SQL execution is not available in this context.');
    }
    const documentUri = requestedDocumentUri ?? vscode.window.activeTextEditor?.document.uri.toString();
    if (!documentUri) {
        throw new Error('An active SQL editor is required.');
    }
    const connectionName = connectionManager.getConnectionForExecution(documentUri);
    if (!connectionName) {
        throw new Error('No connection selected for the active SQL editor.');
    }
    await ensurePersistentConnectionReadyForQuery(connectionManager, documentUri, connectionName);
    const connection = await connectionManager.getDocumentPersistentConnection(documentUri, connectionName);
    await connection.createCommand(sql).execute();
}

async function executeActiveConnectionSqlQuery(
    connectionManager: ConnectionManager | undefined,
    sql: string,
    requestedDocumentUri?: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
    if (!connectionManager) {
        throw new Error('SQL execution is not available in this context.');
    }
    const documentUri = requestedDocumentUri ?? vscode.window.activeTextEditor?.document.uri.toString();
    if (!documentUri) {
        throw new Error('An active SQL editor is required.');
    }
    const connectionName = connectionManager.getConnectionForExecution(documentUri);
    if (!connectionName) {
        throw new Error('No connection selected for the active SQL editor.');
    }
    await ensurePersistentConnectionReadyForQuery(connectionManager, documentUri, connectionName);
    const connection = await connectionManager.getDocumentPersistentConnection(documentUri, connectionName);
    const reader = await connection.createCommand(sql).executeReader();
    try {
        const columns: string[] = [];
        for (let index = 0; index < reader.fieldCount; index += 1) {
            columns.push(reader.getName(index));
        }
        const rows: unknown[][] = [];
        while (await reader.read()) {
            const row: unknown[] = [];
            for (let index = 0; index < reader.fieldCount; index += 1) {
                row.push(reader.getValue(index));
            }
            rows.push(row);
        }
        return { columns, rows };
    } finally {
        await reader.close();
    }
}

async function openFileSqlSession(
    context: vscode.ExtensionContext | undefined,
    connectionManager: ConnectionManager | undefined,
    details: ConnectionDetails,
    options: OpenFileSqlSessionOptions = {},
): Promise<void> {
    if (!context || !connectionManager) {
        throw new Error('File SQL session support is not available in this context.');
    }

    const connectionName = options.connectionName?.trim() || details.name?.trim();
    if (!connectionName) {
        throw new Error('A connection name is required to open a File SQL session.');
    }

    const existing = (await connectionManager.getConnections()).find(connection => connection.name === connectionName);
    if (existing && existing.dbType !== 'file') {
        throw new Error(
            `Connection '${connectionName}' already exists and is not a File SQL profile. Choose a different connection name.`,
        );
    }

    const isWorkspaceProfile = details.dbType === 'file' && typeof details.options?.fileWorkspace === 'string';
    const shouldRefreshExistingWorkspace = Boolean(
        existing
        && isWorkspaceProfile
        && typeof existing.options?.fileWorkspace === 'string',
    );
    if (!existing || shouldRefreshExistingWorkspace) {
        await connectionManager.saveConnection({ ...details, name: connectionName });
        // File SQL objects (views + editable table) appear only after the
        // connection is established; drop stale negative metadata so the
        // linter does not report SQL006 for them before the first connect.
        try {
            await vscode.commands.executeCommand('netezza.refreshSchema');
        } catch {
            // Best-effort: the schema refresh command may be unavailable
            // during activation; the linter treats unknown tables as valid.
        }
    }

    const document = await vscode.workspace.openTextDocument({
        language: 'sql',
        content: options.content ?? `-- File SQL: ${connectionName}\n`,
    });
    await vscode.window.showTextDocument(document, { preview: false });
    connectionManager.setDocumentConnection(document.uri.toString(), connectionName);
}

async function openFileSqlWorkspaceSession(
    context: vscode.ExtensionContext | undefined,
    connectionManager: ConnectionManager | undefined,
    filePaths: readonly string[],
    options: OpenFileSqlWorkspaceSessionOptions = {},
): Promise<void> {
    const normalizedFiles = Array.from(
        new Set(
            filePaths
                .map(filePath => filePath.trim())
                .filter(filePath => filePath.length > 0)
                .map(filePath => path.resolve(filePath)),
        ),
    );
    if (normalizedFiles.length === 0) {
        throw new Error('At least one data file is required to open a File SQL workspace.');
    }

    const connectionName = options.connectionName?.trim() || `File SQL Workspace (${normalizedFiles.length} files)`;
    const workspaceOption = JSON.stringify({ version: 1, files: normalizedFiles });
    await openFileSqlSession(
        context,
        connectionManager,
        {
            name: connectionName,
            host: 'local',
            database: normalizedFiles[0],
            user: 'file',
            dbType: 'file',
            options: { fileWorkspace: workspaceOption },
        },
        {
            connectionName,
            content: options.content,
        },
    );
}

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';
import {
    createConnectedDatabaseConnectionFromDetails,
    getRequiredDatabaseDdlProvider,
} from '../core/connectionFactory';
import { parseCatalogDdlQuery, parseCatalogDdlUri } from '../server/catalogNavigation';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import { Logger } from '../utils/logger';

const CATALOG_SCHEME = 'netezza-catalog';

/**
 * Virtual document provider for catalog DDL (F12 → object definition).
 */
export class CatalogDocumentProvider implements vscode.TextDocumentContentProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    public readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly connectionManager: ConnectionManager,
        _metadataCache: MetadataCache,
    ) {}

    public refresh(uri: vscode.Uri): void {
        this._onDidChange.fire(uri);
    }

    public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const parsed =
            uri.scheme === CATALOG_SCHEME && uri.query
                ? parseCatalogDdlQuery(uri.query)
                : parseCatalogDdlUri(uri.toString());
        if (!parsed) {
            return '-- Invalid catalog URI';
        }

        const connectionName =
            (parsed.sourceDocumentUri
                ? this.connectionManager.getConnectionForExecution(parsed.sourceDocumentUri)
                : undefined) ??
            this.connectionManager.getActiveConnectionName();

        if (!connectionName) {
            return '-- No active connection. Connect to a database to load DDL.';
        }

        const connectionDetails = await this.connectionManager.getConnection(connectionName);
        if (!connectionDetails) {
            return `-- Connection "${connectionName}" not found.`;
        }

        const database =
            parsed.database ??
            (parsed.sourceDocumentUri
                ? this.connectionManager.getDocumentDatabase(parsed.sourceDocumentUri)
                : undefined) ??
            (await this.connectionManager.getCurrentDatabase(connectionName)) ??
            undefined;

        if (!database) {
            return '-- No database context. Set a database for this document.';
        }

        const effectiveSchema = parsed.sourceDocumentUri
            ? await this.connectionManager.getEffectiveSchema(parsed.sourceDocumentUri)
            : null;
        const schema =
            parsed.schema ??
            effectiveSchema ??
            (connectionDetails.dbType === 'netezza' ? 'ADMIN' : undefined);

        if (!schema) {
            return '-- No schema context. Qualify the object with a schema or set a default schema on the connection.';
        }

        try {
            const ddlProvider = getRequiredDatabaseDdlProvider(connectionDetails.dbType);
            const connection = await createConnectedDatabaseConnectionFromDetails(
                connectionDetails,
                database,
            );
            if (!connection) {
                return '-- Could not establish database connection.';
            }

            if (parsed.kind === 'table') {
                return await ddlProvider.generateTableDDL(connection, database, schema, parsed.name);
            }
            if (parsed.kind === 'view') {
                return await ddlProvider.generateViewDDL(connection, database, schema, parsed.name);
            }
            return await ddlProvider.generateProcedureDDL(connection, database, schema, parsed.name);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            Logger.getInstance().warn(`CatalogDocumentProvider: ${message}`);
            return `-- Failed to load DDL for ${parsed.kind} ${parsed.name}: ${message}`;
        }
    }
}

export function registerCatalogDocumentProvider(
    context: vscode.ExtensionContext,
    connectionManager: ConnectionManager,
    metadataCache: MetadataCache,
): CatalogDocumentProvider {
    const provider = new CatalogDocumentProvider(connectionManager, metadataCache);
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(CATALOG_SCHEME, provider),
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (
                document.uri.scheme === CATALOG_SCHEME &&
                !isSqlAuthoringLanguageId(document.languageId)
            ) {
                void vscode.languages.setTextDocumentLanguage(document, 'sql');
            }
        }),
    );
    return provider;
}

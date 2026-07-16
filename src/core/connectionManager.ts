import * as path from 'path';
import * as vscode from 'vscode';
import {
    DatabaseCapabilities,
    DatabaseKind,
    NamedConnectionDetails,
    NzConnection,
    type ConnectionDetails as SharedConnectionDetails
} from '../types';
import {
    createDatabaseConnectionFromDetails,
    getDatabaseCapabilities,
    resolveConnectionDatabaseKind
} from './connectionFactory';
import {
    compatibilitySecretKeys,
    compatibilityStateKeys,
    deleteSecretValues,
    getMementoValue,
    getSecretValue,
    storeSecretValue,
    updateMementoValue
} from '../compatibility/state';
import { normalizeConnectionAccentColor } from '../utils/connectionAccent';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import { formatIdentifierForSql } from '../utils/identifierUtils';
import { logWithFallback } from '../utils/logger';
import { normalizeUriKey } from './uriUtils';
import type { MetadataCache } from '../metadataCache';

export type ConnectionDetails = NamedConnectionDetails;

const LEGACY_DB2_OPTION_KEYS = new Set([
    'clientCodepage',
    'security',
    'sslServerCertificate'
]);

const LEGACY_SQLITE_OPTION_KEYS = new Set([
    'mode'
]);

const LEGACY_MSSQL_OPTION_KEYS = new Set([
    'domain',
    'encrypt',
    'trustServerCertificate',
    'requestTimeout'
]);

const LEGACY_ORACLE_OPTION_KEYS = new Set([
    'connectString',
    'configDir'
]);

const LEGACY_POSTGRESQL_OPTION_KEYS = new Set([
    'searchPath',
    'sslMode',
    'statementTimeout'
]);

const LEGACY_PORT_KIND_MAP = new Map<number, DatabaseKind>([
    [50000, 'db2'],
    [1433, 'mssql'],
    [1521, 'oracle'],
    [5432, 'postgresql'],
    [5433, 'vertica'],
    [3306, 'mysql']
]);

const LOCAL_FILE_DIALECT_KINDS = new Set<DatabaseKind>(['sqlite', 'duckdb']);

function isLocalFileDialect(kind: DatabaseKind | undefined): boolean {
    return kind ? LOCAL_FILE_DIALECT_KINDS.has(kind) : false;
}

function isLikelyDuckDbDatabaseName(database: string | undefined): boolean {
    const normalizedDatabase = database?.trim();
    if (!normalizedDatabase) {
        return false;
    }

    return /\.(duckdb|ddb)$/i.test(normalizedDatabase);
}

function getDuckDbCatalogHint(details: SharedConnectionDetails): string {
    const mode = typeof details.options?.mode === 'string' ? details.options.mode.trim().toLowerCase() : undefined;
    const normalizedDatabase = details.database?.trim() ?? '';
    if (mode === 'memory' || normalizedDatabase === ':memory:') {
        return 'memory';
    }

    const parsed = path.win32.parse(normalizedDatabase);
    return parsed.name || parsed.base || normalizedDatabase || 'memory';
}

function formatCatalogTarget(database: string, kind: DatabaseKind): string {
    return database
        .split('.')
        .map(part => formatIdentifierForSql(part.trim(), kind))
        .join('.');
}

function isLikelySqliteDatabaseName(database: string | undefined): boolean {
    const normalizedDatabase = database?.trim();
    if (!normalizedDatabase) {
        return false;
    }

    if (normalizedDatabase === ':memory:') {
        return true;
    }

    return normalizedDatabase.startsWith('file:')
        || /^[a-z]:[\\/]/i.test(normalizedDatabase)
        || normalizedDatabase.includes('\\')
        || normalizedDatabase.includes('/')
        || /\.(db|db3|sqlite|sqlite3)$/i.test(normalizedDatabase);
}

function inferLegacyLoadedDatabaseKind(details: SharedConnectionDetails): DatabaseKind | undefined {
    const optionKeys = Object.keys(details.options ?? {});
    if (isLikelyDuckDbDatabaseName(details.database)) {
        return 'duckdb';
    }

    if (optionKeys.some(key => LEGACY_SQLITE_OPTION_KEYS.has(key)) || isLikelySqliteDatabaseName(details.database)) {
        return 'sqlite';
    }

    if (optionKeys.some(key => LEGACY_DB2_OPTION_KEYS.has(key))) {
        return 'db2';
    }

    if (optionKeys.some(key => LEGACY_MSSQL_OPTION_KEYS.has(key))) {
        return 'mssql';
    }

    if (optionKeys.some(key => LEGACY_ORACLE_OPTION_KEYS.has(key))) {
        return 'oracle';
    }

    if (optionKeys.some(key => LEGACY_POSTGRESQL_OPTION_KEYS.has(key))) {
        return 'postgresql';
    }

    if (typeof details.port === 'number') {
        return LEGACY_PORT_KIND_MAP.get(details.port);
    }

    return undefined;
}

function resolveStoredDatabaseKind(details: SharedConnectionDetails | undefined): DatabaseKind | undefined {
    if (!details) {
        return undefined;
    }

    const explicitKind = tryNormalizeDatabaseKind(details.dbType);
    if (explicitKind && explicitKind !== 'netezza') {
        return explicitKind;
    }

    return inferLegacyLoadedDatabaseKind(details) ?? explicitKind;
}

function normalizeConnectionDetails(details: SharedConnectionDetails, inferLegacyKind = false): SharedConnectionDetails {
    const options = details.options && Object.keys(details.options).length > 0
        ? { ...details.options }
        : undefined;
    const normalizedKind = inferLegacyKind
        ? resolveStoredDatabaseKind({ ...details, options })
        : resolveConnectionDatabaseKind(details.dbType);

    return {
        ...details,
        options,
        dbType: normalizedKind,
        accentColor: normalizeConnectionAccentColor(details.accentColor)
    };
}

function normalizeConnectionMap(
    connections: Record<string, SharedConnectionDetails>
): Record<string, ConnectionDetails> {
    return Object.fromEntries(
        Object.entries(connections).map(([name, details]) => {
            const storedName = details.name && details.name.trim().length > 0 ? details.name : name;
            const normalizedDetails = normalizeConnectionDetails({
                ...details,
                name: storedName
            }, true);
            return [storedName, { ...normalizedDetails, name: storedName }];
        })
    );
}

function validateConnectionDetails(
    details: SharedConnectionDetails,
    options: { requireName?: boolean } = {}
): void {
    const normalizedKind = resolveConnectionDatabaseKind(details.dbType);

    if (options.requireName && (!details.name || details.name.trim().length === 0)) {
        throw new Error('Connection name is required');
    }
    if (!details.database || details.database.trim().length === 0) {
        throw new Error('Connection database is required');
    }
    if (!isLocalFileDialect(normalizedKind) && (!details.host || details.host.trim().length === 0)) {
        throw new Error('Connection host is required');
    }
    if (!isLocalFileDialect(normalizedKind) && (!details.user || details.user.trim().length === 0)) {
        throw new Error('Connection user is required');
    }
}

function getLogicalDefaultDatabase(details: SharedConnectionDetails | undefined): string | null {
    if (!details) {
        return null;
    }

    const resolvedKind = resolveStoredDatabaseKind(details);
    if (resolvedKind === 'sqlite') {
        return 'main';
    }
    if (resolvedKind === 'duckdb') {
        return getDuckDbCatalogHint(details);
    }

    return details.database;
}

export class ConnectionManager {
    // Cache of connection details: { [name]: details }
    private _connections: Record<string, ConnectionDetails> = {};

    // Active connection name
    private _activeConnectionName: string | null = null;

    // Per-document connection selection: Map<documentUri, connectionName>
    private _documentConnections: Map<string, string> = new Map();

    // Map of active promises establishing persistent connections to prevent concurrent sockets to the same URI
    private _documentConnectionPromises: Map<string, Promise<NzConnection>> = new Map();

    // Per-document persistent connections: Map<documentUri, NzConnection>
    private _documentPersistentConnections: Map<string, NzConnection> = new Map();

    // Per-document persistent connection metadata: Map<documentUri, { connectionName: string; database: string; lastSessionId?: string }>
    private _documentPersistentConnectionMeta: Map<string, { connectionName: string; database: string; lastSessionId?: string }> = new Map();

    // Per-document keep connection open setting: Map<documentUri, boolean>
    // Default is true for new documents
    private _documentKeepConnectionOpen: Map<string, boolean> = new Map();

    // Per-document database override: Map<documentUri, databaseName>
    // When set, overrides the default database from connection details
    private _documentDatabaseOverride: Map<string, string> = new Map();

    private _metadataCache?: MetadataCache;

    // Promise that resolves when connections are loaded from Secrets API
    private _loadingPromise: Promise<void>;

    // Whether initial fast-load from globalState cache has fired
    private _fastLoaded = false;

    // Event emitter for connection changes
    private _onDidChangeConnections = new vscode.EventEmitter<void>();
    readonly onDidChangeConnections = this._onDidChangeConnections.event;

    private _onDidChangeActiveConnection = new vscode.EventEmitter<string | null>();
    readonly onDidChangeActiveConnection = this._onDidChangeActiveConnection.event;

    private _onDidChangeDocumentConnection = new vscode.EventEmitter<string>();
    readonly onDidChangeDocumentConnection = this._onDidChangeDocumentConnection.event;

    private _onDidChangeDocumentDatabase = new vscode.EventEmitter<string>();
    readonly onDidChangeDocumentDatabase = this._onDidChangeDocumentDatabase.event;

    constructor(private context: vscode.ExtensionContext) {
        // Fast-load: restore connection list from globalState cache (synchronous, <1ms)
        this._activeConnectionName = getMementoValue<string | null>(
            this.context.globalState,
            compatibilityStateKeys.activeConnection,
            null
        ) || null;
        const cached = getMementoValue<Record<string, SharedConnectionDetails>>(
            this.context.globalState,
            compatibilityStateKeys.connectionsCache
        );
        if (cached && Object.keys(cached).length > 0) {
            this._connections = normalizeConnectionMap(cached);
            this._fastLoaded = true;
            logWithFallback('debug', `[perf] ConnectionManager: fast-loaded ${Object.keys(cached).length} connection(s) from cache`);
        } else {
            logWithFallback('debug', '[perf] ConnectionManager: no cache found, waiting for Secrets API');
        }
        // Full load: read passwords from Secrets API (start immediately)
        this._loadingPromise = this.loadConnections();
    }

    setMetadataCache(metadataCache: MetadataCache): void {
        this._metadataCache = metadataCache;
    }

    getSchemaForConnection(connectionName: string): string | null {
        const details = this._connections[connectionName];
        return this.resolveEffectiveSchemaFromDetails(
            connectionName,
            details?.database,
            details,
        );
    }

    private async loadConnections() {
        // Active connection name already loaded in constructor from globalState

        // Load connections from secrets (may be slow — VS Code Secrets API uses OS credential store)
        const json = await getSecretValue(this.context.secrets, compatibilitySecretKeys.connections);
        if (json) {
            try {
                this._connections = normalizeConnectionMap(JSON.parse(json) as Record<string, SharedConnectionDetails>);
            } catch (e: unknown) {
                logWithFallback('error', '[ConnectionManager] Failed to parse connections:', e);
                this._connections = {};
                // Clear the corrupted secret to prevent future errors
                await deleteSecretValues(this.context.secrets, compatibilitySecretKeys.connections);
            }
        } else if (!this._fastLoaded) {
            // Migration check: check for old single connection style
            const oldJson = await this.context.secrets.get('netezza-vscode');
            if (oldJson) {
                try {
                    const oldDetails = JSON.parse(oldJson);
                    if (oldDetails && oldDetails.host) {
                        const name = `Default (${oldDetails.host})`;
                        const normalizedDetails = normalizeConnectionDetails({ ...oldDetails, name });
                        this._connections = {
                            [name]: { ...normalizedDetails, name }
                        };
                        this._activeConnectionName = name;
                        await this.saveConnectionsToStorage();
                    }
                } catch (migrationErr: unknown) {
                    logWithFallback('warn', '[ConnectionManager] Failed parsing legacy connection.', migrationErr);
                }
            }
        }
        // Update globalState cache for next fast-load
        await this._updateConnectionsCache();
        this._onDidChangeConnections.fire();
    }

    private async ensureLoaded() {
        await this._loadingPromise;
    }

    /**
     * Whether connection list was instantly restored from globalState cache.
     */
    isFastLoaded(): boolean {
        return this._fastLoaded;
    }

    /**
     * Wait for full load from Secrets API (credentials).
     */
    async ensureFullyLoaded(): Promise<void> {
        await this._loadingPromise;
    }

    private async saveConnectionsToStorage() {
        await storeSecretValue(this.context.secrets, compatibilitySecretKeys.connections, JSON.stringify(this._connections));
        await this._updateConnectionsCache();
        await updateMementoValue(
            this.context.globalState,
            compatibilityStateKeys.activeConnection,
            this._activeConnectionName ?? undefined
        );
    }

    /**
     * Persist connection metadata (without passwords) to globalState for fast startup.
     */
    private async _updateConnectionsCache() {
        const cache: Record<string, ConnectionDetails> = {};
        for (const [name, details] of Object.entries(this._connections)) {
            cache[name] = { ...details, password: undefined };
        }
        await updateMementoValue(this.context.globalState, compatibilityStateKeys.connectionsCache, cache);
    }

    async saveConnection(details: SharedConnectionDetails) {
        await this.ensureLoaded();
        const normalizedDetails = normalizeConnectionDetails(details);
        validateConnectionDetails(normalizedDetails, { requireName: true });
        const storedDetails: ConnectionDetails = {
            ...normalizedDetails,
            name: normalizedDetails.name as string
        };
        this._connections[storedDetails.name] = storedDetails;

        // If it's the first connection, make it active
        if (!this._activeConnectionName) {
            await this.setActiveConnection(storedDetails.name);
        }

        await this.saveConnectionsToStorage();
        this._onDidChangeConnections.fire();
    }

    async testConnection(details: SharedConnectionDetails): Promise<void> {
        const normalizedDetails = normalizeConnectionDetails(details);
        validateConnectionDetails(normalizedDetails);
        const connection = createDatabaseConnectionFromDetails(normalizedDetails) as NzConnection;

        try {
            await connection.connect();
        } finally {
            if (connection) {
                try {
                    await connection.close();
                } catch (closeErr: unknown) {
                    logWithFallback('warn', '[ConnectionManager] Ignored error during connection.close() in testConnection:', closeErr);
                }
            }
        }
    }

    async deleteConnection(name: string) {
        await this.ensureLoaded();
        if (this._connections[name]) {
            // Close any document persistent connections using this connection
            // (documents will need to reconnect with different connection)

            delete this._connections[name];

            // If active connection was deleted, reset active
            if (this._activeConnectionName === name) {
                const names = Object.keys(this._connections);
                await this.setActiveConnection(names.length > 0 ? names[0] : null);
            }

            await this.saveConnectionsToStorage();
            this._onDidChangeConnections.fire();
        }
    }

    async getConnections(): Promise<ConnectionDetails[]> {
        // If fast-loaded from globalState cache, return immediately without waiting for Secrets API
        if (this._fastLoaded) {
            return Object.values(this._connections);
        }
        await this.ensureLoaded();
        return Object.values(this._connections);
    }

    async getConnection(name: string): Promise<ConnectionDetails | undefined> {
        // If fast-loaded but no password yet, wait for full load to get credentials
        if (this._fastLoaded && this._connections[name] && !this._connections[name].password) {
            await this.ensureLoaded();
        } else if (!this._fastLoaded) {
            await this.ensureLoaded();
        }
        return this._connections[name];
    }

    getConnectionMetadata(name: string): ConnectionDetails | undefined {
        return this._connections[name];
    }

    getConnectionNames(): string[] {
        return Object.keys(this._connections);
    }

    getConnectionDatabaseKind(name?: string): DatabaseKind | undefined {
        const targetName = name || this._activeConnectionName || undefined;
        if (!targetName) {
            return undefined;
        }
        return resolveStoredDatabaseKind(this._connections[targetName]);
    }

    getConnectionCapabilities(name?: string): DatabaseCapabilities | undefined {
        const kind = this.getConnectionDatabaseKind(name);
        if (!kind) {
            return undefined;
        }
        return getDatabaseCapabilities(kind);
    }

    resolveConnectionName(documentUri?: string, name?: string): string | undefined {
        return name || this.getConnectionForExecution(documentUri) || this._activeConnectionName || undefined;
    }

    getExecutionDatabaseKind(documentUri?: string, name?: string): DatabaseKind | undefined {
        return this.getConnectionDatabaseKind(this.resolveConnectionName(documentUri, name));
    }

    supportsCapability(
        capability: keyof DatabaseCapabilities,
        documentUri?: string,
        name?: string
    ): boolean {
        const capabilities = this.getConnectionCapabilities(this.resolveConnectionName(documentUri, name));
        return capabilities?.[capability] ?? false;
    }

    async setActiveConnection(name: string | null) {
        await this.ensureLoaded();
        this._activeConnectionName = name;
        await updateMementoValue(
            this.context.globalState,
            compatibilityStateKeys.activeConnection,
            name ?? undefined
        );
        this._onDidChangeActiveConnection.fire(name);
    }

    getActiveConnectionName(): string | null {
        return this._activeConnectionName;
    }


    async getCurrentDatabase(name?: string): Promise<string | null> {
        await this.ensureLoaded();
        const targetName = name || this._activeConnectionName;
        if (!targetName) return null;
        return getLogicalDefaultDatabase(this._connections[targetName]);
    }

    // ========== Per-Document Keep Connection Open ==========

    /**
     * Set keep connection open for a specific document (tab)
     */
    setDocumentKeepConnectionOpen(documentUri: string, keepOpen: boolean): void {
        const normalizedUri = normalizeUriKey(documentUri);
        this._documentKeepConnectionOpen.set(normalizedUri, keepOpen);
        if (!keepOpen) {
            // Close persistent connection for this document
            this.closeDocumentPersistentConnection(normalizedUri);
        }
    }

    /**
     * Get keep connection open setting for a specific document (tab)
     * Default is true for new documents
     */
    getDocumentKeepConnectionOpen(documentUri: string): boolean {
        const normalizedUri = normalizeUriKey(documentUri);
        const perDoc = this._documentKeepConnectionOpen.get(normalizedUri);
        if (perDoc !== undefined) {
            return perDoc;
        }
        // Default: keep connection open for new documents
        return true;
    }

    /**
     * Check if document has explicit keep connection setting
     */
    hasDocumentKeepConnectionOpen(documentUri: string): boolean {
        const normalizedUri = normalizeUriKey(documentUri);
        return this._documentKeepConnectionOpen.has(normalizedUri);
    }

    /**
     * Toggle keep connection open for a specific document
     */
    toggleDocumentKeepConnectionOpen(documentUri: string): boolean {
        const current = this.getDocumentKeepConnectionOpen(documentUri);
        const newValue = !current;
        this.setDocumentKeepConnectionOpen(documentUri, newValue);
        return newValue;
    }

    /**
     * Get persistent connection for a specific document (tab)
     * Uses document-specific database override if set
     */
    async getDocumentPersistentConnection(documentUri: string, connectionName?: string): Promise<NzConnection> {
        const normalizedUri = normalizeUriKey(documentUri);
        const targetName = connectionName || this.getConnectionForExecution(documentUri);
        if (!targetName) {
            throw new Error('No connection selected for this document');
        }

        const details = await this.getConnection(targetName);
        if (!details) {
            throw new Error(`Connection '${targetName}' not found or invalid`);
        }

        const resolvedKind = resolveStoredDatabaseKind(details) ?? resolveConnectionDatabaseKind(details.dbType);
        const defaultLogicalDatabase = getLogicalDefaultDatabase(details) ?? details.database;
        const databaseOverride = this._documentDatabaseOverride.get(normalizedUri);
        const effectiveDatabase = databaseOverride || defaultLogicalDatabase;
        const connectionDatabase = isLocalFileDialect(resolvedKind) ? details.database : effectiveDatabase;
        const shouldApplyCatalogOverride =
            isLocalFileDialect(resolvedKind)
            && typeof databaseOverride === 'string'
            && databaseOverride.length > 0
            && databaseOverride !== defaultLogicalDatabase;

        const existing = this._documentPersistentConnections.get(normalizedUri);
        const existingMeta = this._documentPersistentConnectionMeta.get(normalizedUri);

        // If existing connection does not match current connection/database, close it
        if (existing && existingMeta) {
            const metaMatches =
                existingMeta.connectionName === targetName && existingMeta.database === effectiveDatabase;

            if (metaMatches) {
                return existing;
            }

            await this.closeDocumentPersistentConnection(normalizedUri);
        } else if (existing && !existingMeta) {
            // No metadata means we cannot safely verify; close and recreate
            await this.closeDocumentPersistentConnection(normalizedUri);
        }

        // Check if there is an in-flight connection promise for this document
        if (this._documentConnectionPromises.has(normalizedUri)) {
            const inFlightPromise = this._documentConnectionPromises.get(normalizedUri);
            if (inFlightPromise) {
                return inFlightPromise;
            }
        }

        // Create new connection for this document with effective database
        const connectPromise = (async () => {
            let conn: NzConnection | undefined;
            try {
                conn = createDatabaseConnectionFromDetails({
                    ...details,
                    database: connectionDatabase
                }) as NzConnection;
                logWithFallback('info', `[ConnectionManager] Connecting persistent Netezza tab connection for ${normalizedUri}`);
                await conn.connect();
                logWithFallback('info', `[ConnectionManager] Persistent tab connection established for ${normalizedUri}`);
                if (shouldApplyCatalogOverride && databaseOverride) {
                    const setCatalogCommand = conn.createCommand(
                        `SET CATALOG ${formatCatalogTarget(databaseOverride, resolvedKind)}`
                    );
                    await setCatalogCommand.execute();
                }

                this._documentPersistentConnections.set(normalizedUri, conn);
                this._documentPersistentConnectionMeta.set(normalizedUri, {
                    connectionName: targetName,
                    database: effectiveDatabase
                });
                return conn;
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                logWithFallback('warn', `[ConnectionManager] Persistent connection failed for ${normalizedUri}: ${message}`);
                if (conn) {
                    try {
                        await conn.close();
                    } catch (closeError: unknown) {
                        logWithFallback('warn', `[ConnectionManager] Failed to reset failed connection for ${normalizedUri}:`, closeError);
                    }
                }
                throw error;
            } finally {
                // Clear the promise once resolution is complete
                this._documentConnectionPromises.delete(normalizedUri);
            }
        })();

        // Cache the promise immediately so parallel callers wait on the same setup
        this._documentConnectionPromises.set(normalizedUri, connectPromise);
        return connectPromise;
    }

    /**
     * Close persistent connection for a specific document
     */
    async closeDocumentPersistentConnection(documentUri: string): Promise<void> {
        const normalizedUri = normalizeUriKey(documentUri);
        const conn = this._documentPersistentConnections.get(normalizedUri);
        if (conn) {
            try {
                await conn.close();
            } catch (e: unknown) {
                logWithFallback('error', `[ConnectionManager] Error closing document connection for ${documentUri}:`, e);
            }
            this._documentPersistentConnections.delete(normalizedUri);
            this._documentPersistentConnectionMeta.delete(normalizedUri);
        }
    }

    /**
     * Close all document persistent connections
     */
    async closeAllDocumentPersistentConnections(): Promise<void> {
        for (const uri of this._documentPersistentConnections.keys()) {
            await this.closeDocumentPersistentConnection(uri);
        }
    }

    async dispose(): Promise<void> {
        await this.closeAllDocumentPersistentConnections();
        this._onDidChangeConnections.dispose();
        this._onDidChangeActiveConnection.dispose();
        this._onDidChangeDocumentConnection.dispose();
        this._onDidChangeDocumentDatabase.dispose();
    }

    // ========== Per-Document Database Override ==========

    /**
     * Get database override for a specific document (tab)
     * Returns undefined if no override set (use connection's default database)
     */
    getDocumentDatabase(documentUri: string): string | undefined {
        const normalizedUri = normalizeUriKey(documentUri);
        return this._documentDatabaseOverride.get(normalizedUri);
    }

    /**
     * Set database override for a specific document (tab)
     * This will close the existing persistent connection to force reconnect with new database
     */
    async setDocumentDatabase(documentUri: string, database: string): Promise<void> {
        const normalizedUri = normalizeUriKey(documentUri);
        this._documentDatabaseOverride.set(normalizedUri, database);
        // Close persistent connection to force reconnect with new database
        await this.closeDocumentPersistentConnection(normalizedUri);
        this._onDidChangeDocumentDatabase.fire(documentUri);
    }

    /**
     * Clear database override for a specific document (revert to connection's default)
     */
    clearDocumentDatabase(documentUri: string): void {
        const normalizedUri = normalizeUriKey(documentUri);
        this._documentDatabaseOverride.delete(normalizedUri);
        this.closeDocumentPersistentConnection(normalizedUri);
        this._onDidChangeDocumentDatabase.fire(documentUri);
    }

    /**
     * Get the effective database for a document
     * Returns override if set, otherwise falls back to connection's default database
     */
    async getEffectiveDatabase(documentUri: string): Promise<string | null> {
      const normalizedUri = normalizeUriKey(documentUri);
      const override = this._documentDatabaseOverride.get(normalizedUri);
      if (override) {
        return override;
      }
      const connectionName = this.getConnectionForExecution(documentUri);
      if (!connectionName) return null;
      const details = await this.getConnection(connectionName);
      return getLogicalDefaultDatabase(details);
    }
  
    /**
     * Get the effective schema for a document
     * Returns the schema from connection details if available, otherwise undefined
     * This allows dialects with schema concepts to use the configured schema
     * rather than hardcoded defaults
     */
    async getEffectiveSchema(documentUri: string): Promise<string | null> {
      const connectionName = this.getConnectionForExecution(documentUri);
      if (!connectionName) return null;
      const details = await this.getConnection(connectionName);
      const effectiveDb = await this.getEffectiveDatabase(documentUri);
      return this.resolveEffectiveSchemaFromDetails(
        connectionName,
        effectiveDb,
        details,
      );
    }

    /**
     * Synchronous effective schema for UI paths that cannot await connection load.
     * Uses cached connection metadata when available.
     */
    getEffectiveSchemaSync(
      documentUri: string,
      effectiveDb?: string,
    ): string | undefined {
      const connectionName = this.getConnectionForExecution(documentUri);
      if (!connectionName) {
        return undefined;
      }
      const details = this.getConnectionMetadata(connectionName);
      const resolvedDb =
        effectiveDb ??
        this.getDocumentDatabase(documentUri) ??
        getLogicalDefaultDatabase(details) ??
        undefined;
      return (
        this.resolveEffectiveSchemaFromDetails(
          connectionName,
          resolvedDb ?? null,
          details,
        ) ?? undefined
      );
    }

    private resolveEffectiveSchemaFromDetails(
      connectionName: string,
      effectiveDb: string | null | undefined,
      details: ConnectionDetails | undefined,
    ): string | null {
      if (!details) {
        return null;
      }
      if (
        "schema" in details &&
        typeof details.schema === "string" &&
        details.schema.length > 0
      ) {
        return details.schema;
      }
      if (
        details.options?.searchPath &&
        typeof details.options.searchPath === "string"
      ) {
        const firstSchema = (details.options.searchPath as string)
          .split(",")[0]
          ?.trim();
        if (firstSchema) {
          return firstSchema;
        }
      }
      if (effectiveDb) {
        const cachedSchema = this._metadataCache?.getCurrentSchema(
          connectionName,
          effectiveDb,
        );
        if (cachedSchema) {
          return cachedSchema;
        }
      }
      if (this.getConnectionDatabaseKind(connectionName) === "netezza") {
        return "ADMIN";
      }
      return null;
    }

    // Per-document connection management
    getDocumentConnection(documentUri: string): string | undefined {
        const normalizedUri = normalizeUriKey(documentUri);
        return this._documentConnections.get(normalizedUri);
    }

    setDocumentConnection(documentUri: string, connectionName: string) {
        const normalizedUri = normalizeUriKey(documentUri);
        this._documentConnections.set(normalizedUri, connectionName);
        // If connection changes, close existing persistent connection for this document
        this.closeDocumentPersistentConnection(normalizedUri);
        this._onDidChangeDocumentConnection.fire(documentUri);
    }

    clearDocumentConnection(documentUri: string) {
        const normalizedUri = normalizeUriKey(documentUri);
        this._documentConnections.delete(normalizedUri);
        this._documentDatabaseOverride.delete(normalizedUri);
        this.closeDocumentPersistentConnection(normalizedUri);
        this._documentKeepConnectionOpen.delete(normalizedUri);
        this._documentPersistentConnectionMeta.delete(normalizedUri);
        this._onDidChangeDocumentConnection.fire(documentUri);
    }

    // Per-document session ID tracking
    setDocumentLastSessionId(documentUri: string, sessionId: string) {
        const normalizedUri = normalizeUriKey(documentUri);
        const meta = this._documentPersistentConnectionMeta.get(normalizedUri);
        if (meta) {
            meta.lastSessionId = sessionId;
        } else {
            // Should usually strictly update existing meta since connection must exist
            // but we can be safe if it's missing (though weird flow)
        }
    }

    getDocumentLastSessionId(documentUri: string): string | undefined {
        const normalizedUri = normalizeUriKey(documentUri);
        return this._documentPersistentConnectionMeta.get(normalizedUri)?.lastSessionId;
    }

    /**
     * Gets the connection to use for query execution.
     * If documentUri is provided and has a selected connection, use that.
     * Otherwise fall back to global active connection.
     */
    getConnectionForExecution(documentUri?: string): string | undefined {
        if (documentUri) {
            const normalizedUri = normalizeUriKey(documentUri);
            const docConnection = this._documentConnections.get(normalizedUri);
            if (docConnection) {
                return docConnection;
            }
        }
        return this._activeConnectionName || undefined;
    }

    /**
     * Connection details for import flows.
     * Uses the tab's effective database when documentUri is set; droppedDatabase
     * (e.g. schema-tree drop target) takes precedence over the tab override.
     */
    async getConnectionDetailsForImport(
        documentUri?: string,
        connectionName?: string,
        droppedDatabase?: string,
    ): Promise<ConnectionDetails | undefined> {
        await this.ensureLoaded();
        const targetName = connectionName || this.getConnectionForExecution(documentUri);
        if (!targetName) {
            return undefined;
        }

        const details = await this.getConnection(targetName);
        if (!details) {
            return undefined;
        }

        let resolvedDetails = details;
        if (documentUri) {
            const effectiveDb = await this.getEffectiveDatabase(documentUri);
            if (effectiveDb) {
                resolvedDetails = { ...resolvedDetails, database: effectiveDb };
            }
        }

        const normalizedDroppedDatabase = droppedDatabase?.trim();
        if (normalizedDroppedDatabase) {
            resolvedDetails = { ...resolvedDetails, database: normalizedDroppedDatabase };
        }

        return resolvedDetails;
    }
}

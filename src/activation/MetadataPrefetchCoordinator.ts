import * as vscode from 'vscode';
import { queryResultToRows } from '../core/queryRunner';
import { supportsLegacyMetadataPrefetch } from '../metadata/prefetchSupport';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import { Logger } from '../utils/logger';
import { METADATA_QUERY_TIMEOUT_SECONDS } from '../metadata/metadataQueryLimiter';
import { createConnectionScopedMetadataQueryRunner } from '../metadata/connectionScopedMetadataQueryRunner';
import {
    createMetadataRefreshStatusBar,
    updateMetadataRefreshStatusBar,
} from '../services/statusBarManager';
import { MetadataRefreshDetailsPanel } from '../services/metadataRefreshDetailsPanel';
import type { MetadataPrefetchRefreshDetails } from '../metadata/prefetch';
import {
    DEFAULT_POPULAR_DATABASE_COUNT,
    MAX_POPULAR_DATABASE_COUNT,
    type DatabaseUsageHistory,
} from '../metadata/databaseUsageHistory';
import { getExtensionConfiguration } from '../compatibility/configuration';
import type { ExtensionServices } from './extensionServices';
import type { NzConnection } from '../types';

export class MetadataPrefetchCoordinator {
    private readonly metadataRefreshStatusBar: vscode.StatusBarItem;
    private readonly metadataRefreshDetailsPanel: MetadataRefreshDetailsPanel;
    private metadataRefreshHideTimer: ReturnType<typeof setTimeout> | undefined;
    private activeRefreshId: string | undefined;
    private readonly refreshDetailsByConnection = new Map<string, MetadataPrefetchRefreshDetails>();
    private readonly currentSchemaRefreshPromises = new Map<string, Promise<void>>();
    private readonly currentSchemaRefreshedListeners = new Set<
        (connectionName: string, database: string) => void
    >();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: ExtensionServices,
        private readonly logger: Logger,
        private readonly databaseUsageHistory?: DatabaseUsageHistory,
    ) {
        this.metadataRefreshStatusBar = createMetadataRefreshStatusBar(context);
        this.metadataRefreshDetailsPanel = new MetadataRefreshDetailsPanel(connectionName => {
            void vscode.commands.executeCommand('netezza.refreshSchema', connectionName);
        });
    }

    register(context: vscode.ExtensionContext, metadataCacheInit: Promise<void>): void {
        context.subscriptions.push({
            dispose: () => {
                this.clearMetadataRefreshHideTimer();
                this.metadataRefreshDetailsPanel.dispose();
            },
        });

        context.subscriptions.push(
            vscode.commands.registerCommand('netezza.showMetadataRefreshDetails', () => {
                this.metadataRefreshDetailsPanel.show();
            }),
        );

        context.subscriptions.push(
            this.services.metadataCache.onDidPrefetchProgress(progress => {
                if (progress.refreshId) {
                    if (progress.stage === 'start') {
                        this.activeRefreshId = progress.refreshId;
                    } else if (this.activeRefreshId && progress.refreshId !== this.activeRefreshId) {
                        // Events from an older refresh must not overwrite a
                        // newer progress display (the former 100% → 98% jump).
                        return;
                    }
                }
                this.clearMetadataRefreshHideTimer();
                updateMetadataRefreshStatusBar(this.metadataRefreshStatusBar, progress);

                if (progress.stage === 'complete') {
                    this.metadataRefreshHideTimer = setTimeout(() => {
                        updateMetadataRefreshStatusBar(this.metadataRefreshStatusBar, null);
                        this.metadataRefreshHideTimer = undefined;
                    }, 2500);
                } else if (progress.stage === 'error') {
                    this.metadataRefreshHideTimer = setTimeout(() => {
                        updateMetadataRefreshStatusBar(this.metadataRefreshStatusBar, null);
                        this.metadataRefreshHideTimer = undefined;
                    }, 5000);
                }
            }),
        );

        const cacheWithRefreshDetails = this.services.metadataCache as typeof this.services.metadataCache & {
            onDidPrefetchRefreshDetails?: vscode.Event<MetadataPrefetchRefreshDetails>;
        };
        if (cacheWithRefreshDetails.onDidPrefetchRefreshDetails) {
            context.subscriptions.push(
                cacheWithRefreshDetails.onDidPrefetchRefreshDetails(details => {
                    this.refreshDetailsByConnection.set(details.connectionName, details);
                    this.metadataRefreshDetailsPanel.update([...this.refreshDetailsByConnection.values()]);
                }),
            );
        }

        context.subscriptions.push(
            this.services.metadataCache.onDidNeedColumnRecovery((connectionName) => {
                this.triggerForConnection(connectionName);
            }),
        );

        void metadataCacheInit
            .then(async () => {
                for (const document of vscode.workspace.textDocuments) {
                    this.triggerForDocument(document);
                }
                const active = this.services.connectionManager.getActiveConnectionName();
                if (active) {
                    if (this.services.metadataCache.isConnectionMetadataHydrating(active)) {
                        await this.services.metadataCache.whenConnectionMetadataHydrated(active);
                    }
                    await this.services.metadataCache.preloadColumnsForConnection(active);
                    // Always resolve the active + popular database scope: when
                    // every database snapshot is fresh this is a RAM-only check
                    // and records a "skipped" diagnostics card.
                    this.triggerForConnection(active);
                }
            })
            .catch((error: unknown) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Netezza extension: post-init metadata preload failed: ${errorMessage}`);
            });

        context.subscriptions.push(
            this.onCurrentSchemaRefreshed((connectionName, database) => {
                void import('./currentSchemaRefreshRelint').then(({ relintDocumentsAfterCurrentSchemaRefresh }) =>
                    relintDocumentsAfterCurrentSchemaRefresh(
                        this.services.connectionManager,
                        connectionName,
                        database,
                    ),
                );
            }),
        );
    }

    triggerForConnection(connectionName: string | undefined, preferredDatabase?: string): void {
        void this.refreshCurrentSchema(connectionName);
        void this.services.metadataCache.whenDiskReady().then(async () => {
            if (
                !connectionName
                || !supportsLegacyMetadataPrefetch(
                    this.services.connectionManager.getConnectionDatabaseKind(connectionName),
                )
            ) {
                return;
            }

            const connectionRunner = () => createConnectionScopedMetadataQueryRunner({
                context: this.context,
                connectionManager: this.services.connectionManager,
                connectionName,
                maxRows: 1000000,
                timeoutSeconds: METADATA_QUERY_TIMEOUT_SECONDS,
                queryExecutor: this.services.queryExecutor,
            });

            const connectionSnapshotFresh =
                this.services.metadataCache.isConnectionPrefetchFresh(connectionName);
            if (connectionSnapshotFresh) {
                // Cached core snapshot: no catalog SQL, but still recover any
                // incomplete FK slices and keep the connection in the panel.
                void this.services.metadataCache.refreshIncompleteForeignKeyRelationships(
                    connectionName,
                    connectionRunner(),
                ).catch(error => this.logger.warn('FK metadata recovery failed', error));
            }

            const databases = await this.resolvePrefetchDatabases(connectionName, preferredDatabase);
            if (databases.length === 0) {
                this.logger.debug(`[MetadataCache] No active or popular database to warm for ${connectionName}`);
                return;
            }

            let pendingDatabases = 0;
            for (const database of databases) {
                if (this.services.metadataCache.isDatabaseSnapshotFresh(connectionName, database)) {
                    continue;
                }
                pendingDatabases += 1;
                // Sequential by design: one metadata session and one catalog
                // workload per connection. The disk lock is connection-scoped,
                // so starting all databases in parallel would make all but one
                // skip as "locked".
                await this.services.metadataCache.triggerDatabasePrefetch(
                    connectionName,
                    database,
                    connectionRunner(),
                );
            }
            if (pendingDatabases === 0) {
                // No catalog SQL ran, but the connection still belongs in the
                // Schema Refresh Details panel. Without this the panel only
                // ever shows the first connection that happened to refresh.
                this.services.metadataCache.recordConnectionPrefetchSkipped(connectionName, 'fresh');
            }
        });
    }

    /**
     * Active database first, then the most used databases from query history.
     * The rest of the connection stays lazy until the user opens it.
     */
    private async resolvePrefetchDatabases(
        connectionName: string,
        preferredDatabase?: string,
    ): Promise<string[]> {
        const popularCount = Math.max(0, Math.min(
            MAX_POPULAR_DATABASE_COUNT,
            Math.trunc(
                getExtensionConfiguration('metadata')
                    .get<number>('popularDatabases', DEFAULT_POPULAR_DATABASE_COUNT)
                ?? DEFAULT_POPULAR_DATABASE_COUNT,
            ),
        ));
        const activeDatabase = await this.resolveActiveDatabase(connectionName);
        const popular = this.databaseUsageHistory?.getPopular(connectionName, popularCount) ?? [];
        const result: string[] = [];
        const seen = new Set<string>();
        for (const candidate of [activeDatabase, preferredDatabase, ...popular]) {
            const database = candidate?.trim();
            if (!database) {
                continue;
            }
            const key = database.toUpperCase();
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            result.push(database);
        }
        return result;
    }

    private async resolveActiveDatabase(connectionName: string): Promise<string | undefined> {
        const documentUri = vscode.window.activeTextEditor?.document.uri.toString();
        if (documentUri) {
            try {
                const database = await this.services.connectionManager
                    .getEffectiveDatabase(documentUri, connectionName);
                if (database?.trim()) {
                    return database.trim();
                }
            } catch {
                // Fall through to the connection profile database.
            }
        }
        return this.services.connectionManager.getConnectionMetadata(connectionName)?.database;
    }

    triggerForDocument(document: vscode.TextDocument): void {
        if (!isSqlAuthoringLanguageId(document.languageId)) {
            return;
        }

        const documentUri = document.uri.toString();
        const connectionName =
            this.services.connectionManager.getConnectionForExecution(documentUri)
            || this.services.connectionManager.getActiveConnectionName()
            || undefined;
        this.primeAccessConnection(connectionName, documentUri);
        void this.refreshCurrentSchema(connectionName, documentUri);
        if (connectionName) {
            // Warm the database this document is pinned to, not only the
            // active editor's database. Several open documents may target
            // different databases of the same connection.
            void this.services.connectionManager
                .getEffectiveDatabase(documentUri, connectionName)
                .then(database => this.triggerForConnection(connectionName, database?.trim() || undefined))
                .catch(() => this.triggerForConnection(connectionName));
            return;
        }
        this.triggerForConnection(connectionName);
    }

    /**
     * Access metadata and authoring requests can arrive before the first SQL
     * execution. Establish the persistent lease while the SQL document enters
     * focus so autocomplete/reveal do not become the first operation that has
     * to initialize the native file reader and SQL mirror.
     */
    private primeAccessConnection(connectionName: string | undefined, documentUri: string): void {
        if (!connectionName
            || this.services.connectionManager.getConnectionDatabaseKind(connectionName) !== 'access'
            || !this.services.connectionManager.getDocumentKeepConnectionOpen(documentUri)) {
            return;
        }

        void this.services.connectionManager
            .getDocumentPersistentConnection(documentUri, connectionName)
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.warn(`Access connection initialization failed for ${connectionName}: ${message}`);
            });
    }

    refreshCurrentSchemaForDocument(documentUri: string, forceRefresh = false): void {
        const connectionName =
            this.services.connectionManager.getConnectionForExecution(documentUri)
            || this.services.connectionManager.getActiveConnectionName()
            || undefined;
        void this.refreshCurrentSchema(connectionName, documentUri, forceRefresh);
    }

    onCurrentSchemaRefreshed(
        listener: (connectionName: string, database: string) => void,
    ): vscode.Disposable {
        this.currentSchemaRefreshedListeners.add(listener);
        return {
            dispose: () => {
                this.currentSchemaRefreshedListeners.delete(listener);
            },
        };
    }

    private notifyCurrentSchemaRefreshed(
        connectionName: string,
        database: string,
    ): void {
        for (const listener of this.currentSchemaRefreshedListeners) {
            listener(connectionName, database);
        }
    }

    private async refreshCurrentSchema(
        connectionName: string | undefined,
        documentUri?: string,
        forceRefresh = false,
    ): Promise<void> {
        if (!connectionName) {
            return;
        }
        const databaseKind = this.services.connectionManager.getConnectionDatabaseKind(connectionName);
        if (databaseKind !== 'netezza' && databaseKind !== 'oracle') {
            return;
        }

        const database = documentUri
            ? await this.services.connectionManager.getEffectiveDatabase(documentUri)
            : this.services.connectionManager.getConnectionMetadata(connectionName)?.database;
        if (!database) {
            return;
        }

        const key = `${connectionName}|${database.toUpperCase()}`;
        const inFlight = this.currentSchemaRefreshPromises.get(key);
        if (inFlight) {
            await inFlight;
            if (!forceRefresh) {
                return;
            }
            this.services.metadataCache.invalidateCurrentSchema(connectionName, database);
        } else if (!forceRefresh && this.services.metadataCache.getCurrentSchema(connectionName, database)) {
            return;
        } else if (forceRefresh) {
            this.services.metadataCache.invalidateCurrentSchema(connectionName, database);
        }

        const refreshPromise = this.executeCurrentSchemaRefresh(
            connectionName,
            database,
            documentUri,
        );
        this.currentSchemaRefreshPromises.set(key, refreshPromise);
        try {
            await refreshPromise;
            this.notifyCurrentSchemaRefreshed(connectionName, database);
        } finally {
            this.currentSchemaRefreshPromises.delete(key);
        }
    }

    private async executeCurrentSchemaRefresh(
        connectionName: string,
        database: string,
        documentUri?: string,
    ): Promise<void> {
        // The current schema is cached per connection and database, not per
        // session, so it is read on a short-lived connection to the document's
        // database. Using the document's persistent session would make a
        // query the user starts at the same moment fail as busy.
        let transientConnection: NzConnection | undefined;
        try {
            if (documentUri) {
                transientConnection = await this.services.connectionManager
                    .createTransientConnectionForDocument(documentUri, connectionName);
            }
            const result = await this.services.queryExecutor({
                context: this.context,
                query: 'SELECT CURRENT_SCHEMA',
                silent: true,
                connectionManager: this.services.connectionManager,
                connectionName,
                documentUri,
                maxRows: 5000,
                isUserQuery: false,
                connectionOverride: transientConnection,
            });
            const rows = queryResultToRows<{ CURRENT_SCHEMA?: string }>(result);
            const currentSchema = rows[0]?.CURRENT_SCHEMA?.trim();
            if (currentSchema) {
                this.services.metadataCache.setCurrentSchema(connectionName, database, currentSchema);
            }
        } catch (error: unknown) {
            this.logger.debug(
                `Current schema refresh skipped for ${connectionName}/${database}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        } finally {
            await transientConnection?.close().catch(() => undefined);
        }
    }

    private clearMetadataRefreshHideTimer(): void {
        if (this.metadataRefreshHideTimer) {
            clearTimeout(this.metadataRefreshHideTimer);
            this.metadataRefreshHideTimer = undefined;
        }
    }
}

import * as vscode from 'vscode';
import { queryResultToRows } from '../core/queryRunner';
import { supportsLegacyMetadataPrefetch } from '../metadata/prefetchSupport';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';
import { Logger } from '../utils/logger';
import {
    createMetadataRefreshStatusBar,
    updateMetadataRefreshStatusBar,
} from '../services/statusBarManager';
import type { ExtensionServices } from './extensionServices';

export class MetadataPrefetchCoordinator {
    private readonly metadataRefreshStatusBar: vscode.StatusBarItem;
    private metadataRefreshHideTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly currentSchemaRefreshPromises = new Map<string, Promise<void>>();
    private readonly currentSchemaRefreshedListeners = new Set<
        (connectionName: string, database: string) => void
    >();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly services: ExtensionServices,
        private readonly logger: Logger,
    ) {
        this.metadataRefreshStatusBar = createMetadataRefreshStatusBar(context);
    }

    register(context: vscode.ExtensionContext, metadataCacheInit: Promise<void>): void {
        context.subscriptions.push({
            dispose: () => {
                this.clearMetadataRefreshHideTimer();
            },
        });

        context.subscriptions.push(
            this.services.metadataCache.onDidPrefetchProgress(progress => {
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
                    if (!this.services.metadataCache.isConnectionPrefetchFresh(active)) {
                        this.triggerForConnection(active);
                    }
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

    triggerForConnection(connectionName: string | undefined): void {
        void this.refreshCurrentSchema(connectionName);
        void this.services.metadataCache.whenDiskReady().then(() => {
            if (
                !connectionName
                || !supportsLegacyMetadataPrefetch(
                    this.services.connectionManager.getConnectionDatabaseKind(connectionName),
                )
                || this.services.metadataCache.isConnectionPrefetchFresh(connectionName)
            ) {
                return;
            }

            this.services.metadataCache.triggerConnectionPrefetch(connectionName, q =>
                this.services.queryExecutor(
                    this.context,
                    q,
                    true,
                    this.services.connectionManager,
                    connectionName,
                    undefined,
                    undefined,
                    undefined,
                    1000000,
                    false,
                ),
            );
        });
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
        void this.refreshCurrentSchema(connectionName, documentUri);
        this.triggerForConnection(connectionName);
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
        if (this.services.connectionManager.getConnectionDatabaseKind(connectionName) !== 'netezza') {
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
        try {
            const result = await this.services.queryExecutor(
                this.context,
                'SELECT CURRENT_SCHEMA',
                true,
                this.services.connectionManager,
                connectionName,
                documentUri,
                undefined,
                undefined,
                5000,
                false,
            );
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
        }
    }

    private clearMetadataRefreshHideTimer(): void {
        if (this.metadataRefreshHideTimer) {
            clearTimeout(this.metadataRefreshHideTimer);
            this.metadataRefreshHideTimer = undefined;
        }
    }
}

/**
 * Netezza VS Code Extension - Main Entry Point
 *
 * Activation is split across modules under src/activation/.
 * Commands are organized in separate modules under src/commands/.
 */

import * as vscode from 'vscode';
import { type JustyBaseLiteApi, createJustyBaseLiteApi } from './api/publicApi';
import { disposeSharedOutputChannel } from './core/queryRunner';
import { ResultPanelView } from './views/resultPanelView';
import { NetezzaDocumentLinkProvider } from './providers/documentLinkProvider';
import { registerCatalogDocumentProvider } from './providers/catalogDocumentProvider';
import { CatalogReferenceProvider } from './providers/catalogReferenceProvider';
import { registerSqlConsoleCommands } from './commands/sqlConsoleCommands';
import { NetezzaParserNavigationProvider } from './providers/parserNavigationProvider';
import { NetezzaRenameProvider } from './providers/renameProvider';
import { registerWizardCommands } from './commands/wizardCommands';
import { registerCoreCommands, registerStartupCommands } from './commands/coreCommands';
import { registerSchemaCommands } from './commands/schemaCommands';
import { registerExportCommands } from './commands/exportCommands';
import { registerExportToMdCommand } from './commands/exportToMdCommand';
import { registerImportCommands } from './commands/importCommands';
import { registerQueryCommands } from './commands/queryCommands';
import { registerCopilotFeatures } from './activation/copilotRegistration';
import { showSensitiveCopilotToolNotice } from './activation/sensitiveCopilotToolNotice';
import { registerSqlLanguageFeatures } from './activation/sqlLanguageRegistration';
import { getExtensionDocumentParseSession } from './core/extensionDocumentParseSession';
import { startSqlLanguageClient, stopSqlLanguageClient } from './activation/lspRegistration';
import { activateCoreServices } from './activation/activateCoreServices';
import { activateConnectionEvents } from './activation/activateConnectionEvents';
import { MetadataPrefetchCoordinator } from './activation/MetadataPrefetchCoordinator';
import { DeferredFeatureScheduler } from './activation/DeferredFeatureScheduler';
import { activateExplorerViews } from './activation/activateExplorerViews';
import { activateEditorSync } from './activation/activateEditorSync';
import { activateNotebookRegistration } from './activation/activateNotebookRegistration';
import {
    checkForConflictingExtensions,
    getDatabaseList,
    openGettingStartedWalkthrough,
} from './activation/extensionStartupHelpers';
import { registerDatabaseUiContexts } from './services/databaseUiContextService';
import { getExtensionConfiguration, affectsExtensionConfiguration } from './compatibility/configuration';
import { registerCompatibilityCommandAliases } from './compatibility/commandAliases';
import { SqlParser } from './sql/sqlParser';
import { runCompatibilityMigrations } from './compatibility/migrationService';
import { compatibilityStateKeys, getMementoValue, updateMementoValue } from './compatibility/state';
import {
    createKeepConnectionStatusBar,
    createActiveConnectionStatusBar,
    createActiveDatabaseStatusBar,
    updateKeepConnectionStatusBar,
    createSelectionStatsStatusBar,
    updateSelectionStatsStatusBar,
} from './services/statusBarManager';
import {
    createSqlStatementDecoration,
    registerDecorationSubscriptions,
} from './editors/decorationManager';
import { ConnectionAccentDecorationProvider } from './decorations/connectionAccentDecorationProvider';
import { Logger, logWithFallback } from './utils/logger';
import { createPerformanceTimer, formatPerformanceEvent } from './services/perf/performanceEvents';
import { SQL_AUTHORING_LANGUAGE_IDS } from './utils/sqlLanguage';
import { TableDdlSynchronizer } from './metadata/tableDdlSynchronizer';

let isExtensionShuttingDown = false;
let deferredFeatureScheduler: DeferredFeatureScheduler | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<JustyBaseLiteApi> {
    isExtensionShuttingDown = false;
    deferredFeatureScheduler?.dispose();
    deferredFeatureScheduler = undefined;
    context.subscriptions.push({
        dispose: () => {
            isExtensionShuttingDown = true;
            deferredFeatureScheduler?.dispose();
            deferredFeatureScheduler = undefined;
        },
    });

    const activateTimer = createPerformanceTimer('extension.activate');
    const skipDeferredFeatureInit = process.env.NODE_ENV === 'test';
    const outputChannel = vscode.window.createOutputChannel('Netezza');
    Logger.initialize(outputChannel);
    const logger = Logger.getInstance();

    logger.info('Netezza extension: Activating...');
    try {
        await runCompatibilityMigrations(context, logger);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Netezza extension: Compatibility migrations failed but activation will continue: ${errorMessage}`);
    }

    checkForConflictingExtensions(context).catch(() => undefined);

    const { services, metadataCacheInit } = activateCoreServices(context, logger);
    const { connectionManager, metadataCache, schemaProvider } = services;
    const tableDdlSynchronizer = new TableDdlSynchronizer(
        context,
        connectionManager,
        metadataCache,
        schemaProvider,
    );

    context.subscriptions.push(...registerStartupCommands({
        context,
        connectionManager,
        openGettingStartedWalkthrough,
    }));

    const codeLensConfig = vscode.workspace.getConfiguration('justybase');
    void vscode.commands.executeCommand('setContext', 'justybase.codeLensEnabled', codeLensConfig.get<boolean>('codeLens.enabled', false));
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('justybase.codeLens.enabled')) {
                const enabled = vscode.workspace.getConfiguration('justybase').get<boolean>('codeLens.enabled', false);
                void vscode.commands.executeCommand('setContext', 'justybase.codeLensEnabled', enabled);
            }
        }),
    );

    const resultPanelProvider = new ResultPanelView(context, connectionManager);

    let t = performance.now();
    const schemaTreeView = vscode.window.createTreeView('netezza.schema', {
        treeDataProvider: schemaProvider,
        showCollapseAll: true,
        dragAndDropController: schemaProvider,
    });
    context.subscriptions.push(schemaTreeView);
    context.subscriptions.push(...registerDatabaseUiContexts(connectionManager, schemaTreeView));
    schemaTreeView.message = connectionManager.isFastLoaded()
        ? undefined
        : 'Loading saved connections...';
    logger.info(`[perf] createTreeView: ${(performance.now() - t).toFixed(1)}ms`);

    const connLoadStart = performance.now();
    void connectionManager
        .ensureFullyLoaded()
        .then(() => {
            logger.info(`[perf] connectionManager full load (Secrets API): ${(performance.now() - connLoadStart).toFixed(1)}ms`);
            schemaTreeView.message = undefined;
            schemaProvider.refresh();
        })
        .catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            schemaTreeView.message = `Failed to load saved connections: ${errorMessage}`;
        });

    void metadataCacheInit
        .then(() => {
            schemaProvider.refresh();
        })
        .catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Netezza extension: post-init schema refresh failed: ${errorMessage}`);
        });

    const connectionAccentDecorationProvider = new ConnectionAccentDecorationProvider(connectionManager);
    context.subscriptions.push(
        connectionAccentDecorationProvider,
        vscode.window.registerFileDecorationProvider(connectionAccentDecorationProvider),
    );

    context.subscriptions.push({
        dispose: () => {
            connectionManager.closeAllDocumentPersistentConnections();
            try {
                disposeSharedOutputChannel();
            } catch (e) {
                logWithFallback('warn', 'Failed to dispose shared output channel', e);
            }
        },
    });

    t = performance.now();
    const keepConnectionStatusBar = createKeepConnectionStatusBar(context, connectionManager);
    const { updateFn: updateActiveConnectionStatusBar } =
        createActiveConnectionStatusBar(context, connectionManager);
    const { updateFn: updateActiveDatabaseStatusBar } =
        createActiveDatabaseStatusBar(context, connectionManager);
    const selectionStatsStatusBar = createSelectionStatsStatusBar(context);

    resultPanelProvider.setSelectionStatsCallback(stats => {
        updateSelectionStatsStatusBar(selectionStatsStatusBar, stats);
    });

    const updateKeepConnectionStatusBarFn = () => {
        updateKeepConnectionStatusBar(keepConnectionStatusBar, connectionManager);
    };

    const metadataPrefetchCoordinator = new MetadataPrefetchCoordinator(context, services, logger);
    metadataPrefetchCoordinator.register(context, metadataCacheInit);

    updateActiveConnectionStatusBar();
    updateActiveDatabaseStatusBar();
    updateKeepConnectionStatusBarFn();

    activateConnectionEvents({
        context,
        connectionManager,
        connectionAccentDecorationProvider,
        statusBarHandlers: {
            updateActiveConnectionStatusBar,
            updateActiveDatabaseStatusBar,
            updateKeepConnectionStatusBar: updateKeepConnectionStatusBarFn,
        },
        onPrefetchConnection: (connectionName) => metadataPrefetchCoordinator.triggerForConnection(connectionName),
        onRefreshCurrentSchemaForDocument: (documentUri) =>
            metadataPrefetchCoordinator.refreshCurrentSchemaForDocument(documentUri, true),
    });

    logger.info(`[perf] Status bars + event handlers: ${(performance.now() - t).toFixed(1)}ms`);
    t = performance.now();

    activateExplorerViews(context, connectionManager, metadataCache, resultPanelProvider);

    const sqlStatementDecoration = createSqlStatementDecoration();
    registerDecorationSubscriptions(context, sqlStatementDecoration);

    const navigationSelector = [...SQL_AUTHORING_LANGUAGE_IDS];
    if (process.env.NODE_ENV === 'test') {
        const navigationProvider = new NetezzaParserNavigationProvider();
        context.subscriptions.push(
            vscode.languages.registerReferenceProvider(navigationSelector, navigationProvider),
            vscode.languages.registerRenameProvider(navigationSelector, new NetezzaRenameProvider()),
        );
    }

    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider(
            navigationSelector,
            new NetezzaDocumentLinkProvider(getExtensionDocumentParseSession(), connectionManager),
        ),
        vscode.languages.registerReferenceProvider(
            navigationSelector,
            new CatalogReferenceProvider(connectionManager),
        ),
    );
    registerCatalogDocumentProvider(context, connectionManager, metadataCache);

    activateEditorSync({
        context,
        connectionManager,
        connectionAccentDecorationProvider,
        resultPanelProvider,
        metadataPrefetchCoordinator,
    });

    logger.info(`[perf] Schema Explorer + providers: ${(performance.now() - t).toFixed(1)}ms`);
    t = performance.now();

    context.subscriptions.push(...registerSchemaCommands({
        context,
        connectionManager,
        metadataCache,
        schemaProvider,
        schemaTreeView,
        tableDdlSynchronizer,
    }));
    context.subscriptions.push(...registerExportCommands({ context, connectionManager, outputChannel }));
    context.subscriptions.push(registerExportToMdCommand({ connectionManager, resultPanelProvider }));
    context.subscriptions.push(...registerImportCommands({ context, connectionManager, metadataCache, outputChannel }));
    context.subscriptions.push(...registerQueryCommands({
        context,
        connectionManager,
        resultPanelProvider,
        tableDdlSynchronizer,
    }));

    deferredFeatureScheduler = new DeferredFeatureScheduler();
    deferredFeatureScheduler.schedule({
        context,
        logger,
        metadataCache,
        connectionManager,
        skipDeferredFeatureInit,
        isExtensionShuttingDown: () => isExtensionShuttingDown,
    });

    context.subscriptions.push(...registerWizardCommands({ context, connectionManager }));
    context.subscriptions.push(...registerCoreCommands({
        context,
        connectionManager,
        metadataCache,
        schemaProvider,
        resultPanelProvider,
        keepConnectionStatusBar,
        getDatabaseList,
        tableDdlSynchronizer,
    }));
    context.subscriptions.push(...registerSqlConsoleCommands({ context, connectionManager }));
    context.subscriptions.push(...await registerCompatibilityCommandAliases());

    logger.info(`[perf] Command registration: ${(performance.now() - t).toFixed(1)}ms`);
    t = performance.now();
    try {
        registerCopilotFeatures({ context, connectionManager, metadataCache, resultPanelProvider });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Netezza extension: Copilot registration failed but activation will continue: ${errorMessage}`);
        void vscode.window.showWarningMessage(
            'JustyBase AI/Copilot could not be initialized. Some AI functions may not work correctly in this session.',
        );
    }

    if (!skipDeferredFeatureInit) {
        void showSensitiveCopilotToolNotice(context).catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`Netezza extension: Could not show Copilot security notice: ${errorMessage}`);
        });
    }

    const sqlParserConfig = getExtensionConfiguration('sqlParser');
    SqlParser.setFastPathThreshold(sqlParserConfig.get<number>('fastPathThreshold', 1572864) ?? 1572864);
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (affectsExtensionConfiguration(e, 'sqlParser.fastPathThreshold')) {
                const updated = getExtensionConfiguration('sqlParser');
                SqlParser.setFastPathThreshold(updated.get<number>('fastPathThreshold', 1572864) ?? 1572864);
            }
        }),
    );

    registerSqlLanguageFeatures({ context, metadataCache, connectionManager });
    void startSqlLanguageClient(context, metadataCache, connectionManager).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Netezza extension: SQL language server failed to start: ${errorMessage}`);
    });

    activateNotebookRegistration(context, connectionManager, logger);

    if (!skipDeferredFeatureInit) {
        const hasShownGettingStarted = getMementoValue(
            context.globalState,
            compatibilityStateKeys.gettingStartedShown,
            false,
        );
        if (!hasShownGettingStarted) {
            await updateMementoValue(context.globalState, compatibilityStateKeys.gettingStartedShown, true);
            void openGettingStartedWalkthrough().catch(() => undefined);
        }
    }

    logger.info(`[perf] Core commands + providers + linter: ${(performance.now() - t).toFixed(1)}ms`);
    const activationEvent = activateTimer.finish({
        result: 'ok',
        metadata: { deferred_init_skipped: skipDeferredFeatureInit },
    });
    logger.info(formatPerformanceEvent(activationEvent));
    logger.info(`[perf] === Total activate(): ${activationEvent.duration_ms.toFixed(1)}ms ===`);
    logWithFallback('info', 'Netezza extension: Activation complete.');
    try {
        const { tempFileRegistry } = await import('./core/tempFileRegistry');
        tempFileRegistry.cleanupOrphanedFiles();
    } catch (e) {
        logWithFallback('warn', 'Failed to cleanup orphaned disk-backed result files:', e);
    }
    return createJustyBaseLiteApi();
}

export async function deactivate() {
    logWithFallback('info', 'Netezza extension: Deactivating...');
    isExtensionShuttingDown = true;
    deferredFeatureScheduler?.dispose();
    deferredFeatureScheduler = undefined;
    await stopSqlLanguageClient();

    try {
        const { cancelAllRunningQueries } = await import('./core/queryRunner');
        await cancelAllRunningQueries();
    } catch (e) {
        logWithFallback('error', 'Error cancelling queries on deactivate:', e);
    }

    try {
        const { QueryHistoryManager } = await import('./core/queryHistoryManager');
        if (QueryHistoryManager.hasInstance()) {
            const historyManager = QueryHistoryManager.getInstance({} as vscode.ExtensionContext);
            await historyManager.close();
        }
    } catch (e) {
        logWithFallback('error', 'Error saving history on deactivate:', e);
    }

    try {
        const { diskBackedStoreRegistry } = await import('./core/resultDataProvider/diskBackedStoreRegistry');
        const { tempFileRegistry } = await import('./core/tempFileRegistry');
        diskBackedStoreRegistry.disposeAll();
        tempFileRegistry.disposeAll();
    } catch (e) {
        logWithFallback('error', 'Error cleaning up disk-backed result stores:', e);
    }

    logWithFallback('info', 'Netezza extension: Deactivation complete.');
}

import * as vscode from 'vscode';
import { ConnectionManager } from '../core/connectionManager';
import { SchemaProvider } from '../providers/schemaProvider';
import { MetadataCache } from '../metadataCache';
import { runQueryRaw } from '../core/queryRunner';
import { Logger } from '../utils/logger';
import {
    createExtensionServices,
    type ExtensionServices,
} from './extensionServices';

export interface CoreServicesActivationResult {
    services: ExtensionServices;
    metadataCacheInit: Promise<void>;
}

/**
 * Creates ConnectionManager, MetadataCache, SchemaProvider and bundles them as ExtensionServices.
 */
export function activateCoreServices(
    context: vscode.ExtensionContext,
    logger: Logger,
): CoreServicesActivationResult {
    let t = performance.now();
    const connectionManager = new ConnectionManager(context);
    logger.info(`[perf] ConnectionManager ctor: ${(performance.now() - t).toFixed(1)}ms`);

    t = performance.now();
    const metadataCache = new MetadataCache(context, connectionManager);
    connectionManager.setMetadataCache(metadataCache);
    logger.info(`[perf] MetadataCache ctor: ${(performance.now() - t).toFixed(1)}ms`);

    const metadataCacheInit = metadataCache.initialize().catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`Netezza extension: Metadata cache initialization failed: ${errorMessage}`);
    });

    t = performance.now();
    const schemaProvider = new SchemaProvider(context, connectionManager, metadataCache);
    logger.info(`[perf] SchemaProvider ctor: ${(performance.now() - t).toFixed(1)}ms`);

    context.subscriptions.push({
        dispose: () => {
            void metadataCache.dispose().catch((error: unknown) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.warn(`Netezza extension: Metadata cache dispose failed: ${errorMessage}`);
            });
        },
    });

    const services = createExtensionServices(
        connectionManager,
        metadataCache,
        schemaProvider,
        logger,
        runQueryRaw,
    );

    return { services, metadataCacheInit };
}

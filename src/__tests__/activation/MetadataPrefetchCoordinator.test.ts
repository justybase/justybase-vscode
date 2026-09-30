import * as vscode from 'vscode';
import { MetadataPrefetchCoordinator } from '../../activation/MetadataPrefetchCoordinator';
import type { ExtensionServices } from '../../activation/extensionServices';
import type { Logger } from '../../utils/logger';

jest.mock('vscode');
jest.mock('../../metadata/connectionScopedMetadataQueryRunner', () => ({
    createConnectionScopedMetadataQueryRunner: jest.fn(() => jest.fn(async () => undefined)),
}));

describe('MetadataPrefetchCoordinator', () => {
    function createCoordinator(isFresh: boolean) {
        const metadataCache = {
            whenDiskReady: jest.fn(async () => undefined),
            isConnectionPrefetchFresh: jest.fn(() => isFresh),
            refreshIncompleteForeignKeyRelationships: jest.fn(async () => undefined),
            triggerConnectionPrefetch: jest.fn(),
        };
        const connectionManager = {
            getConnectionDatabaseKind: jest.fn(() => 'netezza'),
            getConnectionMetadata: jest.fn(() => undefined),
        };
        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
        } as unknown as Logger;
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const services = {
            metadataCache,
            connectionManager,
            queryExecutor: jest.fn(),
        } as unknown as ExtensionServices;
        return {
            coordinator: new MetadataPrefetchCoordinator(context, services, logger),
            metadataCache,
            connectionManager,
            logger,
        };
    }

    it('recovers FK metadata when the core snapshot is fresh', async () => {
        const { coordinator, metadataCache } = createCoordinator(true);
        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.refreshIncompleteForeignKeyRelationships).toHaveBeenCalledWith('NZ', expect.any(Function));
        expect(metadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
    });

    it('runs full prefetch when the core snapshot is stale', async () => {
        const { coordinator, metadataCache, logger } = createCoordinator(false);
        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.triggerConnectionPrefetch).toHaveBeenCalledWith('NZ', expect.any(Function));
        expect(metadataCache.refreshIncompleteForeignKeyRelationships).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Core snapshot expired'));
    });

    it('skips metadata prefetch for unsupported connection types', async () => {
        const { coordinator, metadataCache, connectionManager } = createCoordinator(false);
        connectionManager.getConnectionDatabaseKind.mockReturnValue('sqlite');
        coordinator.triggerForConnection('SQLITE');
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
        expect(metadataCache.refreshIncompleteForeignKeyRelationships).not.toHaveBeenCalled();
    });
});

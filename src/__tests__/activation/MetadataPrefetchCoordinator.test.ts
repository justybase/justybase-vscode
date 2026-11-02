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
            recordConnectionPrefetchSkipped: jest.fn(),
            invalidateCurrentSchema: jest.fn(),
            setCurrentSchema: jest.fn(),
        };
        const connectionManager = {
            getConnectionDatabaseKind: jest.fn(() => 'netezza'),
            getConnectionMetadata: jest.fn(() => undefined),
            getConnectionForExecution: jest.fn(() => 'NZ'),
            getActiveConnectionName: jest.fn(() => undefined),
            getEffectiveDatabase: jest.fn(async () => 'DWH'),
            createTransientConnectionForDocument: jest.fn(),
            getDocumentPersistentConnection: jest.fn(),
        };
        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
        } as unknown as Logger;
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
        const queryExecutor = jest.fn();
        const services = {
            metadataCache,
            connectionManager,
            queryExecutor,
        } as unknown as ExtensionServices;
        return {
            coordinator: new MetadataPrefetchCoordinator(context, services, logger),
            metadataCache,
            connectionManager,
            queryExecutor,
            logger,
        };
    }

    it('recovers FK metadata when the core snapshot is fresh', async () => {
        const { coordinator, metadataCache } = createCoordinator(true);
        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.refreshIncompleteForeignKeyRelationships).toHaveBeenCalledWith('NZ', expect.any(Function));
        expect(metadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
        // The details panel must still get a card for this connection.
        expect(metadataCache.recordConnectionPrefetchSkipped).toHaveBeenCalledWith('NZ', 'fresh');
    });

    it('runs full prefetch when the core snapshot is stale', async () => {
        const { coordinator, metadataCache, logger } = createCoordinator(false);
        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.triggerConnectionPrefetch).toHaveBeenCalledWith('NZ', expect.any(Function));
        expect(metadataCache.refreshIncompleteForeignKeyRelationships).not.toHaveBeenCalled();
        expect(metadataCache.recordConnectionPrefetchSkipped).not.toHaveBeenCalled();
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

    it('reads the current schema on a short-lived connection, never the document session', async () => {
        const { coordinator, metadataCache, connectionManager, queryExecutor } = createCoordinator(true);
        const transient = { close: jest.fn(async () => undefined) };
        connectionManager.createTransientConnectionForDocument.mockResolvedValue(transient);
        queryExecutor.mockResolvedValue({ columns: [{ name: 'CURRENT_SCHEMA' }], data: [['ADMIN']] });

        coordinator.refreshCurrentSchemaForDocument('untitled:Untitled-2', true);
        await new Promise<void>(resolve => setTimeout(resolve, 0));

        expect(connectionManager.createTransientConnectionForDocument)
            .toHaveBeenCalledWith('untitled:Untitled-2', 'NZ');
        expect(queryExecutor).toHaveBeenCalledWith(expect.objectContaining({
            query: 'SELECT CURRENT_SCHEMA',
            silent: true,
            connectionOverride: transient,
        }));
        expect(connectionManager.getDocumentPersistentConnection).not.toHaveBeenCalled();
        expect(transient.close).toHaveBeenCalledTimes(1);
        expect(metadataCache.setCurrentSchema).toHaveBeenCalledWith('NZ', 'DWH', 'ADMIN');
    });
});

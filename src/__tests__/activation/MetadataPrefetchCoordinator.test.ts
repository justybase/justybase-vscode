import * as vscode from 'vscode';
import { MetadataPrefetchCoordinator } from '../../activation/MetadataPrefetchCoordinator';
import type { ExtensionServices } from '../../activation/extensionServices';
import type { DatabaseUsageHistory } from '../../metadata/databaseUsageHistory';
import type { Logger } from '../../utils/logger';

jest.mock('vscode');
jest.mock('../../metadata/connectionScopedMetadataQueryRunner', () => ({
    createConnectionScopedMetadataQueryRunner: jest.fn(() => jest.fn(async () => undefined)),
}));

describe('MetadataPrefetchCoordinator', () => {
    function createCoordinator(
        isFresh: boolean,
        databaseFresh = true,
        popularDatabases: string[] = [],
    ) {
        const metadataCache = {
            whenDiskReady: jest.fn(async () => undefined),
            isConnectionPrefetchFresh: jest.fn(() => isFresh),
            isDatabaseSnapshotFresh: jest.fn((_connectionName: string, _database: string) => databaseFresh),
            refreshIncompleteForeignKeyRelationships: jest.fn(async () => undefined),
            triggerConnectionPrefetch: jest.fn(),
            triggerDatabasePrefetch: jest.fn(
                async (_connectionName: string, _database: string, _runner: unknown) => undefined,
            ),
            recordConnectionPrefetchSkipped: jest.fn(),
            getCurrentSchema: jest.fn(() => 'PUBLIC'),
            invalidateCurrentSchema: jest.fn(),
            setCurrentSchema: jest.fn(),
        };
        const connectionManager = {
            getConnectionDatabaseKind: jest.fn(() => 'netezza'),
            getConnectionMetadata: jest.fn(() => ({ database: 'DWH' })),
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
        const usageHistory = {
            getPopular: jest.fn(() => popularDatabases),
        } as unknown as DatabaseUsageHistory;
        const services = {
            metadataCache,
            connectionManager,
            queryExecutor,
        } as unknown as ExtensionServices;
        return {
            coordinator: new MetadataPrefetchCoordinator(context, services, logger, usageHistory),
            metadataCache,
            connectionManager,
            queryExecutor,
            logger,
            usageHistory,
        };
    }

    it('recovers FK metadata when the core snapshot is fresh', async () => {
        const { coordinator, metadataCache } = createCoordinator(true);
        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.refreshIncompleteForeignKeyRelationships).toHaveBeenCalledWith('NZ', expect.any(Function));
        expect(metadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
        expect(metadataCache.triggerDatabasePrefetch).not.toHaveBeenCalled();
        // The details panel must still get a card for this connection.
        expect(metadataCache.recordConnectionPrefetchSkipped).toHaveBeenCalledWith('NZ', 'fresh');
    });

    it('runs a scoped database prefetch when the database snapshot is stale', async () => {
        const { coordinator, metadataCache } = createCoordinator(false, false);
        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.triggerDatabasePrefetch).toHaveBeenCalledWith(
            'NZ',
            'DWH',
            expect.any(Function),
        );
        expect(metadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
        expect(metadataCache.refreshIncompleteForeignKeyRelationships).not.toHaveBeenCalled();
        expect(metadataCache.recordConnectionPrefetchSkipped).not.toHaveBeenCalled();
    });

    it('warms the active database first, then popular databases without duplicates', async () => {
        const { coordinator, metadataCache, usageHistory } =
            createCoordinator(false, false, ['ARCHIVE', 'DWH']);

        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(usageHistory.getPopular).toHaveBeenCalledWith('NZ', 2);
        expect(metadataCache.triggerDatabasePrefetch.mock.calls.map(call => call[1]))
            .toEqual(['DWH', 'ARCHIVE']);
    });

    it('skips fresh databases and warms only the missing ones', async () => {
        const { coordinator, metadataCache } = createCoordinator(false, true, ['DWH', 'ARCHIVE']);
        metadataCache.isDatabaseSnapshotFresh.mockImplementation(
            (_connectionName: string, database: string) => database === 'DWH',
        );

        coordinator.triggerForConnection('NZ');
        await new Promise<void>(resolve => setImmediate(resolve));
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.triggerDatabasePrefetch).toHaveBeenCalledTimes(1);
        expect(metadataCache.triggerDatabasePrefetch).toHaveBeenCalledWith(
            'NZ',
            'ARCHIVE',
            expect.any(Function),
        );
        expect(metadataCache.recordConnectionPrefetchSkipped).not.toHaveBeenCalled();
    });

    it('skips metadata prefetch for unsupported connection types', async () => {
        const { coordinator, metadataCache, connectionManager } = createCoordinator(false, false);
        connectionManager.getConnectionDatabaseKind.mockReturnValue('sqlite');
        coordinator.triggerForConnection('SQLITE');
        await new Promise<void>(resolve => setImmediate(resolve));

        expect(metadataCache.triggerConnectionPrefetch).not.toHaveBeenCalled();
        expect(metadataCache.triggerDatabasePrefetch).not.toHaveBeenCalled();
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

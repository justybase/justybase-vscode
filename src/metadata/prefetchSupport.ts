import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import type { MetadataConnectionManager } from '../core/connectionManagerPorts';

export function supportsLegacyMetadataPrefetch(kind?: string | DatabaseKind): boolean {
    if (!kind) {
        return true;
    }

    return tryNormalizeDatabaseKind(kind) === 'netezza';
}

/** Resolve the prefetch policy from the persisted profile when available. */
export function supportsLegacyMetadataPrefetchForConnection(
    connectionManager: Pick<MetadataConnectionManager, 'getConnectionDatabaseKind'>
        & Partial<Pick<MetadataConnectionManager, 'getConnectionMetadata'>>
        | undefined,
    connectionName: string,
): boolean {
    const details = connectionManager?.getConnectionMetadata?.(connectionName);
    if (details?.dbType !== undefined) {
        return supportsLegacyMetadataPrefetch(details.dbType);
    }

    return supportsLegacyMetadataPrefetch(
        connectionManager?.getConnectionDatabaseKind(connectionName),
    );
}

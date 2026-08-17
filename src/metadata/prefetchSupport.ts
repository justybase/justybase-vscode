import type { DatabaseKind } from '../contracts/database';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';

export function supportsLegacyMetadataPrefetch(kind?: string | DatabaseKind): boolean {
    if (!kind) {
        return true;
    }

    return tryNormalizeDatabaseKind(kind) === 'netezza';
}

/** Resolve the prefetch policy from the persisted profile when available. */
export function supportsLegacyMetadataPrefetchForConnection(
    connectionManager: Pick<ConnectionManager, 'getConnectionDatabaseKind'>
        & Partial<Pick<ConnectionManager, 'getConnectionMetadata'>>
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

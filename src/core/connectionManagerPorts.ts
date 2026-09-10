import type { DatabaseKind } from '../contracts/database';
import type {
    DatabaseMetadata,
    ObjectWithSchema,
    SchemaMetadata,
    TableMetadata,
} from '../metadata/types';
import type { ConnectionDetails } from '../types';

/** Connection-manager surface needed by metadata persistence and prefetch. */
export interface MetadataConnectionManager {
    getConnectionDatabaseKind(name?: string): DatabaseKind | undefined;
    getConnectionMetadata(name: string): ConnectionDetails | undefined;
    getConnectionNames(): string[];
    getConnection(name: string): Promise<ConnectionDetails | undefined>;
    ensureFullyLoaded(): Promise<void>;
}

/** Cache surface used by ConnectionManager for schema fallback and invalidation. */
export interface ConnectionManagerMetadataCache {
    clearConnectionMetadata(connectionName: string): void;
    getCurrentSchema(connectionName: string, databaseName: string): string | undefined;
    getDatabases(connectionName: string): DatabaseMetadata[] | undefined;
    getSchemas(connectionName: string, dbName: string): SchemaMetadata[] | undefined;
    getTablesAllSchemas(connectionName: string, dbName: string): TableMetadata[] | undefined;
    getObjectsWithSchema(connectionName: string, dbName?: string): ObjectWithSchema[];
}

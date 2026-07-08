/**
 * MetadataCache adapter for SQL validation.
 * Bridges the MetadataCache (used for autocomplete) with SchemaProvider interface (used by SqlValidator).
 */

import type { SchemaProvider } from './schemaProvider'
import type { TableInfo } from './types'
import type { MetadataCache } from '../metadataCache'
import type { ConnectionManager } from '../core/connectionManager'
import { HostSchemaResolver } from './schemaResolver'
import type {
    QualificationProposal,
    TableQualificationRequest,
} from '../core/tableQualificationResolver'

/**
 * Adapter that provides table/column metadata from MetadataCache for SQL validation.
 * Uses the same cache that powers autocomplete.
 */
export class MetadataCacheSchemaProvider implements SchemaProvider {
    private readonly resolver: HostSchemaResolver

    constructor(
        metadataCache: MetadataCache,
        connectionManager: ConnectionManager,
        defaultConnectionName?: string,
        documentUri?: string
    ) {
        this.resolver = new HostSchemaResolver(metadataCache, connectionManager, defaultConnectionName, documentUri)
    }

    /**
     * Get table information by name
     */
    getTable(database: string | undefined, schema: string | undefined, tableName: string): TableInfo | undefined {
        const connectionName = this.resolver.getActiveConnectionName()
        if (!connectionName) {
            return undefined
        }

        const columns = this.resolver.getColumnsFromCache(connectionName, database, schema, tableName)
        if (!columns) {
            return undefined
        }

        return {
            name: tableName,
            database,
            schema,
            isCte: false,
            isTempTable: false,
            columns
        }
    }

    /**
     * Check if a table exists
     */
    tableExists(database: string | undefined, schema: string | undefined, tableName: string): boolean {
        return this.resolver.tableExists(database, schema, tableName)
    }

    canValidateUnqualifiedTableReferences(): boolean {
        return this.resolver.canValidateUnqualifiedTableReferences()
    }

    /**
     * Get all tables in a schema (not implemented - not needed for validation)
     */
    getTablesInSchema(_database: string | undefined, _schema: string): TableInfo[] {
        return []
    }

    getDatabases(): string[] | undefined {
        return this.resolver.getDatabases()
    }

    proposeTableQualification(request: TableQualificationRequest): QualificationProposal[] {
        return this.resolver.proposeTableQualification(request)
    }
}

/**
 * Create a SchemaProvider backed by MetadataCache
 */
export function createMetadataCacheSchemaProvider(
    metadataCache: MetadataCache,
    connectionManager: ConnectionManager,
    defaultConnectionName?: string,
    documentUri?: string
): SchemaProvider {
    return new MetadataCacheSchemaProvider(metadataCache, connectionManager, defaultConnectionName, documentUri)
}

/**
 * Host-side schema resolution backed by MetadataCache and ConnectionManager.
 * Shared table-existence logic used by MetadataCacheSchemaProvider.
 */

import { getDatabaseMetadataProvider } from '../core/connectionFactory'
import type { ConnectionManager } from '../core/connectionManager'
import {
    proposeTableQualification,
    type QualificationProposal,
    type TableQualificationRequest,
} from '../core/tableQualificationResolver'
import type { MetadataCache } from '../metadataCache'
import { extractLabel } from '../metadata/helpers'
import { isQuotedIdentifier, unquoteIdentifier } from '../utils/identifierUtils'
import type { ColumnInfo } from './types'

export class HostSchemaResolver {
    constructor(
        private readonly metadataCache: MetadataCache,
        private readonly connectionManager: ConnectionManager,
        private readonly defaultConnectionName?: string,
        private readonly documentUri?: string
    ) {}

    getActiveConnectionName(): string | undefined {
        if (this.defaultConnectionName) {
            return this.defaultConnectionName
        }

        return this.connectionManager.getActiveConnectionName() ?? undefined
    }

    tableExists(database: string | undefined, schema: string | undefined, tableName: string): boolean {
        const connectionName = this.getActiveConnectionName()
        if (!connectionName) {
            // No active connection -> cannot validate existence.
            return true
        }

        const normalizedDb = database ? unquoteIdentifier(database) : undefined
        const normalizedSchema = schema ? unquoteIdentifier(schema) : undefined
        const normalizedTable = unquoteIdentifier(tableName)
        const upperDb = normalizedDb?.toUpperCase()
        const upperSchema = normalizedSchema?.toUpperCase()
        const upperTable = normalizedTable.toUpperCase()
        const tableNameWasQuoted = isQuotedIdentifier(tableName)
        const mirroredSystemCatalog = this.getMirroredSystemCatalog(connectionName)
        const isMirroredSystemCatalog = mirroredSystemCatalog?.isMirroredObjectName(normalizedTable) ?? false

        const listHasTable = (
            tables: Array<{ OBJNAME?: string; TABLENAME?: string; label?: unknown }> | undefined
        ): boolean | undefined => {
            if (!tables) return undefined

            for (const t of tables) {
                const rawName = (t.OBJNAME || t.TABLENAME || extractLabel(t))
                if (!rawName) continue

                if (tableNameWasQuoted) {
                    if (rawName === normalizedTable) {
                        return true
                    }
                    continue
                }

                if (rawName.toUpperCase() === upperTable) {
                    return true
                }
            }
            return false
        }

        const searchAcrossCachedDatabases = (): boolean | undefined => {
            const dbNames = this.prioritizeSystemDatabase(connectionName, this.getCachedDatabaseNames(connectionName))
            if (dbNames.length === 0) {
                return undefined
            }

            let checkedAny = false
            for (const dbName of dbNames) {
                const res = listHasTable(this.metadataCache.getTablesAllSchemas(connectionName, dbName))
                if (res === undefined) {
                    continue
                }

                checkedAny = true
                if (res) {
                    return true
                }
            }

            return checkedAny ? false : undefined
        }

        // Most precise: DB.SCHEMA.TABLE
        if (upperDb && upperSchema) {
            const tables = this.metadataCache.getTables(connectionName, `${upperDb}.${upperSchema}`)
            const res = listHasTable(tables)
            if (res !== undefined) return res

            // Cache not loaded for this DB.SCHEMA. Check if database is known.
            const dbNames = this.getCachedDatabaseNames(connectionName)
            if (dbNames.length > 0 && !dbNames.includes(upperDb)) {
                return false // database does not exist in cached list
            }
            return true // unknown, be conservative
        }

        // DB..TABLE (schema not specified) -> search across cached schemas in this DB
        if (upperDb && !upperSchema) {
            const allSchemaTables = this.metadataCache.getTablesAllSchemas(connectionName, upperDb)
            const res = listHasTable(allSchemaTables)
            if (res !== undefined) {
                if (res === true || !isMirroredSystemCatalog) {
                    return res
                }

                const mirroredRes = searchAcrossCachedDatabases()
                return mirroredRes ?? true
            }

            // Cache not loaded for this DB. Check if database is known.
            const dbNames = this.getCachedDatabaseNames(connectionName)
            if (dbNames.length > 0 && !dbNames.includes(upperDb)) {
                return false // database does not exist in cached list
            }

            // Fallback for known database: check column cache to determine existence.
            // When getTablesAllSchemas returns undefined (table list not fetched),
            // the column cache may still have data for individual tables.
            if (dbNames.length > 0 && dbNames.includes(upperDb)) {
                const columns = this.getColumnsFromCache(
                    connectionName,
                    database,
                    schema,
                    tableName,
                )
                if (columns !== undefined) {
                    return true // table has cached columns, exists
                }
                // No cached columns for this table in any database -> does not exist
                return false
            }

            return true // unknown, be conservative
        }

        // SCHEMA.TABLE (DB not specified) -> try across cached DBs
        if (!upperDb && upperSchema) {
            const dbNames = this.getCachedDatabaseNames(connectionName)
            if (dbNames.length === 0) return true

            let checkedAny = false
            for (const dbName of dbNames) {
                const res = listHasTable(this.metadataCache.getTables(connectionName, `${dbName}.${upperSchema}`))
                if (res === undefined) continue

                checkedAny = true
                if (res) return true
            }

            return checkedAny ? false : true
        }

        // Unqualified table name.
        // Validate against preferred DB when known; otherwise best-effort across cached DBs.
        const preferredDb = this.getPreferredDatabaseName(connectionName)
        if (preferredDb) {
            const res = listHasTable(this.metadataCache.getTablesAllSchemas(connectionName, preferredDb))
            if (res === true) {
                return true
            }
            if (res !== undefined && !isMirroredSystemCatalog) {
                return res
            }
        }

        const dbNames = this.prioritizeSystemDatabase(connectionName, this.getCachedDatabaseNames(connectionName))
        if (dbNames.length === 0) {
            return true
        }

        let checkedAny = false
        for (const dbName of dbNames) {
            // If preferred DB was already checked, skip duplicate scan.
            if (preferredDb && dbName === preferredDb) continue

            const res = listHasTable(this.metadataCache.getTablesAllSchemas(connectionName, dbName))
            if (res === undefined) continue

            checkedAny = true
            if (res) return true
        }

        return checkedAny ? false : true
    }

    getColumnsFromCache(
        connectionName: string,
        database: string | undefined,
        schema: string | undefined,
        tableName: string
    ): ColumnInfo[] | undefined {
        const normalizedDb = database ? unquoteIdentifier(database) : undefined
        const normalizedSchema = schema ? unquoteIdentifier(schema) : undefined
        const normalizedTable = unquoteIdentifier(tableName)

        const upperDb = normalizedDb?.toUpperCase()
        const upperSchema = normalizedSchema?.toUpperCase()
        const upperTable = normalizedTable.toUpperCase()

        const tableCandidates = isQuotedIdentifier(tableName)
            ? [normalizedTable]
            : Array.from(new Set([upperTable, normalizedTable]))

        if (upperDb && upperSchema) {
            for (const tableCandidate of tableCandidates) {
                const cacheKey = `${upperDb}.${upperSchema}.${tableCandidate}`
                const columns = this.metadataCache.getColumns(connectionName, cacheKey)
                if (columns) {
                    return this.mapColumnsToColumnInfo(columns)
                }
            }
        }

        if (upperDb && !upperSchema) {
            for (const tableCandidate of tableCandidates) {
                const columns = this.metadataCache.getColumnsAnySchema(connectionName, upperDb, tableCandidate)
                if (columns) {
                    return this.mapColumnsToColumnInfo(columns)
                }
            }
        }

        if (upperSchema) {
            const schemaTableKeys = tableCandidates.map(tableCandidate => `${upperSchema}.${tableCandidate}`)
            const dbs = this.metadataCache.getDatabases(connectionName)
            if (dbs) {
                for (const db of dbs) {
                    const dbName = db.DATABASE || db.label
                    if (dbName) {
                        const dbPrefix = dbName.toUpperCase()
                        for (const cacheKey of schemaTableKeys) {
                            const fullKey = `${dbPrefix}.${cacheKey}`
                            const columns = this.metadataCache.getColumns(connectionName, fullKey)
                            if (columns) {
                                return this.mapColumnsToColumnInfo(columns)
                            }
                        }
                    }
                }
            }
        }

        const dbs = this.metadataCache.getDatabases(connectionName)
        if (dbs) {
            const databaseNames = this.prioritizeSystemDatabase(
                connectionName,
                dbs
                    .map(db => db.DATABASE || db.label)
                    .filter((dbName): dbName is string => !!dbName)
                    .map(dbName => dbName.toUpperCase())
            )

            for (const dbName of databaseNames) {
                for (const tableCandidate of tableCandidates) {
                    const columns = this.metadataCache.getColumnsAnySchema(connectionName, dbName, tableCandidate)
                    if (columns) {
                        return this.mapColumnsToColumnInfo(columns)
                    }
                }
            }
        }

        return undefined
    }

    getCachedDatabaseNames(connectionName: string): string[] {
        const dbs = this.metadataCache.getDatabases(connectionName)
        if (!dbs) return []

        return dbs
            .map(db => (db.DATABASE || (db.label as string | undefined))?.toUpperCase())
            .filter((db): db is string => !!db)
    }

    getDatabases(): string[] | undefined {
        const connectionName = this.getActiveConnectionName()
        if (!connectionName) return undefined

        const dbs = this.metadataCache.getDatabases(connectionName)
        if (!dbs) return undefined

        return this.getCachedDatabaseNames(connectionName)
    }

    proposeTableQualification(request: TableQualificationRequest): QualificationProposal[] {
        return proposeTableQualification(
            {
                metadataCache: this.metadataCache,
                connectionManager: this.connectionManager,
                defaultConnectionName: this.defaultConnectionName,
            },
            {
                ...request,
                documentUri: request.documentUri ?? this.documentUri,
            },
        )
    }

    getPreferredDatabaseName(connectionName: string): string | undefined {
        const documentDb = this.documentUri
            ? this.connectionManager.getDocumentDatabase(this.documentUri)
            : undefined
        if (documentDb) {
            return documentDb.toUpperCase()
        }

        const details = this.connectionManager.getConnectionMetadata(connectionName)
        if (details?.database) {
            return details.database.toUpperCase()
        }

        const dbNames = this.getCachedDatabaseNames(connectionName)
        if (dbNames.length === 1) {
            return dbNames[0]
        }

        return undefined
    }

    canValidateUnqualifiedTableReferences(): boolean {
        const connectionName = this.getActiveConnectionName()
        if (!connectionName) return false

        const preferredDb = this.getPreferredDatabaseName(connectionName)
        if (preferredDb && this.metadataCache.getTablesAllSchemas(connectionName, preferredDb)) {
            return true
        }

        const dbNames = this.getCachedDatabaseNames(connectionName)
        return dbNames.some(dbName => this.metadataCache.getTablesAllSchemas(connectionName, dbName) !== undefined)
    }

    private getMirroredSystemCatalog(connectionName: string) {
        const databaseKind = this.connectionManager.getConnectionDatabaseKind?.(connectionName)
        return getDatabaseMetadataProvider(databaseKind).mirroredSystemCatalog
    }

    private prioritizeSystemDatabase(connectionName: string, dbNames: string[]): string[] {
        const uniqueDbNames = Array.from(new Set(dbNames))
        const sourceDatabase = this.getMirroredSystemCatalog(connectionName)?.sourceDatabase
        if (!sourceDatabase) {
            return uniqueDbNames
        }

        const systemIndex = uniqueDbNames.findIndex(dbName => dbName === sourceDatabase)
        if (systemIndex <= 0) {
            return uniqueDbNames
        }

        const [systemDb] = uniqueDbNames.splice(systemIndex, 1)
        return [systemDb, ...uniqueDbNames]
    }

    private mapColumnsToColumnInfo(
        columns: { ATTNAME: string; FORMAT_TYPE?: string; detail?: string }[],
    ): ColumnInfo[] {
        return columns.map(col => ({
            name: col.ATTNAME,
            dataType: col.FORMAT_TYPE || col.detail,
        }))
    }
}

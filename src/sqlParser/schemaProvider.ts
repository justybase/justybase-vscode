import type { TableInfo } from './types'
import type {
    QualificationProposal,
    TableQualificationRequest,
} from '../core/tableQualificationResolver'

/**
 * Schema metadata provider interface for SQL validation.
 * Implementations can provide table and column metadata from various sources
 * (database connection, cached metadata, mock data for tests, etc.)
 */
export interface SchemaProvider {
    /**
     * Get table information by name
     * @param database - Database name (optional)
     * @param schema - Schema name (optional) 
     * @param tableName - Table name (required)
     * @returns TableInfo with columns, or undefined if not found
     */
    getTable(database: string | undefined, schema: string | undefined, tableName: string): TableInfo | undefined

    /**
     * Check if a table exists
     */
    tableExists(database: string | undefined, schema: string | undefined, tableName: string): boolean

    /**
     * Propose fully qualified DB.SCHEMA.TABLE replacements for partially qualified references.
     * Implementations should return an empty list when no concrete cache-backed proposal exists.
     */
    proposeTableQualification?(request: TableQualificationRequest): QualificationProposal[]

    /**
     * Whether this provider can reliably validate existence of unqualified table names
     * (e.g. FROM table_name without DB/SCHEMA).
     */
    canValidateUnqualifiedTableReferences?(): boolean

    /**
     * Get all tables in a schema
     */
    getTablesInSchema?(database: string | undefined, schema: string): TableInfo[]

    /**
     * (Optional) Get list of databases known to the provider.
     * Used for best-effort dialect validations (e.g. detecting invalid DB.TABLE form in Netezza).
     */
    getDatabases?(): string[] | undefined

    /**
     * (Optional) Get known function names from the schema.
     * Used to augment the hardcoded builtin function list with database-specific functions.
     */
    getKnownFunctions?(): ReadonlySet<string> | undefined
}

/**
 * In-memory schema provider for testing and simple use cases.
 * Stores table definitions in memory and provides quick lookup.
 */
export class InMemorySchemaProvider implements SchemaProvider {
    private tables: Map<string, TableInfo> = new Map()
    private _canValidateUnqualified: boolean
    private _knownFunctions: Set<string> | undefined

    constructor(validateUnqualified: boolean = false) {
        this._canValidateUnqualified = validateUnqualified
    }

    /**
     * Add a table definition to the provider
     */
    addTable(table: TableInfo): void {
        const key = this.getTableKey(table.database, table.schema, table.name)
        this.tables.set(key, table)
    }

    /**
     * Add multiple table definitions
     */
    addTables(tables: TableInfo[]): void {
        tables.forEach(table => this.addTable(table))
    }

    /**
     * Create a table with columns from a simple definition
     */
    createTable(
        database: string | undefined,
        schema: string | undefined,
        tableName: string,
        columnNames: string[]
    ): void {
        this.addTable({
            name: tableName,
            database,
            schema,
            isCte: false,
            isTempTable: false,
            columns: columnNames.map(name => ({ name }))
        })
    }

    getTable(database: string | undefined, schema: string | undefined, tableName: string): TableInfo | undefined {
        // Try exact match first
        const exactKey = this.getTableKey(database, schema, tableName)
        const table = this.tables.get(exactKey)
        
        if (table) return table

        // Try with double-dot notation (database..table means database.schema.table)
        if (database && !schema) {
            // Look for any schema matching this database and table
            for (const [, info] of this.tables) {
                if (info.database?.toUpperCase() === database.toUpperCase() &&
                    info.name.toUpperCase() === tableName.toUpperCase()) {
                    return info
                }
            }
        }

        // Try case-insensitive match
        const upperTableName = tableName.toUpperCase()
        for (const [, info] of this.tables) {
            const tableKey = this.getTableKey(info.database, info.schema, info.name)
            const keyParts = tableKey.split('.')
            const keyTableName = keyParts[keyParts.length - 1]
            if (keyTableName === upperTableName) {
                // Check database/schema match if specified
                if (database && info.database?.toUpperCase() !== database.toUpperCase()) continue
                if (schema && info.schema?.toUpperCase() !== schema.toUpperCase()) continue
                return info
            }
        }

        return undefined
    }

    tableExists(database: string | undefined, schema: string | undefined, tableName: string): boolean {
        return this.getTable(database, schema, tableName) !== undefined
    }

    canValidateUnqualifiedTableReferences(): boolean {
        return this._canValidateUnqualified
    }

    getDatabases(): string[] {
        const dbs = new Set<string>()
        for (const [, table] of this.tables) {
            if (table.database) {
                dbs.add(table.database.toUpperCase())
            }
        }
        return [...dbs]
    }

    private getTableKey(database: string | undefined, schema: string | undefined, tableName: string): string {
        const parts: string[] = []
        if (database) parts.push(database.toUpperCase())
        if (schema) parts.push(schema.toUpperCase())
        parts.push(tableName.toUpperCase())
        return parts.join('.')
    }

    /**
     * Clear all stored tables
     */
    clear(): void {
        this.tables.clear()
    }

    /**
     * Add dynamically discovered function names to augment the hardcoded builtins.
     */
    addKnownFunctions(functions: Set<string>): void {
        if (!this._knownFunctions) {
            this._knownFunctions = new Set()
        }
        for (const fn of functions) {
            this._knownFunctions.add(fn)
        }
    }

    getKnownFunctions(): ReadonlySet<string> | undefined {
        return this._knownFunctions
    }

    /**
     * Mark columns as distribution keys for a table.
     */
    markDistributionKeys(database: string | undefined, schema: string | undefined, tableName: string, distKeyNames: string[]): void {
        const table = this.getTable(database, schema, tableName)
        if (!table) return
        const keySet = new Set(distKeyNames.map(c => c.toUpperCase()))
        for (const col of table.columns) {
            if (keySet.has(col.name.toUpperCase())) {
                col.isDistributionKey = true
            }
        }
    }
}

/**
 * Helper function to create a mock schema provider with predefined tables
 */
type MockColumnDefinition =
    | string
    | {
        name: string
        dataType?: string
    }

export function createMockSchemaProvider(tableDefinitions: Array<{
    database?: string
    schema?: string
    name: string
    columns: MockColumnDefinition[]
}>): InMemorySchemaProvider {
    const provider = new InMemorySchemaProvider()
    
    tableDefinitions.forEach(def => {
        const columnNames = def.columns.map((column) =>
            typeof column === 'string' ? column : column.name,
        )
        provider.createTable(def.database, def.schema, def.name, columnNames)
        const table = provider.getTable(def.database, def.schema, def.name)
        if (table) {
            for (const column of def.columns) {
                if (typeof column === 'string') {
                    continue
                }
                const target = table.columns.find(
                    (entry) => entry.name.toUpperCase() === column.name.toUpperCase(),
                )
                if (target && column.dataType) {
                    target.dataType = column.dataType
                }
            }
        }
    })

    return provider
}

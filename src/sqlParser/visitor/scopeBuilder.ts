import type { Scope, TableInfo, CteInfo, ColumnInfo } from '../types'

export class ScopeBuilder {
    private currentScope: Scope
    private scopeStack: Scope[] = []

    constructor() {
        this.currentScope = this.createScope()
    }

    private createScope(parent?: Scope): Scope {
        return {
            tables: new Map(),
            ctes: new Map(),
            parent,
            level: parent ? parent.level + 1 : 0
        }
    }

    enterScope(): Scope {
        const newScope = this.createScope(this.currentScope)
        this.scopeStack.push(this.currentScope)
        this.currentScope = newScope
        return newScope
    }

    exitScope(): Scope | undefined {
        if (this.scopeStack.length === 0) {
            return undefined
        }
        this.currentScope = this.scopeStack.pop()!
        return this.currentScope
    }

    getCurrentScope(): Scope {
        return this.currentScope
    }

    /**
     * Add a table to the current scope.
     * @returns The existing table if a table with the same key already exists, undefined otherwise
     */
    addTable(table: TableInfo): TableInfo | undefined {
        const key = (table.alias || table.name).toUpperCase()
        const existing = this.currentScope.tables.get(key)
        if (existing) {
            return existing
        }
        this.currentScope.tables.set(key, table)
        return undefined
    }

    addCte(cte: CteInfo): void {
        this.currentScope.ctes.set(cte.name.toUpperCase(), cte)
    }

    findTable(name: string): TableInfo | undefined {
        const upperName = name.toUpperCase()

        // First, look in current scope tables
        let table = this.currentScope.tables.get(upperName)
        if (table) {
            // If table has no columns, check if a CTE with the same name exists
            // This handles the case where a CTE is aliased in FROM clause
            if (table.columns.length === 0) {
                let scope: Scope | undefined = this.currentScope
                while (scope) {
                    const cte = scope.ctes.get(upperName)
                    if (cte) return cte
                    scope = scope.parent
                }
            }
            return table
        }

        // Then look in CTEs (visible in current and parent scopes)
        let scope: Scope | undefined = this.currentScope
        while (scope) {
            const cte = scope.ctes.get(upperName)
            if (cte) return cte
            scope = scope.parent
        }

        // Finally look in parent scopes tables
        scope = this.currentScope.parent
        while (scope) {
            table = scope.tables.get(upperName)
            if (table) {
                // If table has no columns, also check CTEs
                if (table.columns.length === 0) {
                    let cteScope: Scope | undefined = scope
                    while (cteScope) {
                        const cte = cteScope.ctes.get(upperName)
                        if (cte) return cte
                        cteScope = cteScope.parent
                    }
                }
                return table
            }
            scope = scope.parent
        }

        return undefined
    }

    findColumn(tableName: string, columnName: string): ColumnInfo | undefined {
        const table = this.findTable(tableName)
        if (!table) return undefined

        const upperColumn = columnName.toUpperCase()
        return table.columns.find(col => 
            col.name.toUpperCase() === upperColumn || 
            col.alias?.toUpperCase() === upperColumn
        )
    }

    getAllVisibleTables(): TableInfo[] {
        const tables: TableInfo[] = []
        const seen = new Set<string>()

        let scope: Scope | undefined = this.currentScope
        while (scope) {
            // Add CTEs first (they take precedence)
            scope.ctes.forEach((cte, name) => {
                if (!seen.has(name)) {
                    tables.push(cte)
                    seen.add(name)
                }
            })

            // Add tables
            scope.tables.forEach((table, name) => {
                if (!seen.has(name)) {
                    tables.push(table)
                    seen.add(name)
                }
            })

            scope = scope.parent
        }

        return tables
    }

    /**
     * Get tables from the current scope only, without parent scopes.
     * Used for ambiguity checking where inner scopes should shadow outer scopes.
     */
    getCurrentScopeTables(): TableInfo[] {
        const tables: TableInfo[] = []
        const seen = new Set<string>()

        // Add CTEs from current scope
        this.currentScope.ctes.forEach((cte, name) => {
            if (!seen.has(name)) {
                tables.push(cte)
                seen.add(name)
            }
        })

        // Add tables from current scope
        this.currentScope.tables.forEach((table, name) => {
            if (!seen.has(name)) {
                tables.push(table)
                seen.add(name)
            }
        })

        return tables
    }

    getAllVisibleColumns(): ColumnInfo[] {
        const columns: ColumnInfo[] = []
        const tables = this.getAllVisibleTables()
        
        tables.forEach(table => {
            columns.push(...table.columns)
        })

        return columns
    }

    reset(): void {
        this.currentScope = this.createScope()
        this.scopeStack = []
    }
}

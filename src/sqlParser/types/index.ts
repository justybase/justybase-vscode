export interface TokenPosition {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
    offset: number
}

export interface ValidationError {
    message: string
    severity: 'error' | 'warning' | 'information' | 'hint'
    position: TokenPosition
    code: string
    suggestedFix?: string
}

export interface ColumnInfo {
    name: string
    alias?: string
    dataType?: string
    position?: TokenPosition
    isDistributionKey?: boolean
}

export interface TableInfo {
    name: string
    alias?: string
    schema?: string
    database?: string
    isCte: boolean
    isTempTable: boolean
    columns: ColumnInfo[]
    position?: TokenPosition
}

export interface CteInfo extends TableInfo {
    recursive: boolean
}

export interface Scope {
    tables: Map<string, TableInfo>
    ctes: Map<string, CteInfo>
    parent?: Scope
    level: number
    position?: TokenPosition
}

export interface ParsedStatement {
    type: 'select' | 'insert' | 'update' | 'delete' | 'create_table' | 'create_temp_table' | 'cte' | 'unknown'
    scope: Scope
    errors: ValidationError[]
}

export interface ValidationResult {
    valid: boolean
    errors: ValidationError[]
    warnings: ValidationError[]
    scope: Scope
}

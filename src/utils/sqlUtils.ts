/**
 * SQL Utilities - Safe SQL string escaping and query building
 * Prevents SQL injection by properly escaping identifiers and literals
 */

/**
 * Escapes a SQL identifier (table name, column name, schema name, etc.)
 * Netezza uses double quotes for identifiers
 * 
 * @param identifier - The identifier to escape
 * @returns Safely escaped identifier
 */
export function escapeSqlIdentifier(identifier: string): string {
    if (!identifier) {
        throw new Error('Identifier cannot be empty');
    }

    // Remove any existing quotes and escape internal quotes
    const cleaned = identifier.replace(/"/g, '""');

    // Wrap in double quotes
    return `"${cleaned}"`;
}

/**
 * Escapes a SQL string literal
 * Netezza uses single quotes for string literals
 * 
 * @param value - The string value to escape
 * @returns Safely escaped string literal with quotes
 */
export function escapeSqlLiteral(value: string): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }

    // Escape single quotes by doubling them (SQL standard)
    const escaped = value.replace(/'/g, "''");

    // Wrap in single quotes
    return `'${escaped}'`;
}

/**
 * Builds a safe WHERE clause from conditions
 * 
 * @param conditions - Object with column names as keys and values as values
 * @param operator - Comparison operator (default: '=')
 * @returns Safe WHERE clause (without 'WHERE' keyword)
 */
export function buildSafeWhereClause(
    conditions: Record<string, string | number | null>,
    operator: '=' | 'LIKE' | 'IN' = '='
): string {
    const clauses: string[] = [];

    for (const [column, value] of Object.entries(conditions)) {
        const safeColumn = escapeSqlIdentifier(column);

        if (value === null || value === undefined) {
            clauses.push(`${safeColumn} IS NULL`);
        } else if (typeof value === 'number') {
            clauses.push(`${safeColumn} ${operator} ${value}`);
        } else {
            const safeValue = escapeSqlLiteral(value);
            clauses.push(`${safeColumn} ${operator} ${safeValue}`);
        }
    }

    return clauses.join(' AND ');
}

/**
 * Safely builds a schema filter clause for queries
 * 
 * @param schemaName - Schema name to filter by (can be null for all schemas)
 * @param columnAlias - Column alias to use (default: 'SCHEMA')
 * @returns Safe SQL filter clause, or empty string if schema is null
 */
export function buildSchemaFilter(schemaName: string | null | undefined, columnAlias: string = 'SCHEMA'): string {
    if (!schemaName) {
        return '';
    }

    const safeSchema = escapeSqlLiteral(schemaName);
    return `AND ${columnAlias} = ${safeSchema}`;
}

/**
 * Safely builds a database filter clause for queries
 * 
 * @param dbName - Database name to filter by
 * @param columnAlias - Column alias to use (default: 'DBNAME')
 * @returns Safe SQL filter clause
 */
export function buildDatabaseFilter(dbName: string, columnAlias: string = 'DBNAME'): string {
    const safeDb = escapeSqlLiteral(dbName);
    return `${columnAlias} = ${safeDb}`;
}

/**
 * Builds a safe IN clause for multiple values
 * 
 * @param column - Column name
 * @param values - Array of values
 * @returns Safe IN clause
 */
export function buildSafeInClause(column: string, values: (string | number)[]): string {
    if (values.length === 0) {
        throw new Error('IN clause requires at least one value');
    }

    const safeColumn = escapeSqlIdentifier(column);
    const safeValues = values.map(v =>
        typeof v === 'number' ? v.toString() : escapeSqlLiteral(v)
    ).join(', ');

    return `${safeColumn} IN (${safeValues})`;
}

/**
 * Maps Netezza / generic SQL column types to SQLite DDL types for spill tables.
 */
export function mapColumnTypeToSqlite(dataType: string | undefined): string {
    if (!dataType) {
        return 'TEXT';
    }

    const normalized = dataType.trim().toUpperCase();

    if (
        normalized.includes('INT')
        || normalized === 'BYTEINT'
        || normalized === 'SMALLINT'
        || normalized === 'BIGINT'
        || normalized === 'BOOLEAN'
    ) {
        return 'INTEGER';
    }

    if (
        normalized.includes('FLOAT')
        || normalized.includes('DOUBLE')
        || normalized.includes('REAL')
        || normalized.includes('DECIMAL')
        || normalized.includes('NUMERIC')
    ) {
        return 'REAL';
    }

    if (normalized.includes('BLOB') || normalized.includes('BINARY') || normalized.includes('BYTEA')) {
        return 'BLOB';
    }

    return 'TEXT';
}

export function sqliteColumnName(index: number): string {
    return `col_${index}`;
}

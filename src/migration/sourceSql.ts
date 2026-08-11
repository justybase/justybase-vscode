import type { DatabaseKind } from '../contracts/database';

const SOURCE_ALIAS = 'MIG_SRC';

export function normalizeMigrationSourceSql(sql: string): string {
    let normalizedSql = sql.trim();
    while (normalizedSql.endsWith(';')) {
        normalizedSql = normalizedSql.slice(0, -1).trimEnd();
    }
    return normalizedSql;
}

/**
 * Wraps a source SQL query for count queries. Oracle does not support `AS` for
 * a derived-table alias, and the
 * alias must start with a letter to remain a valid unquoted Oracle identifier.
 */
export function wrapMigrationSourceSql(
    sql: string,
    sourceKind: DatabaseKind,
    selectClause: string = 'SELECT *',
): string {
    const normalizedSql = normalizeMigrationSourceSql(sql);
    const alias = sourceKind === 'oracle' ? SOURCE_ALIAS : `AS ${SOURCE_ALIAS}`;
    return `${selectClause} FROM (\n${normalizedSql}\n) ${alias}`;
}

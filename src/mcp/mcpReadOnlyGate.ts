import { buildSafeExplainSql } from '../services/copilotTools/aiSqlSafety';

/**
 * Read-only gate for the MCP server.
 *
 * The MCP server never accepts arbitrary SQL from the language model. All
 * catalog queries are constructed internally by {@link CatalogIntrospection}.
 * The only user-supplied SQL entry point is `explain_sql`, which is passed
 * through this gate and only ever runs as `EXPLAIN [VERBOSE] <statement>`
 * where `<statement>` must be a single SELECT or WITH ... SELECT.
 */

export function buildSafeExplainForMcp(sql: string, verbose = false): string {
    return buildSafeExplainSql(sql, verbose);
}

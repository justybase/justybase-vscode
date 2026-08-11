/**
 * Static catalog of MCP server tools (single source of truth).
 *
 * Used by the tool registry (server-side definitions) and by the
 * JustyBase Settings MCP card (display of offered functions).
 */
export interface McpToolCatalogEntry {
    name: string;
    title: string;
    description: string;
}

export const MCP_TOOL_CATALOG: readonly McpToolCatalogEntry[] = [
    {
        name: 'get_databases',
        title: 'List databases',
        description: 'Lists all databases visible to the current Netezza connection.'
    },
    {
        name: 'get_schemas',
        title: 'List schemas',
        description: 'Lists schemas of a database (defaults to the connected database).'
    },
    {
        name: 'get_tables',
        title: 'List tables',
        description: 'Lists tables of a database, optionally filtered by schema.'
    },
    {
        name: 'get_columns',
        title: 'Get table columns',
        description: 'Returns DATABASE|SCHEMA|TABLE_NAME|COLUMN_NAME|DATA_TYPE|NOT_NULL for one or more tables.'
    },
    {
        name: 'get_table_stats',
        title: 'Get table statistics',
        description: 'Returns catalog-only row, skew, distribution and organization statistics for a table.'
    },
    {
        name: 'get_comments',
        title: 'Get table comments',
        description: 'Returns table and optional column comments from Netezza catalog metadata.'
    },
    {
        name: 'get_dependencies',
        title: 'Get object dependencies',
        description: 'Returns foreign-key and view/procedure source references for a catalog object.'
    },
    {
        name: 'get_external_tables',
        title: 'List external tables',
        description: 'Lists external tables and their data-object metadata without reading external data.'
    },
    {
        name: 'get_table_constraints',
        title: 'Get table constraints',
        description: 'Returns PRIMARY KEY, FOREIGN KEY and UNIQUE metadata for a table.'
    },
    {
        name: 'get_procedures',
        title: 'List stored procedures',
        description: 'Lists stored procedures visible in a database, optionally filtered by schema.'
    },
    {
        name: 'get_views',
        title: 'List views',
        description: 'Lists views of a database, optionally filtered by schema (system views excluded).'
    },
    {
        name: 'search_schema',
        title: 'Search schema objects',
        description: 'Searches catalog objects (tables, views, procedures, columns, ...) by name pattern.'
    },
    {
        name: 'get_ddl',
        title: 'Generate DDL',
        description: 'Generates the CREATE statement for tables, views, procedures, external tables, synonyms.'
    },
    {
        name: 'explain_sql',
        title: 'Explain SQL plan',
        description: 'Runs EXPLAIN for a single SELECT or WITH ... SELECT statement (read-only).'
    },
    {
        name: 'analyze_query_plan',
        title: 'Analyze query plan',
        description: 'Runs a read-only EXPLAIN and returns structural nodes, hotspots, risk and recommendations.'
    },
    {
        name: 'validate_sql',
        title: 'Validate SQL with parser',
        description: 'Validates a SQL script with the Netezza parser and linter (no database needed).'
    }
];

export const MCP_SERVER_NAME = 'Netezza MCP Server';
export const MCP_SERVER_ID = 'netezza-schema';
export const MCP_SERVER_VERSION = '1.0.0';

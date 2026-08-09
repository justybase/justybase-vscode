import { CatalogIntrospection } from '../core/catalogIntrospection';
import { SqlValidator } from '../sqlParser/validator';
import { buildSafeExplainForMcp } from './mcpReadOnlyGate';
import { MCP_TOOL_CATALOG, McpToolCatalogEntry } from './mcpToolCatalog';

/**
 * Tool definitions for the Netezza MCP server.
 *
 * Every tool is read-only: catalog introspection queries against `_V_*`
 * views, parser-based SQL validation, and EXPLAIN-plan only execution.
 * User-supplied SQL is accepted exclusively by `explain_sql` and only
 * after the read-only gate (`buildSafeExplainForMcp`) rejects anything
 * that is not a single SELECT or WITH ... SELECT statement.
 */

export interface McpToolDefinition extends McpToolCatalogEntry {
    inputSchema: Record<string, unknown>;
    handler(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const OPTIONAL_STRING = { type: 'string', description: '' };

export function createMcpToolDefinitions(introspection: CatalogIntrospection): McpToolDefinition[] {
    const definitions: McpToolDefinition[] = [];

    const build = (
        name: string,
        inputSchema: Record<string, unknown>,
        handler: McpToolDefinition['handler']
    ): McpToolDefinition => {
        const catalogEntry = MCP_TOOL_CATALOG.find(entry => entry.name === name);
        if (!catalogEntry) {
            throw new Error(`Unknown MCP tool catalog entry: ${name}`);
        }
        return { ...catalogEntry, inputSchema, handler };
    };

    definitions.push(build(
        'get_databases',
        { type: 'object', properties: {}, additionalProperties: false },
        async () => ({ text: await introspection.getDatabases() })
    ));

    definitions.push(build(
        'get_schemas',
        {
            type: 'object',
            properties: { database: { ...OPTIONAL_STRING, description: 'Database name (defaults to connected database)' } },
            additionalProperties: false
        },
        async (args) => ({ text: await introspection.getSchemas(stringArg(args, 'database')) })
    ));

    definitions.push(build(
        'get_tables',
        {
            type: 'object',
            properties: {
                database: { ...OPTIONAL_STRING, description: 'Database name (defaults to connected database)' },
                schema: { ...OPTIONAL_STRING, description: 'Schema name filter' }
            },
            additionalProperties: false
        },
        async (args) => ({
            text: await introspection.getTables(stringArg(args, 'database'), stringArg(args, 'schema'))
        })
    ));

    definitions.push(build(
        'get_columns',
        {
            type: 'object',
            properties: {
                tables: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    description: 'Table names (TABLENAME, SCHEMA.TABLENAME, DATABASE.SCHEMA.TABLENAME or DATABASE..TABLENAME)'
                }
            },
            required: ['tables'],
            additionalProperties: false
        },
        async (args) => {
            const tables = stringArrayArg(args, 'tables');
            if (tables.length === 0) {
                return { text: 'No tables provided.', isError: true };
            }
            return { text: await introspection.getColumns(tables) };
        }
    ));

    definitions.push(build(
        'get_procedures',
        {
            type: 'object',
            properties: {
                database: { ...OPTIONAL_STRING, description: 'Database name (defaults to connected database)' },
                schema: { ...OPTIONAL_STRING, description: 'Schema name filter' }
            },
            additionalProperties: false
        },
        async (args) => ({
            text: await introspection.getProcedures(stringArg(args, 'database'), stringArg(args, 'schema'))
        })
    ));

    definitions.push(build(
        'get_views',
        {
            type: 'object',
            properties: {
                database: { ...OPTIONAL_STRING, description: 'Database name (defaults to connected database)' },
                schema: { ...OPTIONAL_STRING, description: 'Schema name filter' }
            },
            additionalProperties: false
        },
        async (args) => ({
            text: await introspection.getViews(stringArg(args, 'database'), stringArg(args, 'schema'))
        })
    ));

    definitions.push(build(
        'search_schema',
        {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Name pattern (LIKE semantics, case-insensitive)' },
                objectType: {
                    ...OPTIONAL_STRING,
                    description: 'Object type filter: ALL (default), TABLES, VIEW, PROCEDURE, FUNCTION, AGGREGATE, SYNONYM, EXTERNAL TABLE or COLUMNS'
                },
                database: { ...OPTIONAL_STRING, description: 'Database name (defaults to connected database)' }
            },
            required: ['pattern'],
            additionalProperties: false
        },
        async (args) => {
            const pattern = stringArg(args, 'pattern');
            if (!pattern) {
                return { text: 'No search pattern provided.', isError: true };
            }
            return {
                text: await introspection.searchSchema(
                    pattern,
                    stringArg(args, 'objectType') || 'ALL',
                    stringArg(args, 'database')
                )
            };
        }
    ));

    definitions.push(build(
        'get_ddl',
        {
            type: 'object',
            properties: {
                objectName: { type: 'string', description: 'Object name' },
                objectType: {
                    ...OPTIONAL_STRING,
                    description: 'Object type: table (default), view, procedure, external table, synonym, nickname, alias'
                },
                database: { ...OPTIONAL_STRING, description: 'Database name (defaults to connected database)' },
                schema: { ...OPTIONAL_STRING, description: 'Schema name (defaults to ADMIN)' }
            },
            required: ['objectName'],
            additionalProperties: false
        },
        async (args) => {
            const objectName = stringArg(args, 'objectName');
            if (!objectName) {
                return { text: 'No object name provided.', isError: true };
            }
            try {
                return {
                    text: await introspection.getDDL({
                        objectName,
                        objectType: stringArg(args, 'objectType') || 'table',
                        database: stringArg(args, 'database'),
                        schema: stringArg(args, 'schema')
                    })
                };
            } catch (error) {
                return { text: errorText(error), isError: true };
            }
        }
    ));

    definitions.push(build(
        'explain_sql',
        {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'SELECT or WITH ... SELECT statement (no EXPLAIN prefix)' },
                verbose: { type: 'boolean', description: 'Verbose plan (default false)' },
                database: { ...OPTIONAL_STRING, description: 'Database name for cross-database execution (defaults to connected database)' }
            },
            required: ['sql'],
            additionalProperties: false
        },
        async (args) => {
            const sql = stringArg(args, 'sql');
            if (!sql) {
                return { text: 'No SQL statement provided.', isError: true };
            }
            try {
                const explainSql = buildSafeExplainForMcp(sql, booleanArg(args, 'verbose'));
                return { text: await introspection.explain(explainSql, stringArg(args, 'database')) };
            } catch (error) {
                return { text: errorText(error), isError: true };
            }
        }
    ));

    definitions.push(build(
        'validate_sql',
        {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'SQL script to validate' }
            },
            required: ['sql'],
            additionalProperties: false
        },
        async (args) => {
            const sql = stringArg(args, 'sql');
            if (!sql) {
                return { text: 'No SQL provided.', isError: true };
            }
            return { text: validateSqlText(sql) };
        }
    ));

    return definitions;
}

function validateSqlText(sql: string): string {
    const validator = new SqlValidator();
    const result = validator.validate(sql);

    const allIssues = [...result.errors, ...result.warnings];
    if (allIssues.length === 0) {
        return 'SQL parser validation passed. No syntax, semantic, or lint issues found.';
    }

    const maxIssues = 20;
    const lines: string[] = [
        `SQL parser validation found ${result.errors.length} error(s) and ${result.warnings.length} warning(s):`
    ];
    for (const issue of allIssues.slice(0, maxIssues)) {
        lines.push(
            `- ${issue.code} [${issue.severity}] L${issue.position.startLine}:C${issue.position.startColumn} - ${issue.message}`
        );
    }
    if (allIssues.length > maxIssues) {
        lines.push(`- ... ${allIssues.length - maxIssues} more issue(s)`);
    }
    return lines.join('\n');
}

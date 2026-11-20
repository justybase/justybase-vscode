import { CatalogIntrospection } from '../core/catalogIntrospection';
import { SqlCoreBackedValidator } from '../sqlParser/sqlCoreBackedValidator';
import { buildSafeExplainSql, classifySqlStatement, destructiveTarget } from '../core/assistant/sqlAccess';
import {
    executeStatement,
    type ExecuteStatementOptions,
    type ExecuteStatementResult
} from '../core/assistant/executionService';
import {
    emitAudit,
    formatExecuteStatementResult,
    type ToolAuditSink
} from '../core/assistant/audit';
import { getNetezzaAssistantReference } from '../core/assistant/reference';
import { getAssistantTool, type JsonObjectSchema, type ToolTier } from '../core/assistant/toolCatalog';
import {
    normalizeObjectName,
    shortObjectName,
    sqlObjectName
} from '../core/assistant/objectNames';
import type { ToolAccessLevel } from '../core/assistant/toolPolicy';
import { escapeSqlLiteral } from '../utils/sqlUtils';
import { MCP_TOOL_CATALOG, type McpToolCatalogEntry } from './mcpToolCatalog';

/**
 * Tool definitions for the Netezza MCP server.
 *
 * Read tools run catalog queries or a gated EXPLAIN. Write and destructive
 * tools are only registered when the access policy allows them; the policy is
 * resolved before the server is created, so a read-only client never sees
 * them in `tools/list`.
 */

export interface McpToolDefinition extends McpToolCatalogEntry {
    inputSchema: JsonObjectSchema;
    handler(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

export interface McpToolRuntime {
    readonly connectionName?: string;
    /** Profile-level fallback for tests; production passes `accessLevels`. */
    readonly allowWrites?: boolean;
    readonly allowDestructive?: boolean;
    /** Effective capability per canonical tool id, resolved by the access policy. */
    readonly accessLevels?: Readonly<Record<string, ToolAccessLevel>>;
    readonly audit?: ToolAuditSink;
    /** Injected in tests; defaults to a real connection using the introspection details. */
    readonly execute?: (sql: string, options: ExecuteStatementOptions) => Promise<ExecuteStatementResult>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
    }
    return undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
    return typeof args[key] === 'boolean' ? args[key] : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
    const value = args[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function recordArrayArg(args: Record<string, unknown>, key: string): Record<string, unknown>[] {
    const value = args[key];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is Record<string, unknown> => (
        typeof item === 'object' && item !== null && !Array.isArray(item)
    ));
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireArg(args: Record<string, unknown>, key: string, label: string): string {
    const value = stringArg(args, key);
    if (!value) {
        throw new Error(`${label} is required.`);
    }
    return value;
}

function validateSqlText(sql: string): string {
    const validator = new SqlCoreBackedValidator();
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

const OBJECT_TYPE_TO_SQL: Record<string, string> = {
    table: 'TABLE',
    view: 'VIEW',
    procedure: 'PROCEDURE',
    'external table': 'EXTERNAL TABLE',
    synonym: 'SYNONYM',
    nickname: 'NICKNAME',
    alias: 'ALIAS'
};

const OBJECT_SECTION_NAMES = new Set<string>([
    'ddl',
    'columns',
    'comments',
    'stats',
    'constraints',
    'dependencies'
]);

const NAME_PART = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const PROCEDURE_NAME = String.raw`${NAME_PART}(?:\.{1,2}${NAME_PART})*`;
const CREATE_PROCEDURE_RE = new RegExp(
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\s+(${PROCEDURE_NAME})`,
    'iu',
);

function procedureNameFromCreate(sql: string): string | undefined {
    return CREATE_PROCEDURE_RE.exec(sql)?.[1];
}

function buildCallSql(sql: string, callArguments: readonly Record<string, unknown>[]): string {
    const procedure = procedureNameFromCreate(sql);
    if (!procedure) {
        throw new Error('Could not determine the procedure name from the CREATE PROCEDURE block.');
    }
    const target = sqlObjectName({ object: procedure });
    const args = callArguments.map(argument => {
        const type = String(argument.type ?? '').toLowerCase();
        const value = argument.value;
        if (type === 'null') return 'NULL';
        if (type === 'boolean') return value === true || value === 'true' ? 'TRUE' : 'FALSE';
        if (type === 'number') {
            const numeric = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(numeric)) {
                throw new Error(`Invalid numeric CALL argument: ${String(value)}`);
            }
            return String(numeric);
        }
        if (type === 'string' || type === 'date' || type === 'timestamp') {
            return escapeSqlLiteral(String(value ?? ''));
        }
        throw new Error(`Unsupported CALL argument type "${type}".`);
    });
    return `CALL ${target}(${args.join(', ')})`;
}

export function createMcpToolDefinitions(
    introspection: CatalogIntrospection,
    runtime: McpToolRuntime = { allowWrites: false, allowDestructive: false },
    allowedToolIds?: readonly string[]
): McpToolDefinition[] {
    const execute = runtime.execute ?? ((sql: string, options: ExecuteStatementOptions) => (
        introspection.getConnectionDetails().then(details => executeStatement(details, sql, options))
    ));

    const levelFor = (toolId: string): ToolAccessLevel => {
        const explicit = runtime.accessLevels?.[toolId];
        if (explicit !== undefined) return explicit;
        if (runtime.allowDestructive === true) return 'destructive';
        if (runtime.allowWrites === true) return 'write';
        return 'read';
    };

    const runStatement = async (
        sql: string,
        options: ExecuteStatementOptions,
        accessLevel: ToolAccessLevel,
    ): Promise<ExecuteStatementResult> => {
        const classification = classifySqlStatement(sql);
        if (accessLevel === 'off') {
            throw new Error('This tool is disabled for this MCP surface.');
        }
        if (classification.kind === 'destructive' && accessLevel !== 'destructive') {
            throw new Error('Destructive statements require the full access profile for this MCP surface.');
        }
        if (classification.kind === 'write' && accessLevel === 'read') {
            throw new Error('Write statements are disabled for this MCP surface.');
        }
        return execute(classification.statement, options);
    };

    const handlers: Record<string, ToolHandler> = {
        async search_catalog(args) {
            const kind = requireArg(args, 'kind', 'kind');
            const query = stringArg(args, 'query');
            const database = stringArg(args, 'database');
            const schema = stringArg(args, 'schema');
            switch (kind) {
                case 'databases':
                    return { text: await introspection.getDatabases() };
                case 'schemas':
                    return { text: await introspection.getSchemas(database) };
                case 'tables':
                    return { text: await introspection.getTables(database, schema) };
                case 'views':
                    return { text: await introspection.getViews(database, schema) };
                case 'procedures':
                    return { text: await introspection.getProcedures(database, schema) };
                case 'external_tables':
                    return { text: await introspection.getExternalTables(database, schema, query) };
                case 'columns':
                    if (!query) throw new Error('query is required when kind is "columns".');
                    return { text: await introspection.searchSchema(query, 'COLUMNS', database) };
                case 'all':
                    if (!query) throw new Error('query is required when kind is "all".');
                    return { text: await introspection.searchSchema(query, 'ALL', database) };
                default:
                    throw new Error(`Unsupported catalog kind "${kind}".`);
            }
        },

        async get_object(args) {
            const object = requireArg(args, 'object', 'object');
            const objectType = (stringArg(args, 'objectType') ?? 'table').toLowerCase();
            const sqlType = OBJECT_TYPE_TO_SQL[objectType];
            if (!sqlType) {
                throw new Error(`Unsupported objectType "${objectType}".`);
            }
            const database = stringArg(args, 'database');
            const schema = stringArg(args, 'schema');
            const qualifiedObject = normalizeObjectName({ object, database, schema });
            const requested = stringArrayArg(args, 'sections');
            const sections = requested.length > 0 ? requested : ['ddl', 'columns'];
            const unsupported = sections.filter(section => !OBJECT_SECTION_NAMES.has(section));
            if (unsupported.length > 0) {
                throw new Error(
                    `Unsupported section(s): ${unsupported.join(', ')}. Allowed: ${[...OBJECT_SECTION_NAMES].join(', ')}.`
                );
            }
            const results: string[] = [];
            let failed = false;

            for (const section of sections) {
                const label = section.toUpperCase();
                try {
                    results.push(`## ${label}\n${await readObjectSection(section)}`);
                } catch (error: unknown) {
                    failed = true;
                    results.push(`## ${label}\nError: ${errorText(error)}`);
                }
            }
            return { text: results.join('\n\n'), ...(failed ? { isError: true } : {}) };

            async function readObjectSection(section: string): Promise<string> {
                switch (section) {
                    case 'ddl':
                        return introspection.getDDL({ objectName: object, objectType, database, schema });
                    case 'columns':
                        return introspection.getColumns([qualifiedObject], database);
                    case 'comments':
                        return introspection.getComments(object, database, schema, true);
                    case 'stats':
                        if (objectType !== 'table' && objectType !== 'external table') {
                            return `Skipped: statistics are available for tables and external tables, not "${objectType}".`;
                        }
                        return introspection.getTableStats(qualifiedObject, database);
                    case 'constraints':
                        if (objectType !== 'table') {
                            return `Skipped: constraints are available for tables, not "${objectType}".`;
                        }
                        return introspection.getTableConstraints(object, database, schema);
                    case 'dependencies':
                        if (objectType !== 'table' && objectType !== 'view' && objectType !== 'procedure') {
                            return `Skipped: dependencies are available for tables, views and procedures, not "${objectType}".`;
                        }
                        return introspection.getDependencies(qualifiedObject, database, sqlType);
                    default:
                        return `Unsupported section "${section}".`;
                }
            }
        },

        async explain_query(args) {
            const sql = requireArg(args, 'sql', 'sql');
            const explainSql = buildSafeExplainSql(sql, booleanArg(args, 'verbose') === true);
            const database = stringArg(args, 'database');
            const analyze = booleanArg(args, 'analyze') !== false;
            return {
                text: analyze
                    ? await introspection.analyzeQueryPlan(explainSql, database)
                    : await introspection.explain(explainSql, database)
            };
        },

        async validate_sql(args) {
            const sql = requireArg(args, 'sql', 'sql');
            const mode = (stringArg(args, 'mode') ?? 'parser').toLowerCase();
            if (mode === 'parser') {
                return { text: validateSqlText(sql) };
            }
            if (mode === 'database') {
                const explainSql = buildSafeExplainSql(sql);
                const plan = await introspection.explain(explainSql, stringArg(args, 'database'));
                return { text: `Database validation succeeded (EXPLAIN plan):\n\n${plan}` };
            }
            throw new Error(`Unsupported validation mode "${mode}".`);
        },

        async get_reference(args) {
            const topic = (stringArg(args, 'topic') ?? 'all') as 'optimization' | 'nzplsql' | 'all';
            return { text: getNetezzaAssistantReference(topic) };
        },

        async execute_sql(args) {
            const sql = requireArg(args, 'sql', 'sql');
            const accessLevel = levelFor('execute_sql');
            const classification = classifySqlStatement(sql);
            if (classification.kind === 'destructive') {
                if (accessLevel !== 'destructive') {
                    throw new Error('Destructive statements require the full access profile for this MCP surface.');
                }
                const target = destructiveTarget(classification.statement);
                if (!target) {
                    throw new Error(
                        'The destructive statement target could not be determined. Use a supported DROP/TRUNCATE/CALL statement or the drop_object tool.'
                    );
                }
                const confirm = stringArg(args, 'confirm');
                if (!confirm) {
                    throw new Error(`Destructive statements require confirm equal to "${target}".`);
                }
                if (confirm.toLowerCase() !== target.toLowerCase()) {
                    throw new Error(`confirm must equal the object name "${target}".`);
                }
            }
            const result = await runStatement(sql, {
                maxRows: numberArg(args, 'maxRows'),
                timeoutMs: numberArg(args, 'timeoutMs'),
                database: stringArg(args, 'database')
            }, accessLevel);
            return { text: formatExecuteStatementResult(result) };
        },

        async drop_object(args) {
            const accessLevel = levelFor('drop_object');
            if (accessLevel !== 'destructive') {
                throw new Error('Destructive statements require the full access profile for this MCP surface.');
            }
            const object = requireArg(args, 'object', 'object');
            const objectType = requireArg(args, 'objectType', 'objectType').toLowerCase();
            const sqlType = OBJECT_TYPE_TO_SQL[objectType];
            if (!sqlType) {
                throw new Error(`Unsupported objectType "${objectType}".`);
            }
            const confirm = requireArg(args, 'confirm', 'confirm');
            const shortName = shortObjectName(object) ?? '';
            if (confirm.trim().toLowerCase() !== shortName.toLowerCase()) {
                throw new Error('confirm must repeat the object name exactly.');
            }
            const target = sqlObjectName({
                object,
                database: stringArg(args, 'database'),
                schema: stringArg(args, 'schema')
            });
            const sql = `DROP ${sqlType} ${target}${booleanArg(args, 'cascade') === true ? ' CASCADE' : ''}`;
            const result = await runStatement(sql, {}, accessLevel);
            return { text: formatExecuteStatementResult(result) };
        },

        async compile_procedure(args) {
            const sql = stringArg(args, 'sql');
            if (!sql) {
                throw new Error('sql with a CREATE PROCEDURE block is required.');
            }
            if (!/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?PROCEDURE\b/iu.test(sql)) {
                throw new Error('The statement must be a CREATE [OR REPLACE] PROCEDURE block.');
            }
            const mode = stringArg(args, 'mode') ?? 'compile_only';
            if (mode !== 'compile_only' && mode !== 'compile_and_call') {
                throw new Error(`Unsupported compile mode "${mode}".`);
            }
            const accessLevel = levelFor('compile_procedure');
            if (mode === 'compile_and_call') {
                if (!Array.isArray(args.callArguments)) {
                    throw new Error(
                        'callArguments is required for compile_and_call (use [] for a no-argument procedure).'
                    );
                }
                if (accessLevel !== 'destructive') {
                    throw new Error('compile_and_call requires the full access profile for this MCP surface.');
                }
                const procedure = procedureNameFromCreate(sql);
                const target = procedure ? shortObjectName(procedure) : undefined;
                if (!target) {
                    throw new Error('Could not determine the procedure name from the CREATE PROCEDURE block.');
                }
                const confirm = stringArg(args, 'confirm');
                if (!confirm || confirm.toLowerCase() !== target.toLowerCase()) {
                    throw new Error(`compile_and_call requires confirm equal to the procedure name "${target}".`);
                }
            }
            const compiled = await runStatement(sql, {}, accessLevel);
            const lines = [formatExecuteStatementResult(compiled)];
            if (mode === 'compile_and_call') {
                const callSql = buildCallSql(sql, recordArrayArg(args, 'callArguments'));
                const called = await runStatement(callSql, { maxRows: 500 }, accessLevel);
                lines.push('Test CALL:', formatExecuteStatementResult(called));
            }
            return { text: lines.join('\n\n') };
        }
    };

    const allowed = allowedToolIds === undefined ? undefined : new Set(allowedToolIds);
    const definitions: McpToolDefinition[] = [];

    for (const entry of MCP_TOOL_CATALOG) {
        if (allowed && !allowed.has(entry.name)) continue;
        const definition = getAssistantTool(entry.name);
        if (!definition) {
            throw new Error(`Unknown assistant tool: ${entry.name}`);
        }
        const handler = handlers[entry.name];
        if (!handler) {
            throw new Error(`Missing MCP handler for tool: ${entry.name}`);
        }
        definitions.push({
            ...entry,
            inputSchema: definition.inputSchema,
            handler: withAudit(entry.name, entry.tier, handler)
        });
    }

    return definitions;

    function withAudit(name: string, tier: ToolTier, handler: ToolHandler): ToolHandler {
        return async args => {
            const startedAt = Date.now();
            try {
                const result = await handler(args);
                emitAudit(runtime.audit, {
                    tool: name,
                    tier,
                    surface: 'mcp',
                    connectionName: runtime.connectionName,
                    durationMs: Date.now() - startedAt,
                    ok: result.isError !== true
                });
                return result;
            } catch (error: unknown) {
                emitAudit(runtime.audit, {
                    tool: name,
                    tier,
                    surface: 'mcp',
                    connectionName: runtime.connectionName,
                    durationMs: Date.now() - startedAt,
                    ok: false,
                    error: errorText(error)
                });
                return { text: errorText(error), isError: true };
            }
        };
    }
}

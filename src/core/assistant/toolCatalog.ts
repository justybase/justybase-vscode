/**
 * Canonical catalog of JustyBase assistant tools.
 *
 * One definition drives both surfaces:
 * - VS Code language-model tools (`contributes.languageModelTools` / `vscode.lm`),
 * - the bundled Netezza MCP server (`dist/mcp/mcpServer.js`).
 *
 * The catalog is intentionally free of `vscode` imports so the standalone MCP
 * process can consume it.
 */

export type ToolTier = 'read' | 'write' | 'destructive';

export type ToolSurface = 'copilot' | 'mcp' | 'mcpExternal';

export interface JsonObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface AssistantToolDefinition {
  /** Canonical id. MCP tool names use it verbatim; Copilot uses `netezza_<id>`. */
  readonly id: string;
  readonly title: string;
  /** Model-facing description shared by both surfaces. */
  readonly description: string;
  readonly tier: ToolTier;
  readonly surfaces: readonly ToolSurface[];
  readonly requiresConnection: boolean;
  readonly inputSchema: JsonObjectSchema;
}

const string = (description: string): Record<string, unknown> => ({ type: 'string', description });
const optionalString = (description: string): Record<string, unknown> => ({ type: 'string', description });
const boolean = (description: string): Record<string, unknown> => ({ type: 'boolean', description });
const number = (description: string): Record<string, unknown> => ({ type: 'number', description });
const enumString = (values: readonly string[], description: string): Record<string, unknown> => ({
  type: 'string',
  enum: [...values],
  description,
});

function object(
  properties: Record<string, Record<string, unknown>>,
  required: readonly string[] = [],
): JsonObjectSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    additionalProperties: false,
  };
}

export const OBJECT_SECTIONS = [
  'ddl',
  'columns',
  'comments',
  'stats',
  'constraints',
  'dependencies',
] as const;

export type ObjectSection = (typeof OBJECT_SECTIONS)[number];

export const CATALOG_SEARCH_KINDS = [
  'databases',
  'schemas',
  'tables',
  'views',
  'procedures',
  'external_tables',
  'columns',
  'all',
] as const;

export type CatalogSearchKind = (typeof CATALOG_SEARCH_KINDS)[number];

export const ASSISTANT_TOOL_CATALOG: readonly AssistantToolDefinition[] = [
  {
    id: 'get_context',
    title: 'Get SQL Context',
    description:
      'Collects the current SQL text or selection, the active connection and dialect, DDL for referenced tables, and current parser/linter diagnostics. Use it first when the user asks about "this query", "the current SQL", or a diagnostic.',
    tier: 'read',
    surfaces: ['copilot'],
    requiresConnection: false,
    inputSchema: object({
      sql: optionalString('Optional SQL text. When omitted, the active editor content or selection is used.'),
      includeSchema: boolean('Include DDL for referenced tables (default true).'),
      includeDiagnostics: boolean('Include current parser/linter diagnostics (default true).'),
    }),
  },
  {
    id: 'search_catalog',
    title: 'Search Catalog',
    description:
      'Unified catalog discovery for the connected Netezza database. Choose kind to list databases, schemas, tables, views, procedures or external tables, search columns, or search all objects by name pattern.',
    tier: 'read',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: true,
    inputSchema: object(
      {
        kind: enumString(CATALOG_SEARCH_KINDS, 'What to list or search.'),
        query: optionalString('Name pattern for columns/all searches (case-insensitive contains match).'),
        database: optionalString('Database name. Defaults to the connected database.'),
        schema: optionalString('Schema filter for tables, views, procedures and external tables.'),
      },
      ['kind'],
    ),
  },
  {
    id: 'get_object',
    title: 'Get Object Details',
    description:
      'Returns one or more sections for a single catalog object in one call: DDL, columns, comments, table statistics, constraints and dependencies. Prefer this over several narrow metadata calls.',
    tier: 'read',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: true,
    inputSchema: object(
      {
        object: string('Object name (TABLE, SCHEMA.TABLE, DATABASE..TABLE or DATABASE.SCHEMA.TABLE).'),
        objectType: enumString(
          ['table', 'view', 'procedure', 'external table', 'synonym', 'nickname', 'alias'],
          'Object type (default table).',
        ),
        database: optionalString('Database name. Defaults to the connected database.'),
        schema: optionalString('Schema name when the object is unqualified.'),
        sections: {
          type: 'array',
          items: { type: 'string', enum: [...OBJECT_SECTIONS] },
          description: 'Sections to return. Default: ddl, columns.',
        },
      },
      ['object'],
    ),
  },
  {
    id: 'explain_query',
    title: 'Explain Query',
    description:
      'Runs a read-only EXPLAIN for a single SELECT or WITH ... SELECT statement and returns the plan, structural hotspots and recommendations. Never executes the statement itself.',
    tier: 'read',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: true,
    inputSchema: object(
      {
        sql: string('A single SELECT or WITH ... SELECT statement. Do not include an EXPLAIN prefix.'),
        verbose: boolean('Request EXPLAIN VERBOSE (default false).'),
        analyze: boolean('Return structured analysis with hotspots and recommendations (default true).'),
        database: optionalString('Database name. Defaults to the connected database.'),
      },
      ['sql'],
    ),
  },
  {
    id: 'validate_sql',
    title: 'Validate SQL',
    description:
      'Validates a SQL script. mode=parser runs the offline Netezza parser/linter; mode=database additionally asks the server to validate the statement through a read-only EXPLAIN.',
    tier: 'read',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: false,
    inputSchema: object(
      {
        sql: string('SQL text to validate.'),
        mode: enumString(['parser', 'database'], 'Validation mode (default parser).'),
        database: optionalString('Database name for mode=database.'),
      },
      ['sql'],
    ),
  },
  {
    id: 'get_reference',
    title: 'Get Dialect Reference',
    description:
      'Returns the Netezza reference for SQL authoring, NZPLSQL procedures, or performance tuning. Use it before writing dialect-specific syntax or procedures.',
    tier: 'read',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: false,
    inputSchema: object({
      topic: enumString(['optimization', 'nzplsql', 'all'], 'Reference topic (default all).'),
    }),
  },
  {
    id: 'inspect_import_file',
    title: 'Inspect Import File',
    description:
      'Inspects a local delimited or spreadsheet file without importing it: columns, inferred types, sample rows and delimiter/encoding hints.',
    tier: 'read',
    surfaces: ['copilot'],
    requiresConnection: false,
    inputSchema: object(
      {
        filePath: string('Absolute path to the file to inspect.'),
        sampleRows: number('Number of sample rows (default 5).'),
      },
      ['filePath'],
    ),
  },
  {
    id: 'propose_import_mapping',
    title: 'Propose Import Mapping',
    description:
      'Proposes a column mapping and staging/target DDL for importing a local file into a Netezza table. It never executes the import.',
    tier: 'read',
    surfaces: ['copilot'],
    requiresConnection: true,
    inputSchema: object(
      {
        filePath: string('Absolute path to the file to import.'),
        targetTable: string('Target table name.'),
      },
      ['filePath', 'targetTable'],
    ),
  },
  {
    id: 'execute_sql',
    title: 'Execute SQL',
    description:
      'Executes exactly one SQL statement on the selected Netezza connection. SELECT returns capped rows; DML/DDL returns the affected row count. Destructive statements require the destructive tier and an explicit confirm value.',
    tier: 'write',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: true,
    inputSchema: object(
      {
        sql: string('Exactly one SQL statement.'),
        maxRows: number('Maximum rows returned for SELECT (default 500, max 5000).'),
        timeoutMs: number('Command timeout in milliseconds (default 60000).'),
        database: optionalString('Database to execute in. Defaults to the selected connection database.'),
        confirm: optionalString(
          'Required for destructive statements: the object name being dropped or truncated.',
        ),
      },
      ['sql'],
    ),
  },
  {
    id: 'drop_object',
    title: 'Drop Object',
    description:
      'Drops a single Netezza object with an explicit confirmation value. This is destructive: it requires the destructive tier and confirm equal to the object name.',
    tier: 'destructive',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: true,
    inputSchema: object(
      {
        object: string('Object name to drop.'),
        objectType: enumString(
          ['table', 'view', 'procedure', 'external table', 'synonym', 'nickname', 'alias'],
          'Object type.',
        ),
        cascade: boolean('Add CASCADE (default false).'),
        database: optionalString('Database name. Defaults to the connected database.'),
        confirm: string('Must repeat the object name exactly (case-insensitive).'),
      },
      ['object', 'objectType', 'confirm'],
    ),
  },
  {
    id: 'compile_procedure',
    title: 'Compile Procedure',
    description:
      'Creates or replaces a Netezza NZPLSQL procedure from the supplied CREATE PROCEDURE block. Use mode=compile_and_call to run a test CALL; that CALL may modify data and is confirmed separately.',
    tier: 'write',
    surfaces: ['copilot', 'mcp', 'mcpExternal'],
    requiresConnection: true,
    inputSchema: object(
      {
        sql: optionalString('CREATE PROCEDURE block. When omitted, the active editor selection is used.'),
        mode: enumString(['compile_only', 'compile_and_call'], 'Compile only, or compile and run a test CALL.'),
        callArguments: {
          type: 'array',
          description: 'Typed arguments for the test CALL when mode=compile_and_call.',
          items: { type: 'object', additionalProperties: true },
        },
      },
      ['mode'],
    ),
  },
];

const TOOL_BY_ID = new Map(ASSISTANT_TOOL_CATALOG.map(tool => [tool.id, tool]));

export function getAssistantTool(id: string): AssistantToolDefinition | undefined {
  return TOOL_BY_ID.get(id);
}

/** VS Code language-model tool names are namespaced to avoid collisions. */
export function copilotToolName(id: string): string {
  return `netezza_${id}`;
}

export function copilotToolId(toolName: string): string {
  return toolName.startsWith('netezza_') ? toolName.slice('netezza_'.length) : toolName;
}

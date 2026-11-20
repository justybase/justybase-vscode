jest.unmock('chevrotain');

import { CatalogIntrospection } from '../../core/catalogIntrospection';
import { MCP_TOOL_CATALOG } from '../../mcp/mcpToolCatalog';
import { createMcpToolDefinitions, type McpToolDefinition, type McpToolRuntime } from '../../mcp/mcpToolRegistry';
import { jsonSchemaToZod } from '../../mcp/mcpServerCore';
import type { ExecuteStatementResult } from '../../core/assistant/executionService';
import type { ToolAuditEvent } from '../../core/assistant/audit';

function createFakeIntrospection(): CatalogIntrospection {
    return {
        getDatabases: jest.fn().mockResolvedValue('[{ "DATABASE": "DWH" }]'),
        getSchemas: jest.fn().mockResolvedValue('[]'),
        getTables: jest.fn().mockResolvedValue('[]'),
        getColumns: jest.fn().mockResolvedValue('DATABASE|SCHEMA|TABLE_NAME|COLUMN_NAME|DATA_TYPE|NOT_NULL'),
        getTableStats: jest.fn().mockResolvedValue('{"tableName":"ORDERS"}'),
        getComments: jest.fn().mockResolvedValue('{"columns":[]}'),
        getDependencies: jest.fn().mockResolvedValue('{"dependencies":[]}'),
        getExternalTables: jest.fn().mockResolvedValue('[]'),
        getTableConstraints: jest.fn().mockResolvedValue('{"constraints":[]}'),
        getProcedures: jest.fn().mockResolvedValue('[]'),
        getViews: jest.fn().mockResolvedValue('[]'),
        searchSchema: jest.fn().mockResolvedValue('[]'),
        getDDL: jest.fn().mockResolvedValue('## DDL'),
        explain: jest.fn().mockResolvedValue('Plan'),
        analyzeQueryPlan: jest.fn().mockResolvedValue('{"summary":{"overallRisk":"low"}}'),
        getConnectionDetails: jest.fn().mockResolvedValue({ host: 'h', database: 'DWH' })
    } as unknown as CatalogIntrospection;
}

function result(overrides: Partial<ExecuteStatementResult> = {}): ExecuteStatementResult {
    return {
        kind: 'read',
        columns: ['X'],
        rows: [[1]],
        rowCount: 1,
        affectedRows: 0,
        truncated: false,
        notices: [],
        ...overrides
    };
}

function toolByName(tools: readonly McpToolDefinition[], name: string): McpToolDefinition {
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`Missing tool ${name}`);
    return tool;
}

describe('MCP tool registry', () => {
    const introspection = createFakeIntrospection();
    const execute = jest.fn();
    let tools: McpToolDefinition[];

    const writableRuntime: McpToolRuntime = {
        allowWrites: true,
        allowDestructive: true,
        execute: (sql, options) => execute(sql, options)
    };

    beforeAll(() => {
        tools = createMcpToolDefinitions(introspection, writableRuntime);
    });

    beforeEach(() => {
        jest.clearAllMocks();
        execute.mockResolvedValue(result());
    });

    it('exposes exactly the catalog tools', () => {
        expect(tools.map(tool => tool.name).sort()).toEqual(
            MCP_TOOL_CATALOG.map(tool => tool.name).sort()
        );
        expect(tools).toHaveLength(MCP_TOOL_CATALOG.length);
        for (const tool of tools) {
            expect(tool.inputSchema.type).toBe('object');
            expect(typeof tool.handler).toBe('function');
        }
    });

    it('filters the registered tools to the effective policy', () => {
        const filtered = createMcpToolDefinitions(introspection, writableRuntime, ['search_catalog', 'get_object']);
        expect(filtered.map(tool => tool.name)).toEqual(['search_catalog', 'get_object']);
    });

    it('routes every catalog search kind', async () => {
        const tool = toolByName(tools, 'search_catalog');
        await tool.handler({ kind: 'databases' });
        await tool.handler({ kind: 'schemas', database: 'DWH' });
        await tool.handler({ kind: 'tables', database: 'DWH', schema: 'ADMIN' });
        await tool.handler({ kind: 'views', database: 'DWH' });
        await tool.handler({ kind: 'procedures', database: 'DWH' });
        await tool.handler({ kind: 'external_tables', database: 'DWH' });
        await tool.handler({ kind: 'columns', query: 'NAME' });
        await tool.handler({ kind: 'all', query: 'NAME' });

        expect(introspection.getTables).toHaveBeenCalledWith('DWH', 'ADMIN');
        expect(introspection.searchSchema).toHaveBeenCalledWith('NAME', 'COLUMNS', undefined);
        expect(introspection.searchSchema).toHaveBeenCalledWith('NAME', 'ALL', undefined);
    });

    it('requires a query for column and object searches', async () => {
        const result = await toolByName(tools, 'search_catalog').handler({ kind: 'columns' });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('query is required');
    });

    it('reads default and requested object sections', async () => {
        const tool = toolByName(tools, 'get_object');
        const defaults = await tool.handler({ object: 'ADMIN.ORDERS' });
        expect(defaults.isError).toBeUndefined();
        expect(introspection.getDDL).toHaveBeenCalledWith({
            objectName: 'ADMIN.ORDERS',
            objectType: 'table',
            database: undefined,
            schema: undefined
        });
        expect(introspection.getColumns).toHaveBeenCalledWith(['ADMIN.ORDERS'], undefined);

        await tool.handler({
            object: 'ADMIN.ORDERS',
            sections: ['stats', 'constraints', 'dependencies']
        });
        expect(introspection.getTableStats).toHaveBeenCalledWith('ADMIN.ORDERS', undefined);
        expect(introspection.getTableConstraints).toHaveBeenCalledWith('ADMIN.ORDERS', undefined, undefined);
        expect(introspection.getDependencies).toHaveBeenCalledWith('ADMIN.ORDERS', undefined, 'TABLE');
    });

    it('qualifies sections with an explicit schema and database', async () => {
        const tool = toolByName(tools, 'get_object');
        await tool.handler({
            object: 'ORDERS',
            database: 'DWH',
            schema: 'ADMIN',
            sections: ['columns', 'stats', 'dependencies']
        });

        expect(introspection.getColumns).toHaveBeenCalledWith(['DWH.ADMIN.ORDERS'], 'DWH');
        expect(introspection.getTableStats).toHaveBeenCalledWith('DWH.ADMIN.ORDERS', 'DWH');
        expect(introspection.getDependencies).toHaveBeenCalledWith('DWH.ADMIN.ORDERS', 'DWH', 'TABLE');
    });

    it('rejects DML through explain_query', async () => {
        const result = await toolByName(tools, 'explain_query').handler({ sql: 'DELETE FROM t' });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/SELECT or WITH|planner-safe/i);
        expect(introspection.explain).not.toHaveBeenCalled();
        expect(introspection.analyzeQueryPlan).not.toHaveBeenCalled();
    });

    it('passes gated EXPLAIN SQL to the introspection', async () => {
        const analyzed = await toolByName(tools, 'explain_query').handler({ sql: 'SELECT * FROM admin.orders' });
        expect(analyzed.isError).toBeUndefined();
        expect(introspection.analyzeQueryPlan).toHaveBeenCalledWith('EXPLAIN SELECT * FROM admin.orders', undefined);

        const raw = await toolByName(tools, 'explain_query').handler({
            sql: 'SELECT 1',
            verbose: true,
            analyze: false
        });
        expect(raw.isError).toBeUndefined();
        expect(introspection.explain).toHaveBeenCalledWith('EXPLAIN VERBOSE SELECT 1', undefined);
    });

    it.each([
        'SELECT * INTO backup FROM admin.orders',
        'SELECT * FROM admin.orders FOR UPDATE'
    ])('blocks table-materializing and row-locking SQL: %s', async sql => {
        const result = await toolByName(tools, 'explain_query').handler({ sql });
        expect(result.isError).toBe(true);
        expect(introspection.explain).not.toHaveBeenCalled();
        expect(introspection.analyzeQueryPlan).not.toHaveBeenCalled();
    });

    it('validate_sql reports parser issues without a connection', async () => {
        const result = await toolByName(tools, 'validate_sql').handler({ sql: 'SELECT * FRO' });
        expect(result.isError).toBeUndefined();
        expect(result.text).toContain('SQL parser validation found');
    });

    it('validate_sql passes clean SQL and supports database validation', async () => {
        const clean = await toolByName(tools, 'validate_sql').handler({ sql: 'SELECT * FROM _V_TABLE' });
        expect(clean.text).toContain('passed');

        const database = await toolByName(tools, 'validate_sql').handler({
            sql: 'SELECT 1',
            mode: 'database'
        });
        expect(database.isError).toBeUndefined();
        expect(introspection.explain).toHaveBeenCalledWith('EXPLAIN SELECT 1', undefined);
    });

    it('validate_sql rejects missing sql input', async () => {
        const result = await toolByName(tools, 'validate_sql').handler({});
        expect(result.isError).toBe(true);
    });

    describe('write access', () => {
        it('requires the write tier', async () => {
            const readOnly = createMcpToolDefinitions(introspection, {
                allowWrites: false,
                allowDestructive: false,
                execute: (sql, options) => execute(sql, options)
            });
            const denied = await toolByName(readOnly, 'execute_sql').handler({ sql: 'DELETE FROM t' });
            expect(denied.isError).toBe(true);
            expect(denied.text).toContain('disabled');
            expect(execute).not.toHaveBeenCalled();
        });

        it('runs a write statement when the tier allows it', async () => {
            execute.mockResolvedValue(result({ kind: 'write', columns: [], rows: [], rowCount: 0, affectedRows: 2 }));
            const written = await toolByName(tools, 'execute_sql').handler({ sql: 'DELETE FROM ADMIN.ORDERS' });
            expect(written.isError).toBeUndefined();
            expect(written.text).toContain('affected rows: 2');
            expect(execute).toHaveBeenCalledWith('DELETE FROM ADMIN.ORDERS', {});
        });

        it('returns capped read rows', async () => {
            const read = await toolByName(tools, 'execute_sql').handler({ sql: 'SELECT 1 AS X', maxRows: 10 });
            expect(read.isError).toBeUndefined();
            expect(read.text).toContain('Read 1 row(s)');
            expect(execute).toHaveBeenCalledWith('SELECT 1 AS X', { maxRows: 10 });
        });

        it('requires a matching confirmation for destructive statements', async () => {
            const missing = await toolByName(tools, 'execute_sql').handler({ sql: 'DROP TABLE ADMIN.ORDERS' });
            expect(missing.isError).toBe(true);
            expect(missing.text).toContain('confirm');

            const mismatch = await toolByName(tools, 'execute_sql').handler({
                sql: 'DROP TABLE ADMIN.ORDERS',
                confirm: 'CUSTOMERS'
            });
            expect(mismatch.isError).toBe(true);
            expect(execute).not.toHaveBeenCalled();
        });

        it('accepts a matching destructive confirmation', async () => {
            execute.mockResolvedValue(result({ kind: 'destructive', columns: [], rows: [], rowCount: 0, affectedRows: 1 }));
            const dropped = await toolByName(tools, 'execute_sql').handler({
                sql: 'DROP TABLE ADMIN.ORDERS',
                confirm: 'orders'
            });
            expect(dropped.isError).toBeUndefined();
            expect(execute).toHaveBeenCalledWith('DROP TABLE ADMIN.ORDERS', {});
        });

        it('rejects destructive access when the tier is disabled', async () => {
            const noDestructive = createMcpToolDefinitions(introspection, {
                allowWrites: true,
                allowDestructive: false,
                execute: (sql, options) => execute(sql, options)
            });
            const denied = await toolByName(noDestructive, 'execute_sql').handler({
                sql: 'TRUNCATE TABLE ADMIN.ORDERS',
                confirm: 'ORDERS'
            });
            expect(denied.isError).toBe(true);
            expect(denied.text).toContain('full access profile');
            expect(execute).not.toHaveBeenCalled();
        });

        it('treats CALL as destructive and requires the procedure name', async () => {
            const writeOnly = createMcpToolDefinitions(introspection, {
                allowWrites: true,
                allowDestructive: false,
                execute: (sql, options) => execute(sql, options)
            });
            const denied = await toolByName(writeOnly, 'execute_sql').handler({
                sql: 'CALL ADMIN.P(1)',
                confirm: 'P'
            });
            expect(denied.isError).toBe(true);
            expect(denied.text).toContain('full access profile');

            execute.mockResolvedValue(result({ kind: 'destructive', columns: [], rows: [], rowCount: 0, affectedRows: 1 }));
            const called = await toolByName(tools, 'execute_sql').handler({
                sql: 'CALL ADMIN.P(1)',
                confirm: 'p'
            });
            expect(called.isError).toBeUndefined();
            expect(execute).toHaveBeenCalledWith('CALL ADMIN.P(1)', {});
        });
    });

    describe('drop_object', () => {
        it('drops an object with a matching confirmation', async () => {
            execute.mockResolvedValue(result({ kind: 'destructive', columns: [], rows: [], rowCount: 0, affectedRows: 1 }));
            const dropped = await toolByName(tools, 'drop_object').handler({
                object: 'ADMIN.ORDERS',
                objectType: 'table',
                confirm: 'ORDERS'
            });
            expect(dropped.isError).toBeUndefined();
            expect(execute).toHaveBeenCalledWith('DROP TABLE "ADMIN"."ORDERS"', {});
        });

        it('preserves DATABASE..TABLE notation', async () => {
            execute.mockResolvedValue(result({ kind: 'destructive', columns: [], rows: [], rowCount: 0, affectedRows: 1 }));
            const dropped = await toolByName(tools, 'drop_object').handler({
                object: 'DWH..ORDERS',
                objectType: 'table',
                confirm: 'ORDERS'
            });
            expect(dropped.isError).toBeUndefined();
            expect(execute).toHaveBeenCalledWith('DROP TABLE "DWH".."ORDERS"', {});
        });

        it('rejects a mismatched confirmation', async () => {
            const mismatch = await toolByName(tools, 'drop_object').handler({
                object: 'ADMIN.ORDERS',
                objectType: 'table',
                confirm: 'CUSTOMERS'
            });
            expect(mismatch.isError).toBe(true);
            expect(execute).not.toHaveBeenCalled();
        });

        it('rejects destructive access when the tier is disabled', async () => {
            const noDestructive = createMcpToolDefinitions(introspection, {
                allowWrites: true,
                allowDestructive: false,
                execute: (sql, options) => execute(sql, options)
            });
            const denied = await toolByName(noDestructive, 'drop_object').handler({
                object: 'ADMIN.ORDERS',
                objectType: 'table',
                confirm: 'ORDERS'
            });
            expect(denied.isError).toBe(true);
            expect(denied.text).toContain('Destructive');
            expect(execute).not.toHaveBeenCalled();
        });
    });

    describe('compile_procedure', () => {
        it('compiles only by default', async () => {
            execute.mockResolvedValue(result({ kind: 'write', columns: [], rows: [], rowCount: 0, affectedRows: 0 }));
            const compiled = await toolByName(tools, 'compile_procedure').handler({
                sql: 'CREATE PROCEDURE ADMIN.P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;',
                mode: 'compile_only'
            });
            expect(compiled.isError).toBeUndefined();
            expect(execute).toHaveBeenCalledTimes(1);
        });

        it('runs the test CALL with typed arguments', async () => {
            execute.mockResolvedValue(result({ kind: 'write', columns: [], rows: [], rowCount: 0, affectedRows: 0 }));
            const compiled = await toolByName(tools, 'compile_procedure').handler({
                sql: 'CREATE PROCEDURE ADMIN.P(v INT) RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN v; END_PROC;',
                mode: 'compile_and_call',
                callArguments: [{ type: 'number', value: 7 }],
                confirm: 'P'
            });
            expect(compiled.isError).toBeUndefined();
            expect(execute).toHaveBeenNthCalledWith(2, 'CALL "ADMIN"."P"(7)', { maxRows: 500 });
        });

        it('requires confirm for compile_and_call', async () => {
            const rejected = await toolByName(tools, 'compile_procedure').handler({
                sql: 'CREATE PROCEDURE ADMIN.P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;',
                mode: 'compile_and_call',
                callArguments: []
            });
            expect(rejected.isError).toBe(true);
            expect(rejected.text).toContain('confirm');
            expect(execute).not.toHaveBeenCalled();
        });

        it('preserves DATABASE..PROCEDURE notation in the test CALL', async () => {
            execute.mockResolvedValue(result({ kind: 'write', columns: [], rows: [], rowCount: 0, affectedRows: 0 }));
            const compiled = await toolByName(tools, 'compile_procedure').handler({
                sql: 'CREATE PROCEDURE DWH..P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;',
                mode: 'compile_and_call',
                callArguments: [],
                confirm: 'P'
            });
            expect(compiled.isError).toBeUndefined();
            expect(execute).toHaveBeenNthCalledWith(2, 'CALL "DWH".."P"()', { maxRows: 500 });
        });

        it('rejects non-CREATE PROCEDURE input', async () => {
            const rejected = await toolByName(tools, 'compile_procedure').handler({
                sql: 'DROP TABLE ADMIN.ORDERS',
                mode: 'compile_only'
            });
            expect(rejected.isError).toBe(true);
            expect(execute).not.toHaveBeenCalled();
        });
    });

    it('emits audit events without SQL text', async () => {
        const events: ToolAuditEvent[] = [];
        const audited = createMcpToolDefinitions(introspection, {
            ...writableRuntime,
            audit: event => events.push(event)
        });
        await toolByName(audited, 'execute_sql').handler({ sql: 'SELECT 1' });
        await toolByName(audited, 'execute_sql').handler({ sql: 'DROP TABLE t' });

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ tool: 'execute_sql', tier: 'write', surface: 'mcp', ok: true });
        expect(events[1]).toMatchObject({ tool: 'execute_sql', ok: false });
        expect(JSON.stringify(events)).not.toContain('DELETE FROM t');
    });

    it('keeps JSON Schema optional properties optional in the MCP validator', () => {
        const schema = jsonSchemaToZod({
            type: 'object',
            properties: {
                database: { type: 'string' },
                verbose: { type: 'boolean' },
                sql: { type: 'string' }
            },
            required: ['sql'],
            additionalProperties: false
        });

        expect(schema.safeParse({ sql: 'SELECT 1' }).success).toBe(true);
        expect(schema.safeParse({}).success).toBe(false);
    });
});

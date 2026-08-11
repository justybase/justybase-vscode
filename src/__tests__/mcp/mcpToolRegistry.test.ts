jest.unmock('chevrotain');

import { CatalogIntrospection } from '../../core/catalogIntrospection';
import { MCP_TOOL_CATALOG } from '../../mcp/mcpToolCatalog';
import { createMcpToolDefinitions, McpToolDefinition } from '../../mcp/mcpToolRegistry';
import { jsonSchemaToZod } from '../../mcp/mcpServerCore';

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
        analyzeQueryPlan: jest.fn().mockResolvedValue('{"summary":{"overallRisk":"low"}}')
    } as unknown as CatalogIntrospection;
}

describe('MCP tool registry', () => {
    const introspection = createFakeIntrospection();
    let tools: McpToolDefinition[];

    beforeAll(() => {
        tools = createMcpToolDefinitions(introspection);
    });

    it('exposes exactly the catalog tools', () => {
        expect(tools.map(t => t.name).sort()).toEqual(
            MCP_TOOL_CATALOG.map(t => t.name).sort()
        );
        expect(tools).toHaveLength(MCP_TOOL_CATALOG.length);
        for (const tool of tools) {
            expect(tool.inputSchema.type).toBe('object');
            expect(typeof tool.handler).toBe('function');
        }
    });

    it('rejects get_columns without tables', async () => {
        const tool = tools.find(t => t.name === 'get_columns')!;
        const result = await tool.handler({ tables: [] });
        expect(result.isError).toBe(true);
        expect(result.text).toContain('No tables');
    });

    it('forwards tables to the columns introspection', async () => {
        const tool = tools.find(t => t.name === 'get_columns')!;
        const result = await tool.handler({ tables: ['SALES'] });
        expect(result.isError).toBeUndefined();
        expect(introspection.getColumns).toHaveBeenCalledWith(['SALES']);
    });

    it('forwards database/schema to the tables introspection', async () => {
        const tool = tools.find(t => t.name === 'get_tables')!;
        await tool.handler({ database: 'DWH', schema: 'ADMIN' });
        expect(introspection.getTables).toHaveBeenCalledWith('DWH', 'ADMIN');
    });

    it('forwards the new catalog tools without accepting table data SQL', async () => {
        await tools.find(t => t.name === 'get_table_stats')!.handler({ tableName: 'ADMIN.ORDERS' });
        expect(introspection.getTableStats).toHaveBeenCalledWith('ADMIN.ORDERS', undefined);

        await tools.find(t => t.name === 'get_comments')!.handler({ tableName: 'ORDERS', includeColumns: false });
        expect(introspection.getComments).toHaveBeenCalledWith('ORDERS', undefined, undefined, false);

        await tools.find(t => t.name === 'get_dependencies')!.handler({ object: 'ORDERS', objectType: 'TABLE' });
        expect(introspection.getDependencies).toHaveBeenCalledWith('ORDERS', undefined, 'TABLE');

        await tools.find(t => t.name === 'get_external_tables')!.handler({ database: 'DWH' });
        expect(introspection.getExternalTables).toHaveBeenCalledWith('DWH', undefined, undefined);

        await tools.find(t => t.name === 'get_table_constraints')!.handler({ tableName: 'ORDERS' });
        expect(introspection.getTableConstraints).toHaveBeenCalledWith('ORDERS', undefined, undefined);

        await tools.find(t => t.name === 'analyze_query_plan')!.handler({ sql: 'SELECT 1' });
        expect(introspection.analyzeQueryPlan).toHaveBeenCalledWith('EXPLAIN SELECT 1', undefined);
    });

    it.each([
        ['get_table_stats', {}],
        ['get_comments', {}],
        ['get_dependencies', {}],
        ['get_table_constraints', {}],
        ['analyze_query_plan', {}]
    ])('rejects missing required arguments for %s', async (name, args) => {
        const result = await tools.find(t => t.name === name)!.handler(args);
        expect(result.isError).toBe(true);
    });

    it('rejects DML through explain_sql', async () => {
        const tool = tools.find(t => t.name === 'explain_sql')!;
        const result = await tool.handler({ sql: 'DELETE FROM t' });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/SELECT or WITH|planner-safe/i);
        expect(introspection.explain).not.toHaveBeenCalled();
    });

    it('passes gated EXPLAIN SQL to the introspection', async () => {
        const tool = tools.find(t => t.name === 'explain_sql')!;
        const result = await tool.handler({ sql: 'SELECT * FROM admin.orders', verbose: true });
        expect(result.isError).toBeUndefined();
        expect(introspection.explain).toHaveBeenCalledWith('EXPLAIN VERBOSE SELECT * FROM admin.orders', undefined);
    });

    it('validate_sql reports parser issues without a connection', async () => {
        const tool = tools.find(t => t.name === 'validate_sql')!;
        const result = await tool.handler({ sql: 'SELECT * FRO' });
        expect(result.isError).toBeUndefined();
        expect(result.text).toContain('SQL parser validation found');
    });

    it('validate_sql passes clean SQL', async () => {
        const tool = tools.find(t => t.name === 'validate_sql')!;
        const result = await tool.handler({ sql: 'SELECT * FROM _V_TABLE' });
        expect(result.text).toContain('passed');
    });

    it('validate_sql rejects missing sql input', async () => {
        const tool = tools.find(t => t.name === 'validate_sql')!;
        const result = await tool.handler({});
        expect(result.isError).toBe(true);
    });

    it('keeps JSON Schema optional properties optional in the MCP validator', () => {
        const schema = jsonSchemaToZod({
            type: 'object',
            properties: {
                database: { type: 'string' },
                verbose: { type: 'boolean' },
                sql: { type: 'string' },
            },
            required: ['sql'],
            additionalProperties: false,
        });

        expect(schema.safeParse({ sql: 'SELECT 1' }).success).toBe(true);
        expect(schema.safeParse({}).success).toBe(false);
    });
});

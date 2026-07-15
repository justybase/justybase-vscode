/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for all Copilot Tools
 * Tests the 17 Tool classes that were refactored from copilotService.ts
 */

import * as vscode from 'vscode';
import {
    SchemaTool,
    ISchemaToolParameters,
    ColumnsTool,
    IColumnsToolParameters,
    TablesTool,
    ITablesToolParameters,
    ExplainPlanTool,
    IExplainPlanToolParameters,
    SearchSchemaTool,
    ISearchSchemaToolParameters,
    TableStatsTool,
    ITableStatsToolParameters,
    DependenciesTool,
    IDependenciesToolParameters,
    ValidateSqlTool,
    IValidateSqlToolParameters,
    DatabasesTool,
    IDatabasesToolParameters,
    SchemasTool,
    ISchemasToolParameters,
    ProceduresTool,
    IProceduresToolParameters,
    ViewsTool,
    IViewsToolParameters,
    ExternalTablesTool,
    IExternalTablesToolParameters,
    NetezzaReferenceTool,
    INetezzaReferenceToolParameters,
    FavoritesTool,
    IFavoritesToolParameters
} from '../services/copilotTools';

// Mock CopilotService type
interface MockCopilotService {
    getSchemaForSql: jest.Mock;
    getSchemaContextForCurrentSql: jest.Mock;
    getColumnsForTables: jest.Mock;
    getTablesFromDatabase: jest.Mock;
    executeSelectQuery: jest.Mock;
    getSampleData: jest.Mock;
    getExplainPlanAnalysis: jest.Mock;
    searchSchema: jest.Mock;
    getTableStats: jest.Mock;
    getObjectDependencies: jest.Mock;
    validateSql: jest.Mock;
    getDatabases: jest.Mock;
    getSchemas: jest.Mock;
    getProcedures: jest.Mock;
    getViews: jest.Mock;
    getExternalTables: jest.Mock;
    getDDL: jest.Mock;
    getNetezzaReference: jest.Mock;
    includeWorkspaceTableProfileNow: jest.Mock;
    getWorkspaceTableProfilesSummary: jest.Mock;
}

// Mock CopilotService
const mockCopilotService: MockCopilotService = {
    getSchemaForSql: jest.fn(),
    getSchemaContextForCurrentSql: jest.fn(),
    getColumnsForTables: jest.fn(),
    getTablesFromDatabase: jest.fn(),
    executeSelectQuery: jest.fn(),
    getSampleData: jest.fn(),
    getExplainPlanAnalysis: jest.fn(),
    searchSchema: jest.fn(),
    getTableStats: jest.fn(),
    getObjectDependencies: jest.fn(),
    validateSql: jest.fn(),
    getDatabases: jest.fn(),
    getSchemas: jest.fn(),
    getProcedures: jest.fn(),
    getViews: jest.fn(),
    getExternalTables: jest.fn(),
    getDDL: jest.fn(),
    getNetezzaReference: jest.fn(),
    includeWorkspaceTableProfileNow: jest.fn(),
    getWorkspaceTableProfilesSummary: jest.fn()
};

describe('Copilot Tools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('SchemaTool', () => {
        let tool: SchemaTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new SchemaTool(mockCopilotService as unknown as InstanceType<typeof SchemaTool>['copilotService']);
        });

        describe('prepareInvocation', () => {
            it('should prepare invocation with provided SQL', async () => {
                const options = {
                    input: { sql: 'SELECT * FROM users' }
                } as vscode.LanguageModelToolInvocationPrepareOptions<ISchemaToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('Fetching table schema');
                expect(result.invocationMessage).toContain('provided SQL');
                expect(result.confirmationMessages?.title).toBe('Get SQL Schema');
            });

            it('should prepare invocation for current editor', async () => {
                const options = {
                    input: {}
                } as vscode.LanguageModelToolInvocationPrepareOptions<ISchemaToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('current editor');
            });
        });

        describe('invoke', () => {
            it('should invoke with provided SQL', async () => {
                const schemaInfo = 'Table: users\n- id: INTEGER\n- name: VARCHAR(100)';
                mockCopilotService.getSchemaForSql.mockResolvedValue(schemaInfo);

                const options = {
                    input: { sql: 'SELECT * FROM users' }
                } as vscode.LanguageModelToolInvocationOptions<ISchemaToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getSchemaForSql).toHaveBeenCalledWith('SELECT * FROM users');
                expect(result).toBeDefined();
                expect(result.content).toBeDefined();
            });

            it('should invoke with current editor SQL', async () => {
                const schemaInfo = 'Current SQL schema context';
                mockCopilotService.getSchemaContextForCurrentSql.mockResolvedValue(schemaInfo);

                const options = {
                    input: {}
                } as vscode.LanguageModelToolInvocationOptions<ISchemaToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getSchemaContextForCurrentSql).toHaveBeenCalled();
                expect(result).toBeDefined();
            });

            it('should handle errors', async () => {
                mockCopilotService.getSchemaForSql.mockRejectedValue(new Error('Connection failed'));

                const options = {
                    input: { sql: 'SELECT * FROM users' }
                } as vscode.LanguageModelToolInvocationOptions<ISchemaToolParameters>;

                await expect(tool.invoke(options, mockToken)).rejects.toThrow('Failed to get SQL schema');
            });
        });
    });

    describe('ColumnsTool', () => {
        let tool: ColumnsTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new ColumnsTool(mockCopilotService as any);
        });

        describe('prepareInvocation', () => {
            it('should prepare invocation with tables list', async () => {
                const options = {
                    input: { tables: ['users', 'orders'], database: 'mydb' }
                } as vscode.LanguageModelToolInvocationPrepareOptions<IColumnsToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('2 table(s)');
                expect(result.invocationMessage).toContain('mydb');
                expect(result.confirmationMessages?.title).toBe('Get Table Columns');
            });

            it('should prepare invocation without database', async () => {
                const options = {
                    input: { tables: ['users'] }
                } as vscode.LanguageModelToolInvocationPrepareOptions<IColumnsToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('1 table(s)');
            });
        });

        describe('invoke', () => {
            it('should fetch columns for tables', async () => {
                const columnsInfo = 'users:\n- id: INTEGER\n- name: VARCHAR(100)';
                mockCopilotService.getColumnsForTables.mockResolvedValue(columnsInfo);

                const options = {
                    input: { tables: ['users', 'orders'], database: 'mydb' }
                } as vscode.LanguageModelToolInvocationOptions<IColumnsToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getColumnsForTables).toHaveBeenCalledWith(['users', 'orders'], 'mydb');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should throw error when no tables specified', async () => {
                const options: vscode.LanguageModelToolInvocationOptions<IColumnsToolParameters> = {
                    input: { tables: [] },
                    toolInvocationToken: {} as any
                };

                await expect(tool.invoke(options, mockToken)).rejects.toThrow('No tables specified');
            });

            it('should handle service errors', async () => {
                mockCopilotService.getColumnsForTables.mockRejectedValue(new Error('DB Error'));

                const options = {
                    input: { tables: ['users'] }
                } as vscode.LanguageModelToolInvocationOptions<IColumnsToolParameters>;

                await expect(tool.invoke(options, mockToken)).rejects.toThrow('Failed to get columns');
            });
        });
    });

    describe('TablesTool', () => {
        let tool: TablesTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new TablesTool(mockCopilotService as any);
        });

        describe('prepareInvocation', () => {
            it('should prepare invocation with database', async () => {
                const options = {
                    input: { database: 'mydb', schema: 'public' }
                } as vscode.LanguageModelToolInvocationPrepareOptions<ITablesToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('mydb');
                expect(result.invocationMessage).toContain('public');
            });
        });

        describe('invoke', () => {
            it('should fetch tables from database', async () => {
                const tablesInfo = 'Tables in mydb:\n- users\n- orders\n- products';
                mockCopilotService.getTablesFromDatabase.mockResolvedValue(tablesInfo);

                const options = {
                    input: { database: 'mydb', schema: 'public' }
                } as vscode.LanguageModelToolInvocationOptions<ITablesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getTablesFromDatabase).toHaveBeenCalledWith('mydb', 'public');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });





    describe('ExplainPlanTool', () => {
        let tool: ExplainPlanTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new ExplainPlanTool(mockCopilotService as any);
        });

        describe('prepareInvocation', () => {
            it('should prepare invocation in verbose mode', async () => {
                const options = {
                    input: { sql: 'SELECT * FROM users', verbose: true }
                } as vscode.LanguageModelToolInvocationPrepareOptions<IExplainPlanToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('verbose');
            });
        });

        describe('invoke', () => {
            it('should get explain plan', async () => {
                const explainPlan = 'QUERY PLAN\nSeq Scan on users';
                mockCopilotService.getExplainPlanAnalysis.mockResolvedValue(explainPlan);

                const options = {
                    input: { sql: 'SELECT * FROM users', verbose: true }
                } as vscode.LanguageModelToolInvocationOptions<IExplainPlanToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getExplainPlanAnalysis).toHaveBeenCalledWith('SELECT * FROM users', true, undefined);
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should pass database scope to explain plan', async () => {
                const explainPlan = 'QUERY PLAN\nSeq Scan on users';
                mockCopilotService.getExplainPlanAnalysis.mockResolvedValue(explainPlan);

                const options = {
                    input: { sql: 'SELECT * FROM users', verbose: false, database: 'MYDB' }
                } as vscode.LanguageModelToolInvocationOptions<IExplainPlanToolParameters>;

                await tool.invoke(options, mockToken);

                expect(mockCopilotService.getExplainPlanAnalysis).toHaveBeenCalledWith('SELECT * FROM users', false, 'MYDB');
            });
        });
    });

    describe('SearchSchemaTool', () => {
        let tool: SearchSchemaTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new SearchSchemaTool(mockCopilotService as any);
        });

        describe('prepareInvocation', () => {
            it('should prepare invocation with search pattern', async () => {
                const options = {
                    input: { pattern: 'user%', searchType: 'tables', database: 'mydb' }
                } as vscode.LanguageModelToolInvocationPrepareOptions<ISearchSchemaToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('user%');
                expect(result.invocationMessage).toContain('tables');
            });
        });

        describe('invoke', () => {
            it('should search schema', async () => {
                const searchResult = 'Found tables:\n- users\n- user_profiles';
                mockCopilotService.searchSchema.mockResolvedValue(searchResult);

                const options = {
                    input: { pattern: 'user%', searchType: 'tables', database: 'mydb' }
                } as vscode.LanguageModelToolInvocationOptions<ISearchSchemaToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.searchSchema).toHaveBeenCalledWith('user%', 'tables', 'mydb');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });

    describe('TableStatsTool', () => {
        let tool: TableStatsTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new TableStatsTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch table statistics', async () => {
                const stats = 'Table: users\nRows: 10000\nSize: 2MB';
                mockCopilotService.getTableStats.mockResolvedValue(stats);

                const options = {
                    input: { table: 'users', database: 'mydb' }
                } as vscode.LanguageModelToolInvocationOptions<ITableStatsToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getTableStats).toHaveBeenCalledWith('users', 'mydb');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });

    describe('DependenciesTool', () => {
        let tool: DependenciesTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new DependenciesTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch object dependencies', async () => {
                const deps = 'Objects depending on users:\n- view_user_summary\n- proc_validate_user';
                mockCopilotService.getObjectDependencies.mockResolvedValue(deps);

                const options = {
                    input: { object: 'users', database: 'mydb' }
                } as vscode.LanguageModelToolInvocationOptions<IDependenciesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getObjectDependencies).toHaveBeenCalledWith('users', 'mydb', undefined);
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should throw error when object name is missing', async () => {
                const options = {
                    input: { object: '' }
                } as vscode.LanguageModelToolInvocationOptions<IDependenciesToolParameters>;

                await expect(tool.invoke(options, mockToken)).rejects.toThrow('Object name is required');
            });
        });
    });

    describe('ValidateSqlTool', () => {
        let tool: ValidateSqlTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new ValidateSqlTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should validate SQL', async () => {
                const validation = 'SQL is valid\nSyntax: OK';
                mockCopilotService.validateSql.mockResolvedValue(validation);

                const options = {
                    input: { sql: 'SELECT * FROM users' }
                } as vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.validateSql).toHaveBeenCalledWith('SELECT * FROM users');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should throw error when SQL is missing', async () => {
                const options = {
                    input: { sql: '' }
                } as vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>;

                await expect(tool.invoke(options, mockToken)).rejects.toThrow('SQL is required');
            });
        });
    });

    describe('DatabasesTool', () => {
        let tool: DatabasesTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new DatabasesTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch databases list', async () => {
                const databases = 'Available databases:\n- system\n- mydb\n- testdb';
                mockCopilotService.getDatabases.mockResolvedValue(databases);

                const options = {
                    input: {}
                } as vscode.LanguageModelToolInvocationOptions<IDatabasesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getDatabases).toHaveBeenCalled();
                expect(result).toBeDefined();
                expect(result.content).toBeDefined();
            });
        });
    });

    describe('SchemasTool', () => {
        let tool: SchemasTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new SchemasTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch schemas for database', async () => {
                const schemas = 'Schemas in mydb:\n- public\n- admin\n- app_data';
                mockCopilotService.getSchemas.mockResolvedValue(schemas);

                const options = {
                    input: { database: 'mydb' }
                } as vscode.LanguageModelToolInvocationOptions<ISchemasToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getSchemas).toHaveBeenCalledWith('mydb');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });

    describe('ProceduresTool', () => {
        let tool: ProceduresTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new ProceduresTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch procedures', async () => {
                const procedures = 'Procedures:\n- get_user_count()\n- validate_data()';
                mockCopilotService.getProcedures.mockResolvedValue(procedures);

                const options = {
                    input: { database: 'mydb', schema: 'public' }
                } as vscode.LanguageModelToolInvocationOptions<IProceduresToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getProcedures).toHaveBeenCalledWith('mydb', 'public');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });

    describe('ViewsTool', () => {
        let tool: ViewsTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new ViewsTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch views', async () => {
                const views = 'Views:\n- user_summary\n- order_stats';
                mockCopilotService.getViews.mockResolvedValue(views);

                const options = {
                    input: { database: 'mydb', schema: 'public' }
                } as vscode.LanguageModelToolInvocationOptions<IViewsToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getViews).toHaveBeenCalledWith('mydb', 'public');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });

    describe('ExternalTablesTool', () => {
        let tool: ExternalTablesTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new ExternalTablesTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should fetch external tables', async () => {
                const extTables = 'External Tables:\n- ext_users\n- ext_orders';
                mockCopilotService.getExternalTables.mockResolvedValue(extTables);

                const options = {
                    input: { database: 'mydb', schema: 'public', dataObjectPattern: 'ext_%' }
                } as vscode.LanguageModelToolInvocationOptions<IExternalTablesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getExternalTables).toHaveBeenCalledWith('mydb', 'public', 'ext_%');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
        });
    });

    describe('NetezzaReferenceTool', () => {
        let tool: NetezzaReferenceTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new NetezzaReferenceTool(mockCopilotService as any);
        });

        describe('invoke', () => {
            it('should get optimization reference', async () => {
                const reference = 'Optimization rules:\n1. Use indexes';
                mockCopilotService.getNetezzaReference.mockReturnValue(reference);

                const options = {
                    input: { topic: 'optimization' }
                } as vscode.LanguageModelToolInvocationOptions<INetezzaReferenceToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getNetezzaReference).toHaveBeenCalledWith('optimization');
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should get nzplsql reference', async () => {
                const reference = 'NZPLSQL syntax:\nCREATE PROCEDURE...';
                mockCopilotService.getNetezzaReference.mockReturnValue(reference);

                const options = {
                    input: { topic: 'nzplsql' }
                } as vscode.LanguageModelToolInvocationOptions<INetezzaReferenceToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getNetezzaReference).toHaveBeenCalledWith('nzplsql');
                expect(result).toBeDefined();
            });
        });
    });

    describe('FavoritesTool', () => {
        let tool: FavoritesTool;
        const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

        beforeEach(() => {
            tool = new FavoritesTool(mockCopilotService as any);
        });

        describe('prepareInvocation', () => {
            it('should prepare invocation with summary mode', async () => {
                const options = {
                    input: { mode: 'summary' }
                } as vscode.LanguageModelToolInvocationPrepareOptions<IFavoritesToolParameters>;

                const result = await tool.prepareInvocation(options, mockToken);

                expect(result.invocationMessage).toContain('listing favorites');
                expect(result.confirmationMessages?.title).toBe('Netezza Favorites');
            });
        });

        describe('invoke', () => {
            it('should return favorites in summary mode', async () => {
                mockCopilotService.getWorkspaceTableProfilesSummary.mockResolvedValue('summary output');

                const options = {
                    input: { mode: 'summary' }
                } as vscode.LanguageModelToolInvocationOptions<IFavoritesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getWorkspaceTableProfilesSummary).toHaveBeenCalledWith('summary', undefined);
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should return favorites in content mode with filtering', async () => {
                mockCopilotService.getWorkspaceTableProfilesSummary.mockResolvedValue('filtered output');

                const options = {
                    input: { mode: 'content', profileNames: ['test'] }
                } as vscode.LanguageModelToolInvocationOptions<IFavoritesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getWorkspaceTableProfilesSummary).toHaveBeenCalledWith('content', ['test']);
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });
            it('should return workspace profiles summary', async () => {
                mockCopilotService.getWorkspaceTableProfilesSummary.mockResolvedValue('profiles summary');

                const options = {
                    input: {}
                } as vscode.LanguageModelToolInvocationOptions<IFavoritesToolParameters>;

                const result = await tool.invoke(options, mockToken);

                expect(mockCopilotService.getWorkspaceTableProfilesSummary).toHaveBeenCalled();
                expect(result).toBeInstanceOf(vscode.LanguageModelToolResult);
            });

            it('should include profile for next prompt when includeNowProfileId is provided', async () => {
                mockCopilotService.includeWorkspaceTableProfileNow.mockResolvedValue(true);
                mockCopilotService.getWorkspaceTableProfilesSummary.mockResolvedValue('profiles summary');

                const options = {
                    input: { includeNowProfileId: 'DB.SCH.TAB' }
                } as vscode.LanguageModelToolInvocationOptions<IFavoritesToolParameters>;

                await tool.invoke(options, mockToken);

                expect(mockCopilotService.includeWorkspaceTableProfileNow).toHaveBeenCalledWith('DB.SCH.TAB');
            });

            it('should throw when includeNow profile is missing', async () => {
                mockCopilotService.includeWorkspaceTableProfileNow.mockResolvedValue(false);

                const options = {
                    input: { includeNowProfileId: 'DB.SCH.MISSING' }
                } as vscode.LanguageModelToolInvocationOptions<IFavoritesToolParameters>;

                await expect(tool.invoke(options, mockToken)).rejects.toThrow('Failed to read favorites');
            });
        });
    });
});

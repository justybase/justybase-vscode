/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the consolidated JustyBase AI tools.
 *
 * The tool set is defined once in `core/assistant/toolCatalog.ts`; these tests
 * cover the VS Code adapters that translate tool arguments into service calls.
 */

import * as vscode from 'vscode';
import {
    CompileProcedureTool,
    DropObjectTool,
    ExecuteSqlTool,
    ExplainQueryTool,
    GetContextTool,
    GetObjectTool,
    GetReferenceTool,
    IExplainQueryToolParameters,
    IGetContextToolParameters,
    IGetObjectToolParameters,
    IGetReferenceToolParameters,
    IInspectImportFileToolParameters,
    IProposeImportMappingToolParameters,
    ISearchCatalogToolParameters,
    IValidateSqlToolParameters,
    InspectImportFileTool,
    ProposeImportMappingTool,
    SearchCatalogTool,
    ValidateSqlTool,
    type IDropObjectToolParameters,
    type IExecuteSqlToolParameters,
    type ICompileProcedureToolParameters
} from '../services/copilotTools';

interface MockCopilotService {
    getToolContext: jest.Mock;
    getSchemaForSql: jest.Mock;
    getSqlDiagnostics: jest.Mock;
    getDatabases: jest.Mock;
    getSchemas: jest.Mock;
    getTablesFromDatabase: jest.Mock;
    getViews: jest.Mock;
    getProcedures: jest.Mock;
    getExternalTables: jest.Mock;
    searchSchema: jest.Mock;
    findTableLocations: jest.Mock;
    getDDL: jest.Mock;
    getColumnsForTables: jest.Mock;
    getComments: jest.Mock;
    getTableStats: jest.Mock;
    getTableConstraints: jest.Mock;
    getObjectDependencies: jest.Mock;
    getWorkspaceTableProfilesSummary: jest.Mock;
    getExplainPlan: jest.Mock;
    getExplainPlanAnalysis: jest.Mock;
    validateSql: jest.Mock;
    validateSqlOnDatabase: jest.Mock;
    inspectImportFile: jest.Mock;
    proposeImportMapping: jest.Mock;
    getNetezzaReference: jest.Mock;
    executeSql: jest.Mock;
    repairProcedure: jest.Mock;
}

const mockCopilotService: MockCopilotService = {
    getToolContext: jest.fn(),
    getSchemaForSql: jest.fn(),
    getSqlDiagnostics: jest.fn(),
    getDatabases: jest.fn(),
    getSchemas: jest.fn(),
    getTablesFromDatabase: jest.fn(),
    getViews: jest.fn(),
    getProcedures: jest.fn(),
    getExternalTables: jest.fn(),
    searchSchema: jest.fn(),
    findTableLocations: jest.fn(),
    getDDL: jest.fn(),
    getColumnsForTables: jest.fn(),
    getComments: jest.fn(),
    getTableStats: jest.fn(),
    getTableConstraints: jest.fn(),
    getObjectDependencies: jest.fn(),
    getWorkspaceTableProfilesSummary: jest.fn(),
    getExplainPlan: jest.fn(),
    getExplainPlanAnalysis: jest.fn(),
    validateSql: jest.fn(),
    validateSqlOnDatabase: jest.fn(),
    inspectImportFile: jest.fn(),
    proposeImportMapping: jest.fn(),
    getNetezzaReference: jest.fn(),
    executeSql: jest.fn(),
    repairProcedure: jest.fn()
};

const mockToken = {
    isCancellationRequested: false,
    onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() }))
} as unknown as vscode.CancellationToken;

function writeResult(overrides: Record<string, unknown> = {}): unknown {
    return {
        kind: 'write',
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 1,
        truncated: false,
        notices: [],
        ...overrides
    };
}

describe('JustyBase AI tools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GetContextTool', () => {
        const tool = new GetContextTool(mockCopilotService as any);

        it('collects context with default options', async () => {
            mockCopilotService.getToolContext.mockResolvedValue('context');
            const options = { input: {} } as vscode.LanguageModelToolInvocationOptions<IGetContextToolParameters>;

            const result = await tool.invoke(options, mockToken);

            expect(mockCopilotService.getToolContext).toHaveBeenCalledWith(undefined, true, true);
            expect(result).toBeDefined();
        });

        it('passes explicit options and handles errors', async () => {
            mockCopilotService.getToolContext.mockRejectedValue(new Error('boom'));
            const options = { input: { sql: 'SELECT 1', includeSchema: false, includeDiagnostics: false } } as vscode.LanguageModelToolInvocationOptions<IGetContextToolParameters>;

            await expect(tool.invoke(options, mockToken)).rejects.toThrow('Failed to collect SQL context');
            expect(mockCopilotService.getToolContext).toHaveBeenCalledWith('SELECT 1', false, false);
        });
    });

    describe('SearchCatalogTool', () => {
        const tool = new SearchCatalogTool(mockCopilotService as any);

        it('lists tables by default', async () => {
            mockCopilotService.getTablesFromDatabase.mockResolvedValue('tables');
            const options = { input: {} } as vscode.LanguageModelToolInvocationOptions<ISearchCatalogToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getTablesFromDatabase).toHaveBeenCalledWith(undefined, undefined);
        });

        it('routes each catalog kind', async () => {
            mockCopilotService.getDatabases.mockResolvedValue('dbs');
            mockCopilotService.getSchemas.mockResolvedValue('schemas');
            mockCopilotService.getViews.mockResolvedValue('views');
            mockCopilotService.getProcedures.mockResolvedValue('procs');
            mockCopilotService.getExternalTables.mockResolvedValue('ext');
            mockCopilotService.searchSchema.mockResolvedValue('search');

            const invoke = (input: ISearchCatalogToolParameters) => tool.invoke(
                { input } as vscode.LanguageModelToolInvocationOptions<ISearchCatalogToolParameters>,
                mockToken
            );

            await invoke({ kind: 'databases' });
            await invoke({ kind: 'schemas', database: 'DB' });
            await invoke({ kind: 'views', database: 'DB', schema: 'ADMIN' });
            await invoke({ kind: 'procedures', database: 'DB' });
            await invoke({ kind: 'external_tables', query: 'EXT' });
            await invoke({ kind: 'columns', query: 'NAME' });
            await invoke({ kind: 'all', query: 'NAME' });

            expect(mockCopilotService.searchSchema).toHaveBeenCalledWith('NAME', 'COLUMNS', undefined);
            expect(mockCopilotService.searchSchema).toHaveBeenCalledWith('NAME', 'ALL', undefined);
        });

        it('requires a query for column and object searches', async () => {
            const options = { input: { kind: 'columns' } } as vscode.LanguageModelToolInvocationOptions<ISearchCatalogToolParameters>;
            await expect(tool.invoke(options, mockToken)).rejects.toThrow('Catalog search failed');
        });
    });

    describe('GetObjectTool', () => {
        const tool = new GetObjectTool(mockCopilotService as any);

        it('reads default sections', async () => {
            mockCopilotService.getDDL.mockResolvedValue('DDL');
            mockCopilotService.getColumnsForTables.mockResolvedValue('COLUMNS');
            const options = { input: { object: 'ADMIN.T' } } as vscode.LanguageModelToolInvocationOptions<IGetObjectToolParameters>;

            const result = await tool.invoke(options, mockToken);
            expect(mockCopilotService.getDDL).toHaveBeenCalledWith({
                objectName: 'ADMIN.T',
                objectType: 'table',
                database: undefined,
                schema: undefined
            });
            expect(mockCopilotService.getColumnsForTables).toHaveBeenCalledWith(['ADMIN.T'], undefined);
            expect(result).toBeDefined();
        });

        it('qualifies columns, statistics and dependencies with schema and database', async () => {
            mockCopilotService.getColumnsForTables.mockResolvedValue('COLUMNS');
            mockCopilotService.getTableStats.mockResolvedValue('STATS');
            mockCopilotService.getObjectDependencies.mockResolvedValue('DEPS');
            const options = {
                input: {
                    object: 'ORDERS',
                    database: 'DWH',
                    schema: 'ADMIN',
                    sections: ['columns', 'stats', 'dependencies']
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetObjectToolParameters>;

            await tool.invoke(options, mockToken);

            expect(mockCopilotService.getColumnsForTables).toHaveBeenCalledWith(['DWH.ADMIN.ORDERS'], 'DWH');
            expect(mockCopilotService.getTableStats).toHaveBeenCalledWith('DWH.ADMIN.ORDERS', 'DWH');
            expect(mockCopilotService.getObjectDependencies).toHaveBeenCalledWith(
                'DWH.ADMIN.ORDERS',
                'DWH',
                'TABLE'
            );
        });

        it('supports all sections and continues after a section error', async () => {
            mockCopilotService.getDDL.mockResolvedValue('DDL');
            mockCopilotService.getColumnsForTables.mockResolvedValue('COLUMNS');
            mockCopilotService.getComments.mockResolvedValue('COMMENTS');
            mockCopilotService.getTableStats.mockResolvedValue('STATS');
            mockCopilotService.getTableConstraints.mockRejectedValue(new Error('no constraints'));
            mockCopilotService.getObjectDependencies.mockResolvedValue('DEPS');

            const options = {
                input: {
                    object: 'ADMIN.T',
                    sections: ['ddl', 'columns', 'comments', 'stats', 'constraints', 'dependencies']
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetObjectToolParameters>;

            const result = await tool.invoke(options, mockToken);
            expect(result).toBeDefined();
            expect(mockCopilotService.getTableConstraints).toHaveBeenCalledWith('ADMIN.T', undefined, undefined);
            expect(mockCopilotService.getObjectDependencies).toHaveBeenCalledWith('ADMIN.T', undefined, 'TABLE');
        });
    });

    describe('ExplainQueryTool', () => {
        const tool = new ExplainQueryTool(mockCopilotService as any);

        it('returns plan analysis by default', async () => {
            mockCopilotService.getExplainPlanAnalysis.mockResolvedValue('plan');
            const options = { input: { sql: 'SELECT 1', verbose: true, database: 'DB' } } as vscode.LanguageModelToolInvocationOptions<IExplainQueryToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getExplainPlanAnalysis).toHaveBeenCalledWith('SELECT 1', true, 'DB');
        });

        it('returns the raw plan when analyze is false', async () => {
            mockCopilotService.getExplainPlan.mockResolvedValue('raw');
            const options = { input: { sql: 'SELECT 1', analyze: false } } as vscode.LanguageModelToolInvocationOptions<IExplainQueryToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getExplainPlan).toHaveBeenCalledWith('SELECT 1', false, undefined);
        });

        it('rejects missing SQL', async () => {
            const options = { input: { sql: '' } } as vscode.LanguageModelToolInvocationOptions<IExplainQueryToolParameters>;
            await expect(tool.invoke(options, mockToken)).rejects.toThrow('SQL is required');
        });
    });

    describe('ValidateSqlTool', () => {
        const tool = new ValidateSqlTool(mockCopilotService as any);

        it('validates parser syntax by default', async () => {
            mockCopilotService.validateSql.mockResolvedValue('valid');
            const options = { input: { sql: 'SELECT 1' } } as vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.validateSql).toHaveBeenCalledWith('SELECT 1');
        });

        it('validates on the requested database', async () => {
            mockCopilotService.validateSqlOnDatabase.mockResolvedValue('valid');
            const options = { input: { sql: 'SELECT 1', mode: 'database', database: 'DB' } } as vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.validateSqlOnDatabase).toHaveBeenCalledWith('SELECT 1', 'DB');
        });
    });

    describe('Import tools', () => {
        it('inspects an import file', async () => {
            mockCopilotService.inspectImportFile.mockResolvedValue('inspection');
            const tool = new InspectImportFileTool(mockCopilotService as any);
            const options = { input: { filePath: 'C:/tmp/data.csv', sampleRows: 3 } } as vscode.LanguageModelToolInvocationOptions<IInspectImportFileToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.inspectImportFile).toHaveBeenCalledWith('C:/tmp/data.csv', 3);
        });

        it('proposes an import mapping', async () => {
            mockCopilotService.proposeImportMapping.mockResolvedValue('mapping');
            const tool = new ProposeImportMappingTool(mockCopilotService as any);
            const options = { input: { filePath: 'C:/tmp/data.csv', targetTable: 'ADMIN.T' } } as vscode.LanguageModelToolInvocationOptions<IProposeImportMappingToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.proposeImportMapping).toHaveBeenCalledWith('C:/tmp/data.csv', 'ADMIN.T');
        });
    });

    describe('GetReferenceTool', () => {
        const tool = new GetReferenceTool(mockCopilotService as any);

        it('returns the requested reference topic', async () => {
            mockCopilotService.getNetezzaReference.mockReturnValue('reference');
            const options = { input: { topic: 'nzplsql' } } as vscode.LanguageModelToolInvocationOptions<IGetReferenceToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getNetezzaReference).toHaveBeenCalledWith('nzplsql');
        });

        it('defaults to all topics', async () => {
            mockCopilotService.getNetezzaReference.mockReturnValue('reference');
            const options = { input: {} } as vscode.LanguageModelToolInvocationOptions<IGetReferenceToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getNetezzaReference).toHaveBeenCalledWith('all');
        });
    });

    describe('ExecuteSqlTool', () => {
        it('runs read statements without a confirmation value', async () => {
            mockCopilotService.executeSql.mockResolvedValue(writeResult({
                kind: 'read',
                columns: ['X'],
                rows: [[1]],
                rowCount: 1
            }));
            const tool = new ExecuteSqlTool(mockCopilotService as any, false);
            const options = { input: { sql: 'SELECT 1 AS X' } } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.executeSql).toHaveBeenCalledWith(
                'SELECT 1 AS X',
                expect.objectContaining({ signal: expect.anything() })
            );
        });

        it('requires confirm for destructive statements', async () => {
            const tool = new ExecuteSqlTool(mockCopilotService as any, true);
            const options = { input: { sql: 'DROP TABLE ADMIN.ORDERS' } } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            await expect(tool.invoke(options, mockToken)).rejects.toThrow('confirm');
            expect(mockCopilotService.executeSql).not.toHaveBeenCalled();
        });

        it('accepts a matching destructive confirmation', async () => {
            mockCopilotService.executeSql.mockResolvedValue(writeResult());
            const tool = new ExecuteSqlTool(mockCopilotService as any, true);
            const options = {
                input: { sql: 'DROP TABLE ADMIN.ORDERS', confirm: 'orders' }
            } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.executeSql).toHaveBeenCalledWith('DROP TABLE ADMIN.ORDERS', expect.anything());
        });

        it('rejects destructive statements when the full profile is off', async () => {
            const tool = new ExecuteSqlTool(mockCopilotService as any, false);
            const options = {
                input: { sql: 'TRUNCATE TABLE ADMIN.ORDERS', confirm: 'ORDERS' }
            } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            await expect(tool.invoke(options, mockToken)).rejects.toThrow('full');
            expect(mockCopilotService.executeSql).not.toHaveBeenCalled();
        });

        it('still runs write statements under the read-write profile', async () => {
            mockCopilotService.executeSql.mockResolvedValue(writeResult());
            const tool = new ExecuteSqlTool(mockCopilotService as any, false);
            const options = {
                input: { sql: 'DELETE FROM ADMIN.ORDERS WHERE ID = 1' }
            } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.executeSql).toHaveBeenCalledWith(
                'DELETE FROM ADMIN.ORDERS WHERE ID = 1',
                expect.anything()
            );
        });

        it('rejects writes when the effective tier is read', async () => {
            const tool = new ExecuteSqlTool(mockCopilotService as any, false, false);
            const options = {
                input: { sql: 'DELETE FROM ADMIN.ORDERS WHERE ID = 1' }
            } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            await expect(tool.invoke(options, mockToken)).rejects.toThrow('read-write');
            expect(mockCopilotService.executeSql).not.toHaveBeenCalled();
        });

        it('requires the procedure name to confirm a CALL', async () => {
            const tool = new ExecuteSqlTool(mockCopilotService as any, true);
            const options = {
                input: { sql: 'CALL ADMIN.P(1)', confirm: 'P' }
            } as vscode.LanguageModelToolInvocationOptions<IExecuteSqlToolParameters>;

            mockCopilotService.executeSql.mockResolvedValue(writeResult());
            await tool.invoke(options, mockToken);
            expect(mockCopilotService.executeSql).toHaveBeenCalledWith('CALL ADMIN.P(1)', expect.anything());
        });
    });

    describe('DropObjectTool', () => {
        it('drops with a matching confirmation', async () => {
            mockCopilotService.executeSql.mockResolvedValue(writeResult());
            const tool = new DropObjectTool(mockCopilotService as any, true);
            const options = {
                input: { object: 'ADMIN.ORDERS', objectType: 'table', confirm: 'ORDERS' }
            } as vscode.LanguageModelToolInvocationOptions<IDropObjectToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.executeSql).toHaveBeenCalledWith(
                'DROP TABLE "ADMIN"."ORDERS"',
                expect.anything()
            );
        });

        it('rejects a mismatched confirmation', async () => {
            const tool = new DropObjectTool(mockCopilotService as any, true);
            const options = {
                input: { object: 'ADMIN.ORDERS', objectType: 'table', confirm: 'CUSTOMERS' }
            } as vscode.LanguageModelToolInvocationOptions<IDropObjectToolParameters>;

            await expect(tool.invoke(options, mockToken)).rejects.toThrow('confirm');
            expect(mockCopilotService.executeSql).not.toHaveBeenCalled();
        });

        it('rejects dropping when destructive access is off', async () => {
            const tool = new DropObjectTool(mockCopilotService as any, false);
            const options = {
                input: { object: 'ADMIN.ORDERS', objectType: 'table', confirm: 'ORDERS' }
            } as vscode.LanguageModelToolInvocationOptions<IDropObjectToolParameters>;

            await expect(tool.invoke(options, mockToken)).rejects.toThrow('full');
        });
    });

    describe('CompileProcedureTool', () => {
        it('delegates compilation to the shared repair workflow', async () => {
            mockCopilotService.repairProcedure.mockResolvedValue('compiled');
            const tool = new CompileProcedureTool(mockCopilotService as any);
            const input: ICompileProcedureToolParameters = {
                mode: 'compile_only',
                sql: 'CREATE PROCEDURE P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;'
            };
            const options = { input } as vscode.LanguageModelToolInvocationOptions<ICompileProcedureToolParameters>;

            const result = await tool.invoke(options, mockToken);
            expect(mockCopilotService.repairProcedure).toHaveBeenCalledWith(input, mockToken);
            expect(result).toBeDefined();
        });

        it('requires full access and a matching confirm for compile_and_call', async () => {
            const input: ICompileProcedureToolParameters = {
                mode: 'compile_and_call',
                sql: 'CREATE PROCEDURE ADMIN.P() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;',
                callArguments: [],
                confirm: 'P'
            };
            const options = { input } as vscode.LanguageModelToolInvocationOptions<ICompileProcedureToolParameters>;

            await expect(new CompileProcedureTool(mockCopilotService as any, true, false).invoke(options, mockToken))
                .rejects.toThrow('full');
            await expect(new CompileProcedureTool(mockCopilotService as any, false, true).invoke(options, mockToken))
                .rejects.toThrow('read-write');

            mockCopilotService.repairProcedure.mockResolvedValue('compiled');
            await new CompileProcedureTool(mockCopilotService as any, true, true).invoke(options, mockToken);
            expect(mockCopilotService.repairProcedure).toHaveBeenCalledWith(input, mockToken);
        });
    });
});

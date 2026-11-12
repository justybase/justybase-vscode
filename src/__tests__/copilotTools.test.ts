/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the consolidated JustyBase AI tools.
 */

import * as vscode from 'vscode';
import {
    GetContextTool,
    IGetContextToolParameters,
    SearchCatalogTool,
    ISearchCatalogToolParameters,
    GetObjectDetailsTool,
    IGetObjectDetailsToolParameters,
    ExplainSqlTool,
    IExplainSqlToolParameters,
    ValidateSqlTool,
    IValidateSqlToolParameters,
    ValidateSqlOnDatabaseTool,
    IValidateSqlOnDatabaseToolParameters,
    InspectImportFileTool,
    IInspectImportFileToolParameters,
    ProposeImportMappingTool,
    IProposeImportMappingToolParameters,
    NetezzaReferenceTool,
    INetezzaReferenceToolParameters
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
    getObjectDependencies: jest.Mock;
    getWorkspaceTableProfilesSummary: jest.Mock;
    getExplainPlanAnalysis: jest.Mock;
    validateSql: jest.Mock;
    validateSqlOnDatabase: jest.Mock;
    inspectImportFile: jest.Mock;
    proposeImportMapping: jest.Mock;
    getNetezzaReference: jest.Mock;
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
    getObjectDependencies: jest.fn(),
    getWorkspaceTableProfilesSummary: jest.fn(),
    getExplainPlanAnalysis: jest.fn(),
    validateSql: jest.fn(),
    validateSqlOnDatabase: jest.fn(),
    inspectImportFile: jest.fn(),
    proposeImportMapping: jest.fn(),
    getNetezzaReference: jest.fn()
};

const mockToken = { isCancellationRequested: false } as vscode.CancellationToken;

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

        it('routes each catalog object type', async () => {
            mockCopilotService.getDatabases.mockResolvedValue('dbs');
            mockCopilotService.getSchemas.mockResolvedValue('schemas');
            mockCopilotService.getViews.mockResolvedValue('views');
            mockCopilotService.getProcedures.mockResolvedValue('procs');
            mockCopilotService.getExternalTables.mockResolvedValue('ext');
            mockCopilotService.searchSchema.mockResolvedValue('search');
            mockCopilotService.findTableLocations.mockResolvedValue('locations');

            const invoke = (input: ISearchCatalogToolParameters) => tool.invoke(
                { input } as vscode.LanguageModelToolInvocationOptions<ISearchCatalogToolParameters>,
                mockToken
            );

            await invoke({ objectType: 'databases' });
            await invoke({ objectType: 'schemas', database: 'DB' });
            await invoke({ objectType: 'views', database: 'DB', schema: 'ADMIN' });
            await invoke({ objectType: 'procedures', database: 'DB' });
            await invoke({ objectType: 'external tables', pattern: 'EXT' });
            await invoke({ objectType: 'columns', pattern: 'NAME' });
            await invoke({ objectType: 'all', pattern: 'NAME' });
            await invoke({ objectType: 'locations', pattern: 'ORDERS' });

            expect(mockCopilotService.searchSchema).toHaveBeenCalledWith('NAME', 'COLUMNS', undefined);
            expect(mockCopilotService.searchSchema).toHaveBeenCalledWith('NAME', 'ALL', undefined);
            expect(mockCopilotService.findTableLocations).toHaveBeenCalledWith('ORDERS');
        });

        it('requires a pattern for column and location searches', async () => {
            const options = { input: { objectType: 'columns' } } as vscode.LanguageModelToolInvocationOptions<ISearchCatalogToolParameters>;
            await expect(tool.invoke(options, mockToken)).rejects.toThrow('Catalog search failed');
        });
    });

    describe('GetObjectDetailsTool', () => {
        const tool = new GetObjectDetailsTool(mockCopilotService as any);

        it('reads default sections', async () => {
            mockCopilotService.getDDL.mockResolvedValue('DDL');
            mockCopilotService.getColumnsForTables.mockResolvedValue('COLUMNS');
            const options = { input: { objectName: 'ADMIN.T' } } as vscode.LanguageModelToolInvocationOptions<IGetObjectDetailsToolParameters>;

            const result = await tool.invoke(options, mockToken);
            expect(mockCopilotService.getDDL).toHaveBeenCalled();
            expect(mockCopilotService.getColumnsForTables).toHaveBeenCalledWith(['ADMIN.T'], undefined);
            expect(result).toBeDefined();
        });

        it('supports all sections and continues after a section error', async () => {
            mockCopilotService.getDDL.mockResolvedValue('DDL');
            mockCopilotService.getColumnsForTables.mockResolvedValue('COLUMNS');
            mockCopilotService.getComments.mockResolvedValue('COMMENTS');
            mockCopilotService.getTableStats.mockResolvedValue('STATS');
            mockCopilotService.getObjectDependencies.mockResolvedValue('DEPS');
            mockCopilotService.getWorkspaceTableProfilesSummary.mockResolvedValue('FAVORITES');

            const options = {
                input: {
                    objectName: 'ADMIN.T',
                    sections: ['ddl', 'columns', 'comments', 'stats', 'dependencies', 'favorites']
                }
            } as vscode.LanguageModelToolInvocationOptions<IGetObjectDetailsToolParameters>;

            const result = await tool.invoke(options, mockToken);
            expect(result).toBeDefined();
            expect(mockCopilotService.getObjectDependencies).toHaveBeenCalledWith('ADMIN.T', undefined, 'TABLE');
        });

        it('requires objectName unless only favorites are requested', async () => {
            const invalid = { input: { sections: ['ddl'] } } as vscode.LanguageModelToolInvocationOptions<IGetObjectDetailsToolParameters>;
            await expect(tool.invoke(invalid, mockToken)).rejects.toThrow('objectName');

            mockCopilotService.getWorkspaceTableProfilesSummary.mockResolvedValue('FAVORITES');
            const favorites = { input: { sections: ['favorites'] } } as vscode.LanguageModelToolInvocationOptions<IGetObjectDetailsToolParameters>;
            await expect(tool.invoke(favorites, mockToken)).resolves.toBeDefined();
        });
    });

    describe('ExplainSqlTool', () => {
        const tool = new ExplainSqlTool(mockCopilotService as any);

        it('returns plan analysis', async () => {
            mockCopilotService.getExplainPlanAnalysis.mockResolvedValue('plan');
            const options = { input: { sql: 'SELECT 1', verbose: true, database: 'DB' } } as vscode.LanguageModelToolInvocationOptions<IExplainSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getExplainPlanAnalysis).toHaveBeenCalledWith('SELECT 1', true, 'DB');
        });

        it('rejects missing SQL', async () => {
            const options = { input: { sql: '' } } as vscode.LanguageModelToolInvocationOptions<IExplainSqlToolParameters>;
            await expect(tool.invoke(options, mockToken)).rejects.toThrow('SQL query is required');
        });
    });

    describe('ValidateSqlTool', () => {
        const tool = new ValidateSqlTool(mockCopilotService as any);

        it('validates provided SQL', async () => {
            mockCopilotService.validateSql.mockResolvedValue('valid');
            const options = { input: { sql: 'SELECT 1' } } as vscode.LanguageModelToolInvocationOptions<IValidateSqlToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.validateSql).toHaveBeenCalledWith('SELECT 1');
        });
    });

    describe('ValidateSqlOnDatabaseTool', () => {
        const tool = new ValidateSqlOnDatabaseTool(mockCopilotService as any);

        it('validates on the requested database', async () => {
            mockCopilotService.validateSqlOnDatabase.mockResolvedValue('valid');
            const options = { input: { sql: 'SELECT 1', database: 'DB' } } as vscode.LanguageModelToolInvocationOptions<IValidateSqlOnDatabaseToolParameters>;

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

    describe('NetezzaReferenceTool', () => {
        const tool = new NetezzaReferenceTool(mockCopilotService as any);

        it('returns the requested reference topic', async () => {
            mockCopilotService.getNetezzaReference.mockReturnValue('reference');
            const options = { input: { topic: 'nzplsql' } } as vscode.LanguageModelToolInvocationOptions<INetezzaReferenceToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getNetezzaReference).toHaveBeenCalledWith('nzplsql');
        });

        it('defaults to all topics', async () => {
            mockCopilotService.getNetezzaReference.mockReturnValue('reference');
            const options = { input: {} } as vscode.LanguageModelToolInvocationOptions<INetezzaReferenceToolParameters>;

            await tool.invoke(options, mockToken);
            expect(mockCopilotService.getNetezzaReference).toHaveBeenCalledWith('all');
        });
    });
});

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { CopilotContextBuilder } from '../services/copilot/CopilotContextBuilder';
import { ConnectionManager } from '../core/connectionManager';
import {
    createConnectedDatabaseConnectionFromDetails,
    executeDatabaseQuery,
    getDatabaseMetadataProvider,
    getRequiredDatabaseDdlProvider
} from '../core/connectionFactory';
import { TableReferenceExtractor } from '../services/copilot/TableReferenceExtractor';
import { DDLCacheManager } from '../services/copilot/DDLCacheManager';

jest.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined
    },
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn().mockReturnValue(10)
        })
    },
    Position: function(line: number, character: number) { return { line, character }; },
    Range: function(start: { line: number; character: number }, end: { line: number; character: number }) { return { start, end }; }
}), { virtual: true });

jest.mock('../services/copilot/TableReferenceExtractor');

jest.mock('../services/copilot/DDLCacheManager');

jest.mock('../core/connectionFactory', () => {
    const actual = jest.requireActual('../core/connectionFactory');
    return {
        ...actual,
        createConnectedDatabaseConnectionFromDetails: jest.fn(),
        executeDatabaseQuery: jest.fn(),
        getDatabaseMetadataProvider: jest.fn(),
        getRequiredDatabaseDdlProvider: jest.fn()
    };
});

describe('CopilotContextBuilder', () => {
    let contextBuilder: CopilotContextBuilder;
    let mockConnManager: jest.Mocked<ConnectionManager>;
    let mockTableExtractor: jest.Mocked<TableReferenceExtractor>;
    let mockCacheManager: jest.Mocked<DDLCacheManager>;
    let mockConnection: { close: jest.Mock };
    let mockDdlProvider: {
        buildFindTableSchemaQuery: jest.Mock;
        generateTableDDL: jest.Mock;
    };

    beforeEach(() => {
        jest.clearAllMocks();

        mockConnection = {
            close: jest.fn().mockResolvedValue(undefined)
        };
        mockDdlProvider = {
            buildFindTableSchemaQuery: jest.fn().mockReturnValue('SELECT SCHEMA FROM _V_OBJECT_DATA'),
            generateTableDDL: jest.fn().mockResolvedValue('CREATE TABLE TEST_TABLE (COL1 INT);')
        };

        (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockResolvedValue(mockConnection);
        (executeDatabaseQuery as jest.Mock).mockResolvedValue([]);
        (getRequiredDatabaseDdlProvider as jest.Mock).mockReturnValue(mockDdlProvider);
        (getDatabaseMetadataProvider as jest.Mock).mockReturnValue({
            buildColumnsWithKeysQuery: jest.fn().mockReturnValue('SELECT * FROM _V_RELATION_COLUMN')
        });

        mockConnManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('test-connection'),
            getConnectionForExecution: jest.fn().mockReturnValue('test-connection'),
            getDocumentConnection: jest.fn().mockReturnValue('test-connection'),
            getConnection: jest.fn().mockResolvedValue({
                host: 'test-host',
                database: 'TEST_DB',
                user: 'test-user',
                password: 'test-password'
            }),
            getCurrentDatabase: jest.fn().mockResolvedValue('TEST_DB')
        } as any;

        mockTableExtractor = {
            extract: jest.fn()
        } as any;

        mockCacheManager = {
            getCachedDDL: jest.fn(),
            clear: jest.fn()
        } as any;

        contextBuilder = new CopilotContextBuilder(
            mockConnManager,
            mockTableExtractor,
            mockCacheManager
        );
    });

    describe('gatherContext', () => {
        it('should gather context from active editor', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockCacheManager.getCachedDDL.mockResolvedValue('CREATE TABLE users (id INT);');

            const context = await contextBuilder.gatherContext();

            expect(context.selectedSql).toBe('SELECT * FROM users');
            expect(context.connectionInfo).toContain('test-connection');
            expect(mockTableExtractor.extract).toHaveBeenCalledWith('SELECT * FROM users');
        });

        it('should gather context with selection', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users WHERE id = 1;'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: {
                    isEmpty: false,
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 30 }
                }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockCacheManager.getCachedDDL.mockResolvedValue('CREATE TABLE users (id INT);');

            const context = await contextBuilder.gatherContext();

            expect(context.selectedSql).toBe('SELECT * FROM users WHERE id = 1;');
        });

        it('should throw error when no active editor', async () => {
            (vscode.window.activeTextEditor as any) = undefined;

            await expect(contextBuilder.gatherContext()).rejects.toThrow('No active editor');
        });

        it('should throw error when SQL is empty', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue(''),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            await expect(contextBuilder.gatherContext()).rejects.toThrow('No SQL selected or document is empty');
        });

        it('should handle whitespace only SQL', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('   \n   \t   '),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            await expect(contextBuilder.gatherContext()).rejects.toThrow('No SQL selected or document is empty');
        });

        it('should format DDL with code block when valid', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockCacheManager.getCachedDDL.mockResolvedValue('CREATE TABLE users (id INT);');

            const context = await contextBuilder.gatherContext();

            expect(context.ddlContext).toContain('```sql');
            expect(context.ddlContext).toContain('CREATE TABLE users (id INT);');
        });

        it('should format DDL without code block when invalid', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockCacheManager.getCachedDDL.mockResolvedValue('Table not found');

            const context = await contextBuilder.gatherContext();

            expect(context.ddlContext).toContain('Table not found');
            expect(context.ddlContext).not.toContain('```sql');
        });
    });

    describe('getSchemaForSql', () => {
        it('should get schema for SQL with table references', async () => {
            const sql = 'SELECT * FROM users';
            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockCacheManager.getCachedDDL.mockResolvedValue('CREATE TABLE users (id INT);');

            const result = await contextBuilder.getSchemaForSql(sql);

            expect(result).toContain('CREATE TABLE users (id INT);');
            expect(mockTableExtractor.extract).toHaveBeenCalledWith(sql);
        });

        it('should return message when no tables found', async () => {
            const sql = 'SELECT 1';
            mockTableExtractor.extract.mockReturnValue([]);

            const result = await contextBuilder.getSchemaForSql(sql);

            expect(result).toBe('No tables found in SQL.');
        });

        it('should return message when no active connection', async () => {
            const sql = 'SELECT * FROM users';
            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockConnManager.getActiveConnectionName.mockReturnValue(null);

            const result = await contextBuilder.getSchemaForSql(sql);

            expect(result).toBe('No active connection.');
        });
    });

    describe('gatherSchemaOverview', () => {
        it('should return null when no active connection', async () => {
            mockConnManager.getActiveConnectionName.mockReturnValue(null);

            const result = await contextBuilder.gatherSchemaOverview();

            expect(result).toBeNull();
        });

        it('should return null when connection not found', async () => {
            mockConnManager.getConnection.mockResolvedValue(undefined);

            const result = await contextBuilder.gatherSchemaOverview();

            expect(result).toBeNull();
        });

        it('should return null when no database', async () => {
            mockConnManager.getCurrentDatabase.mockResolvedValue(null);

            const result = await contextBuilder.gatherSchemaOverview();

            expect(result).toBeNull();
        });

        it('should return message when no tables found', async () => {
            (executeDatabaseQuery as jest.Mock).mockResolvedValue([]);

            const result = await contextBuilder.gatherSchemaOverview();

            expect(result).toBe('No tables found in database');
            expect(mockConnection.close).toHaveBeenCalled();
        });
    });

    describe('buildGenerateSqlPrompt', () => {
        it('should build prompt with user description and schema', () => {
            const userDescription = 'Find all customers with orders over $1000';
            const schemaOverview = 'DATABASE: TEST_DB\nTABLES: 1\n\n[SCHEMA: PUBLIC]\n  TABLE: customers\n    - id: INT\n    - name: VARCHAR';

            const prompt = contextBuilder.buildGenerateSqlPrompt(userDescription, schemaOverview);

            expect(prompt).toContain(userDescription);
            expect(prompt).toContain('DATABASE: TEST_DB');
            expect(prompt).toContain('NETEZZA SQL NAMING CONVENTIONS');
            expect(prompt).toContain('DISTRIBUTE ON');
            expect(prompt).toContain('ORGANIZE ON');
        });

        it('should include Netezza-specific rules in prompt', () => {
            const userDescription = 'Create a table';
            const schemaOverview = 'DATABASE: TEST_DB';

            const prompt = contextBuilder.buildGenerateSqlPrompt(userDescription, schemaOverview);

            expect(prompt).toContain('DATABASE..OBJECT');
            expect(prompt).toContain('DATABASE..TABLE syntax is valid and CORRECT');
            expect(prompt).toContain('GROOM TABLE');
            expect(prompt).toContain('GENERATE STATISTICS');
        });

        it('should include aggregation intent scaffold for metric requests', () => {
            const userDescription = 'Calculate monthly revenue sum and average order value by region';
            const schemaOverview = 'DATABASE: TEST_DB';

            const prompt = contextBuilder.buildGenerateSqlPrompt(userDescription, schemaOverview);

            expect(prompt).toContain('Intent: aggregation');
            expect(prompt).toContain('Aggregation / summarization');
            expect(prompt).toContain('Pre-filter raw rows before GROUP BY');
        });

        it('should include data quality intent scaffold for validation requests', () => {
            const userDescription = 'Find duplicate customer IDs and rows with missing email';
            const schemaOverview = 'DATABASE: TEST_DB';

            const prompt = contextBuilder.buildGenerateSqlPrompt(userDescription, schemaOverview);

            expect(prompt).toContain('Intent: quality-check');
            expect(prompt).toContain('Data quality validation');
            expect(prompt).toContain('null/duplicate checks');
        });

        it('should avoid substring false-positives in intent classification', () => {
            const userDescription = 'Prepare backstage report for weekly revenue trend';
            const schemaOverview = 'DATABASE: TEST_DB';

            const prompt = contextBuilder.buildGenerateSqlPrompt(userDescription, schemaOverview);

            expect(prompt).toContain('Intent: reporting');
            expect(prompt).not.toContain('Intent: etl-transform');
        });
    });

    describe('error handling', () => {
        it('should handle connection errors gracefully', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockTableExtractor.extract.mockReturnValue([{ name: 'users', database: 'TEST_DB', schema: 'PUBLIC' }]);
            mockCacheManager.getCachedDDL.mockRejectedValue(new Error('Connection failed'));

            const context = await contextBuilder.gatherContext();

            expect(context.ddlContext).toContain('Error gathering DDL');
        });

        it('should handle DDL fetch errors per table', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users, orders'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockTableExtractor.extract.mockReturnValue([
                { name: 'users', database: 'TEST_DB', schema: 'PUBLIC' },
                { name: 'orders', database: 'TEST_DB', schema: 'PUBLIC' }
            ]);

            mockCacheManager.getCachedDDL
                .mockResolvedValueOnce('CREATE TABLE users (id INT);')
                .mockRejectedValueOnce(new Error('Orders table error'));

            const context = await contextBuilder.gatherContext();

            expect(context.ddlContext).toContain('CREATE TABLE users (id INT);');
            expect(context.ddlContext).toContain('error retrieving DDL: Orders table error');
        });
    });
});

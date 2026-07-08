/**
 * Tests for commands/schema/ddlCommands.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as vscode from 'vscode';
import { registerDDLCommands } from '../commands/schema/ddlCommands';
import { SchemaCommandsDependencies, SchemaItemData } from '../commands/schema/types';

// Mock vscode
jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn()
    },
    window: {
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showQuickPick: jest.fn(),
        showTextDocument: jest.fn(),
        showSaveDialog: jest.fn()
    },
    workspace: {
        openTextDocument: jest.fn(),
        fs: {
            writeFile: jest.fn()
        }
    },
    env: {
        clipboard: {
            writeText: jest.fn()
        }
    },
    Uri: {
        file: jest.fn((path: string) => ({ fsPath: path }))
    },
    ProgressLocation: {
        Notification: 15
    }
}));

// Mock queryRunner
jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn()
}));

// Mock helpers
jest.mock('../commands/schema/helpers', () => ({
    executeWithProgress: jest.fn()
}));

// Mock ddlGenerator
jest.mock('../ddlGenerator', () => ({
    generateDDL: jest.fn(),
    generateBatchDDL: jest.fn()
}));

// Mock schemaComparer
jest.mock('../schema/schemaComparer', () => ({
    compareProcedures: jest.fn(),
    compareTableStructures: jest.fn()
}));

// Mock schemaCompareView
jest.mock('../views/schemaCompareView', () => ({
    SchemaCompareView: {
        createOrShow: jest.fn()
    }
}));

import { runQueryRaw, queryResultToRows } from '../core/queryRunner';
import { generateDDL, generateBatchDDL } from '../ddlGenerator';
import { compareProcedures, compareTableStructures } from '../schema/schemaComparer';
import { executeWithProgress } from '../commands/schema/helpers';

const mockedRunQueryRaw = runQueryRaw as jest.MockedFunction<typeof runQueryRaw>;
const mockedQueryResultToRows = queryResultToRows as jest.MockedFunction<typeof queryResultToRows>;
const mockedGenerateDDL = generateDDL as jest.MockedFunction<typeof generateDDL>;
const mockedGenerateBatchDDL = generateBatchDDL as jest.MockedFunction<typeof generateBatchDDL>;
const mockedCompareProcedures = compareProcedures as jest.MockedFunction<typeof compareProcedures>;
const mockedCompareTableStructures = compareTableStructures as jest.MockedFunction<typeof compareTableStructures>;
const mockedExecuteWithProgress = executeWithProgress as jest.MockedFunction<typeof executeWithProgress>;

describe('commands/schema/ddlCommands', () => {
    let mockDeps: SchemaCommandsDependencies;
    let registeredCommands: Map<string, (item?: SchemaItemData) => Promise<void>>;

    beforeEach(() => {
        jest.clearAllMocks();
        registeredCommands = new Map();

        // Setup command registration mock
        (vscode.commands.registerCommand as jest.Mock).mockImplementation((id: string, handler: () => Promise<void>) => {
            registeredCommands.set(id, handler);
            return { dispose: jest.fn() };
        });

        // Setup dependencies
        mockDeps = {
            context: {
                extensionUri: { fsPath: '/test/extension' },
                subscriptions: [],
                extensionPath: '/test/extension',
                globalState: {
                    get: jest.fn(),
                    update: jest.fn(),
                    keys: jest.fn(() => [])
                },
                workspaceState: {
                    get: jest.fn(),
                    update: jest.fn(),
                    keys: jest.fn(() => [])
                },
                secrets: {
                    get: jest.fn(),
                    store: jest.fn(),
                    delete: jest.fn(),
                    onDidChange: jest.fn()
                },
                storageUri: {} as any,
                globalStorageUri: {} as any,
                logUri: {} as any,
                extensionMode: 1,
                environmentVariableCollection: {} as any
            } as any,
            connectionManager: {
                getActiveConnectionName: jest.fn(() => 'test-connection'),
                getConnection: jest.fn(),
                resolveConnectionName: jest.fn((_documentUri: string | undefined, name?: string) => name || 'test-connection'),
                setDocumentConnection: jest.fn(),
                setDocumentDatabase: jest.fn().mockResolvedValue(undefined)
            } as any,
            metadataCache: {} as any,
            schemaProvider: {} as any,
            schemaTreeView: {} as any
        };

        // Default mock implementations
        (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue({
            host: 'localhost',
            port: 5480,
            database: 'testdb',
            user: 'testuser',
            password: 'testpass'
        });

        mockedExecuteWithProgress.mockImplementation(async (_title: string, task: any) => {
            await task({});
        });
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
            uri: { toString: () => 'untitled:test-ddl-doc' }
        });
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({});
    });

    describe('registerDDLCommands', () => {
        it('should register all DDL commands', () => {
            const disposables = registerDDLCommands(mockDeps);

            expect(disposables).toHaveLength(3);
            expect(registeredCommands.has('netezza.createDDL')).toBe(true);
            expect(registeredCommands.has('netezza.compareSchema')).toBe(true);
            expect(registeredCommands.has('netezza.batchExportDDL')).toBe(true);
        });

        it('should return disposables for cleanup', () => {
            const disposables = registerDDLCommands(mockDeps);

            disposables.forEach(d => {
                expect(d).toHaveProperty('dispose');
            });
        });
    });

    describe('netezza.createDDL command handler', () => {
        it('should show error when item is missing', async () => {
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler(undefined);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid object selected for DDL generation');
        });

        it('should show error when item is missing required fields', async () => {
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({ label: 'test' } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid object selected for DDL generation');
        });

        it('should show error when connection not configured', async () => {
            (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue(null);
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Connection not configured. Please connect via Netezza: Connect...'
            );
        });

        it('should generate SQLite DDL without requiring schema and using the selected node connection', async () => {
            (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue({
                host: 'localhost',
                database: ':memory:',
                user: 'testuser',
                dbType: 'sqlite'
            });
            mockedGenerateDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE main.sales (id INTEGER);'
            });
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({
                label: 'sales',
                rawLabel: 'sales',
                dbName: 'main',
                objType: 'TABLE',
                connectionName: 'sqlite-connection'
            } as SchemaItemData);

            expect(mockDeps.connectionManager.resolveConnectionName).toHaveBeenCalledWith(undefined, 'sqlite-connection');
            expect(mockedGenerateDDL).toHaveBeenCalledWith(
                expect.objectContaining({ dbType: 'sqlite' }),
                'main',
                '',
                'sales',
                'TABLE'
            );
        });

        it('should open DDL in editor when selected', async () => {
            mockedGenerateDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE test (id INT);'
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Open in Editor',
                value: 'editor'
            });

            const doc = { uri: { toString: () => 'untitled:ddl-test' } };
            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(doc);
            (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({});

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE',
                connectionName: 'db2-connection'
            } as SchemaItemData);

            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({
                content: 'CREATE TABLE test (id INT);',
                language: 'sql'
            });
            expect(mockDeps.connectionManager.setDocumentConnection).toHaveBeenCalledWith('untitled:ddl-test', 'db2-connection');
            expect(mockDeps.connectionManager.setDocumentDatabase).toHaveBeenCalledWith('untitled:ddl-test', 'testdb');
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
        });

        it('should copy DDL to clipboard when selected', async () => {
            mockedGenerateDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE test (id INT);'
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Copy to Clipboard',
                value: 'clipboard'
            });

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('CREATE TABLE test (id INT);');
        });

        it('should pass rawLabel to DDL generator when available', async () => {
            mockedGenerateDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE "lower" (id INT);'
            });
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({
                label: '"lower"',
                rawLabel: 'lower',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(mockedGenerateDDL).toHaveBeenCalledWith(
                expect.any(Object),
                'testdb',
                'public',
                'lower',
                'TABLE'
            );
        });

        it('should show error when DDL generation fails', async () => {
            mockedGenerateDDL.mockResolvedValue({
                success: false,
                error: 'DDL generation failed'
            });

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.createDDL')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error generating DDL: DDL generation failed');
        });
    });

    describe('netezza.compareSchema command handler', () => {
        it('should show error when item is missing', async () => {
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.compareSchema')!;

            await handler(undefined);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid object selected for comparison');
        });

        it('should show error when item is missing required fields', async () => {
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.compareSchema')!;

            await handler({ label: 'test' } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid object selected for comparison');
        });

        it('should show warning when no other objects found for comparison', async () => {
            mockedRunQueryRaw.mockResolvedValue({
                data: [],
                columns: []
            });

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.compareSchema')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No other TABLEs found to compare with.');
        });

        it('should compare tables when selected', async () => {
            mockedRunQueryRaw.mockResolvedValue({
                data: [['other_table', 'public']],
                columns: [{ name: 'OBJNAME' }, { name: 'SCHEMA' }]
            } as any);

            mockedQueryResultToRows.mockReturnValue([
                { OBJNAME: 'other_table', SCHEMA: 'public' }
            ] as any);

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'other_table',
                description: 'testdb.public',
                db: 'testdb',
                schema: 'public',
                name: 'other_table'
            });

                        mockedCompareTableStructures.mockResolvedValue(
                {} as any);

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.compareSchema')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(mockedCompareTableStructures).toHaveBeenCalled();
        });

        it('should compare procedures when selected', async () => {
            mockedRunQueryRaw.mockResolvedValue({
                data: [['other_proc', 'public']],
                columns: [{ name: 'OBJNAME' }, { name: 'SCHEMA' }]
            });

            mockedQueryResultToRows.mockReturnValue([
                { OBJNAME: 'other_proc', SCHEMA: 'public' }
            ] as any);

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'other_proc',
                description: 'testdb.public',
                db: 'testdb',
                schema: 'public',
                name: 'other_proc'
            });

                        mockedCompareProcedures.mockResolvedValue(
                {} as any);

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.compareSchema')!;

            await handler({
                label: 'test_proc',
                dbName: 'testdb',
                schema: 'public',
                objType: 'PROCEDURE'
            } as SchemaItemData);

            expect(mockedCompareProcedures).toHaveBeenCalled();
        });

        it('should cancel when no target object selected', async () => {
            mockedRunQueryRaw.mockResolvedValue({
                data: [],
                columns: []
            });

            mockedQueryResultToRows.mockReturnValue([
                { OBJNAME: 'other_table', SCHEMA: 'public' }
            ] as any);

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.compareSchema')!;

            await handler({
                label: 'test_table',
                dbName: 'testdb',
                schema: 'public',
                objType: 'TABLE'
            } as SchemaItemData);

            // Should not call compare functions
            expect(mockedCompareTableStructures).not.toHaveBeenCalled();
        });
    });

    describe('netezza.batchExportDDL command handler', () => {
        it('should show error when item is missing', async () => {
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler(undefined);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Invalid node selected for batch DDL export');
        });

        it('should show error when item contextValue is invalid', async () => {
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'table'
            } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Batch DDL export is only available on database or object type nodes'
            );
        });

        it('should show error when connection not configured', async () => {
            (mockDeps.connectionManager.getConnection as jest.Mock).mockResolvedValue(null);
            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'database',
                label: 'testdb'
            } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Connection not configured. Please connect via Netezza: Connect...'
            );
        });

        it('should export database DDL to editor', async () => {
            mockedGenerateBatchDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE t1 (id INT);',
                objectCount: 1,
                errors: [],
                skipped: 0
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Open in Editor',
                value: 'editor'
            });

            const doc = { uri: { toString: () => 'untitled:batch-ddl-test' } };
            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(doc);
            (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({});

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'database',
                label: 'testdb',
                connectionName: 'db2-connection'
            } as SchemaItemData);

            expect(mockedGenerateBatchDDL).toHaveBeenCalledWith({
                connectionDetails: expect.any(Object),
                database: 'testdb',
                objectTypes: undefined
            });
            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
            expect(mockDeps.connectionManager.setDocumentConnection).toHaveBeenCalledWith('untitled:batch-ddl-test', 'db2-connection');
            expect(mockDeps.connectionManager.setDocumentDatabase).toHaveBeenCalledWith('untitled:batch-ddl-test', 'testdb');
        });

        it('should export DDL to file when selected', async () => {
            mockedGenerateBatchDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE t1 (id INT);',
                objectCount: 1,
                errors: [],
                skipped: 0
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Save to File',
                value: 'file'
            });

            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({
                fsPath: '/path/to/testdb_all_ddl.sql'
            });

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'database',
                label: 'testdb'
            } as SchemaItemData);

            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
            expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
        });

        it('should export DDL to clipboard when selected', async () => {
            mockedGenerateBatchDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE t1 (id INT);',
                objectCount: 1,
                errors: [],
                skipped: 0
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Copy to Clipboard',
                value: 'clipboard'
            });

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'database',
                label: 'testdb'
            } as SchemaItemData);

            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('CREATE TABLE t1 (id INT);');
        });

        it('should show warning when batch DDL has errors', async () => {
            mockedGenerateBatchDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE t1 (id INT);',
                objectCount: 1,
                errors: ['Error generating DDL for t2'],
                skipped: 0
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Open in Editor',
                value: 'editor'
            });

            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
                uri: { toString: () => 'untitled:batch-ddl-warning' }
            });
            (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({});

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'database',
                label: 'testdb'
            } as SchemaItemData);

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'Batch DDL completed with 1 error(s). Check the generated file for details.'
            );
        });

        it('should show error when batch DDL fails', async () => {
            mockedGenerateBatchDDL.mockResolvedValue({
                success: false,
                ddlCode: undefined,
                objectCount: 0,
                errors: ['Connection failed'],
                skipped: 0
            });

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'database',
                label: 'testdb'
            } as SchemaItemData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error exporting DDL: Connection failed');
        });

        it('should handle typeGroup contextValue', async () => {
            mockedGenerateBatchDDL.mockResolvedValue({
                success: true,
                ddlCode: 'CREATE TABLE t1 (id INT);',
                objectCount: 1,
                errors: [],
                skipped: 0
            });

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Open in Editor',
                value: 'editor'
            });

            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
                uri: { toString: () => 'untitled:batch-ddl-type-group' }
            });
            (vscode.window.showTextDocument as jest.Mock).mockResolvedValue({});

            registerDDLCommands(mockDeps);
            const handler = registeredCommands.get('netezza.batchExportDDL')!;

            await handler({
                contextValue: 'typeGroup:TABLE',
                dbName: 'testdb',
                objType: 'TABLE'
            } as SchemaItemData);

            expect(mockedGenerateBatchDDL).toHaveBeenCalledWith({
                connectionDetails: expect.any(Object),
                database: 'testdb',
                objectTypes: ['TABLE']
            });
        });
    });
});

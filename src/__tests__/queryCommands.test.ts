/**
 * Unit tests for commands/queryCommands.ts
 * Tests query command registration and helper functions
 */

import * as vscode from 'vscode';
import { registerQueryCommands, QueryCommandsDependencies } from '../commands/queryCommands';
import {
    runExplainQuery,
    runQueriesSequentially,
    runQueriesWithStreaming,
    cancelQueryByUri,
    runQueryRaw
} from '../core/queryRunner';
import { SqlParser } from '../sql/sqlParser';
import { parseExplainOutput } from '../views/explainPlanView';
import { clearQueryExecutionGateForTests } from '../commands/query/queryExecutionGate';

// Mock vscode module
jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() })),
        executeCommand: jest.fn()
    },
    window: {
        activeTextEditor: undefined,
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn().mockResolvedValue(undefined),
        showTextDocument: jest.fn().mockResolvedValue(undefined),
        createTerminal: jest.fn(() => ({
            show: jest.fn(),
            sendText: jest.fn()
        })),
        withProgress: jest.fn()
    },
    workspace: {
        openTextDocument: jest.fn(),
        getConfiguration: jest.fn(() => ({
            get: jest.fn((_key: string, defaultValue: unknown) => defaultValue)
        }))
    },
    ProgressLocation: {
        Notification: 1
    },
    Selection: jest.fn().mockImplementation((start, end) => ({ start, end, isEmpty: false })),
    Range: jest.fn().mockImplementation((start, end) => ({ start, end })),
    Uri: {
        parse: jest.fn((value: string) => ({ toString: () => value }))
    }
}));

// Mock connection manager
jest.mock('../core/connectionManager', () => ({
    ConnectionManager: jest.fn()
}));

// Mock queryRunner
jest.mock('../core/queryRunner', () => ({
    runQueriesSequentially: jest.fn(),
    runExplainQuery: jest.fn(),
    runQueriesWithStreaming: jest.fn(),
    cancelQueryByUri: jest.fn(),
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn((result: { columns: { name: string }[]; data: unknown[][] }) =>
        result.data.map(row => {
            const obj: Record<string, unknown> = {};
            result.columns.forEach((col, index) => {
                obj[col.name] = row[index];
            });
            return obj;
        })
    ),
    StreamingChunk: {}
}));

// Mock SqlParser
jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        splitStatements: jest.fn((sql: string) => sql.split(';').filter(s => s.trim())),
        getStatementAtPosition: jest.fn()
    }
}));

// Mock ResultPanelView
jest.mock('../views/resultPanelView', () => ({
    ResultPanelView: jest.fn()
}));

jest.mock('../views/explainPlanView', () => ({
    parseExplainOutput: jest.fn(() => ({ tree: [] })),
    ExplainPlanView: { createOrShow: jest.fn() }
}));

// Mock shellUtils
jest.mock('../utils/shellUtils', () => ({
}));

// Mock internal SQL formatter
jest.mock('../services/sqlFormatter', () => ({
    formatSql: jest.fn((sql: string) => sql)
}));

describe('commands/queryCommands', () => {
    let mockContext: vscode.ExtensionContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockConnectionManager: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockResultPanelProvider: any;
    const mockGlobalStateStore: Record<string, unknown> = {};

    beforeEach(() => {
        jest.clearAllMocks();
        clearQueryExecutionGateForTests();
        Object.keys(mockGlobalStateStore).forEach(key => delete mockGlobalStateStore[key]);
        (vscode.window.withProgress as jest.Mock).mockImplementation(async (_options, callback) => {
            return callback({ report: jest.fn() });
        });
        (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
            uri: { toString: () => 'untitled:tuning-report.md' }
        });
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((key: string, defaultValue: unknown) => {
                if (key === 'enableStreaming') return true;
                if (key === 'streamingChunkSize') return 5000;
                if (key === 'pythonPath') return 'python';
                return defaultValue;
            })
        });

        mockContext = {
            globalState: {
                get: jest.fn((key: string, defaultValue?: unknown) =>
                    Object.prototype.hasOwnProperty.call(mockGlobalStateStore, key)
                        ? mockGlobalStateStore[key]
                        : defaultValue
                ),
                update: jest.fn(async (key: string, value: unknown) => {
                    mockGlobalStateStore[key] = value;
                })
            }
        } as unknown as vscode.ExtensionContext;
        mockConnectionManager = {
            getConnectionForExecution: jest.fn().mockReturnValue('test-connection'),
            getActiveConnectionName: jest.fn().mockReturnValue('test-connection'),
            getConnectionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            getExecutionDatabaseKind: jest.fn().mockReturnValue('netezza'),
            getEffectiveDatabase: jest.fn().mockResolvedValue('TESTDB'),
            getCurrentDatabase: jest.fn().mockResolvedValue('TESTDB'),
            supportsCapability: jest.fn().mockReturnValue(true),
            getConnection: jest.fn().mockResolvedValue({
                name: 'test-connection',
                host: 'localhost',
                port: 5480,
                database: 'testdb',
                username: 'user'
            })
        };
        mockResultPanelProvider = {
            setActiveSource: jest.fn(),
            startExecution: jest.fn(),
            finalizeExecution: jest.fn(),
            cancelExecution: jest.fn(),
            getExecutingSources: jest.fn().mockReturnValue([]),
            getActiveSource: jest.fn(),
            log: jest.fn(),
            logExecutionStart: jest.fn().mockReturnValue('exec-1'),
            logExecutionEnd: jest.fn(),
            updateResults: jest.fn(),
            appendStreamingChunk: jest.fn(),
            onDidCancel: jest.fn(() => ({ dispose: jest.fn() }))
        };
    });

    describe('registerQueryCommands', () => {
        it('should register all query commands', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            const disposables = registerQueryCommands(deps);

            // Should register 10 commands: cancelQuery, viewTableData, runQuery, runQueryContinueOnError,
            // executeAndLoadToDuckDb, runQueryBatch, explainQuery, explainQueryVerbose, tuningAdvisor, formatSQL
            expect(disposables).toHaveLength(10);
            expect(vscode.commands.registerCommand).toHaveBeenCalledTimes(10);
        });

        it('should register netezza.cancelQuery command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.cancelQuery',
                expect.any(Function)
            );
        });

        it('should register netezza.action.viewTableData command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.action.viewTableData',
                expect.any(Function)
            );
        });

        it('should register netezza.runQuery command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.runQuery',
                expect.any(Function)
            );
        });

        it('should register netezza.runQueryContinueOnError command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.runQueryContinueOnError',
                expect.any(Function)
            );
        });

        it('should register netezza.runQueryBatch command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.runQueryBatch',
                expect.any(Function)
            );
        });

        it('should register netezza.explainQuery command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.explainQuery',
                expect.any(Function)
            );
        });

        it('should register netezza.explainQueryVerbose command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.explainQueryVerbose',
                expect.any(Function)
            );
        });

        it('should register netezza.tuningAdvisor command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.tuningAdvisor',
                expect.any(Function)
            );
        });

        it('should register netezza.formatSQL command', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.formatSQL',
                expect.any(Function)
            );
        });

        it('should return disposables for cleanup', () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            const disposables = registerQueryCommands(deps);

            disposables.forEach(d => {
                expect(d).toHaveProperty('dispose');
            });
        });
    });

    describe('viewTableData command handler', () => {
        it('should run SELECT * LIMIT 100 and update the result panel', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'ID', type: 'INTEGER' }],
                data: [[1]]
            });

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.action.viewTableData'
            )?.[1] as ((args: { documentUri: string; databaseName?: string; schemaName?: string; tableName: string }) => Promise<void>);

            await handler({
                documentUri: 'file:///view-data.sql',
                databaseName: 'TESTDB',
                schemaName: 'ADMIN',
                tableName: 'CUSTOMERS'
            });

            expect(runQueryRaw).toHaveBeenCalledWith(
                expect.objectContaining({
                    query: 'SELECT * FROM "TESTDB"."ADMIN"."CUSTOMERS" LIMIT 100',
                    maxRows: 100,
                    isUserQuery: false,
                    documentUri: 'file:///view-data.sql'
                })
            );
            expect(mockResultPanelProvider.setActiveSource).toHaveBeenCalledWith('file:///view-data.sql');
            expect(mockResultPanelProvider.startExecution).toHaveBeenCalledWith('file:///view-data.sql');
            expect(mockResultPanelProvider.updateResults).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        sql: 'SELECT * FROM "TESTDB"."ADMIN"."CUSTOMERS" LIMIT 100',
                        name: 'CUSTOMERS (TOP 100)'
                    })
                ],
                'file:///view-data.sql',
                true
            );
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.results.focus');
        });

        it('should resolve the document database when command arguments omit it', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'ID', type: 'INTEGER' }],
                data: [[1]]
            });

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.action.viewTableData'
            )?.[1] as ((args: { documentUri: string; databaseName?: string; schemaName?: string; tableName: string }) => Promise<void>);

            await handler({
                documentUri: 'file:///view-data.sql',
                tableName: 'CUSTOMERS'
            });

            expect(mockConnectionManager.getEffectiveDatabase).toHaveBeenCalledWith('file:///view-data.sql');
            expect(runQueryRaw).toHaveBeenCalledWith(
                expect.objectContaining({
                    query: 'SELECT * FROM "TESTDB".."CUSTOMERS" LIMIT 100'
                })
            );
        });

        it('should use SQLite two-part object paths for view data queries', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: {
                    ...mockConnectionManager,
                    getConnectionDatabaseKind: jest.fn().mockReturnValue('sqlite'),
                    getEffectiveDatabase: jest.fn().mockResolvedValue('main')
                },
                resultPanelProvider: mockResultPanelProvider
            };
            (runQueryRaw as jest.Mock).mockResolvedValue({
                columns: [{ name: 'ID', type: 'INTEGER' }],
                data: [[1]]
            });

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.action.viewTableData'
            )?.[1] as ((args: { documentUri: string; databaseName?: string; schemaName?: string; tableName: string }) => Promise<void>);

            await handler({
                documentUri: 'file:///view-data.sql',
                databaseName: 'main',
                tableName: 'sales'
            });

            expect(runQueryRaw).toHaveBeenCalledWith(
                expect.objectContaining({
                    query: 'SELECT * FROM main.sales LIMIT 100'
                })
            );
            expect(mockResultPanelProvider.updateResults).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        sql: 'SELECT * FROM main.sales LIMIT 100',
                        name: 'sales (TOP 100)'
                    })
                ],
                'file:///view-data.sql',
                true
            );
        });

        it('should surface a missing connection before running the query', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: {
                    ...mockConnectionManager,
                    getConnectionForExecution: jest.fn().mockReturnValue(undefined),
                    getActiveConnectionName: jest.fn().mockReturnValue(undefined)
                },
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.action.viewTableData'
            )?.[1] as ((args: { documentUri: string; databaseName?: string; schemaName?: string; tableName: string }) => Promise<void>);

            await handler({
                documentUri: 'file:///view-data.sql',
                tableName: 'CUSTOMERS'
            });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No database connection. Please connect first.');
            expect(runQueryRaw).not.toHaveBeenCalled();
        });
    });

    describe('runQuery command handler', () => {
        it('should show error when no active editor', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No active editor found');
        });

        it('should warn when cursor is not on SQL statement', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(undefined);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL statement found at cursor');
        });

        it('should execute streaming query flow and finalize', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT 1', start: 0, end: 8 });

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();
            expect(runQueriesWithStreaming).toHaveBeenCalled();
            expect(mockResultPanelProvider.finalizeExecution).toHaveBeenCalledWith('file:///test.sql');
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.results.focus');
        });

        it('should keep Smart Run statement splitting before execution', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider,
            };
            registerQueryCommands(deps);
            (SqlParser.splitStatements as jest.Mock).mockReturnValue(['SELECT 1', 'SELECT 2']);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1; SELECT 2;'),
                },
                selection: { isEmpty: false },
            };

            await handler();

            expect(SqlParser.splitStatements).toHaveBeenCalledWith('SELECT 1; SELECT 2;');
            expect(runQueriesWithStreaming).toHaveBeenCalledWith(
                mockContext,
                ['SELECT 1', 'SELECT 2'],
                expect.anything(),
                'file:///test.sql',
                expect.any(Function),
                expect.any(Function),
                expect.any(Number),
                undefined,
                false,
                undefined,
                expect.any(Function),
                expect.any(Function),
                undefined,
                0,
                undefined,
                expect.any(Object),
            );
        });

        it('should ignore duplicate runQuery while the same tab is already running', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT 1', start: 0, end: 8 });

            let resolveRun: (() => void) | undefined;
            (runQueriesWithStreaming as jest.Mock).mockImplementation(
                () => new Promise<void>(resolve => {
                    resolveRun = resolve;
                })
            );

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            const firstRun = handler();
            await Promise.resolve();
            await handler();

            expect(runQueriesWithStreaming).toHaveBeenCalledTimes(1);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('already running')
            );

            resolveRun?.();
            await firstRun;
        });

        it('should show completion notification and switch to source document when finished in another editor', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT 1', start: 0, end: 8 });
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Switch to SQL Document');
            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
                uri: { toString: () => 'file:///test.sql' }
            });
            (runQueriesWithStreaming as jest.Mock).mockImplementation(async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (vscode.window as any).activeTextEditor = {
                    document: { uri: { toString: () => 'file:///other.sql' } }
                };
            });

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('SQL execution completed for test.sql'),
                'Switch to SQL Document',
                'Show Results'
            );
            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.results.focus');
        });

        it('should execute non-streaming flow when disabled', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn((key: string, defaultValue: unknown) => {
                    if (key === 'enableStreaming') return false;
                    return defaultValue;
                })
            });
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT 1', start: 0, end: 8 });

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();
            expect(runQueriesSequentially).toHaveBeenCalled();
        });

        it('should stop risky runQuery when safe execute is not confirmed', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'DELETE FROM users', start: 0, end: 17 });
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'DELETE FROM users'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringContaining('Safe Execute'),
                expect.objectContaining({ modal: true }),
                'Run Anyway'
            );
            expect(runQueriesWithStreaming).not.toHaveBeenCalled();
            expect(mockResultPanelProvider.startExecution).not.toHaveBeenCalled();
        });

        it('should allow risky runQuery when safe execute is confirmed', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'TRUNCATE TABLE users', start: 0, end: 20 });
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Run Anyway');

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'TRUNCATE TABLE users'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();
            expect(runQueriesWithStreaming).toHaveBeenCalled();
        });

        it('should handle non-cancellation errors for runQuery', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ sql: 'SELECT 1', start: 0, end: 8 });
            (runQueriesWithStreaming as jest.Mock).mockRejectedValue(new Error('boom'));

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQuery'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await handler();
            expect(mockResultPanelProvider.updateResults).toHaveBeenCalled();
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('boom'));
        });
    });

    describe('runQueryBatch command handler', () => {
        it('should show error when no active editor', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQueryBatch'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No active editor found');
        });

        it('should warn on empty batch text', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQueryBatch'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: { uri: { toString: () => 'file:///test.sql' }, getText: jest.fn(() => '   ') },
                selection: { isEmpty: true }
            };

            await handler();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL query to execute');
        });

        it('should execute sequential batch query', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQueryBatch'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: { uri: { toString: () => 'file:///test.sql' }, getText: jest.fn(() => 'SELECT 1') },
                selection: { isEmpty: true }
            };

            await handler();
            expect(runQueriesSequentially).toHaveBeenCalled();
            expect((runQueriesSequentially as jest.Mock).mock.calls[0]?.[15]).toEqual(
                expect.objectContaining({ retryOnBrokenConnection: false }),
            );
            expect(mockResultPanelProvider.finalizeExecution).toHaveBeenCalled();
        });

        it('should ignore duplicate batch run while the same tab is already running', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            let resolveRun: (() => void) | undefined;
            (runQueriesSequentially as jest.Mock).mockImplementation(
                () => new Promise<void>(resolve => {
                    resolveRun = resolve;
                })
            );

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQueryBatch'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: { uri: { toString: () => 'file:///test.sql' }, getText: jest.fn(() => 'SELECT 1') },
                selection: { isEmpty: true }
            };

            const firstRun = handler();
            for (let i = 0; i < 10 && (runQueriesSequentially as jest.Mock).mock.calls.length === 0; i++) {
                await Promise.resolve();
            }
            await handler();

            expect(runQueriesSequentially).toHaveBeenCalledTimes(1);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('already running')
            );

            resolveRun?.();
            await firstRun;
        });

        it('should show completion notification for batch when active editor is different', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Show Results');
            (runQueriesSequentially as jest.Mock).mockImplementation(async () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (vscode.window as any).activeTextEditor = {
                    document: { uri: { toString: () => 'file:///other.sql' } }
                };
            });

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQueryBatch'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: { uri: { toString: () => 'file:///test.sql' }, getText: jest.fn(() => 'SELECT 1') },
                selection: { isEmpty: true }
            };

            await handler();

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('SQL execution completed for test.sql'),
                'Switch to SQL Document',
                'Show Results'
            );
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.results.focus');
        });

        it('should skip safe execute checks when disabled in settings', async () => {
            (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
                get: jest.fn((key: string, defaultValue: unknown) => {
                    if (key === 'safeExecute.enabled') return false;
                    return defaultValue;
                })
            });

            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.runQueryBatch'
            )?.[1];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: { uri: { toString: () => 'file:///test.sql' }, getText: jest.fn(() => 'DELETE FROM users') },
                selection: { isEmpty: true }
            };

            await handler();
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
                expect.stringContaining('Safe Execute'),
                expect.anything(),
                'Run Anyway'
            );
            expect(runQueriesSequentially).toHaveBeenCalled();
        });
    });

    describe('formatSQL command handler', () => {
        it('should show error when no active editor', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.formatSQL'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No active editor');
        });

        it('should show warning for non-SQL files', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.formatSQL'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'javascript',
                    getText: jest.fn()
                },
                selection: { isEmpty: true },
                edit: jest.fn()
            };
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'Format SQL is only available for SQL files'
            );
        });

        it('should format full document and show success message', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.formatSQL'
            )?.[1];

            const editBuilder = { replace: jest.fn() };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    getText: jest.fn(() => 'SELECT * FROM db..table'),
                    positionAt: jest.fn((offset: number) => ({ line: 0, character: offset }))
                },
                selection: { isEmpty: true },
                edit: jest.fn(async (callback: (builder: typeof editBuilder) => void) => callback(editBuilder))
            };

            await handler();
            expect((vscode.window.activeTextEditor as unknown as { edit: jest.Mock }).edit).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('SQL formatted successfully');
        });
    });

    describe('tuningAdvisor command handler', () => {
        it('should show error when no active editor', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.tuningAdvisor'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No active editor found');
        });

        it('should show warning when SQL is empty', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.tuningAdvisor'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => '   '),
                    offsetAt: jest.fn(() => 0),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: false, active: { line: 0, character: 0 } }
            };

            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL query selected for tuning');
            expect(runExplainQuery).not.toHaveBeenCalled();
        });

        it('should show error when no connection is selected', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            mockConnectionManager.getConnectionForExecution.mockReturnValue(undefined);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.tuningAdvisor'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT * FROM SALES'),
                    offsetAt: jest.fn(() => 0),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: false, active: { line: 0, character: 0 } }
            };

            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('No database connection. Please connect first.');
            expect(runExplainQuery).not.toHaveBeenCalled();
        });

        it('should generate markdown report for tuning advisor', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            (runExplainQuery as jest.Mock).mockResolvedValue(
                'Nested Loop (cost=100.00..20000000.00 rows=200000 width=16 conf=0)'
            );
            mockConnectionManager.getCurrentDatabase.mockResolvedValue('TESTDB');

            (runQueryRaw as jest.Mock).mockImplementation(async (options: { query: string }) => {
                const query = options.query;
                if (query.includes('_V_OBJECT_DATA') && query.includes('LIMIT 1')) {
                    return {
                        columns: [{ name: 'SCHEMA' }],
                        data: [['ADMIN']]
                    };
                }
                if (query.startsWith('SELECT COUNT(*) AS ROW_COUNT')) {
                    return {
                        columns: [{ name: 'ROW_COUNT' }],
                        data: [[1000]]
                    };
                }
                if (query.includes('_V_TABLE_DIST_MAP')) {
                    return {
                        columns: [{ name: 'DIST_KEY' }, { name: 'OWNER' }],
                        data: [['RANDOM', 'ADMIN']]
                    };
                }
                if (query.includes('GROUP BY DATASLICEID')) {
                    return {
                        columns: [{ name: 'DATASLICEID' }, { name: 'ROW_COUNT' }],
                        data: [[0, 100], [1, 1000]]
                    };
                }
                return {
                    columns: [],
                    data: []
                };
            });

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.tuningAdvisor'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT * FROM SALES'),
                    offsetAt: jest.fn(() => 0),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: false, active: { line: 0, character: 0 } }
            };

            await handler();

            expect(runExplainQuery).toHaveBeenCalledWith(
                mockContext,
                expect.stringContaining('EXPLAIN VERBOSE'),
                'test-connection',
                mockConnectionManager,
                'file:///test.sql'
            );
                expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                    expect.objectContaining({
                        language: 'markdown',
                        content: expect.stringContaining('# Query Tuning Advisor Report')
                    })
                );
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
            expect(mockResultPanelProvider.log).toHaveBeenCalledWith(
                'file:///test.sql',
                expect.stringContaining('Tuning Advisor report generated')
            );
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('Tuning Advisor report generated'),
                'Helpful',
                'Not Helpful'
            );
        });

        it('should emit tuning_advice_generated and tuning_advice_feedback telemetry events', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            (runExplainQuery as jest.Mock).mockResolvedValue('PLAN');
            mockConnectionManager.getCurrentDatabase.mockResolvedValue('TESTDB');
            (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Helpful');
            (runQueryRaw as jest.Mock).mockImplementation(async (options: { query: string }) => {
                const query = options.query;
                if (query.includes('_V_OBJECT_DATA') && query.includes('LIMIT 1')) {
                    return { columns: [{ name: 'SCHEMA' }], data: [['ADMIN']] };
                }
                if (query.startsWith('SELECT COUNT(*) AS ROW_COUNT')) {
                    return { columns: [{ name: 'ROW_COUNT' }], data: [[1000]] };
                }
                if (query.includes('_V_TABLE_DIST_MAP')) {
                    return { columns: [{ name: 'DIST_KEY' }, { name: 'OWNER' }], data: [['RANDOM', 'ADMIN']] };
                }
                if (query.includes('GROUP BY DATASLICEID')) {
                    return { columns: [{ name: 'DATASLICEID' }, { name: 'ROW_COUNT' }], data: [[0, 100], [1, 1000]] };
                }
                return { columns: [], data: [] };
            });

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.tuningAdvisor'
            )?.[1];
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => { });

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT * FROM SALES'),
                    offsetAt: jest.fn(() => 0),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: false, active: { line: 0, character: 0 } }
            };

            await handler();

            const perfLogs = logSpy.mock.calls
                .map(call => String(call[0]))
                .filter(line => line.includes('[perf_event]'));
            expect(perfLogs.some(line => line.includes('"operation":"tuning_advice_generated"'))).toBe(true);
            expect(perfLogs.some(line => line.includes('"operation":"tuning_advice_feedback"'))).toBe(true);
            expect(perfLogs.some(line => line.includes('"feedback":"helpful"'))).toBe(true);

            logSpy.mockRestore();
        });

        it('should block tuning advisor when the dialect does not support it', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            mockConnectionManager.supportsCapability.mockReturnValue(false);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.tuningAdvisor'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT * FROM SALES'),
                    offsetAt: jest.fn(() => 0),
                    positionAt: jest.fn(() => ({ line: 0, character: 0 }))
                },
                selection: { isEmpty: false, active: { line: 0, character: 0 } }
            };

            await handler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Tuning Advisor is not supported for the active database dialect.'
            );
            expect(runExplainQuery).not.toHaveBeenCalled();
        });
    });

    describe('cancelQuery command handler', () => {
        it('should show warning when no active query to cancel', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };

            registerQueryCommands(deps);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.cancelQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            mockResultPanelProvider.getActiveSource.mockReturnValue(undefined);
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No active query to cancel.');
        });

        it('should cancel using source URI when provided', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.cancelQuery'
            )?.[1];

            await handler('file:///query.sql', [10]);
            expect(mockResultPanelProvider.cancelExecution).toHaveBeenCalledWith('file:///query.sql', [10]);
            expect(cancelQueryByUri).toHaveBeenCalledWith('file:///query.sql');
        });

        it('should cancel currently executing sources when no URI is provided', async () => {
            const deps: QueryCommandsDependencies = {
                context: mockContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.cancelQuery'
            )?.[1];

            mockResultPanelProvider.getExecutingSources.mockReturnValue(['file:///running.sql']);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: { uri: { toString: () => 'file:///other.sql' } }
            };

            await handler();

            expect(mockResultPanelProvider.cancelExecution).toHaveBeenCalledWith('file:///running.sql', undefined);
            expect(cancelQueryByUri).toHaveBeenCalledWith('file:///running.sql');
        });
    });

    describe('explain commands', () => {
        it('should execute explain and explain verbose commands', async () => {
            const deps: QueryCommandsDependencies = {
                context: { extensionUri: { fsPath: 'D:\\ext' } } as vscode.ExtensionContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);

            const explainHandler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.explainQuery'
            )?.[1];
            const explainVerboseHandler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.explainQueryVerbose'
            )?.[1];

            (runExplainQuery as jest.Mock).mockResolvedValue('EXPLAIN OUTPUT');
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ start: 0, end: 8, sql: 'SELECT 1' });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1)
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await explainHandler();
            await explainVerboseHandler();
            expect(runExplainQuery).toHaveBeenCalled();
        });

        it('should normalize MySQL explain JSON into the shared explain graph text shape', async () => {
            const deps: QueryCommandsDependencies = {
                context: { extensionUri: { fsPath: 'D:\\ext' } } as vscode.ExtensionContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            mockConnectionManager.getExecutionDatabaseKind.mockReturnValue('mysql');

            const explainHandler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.explainQuery'
            )?.[1];

            (runExplainQuery as jest.Mock).mockResolvedValue(
                JSON.stringify({
                    query_block: {
                        table: {
                            table_name: 'orders',
                            access_type: 'ALL',
                            rows_examined_per_scan: 120000,
                            rows_produced_per_join: 120000,
                            cost_info: {
                                read_cost: '10',
                                prefix_cost: '500',
                                data_read_per_join: '4M'
                            },
                            attached_condition: "(`analytics`.`orders`.`status` = 'OPEN')"
                        }
                    }
                })
            );
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ start: 0, end: 20 });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT * FROM orders'),
                    offsetAt: jest.fn(() => 1)
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await explainHandler();

            expect(runExplainQuery).toHaveBeenCalledWith(
                expect.anything(),
                'EXPLAIN FORMAT=JSON SELECT * FROM orders',
                'test-connection',
                mockConnectionManager,
                'file:///test.sql'
            );
            expect(parseExplainOutput).toHaveBeenCalledWith(
                expect.stringContaining('Table scan table "orders" {ALL}'),
            );
        });

        it('should block explain when the dialect does not support it', async () => {
            const deps: QueryCommandsDependencies = {
                context: { extensionUri: { fsPath: 'D:\\ext' } } as vscode.ExtensionContext,
                connectionManager: mockConnectionManager,
                resultPanelProvider: mockResultPanelProvider
            };
            registerQueryCommands(deps);
            mockConnectionManager.supportsCapability.mockReturnValue(false);

            const explainHandler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.explainQuery'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: { toString: () => 'file:///test.sql' },
                    getText: jest.fn(() => 'SELECT 1'),
                    offsetAt: jest.fn(() => 1)
                },
                selection: { isEmpty: true, active: { line: 0, character: 1 } }
            };

            await explainHandler();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                'Explain plan is not supported for the active database dialect.'
            );
            expect(runExplainQuery).not.toHaveBeenCalled();
        });
    });
});

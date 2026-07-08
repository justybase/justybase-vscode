/**
 * Unit tests for core/batchQueryExecutor.ts
 * Tests runQueriesSequentially and runQueriesWithStreaming.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';

// ── Mocks ──────────────────────────────────────────────────────────────

jest.mock('vscode', () => ({
    window: {
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
    },
    workspace: {
        getConfiguration: jest.fn().mockReturnValue({
            get: jest.fn().mockImplementation((_key: string, def: unknown) => def),
        }),
    },
    Uri: { file: jest.fn((p: string) => ({ fsPath: p })) },
}));

const mockExecuteAndFetch = jest.fn();
const mockExecuteWithStreaming = jest.fn();
const mockIsAborted = jest.fn().mockReturnValue(false);
const mockClearAborted = jest.fn();
jest.mock('../core/queryCancellation', () => ({
    streamingManager: {
        executeAndFetch: mockExecuteAndFetch,
        executeWithStreaming: mockExecuteWithStreaming,
        abortQuery: jest.fn().mockReturnValue(true),
        isAborted: mockIsAborted,
        clearAborted: mockClearAborted,
    },
}));

const mockGetConnectionForDocument = jest.fn();
jest.mock('../core/queryRunnerHelpers', () => ({
    getConnectionForDocument: mockGetConnectionForDocument,
    executeDropSession: jest.fn().mockResolvedValue(undefined),
    handleBusyConnectionError: jest.fn().mockResolvedValue(false),
}));

const mockGetInstance = jest.fn();
jest.mock('../core/queryHistoryManager', () => ({
    QueryHistoryManager: {
        getInstance: mockGetInstance,
    },
}));

jest.mock('../core/variableUtils', () => ({
    extractVariables: jest.fn().mockReturnValue(new Set()),
    formatPutLogMessage: jest.fn((message: string) => `>>> %PUT: ${message}`),
    parseSetVariables: jest.fn().mockImplementation((sql: string) => ({
        sql,
        setValues: {},
    })),
    replaceVariablesInSql: jest.fn().mockImplementation((sql: string) => sql),
}));

jest.mock('../core/variableResolver', () => ({
    promptForVariableValues: jest.fn().mockResolvedValue({}),
}));

jest.mock('../core/queryRunnerUtils', () => ({
    normalizeUriKey: jest.fn().mockImplementation((uri: string) => uri),
    getOutputChannel: jest.fn().mockReturnValue({
        appendLine: jest.fn(),
        show: jest.fn(),
    }),
    isConnectionBrokenError: jest.fn().mockReturnValue(false),
    logOutput: jest.fn(),
}));

jest.mock('../core/connectionManager', () => ({
    ConnectionManager: jest.fn(),
}));

jest.mock('../utils/sqlConsole', () => ({
    isSqlConsoleDocument: jest.fn().mockReturnValue(false),
    SQL_CONSOLE_HISTORY_TAG: 'console',
}));

import {
    runQueriesSequentially,
    runQueriesWithStreaming,
} from '../core/batchQueryExecutor';
import {
    parseSetVariables,
    replaceVariablesInSql,
} from '../core/variableUtils';

// ── Helpers ────────────────────────────────────────────────────────────

function createMockConnection() {
    return {
        on: jest.fn(),
        removeListener: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn().mockReturnValue({
            executeReader: jest.fn().mockResolvedValue({
                read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
                getValue: jest.fn().mockReturnValue(12345),
                close: jest.fn().mockResolvedValue(undefined),
            }),
        }),
    };
}

function createMockConnManager(overrides: Record<string, any> = {}) {
    return {
        getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
        getConnectionForExecution: jest.fn().mockReturnValue('testConn'),
        getActiveConnectionName: jest.fn().mockReturnValue('testConn'),
        getConnection: jest.fn().mockResolvedValue({
            host: 'localhost',
            port: 5480,
            database: 'testdb',
            user: 'admin',
            password: 'pass',
        }),
        setDocumentLastSessionId: jest.fn(),
        getDocumentLastSessionId: jest.fn(),
        getDocumentPersistentConnection: jest.fn(),
        closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
        ...overrides,
    } as any;
}

function createMockContext(): vscode.ExtensionContext {
    return {
        extensionUri: { fsPath: 'D:\\ext' } as vscode.Uri,
        subscriptions: [],
        globalState: { get: jest.fn(), update: jest.fn() },
        workspaceState: { get: jest.fn(), update: jest.fn() },
    } as unknown as vscode.ExtensionContext;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('batchQueryExecutor', () => {
    let mockConn: ReturnType<typeof createMockConnection>;
    let mockConnManager: ReturnType<typeof createMockConnManager>;
    let mockContext: vscode.ExtensionContext;
    const mockHistoryManager = {
        addEntry: jest.fn().mockResolvedValue(undefined),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (parseSetVariables as jest.Mock).mockImplementation((sql: string) => ({
            sql,
            setValues: {},
        }));
        (replaceVariablesInSql as jest.Mock).mockImplementation((sql: string) => sql);
        mockIsAborted.mockReturnValue(false);
        mockConn = createMockConnection();
        mockConnManager = createMockConnManager();
        mockContext = createMockContext();

        mockGetConnectionForDocument.mockResolvedValue({
            connection: mockConn,
            shouldCloseConnection: false,
        });
        mockGetInstance.mockReturnValue(mockHistoryManager);
    });

    // ── runQueriesSequentially ─────────────────────────────────────

    describe('runQueriesSequentially', () => {
        it('should execute a single query and return results', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [
                    {
                        columns: [{ name: 'id' }],
                        rows: [[1]],
                        limitReached: false,
                    },
                ],
                error: null,
                recordsAffected: undefined,
            });

            const results = await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(results).toHaveLength(1);
            expect(results[0].columns).toEqual([{ name: 'id' }]);
            expect(results[0].data).toEqual([[1]]);
        });

        it('should execute multiple queries sequentially', async () => {
            mockExecuteAndFetch
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'a' }], rows: [[1]], limitReached: false }],
                    error: null,
                })
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'b' }], rows: [[2]], limitReached: false }],
                    error: null,
                });

            const results = await runQueriesSequentially(
                mockContext,
                ['SELECT 1', 'SELECT 2'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(results).toHaveLength(2);
            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(2);
        });

        it('should skip directive-only statements after variable parsing', async () => {
            const logCallback = jest.fn();

            const results = await runQueriesSequentially(
                mockContext,
                ['%let points_cutoff = 20;'],
                mockConnManager,
                'file:///test.sql',
                logCallback,
            );

            expect(results).toEqual([]);
            expect(mockExecuteAndFetch).not.toHaveBeenCalled();
            expect(logCallback).toHaveBeenCalledWith(
                expect.stringContaining('Skipping query 1/1'),
            );
        });

        it('maintains macro variables across batch statements in source order', async () => {
            mockExecuteAndFetch
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                    error: null,
                })
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'x' }], rows: [[2]], limitReached: false }],
                    error: null,
                });

            await runQueriesSequentially(
                mockContext,
                [
                    '%let x = 1;',
                    'SELECT &x;',
                    '%let x = 2;',
                    'SELECT &x;',
                ],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(2);
            expect(mockExecuteAndFetch.mock.calls[0][1]).toBe('SELECT 1;');
            expect(mockExecuteAndFetch.mock.calls[1][1]).toBe('SELECT 2;');
        });

        it('should continue executing later queries when continueOnError is enabled', async () => {
            mockExecuteAndFetch
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'a' }], rows: [[1]], limitReached: false }],
                    error: null,
                })
                .mockRejectedValueOnce(new Error('divide by zero'))
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'c' }], rows: [[2]], limitReached: false }],
                    error: null,
                });

            const results = await runQueriesSequentially(
                mockContext,
                ['SELECT 1', 'SELECT 1/0', 'SELECT 2'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                undefined,
                undefined,
                false,
                undefined,
                undefined,
                undefined,
                undefined,
                0,
                undefined,
                [],
                { continueOnError: true },
            );

            expect(results).toHaveLength(3);
            expect(results[0].data).toEqual([[1]]);
            expect(results[1].isError).toBe(true);
            expect(results[1].message).toContain('divide by zero');
            expect(results[2].data).toEqual([[2]]);
            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(3);
        });

        it('should stop remaining queries when cancellation is requested between statements', async () => {
            // isAborted is now checked multiple times per iteration:
            // 1. At loop start, 2. After queryStartCallback, 3. After executeAndFetch
            // We want: first query executes fully, then cancel detected at start of second iteration
            mockIsAborted
                .mockReturnValueOnce(false)   // loop start, query 1
                .mockReturnValueOnce(false)   // after queryStartCallback, query 1
                .mockReturnValueOnce(false)   // after executeAndFetch, query 1
                .mockReturnValueOnce(true);   // loop start, query 2 → cancel
            mockExecuteAndFetch.mockResolvedValueOnce({
                results: [{ columns: [{ name: 'a' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await expect(
                runQueriesSequentially(
                    mockContext,
                    ['SELECT 1', 'SELECT 2'],
                    mockConnManager,
                    'file:///test.sql',
                ),
            ).rejects.toThrow('Query cancelled');

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
        });

        it('should throw when no connection selected', async () => {
            const cm = createMockConnManager({
                getConnectionForExecution: jest.fn().mockReturnValue(undefined),
                getActiveConnectionName: jest.fn().mockReturnValue(undefined),
            });

            await expect(
                runQueriesSequentially(mockContext, ['SELECT 1'], cm, 'file:///test.sql'),
            ).rejects.toThrow('No connection selected');
        });

        it('should throw when connection details not found', async () => {
            const cm = createMockConnManager({
                getConnection: jest.fn().mockResolvedValue(null),
            });

            await expect(
                runQueriesSequentially(mockContext, ['SELECT 1'], cm, 'file:///test.sql'),
            ).rejects.toThrow();
        });

        it('should call logCallback with execution info', async () => {
            const logCallback = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
                recordsAffected: 5,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                logCallback,
            );

            expect(logCallback).toHaveBeenCalledWith(
                expect.stringContaining('records affected: 5'),
            );
        });

        it('should call logCallback without recordsAffected when 0', async () => {
            const logCallback = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
                recordsAffected: 0,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                logCallback,
            );

            const calls = logCallback.mock.calls.map((c: any[]) => c[0]);
            const execCall = calls.find((c: string) => c.includes('Executed query'));
            expect(execCall).not.toContain('records affected');
        });

        it('should call resultCallback when provided', async () => {
            const resultCallback = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                resultCallback,
            );

            expect(resultCallback).toHaveBeenCalledTimes(1);
            expect(resultCallback).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ columns: [{ name: 'x' }] }),
                ]),
            );
        });

        it('should not call resultCallback when results are empty', async () => {
            const resultCallback = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                resultCallback,
            );

            expect(resultCallback).not.toHaveBeenCalled();
        });

        it('should call queryStartCallback and queryEndCallback', async () => {
            const queryStartCallback = jest.fn().mockReturnValue('exec-001');
            const queryEndCallback = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1], [2]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                undefined,
                undefined,
                false,
                undefined,
                queryStartCallback,
                queryEndCallback,
            );

            expect(queryStartCallback).toHaveBeenCalledWith(0, 'SELECT 1', 'testConn');
            expect(queryEndCallback).toHaveBeenCalledWith('exec-001', 2, expect.any(Number), 'success');
        });

        it('should handle query execution error with queryEndCallback', async () => {
            const queryEndCallback = jest.fn();
            const queryStartCallback = jest.fn().mockReturnValue('exec-err');
            mockExecuteAndFetch.mockRejectedValue(new Error('Syntax error'));

            await expect(
                runQueriesSequentially(
                    mockContext,
                    ['BAD SQL'],
                    mockConnManager,
                    'file:///test.sql',
                    undefined,
                    undefined,
                    undefined,
                    false,
                    undefined,
                    queryStartCallback,
                    queryEndCallback,
                ),
            ).rejects.toThrow();

            expect(queryEndCallback).toHaveBeenCalledWith(
                'exec-err',
                0,
                expect.any(Number),
                'error',
                'Syntax error',
            );
        });

        it('should emit retrying status and reuse executionId on broken connection retry', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(true);

            const queryStartCallback = jest.fn().mockReturnValue('exec-retry');
            const queryEndCallback = jest.fn();
            mockExecuteAndFetch
                .mockRejectedValueOnce(new Error('Connection lost'))
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                    error: null,
                    recordsAffected: undefined,
                });

            const results = await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                undefined,
                undefined,
                false,
                undefined,
                queryStartCallback,
                queryEndCallback,
            );

            expect(results).toHaveLength(1);
            expect(queryStartCallback).toHaveBeenCalledTimes(1);
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                1,
                'exec-retry',
                0,
                expect.any(Number),
                'error',
                'Connection lost',
            );
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                2,
                'exec-retry',
                0,
                0,
                'retrying',
                'Connection was closed by server. Reconnecting and retrying...',
            );
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                3,
                'exec-retry',
                1,
                expect.any(Number),
                'success',
            );
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledWith(
                'file:///test.sql',
            );
        });

        it('should handle batchError from executeAndFetch', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: new Error('partial failure'),
            });

            await expect(
                runQueriesSequentially(
                    mockContext,
                    ['SELECT 1'],
                    mockConnManager,
                    'file:///test.sql',
                ),
            ).rejects.toThrow('partial failure');
        });

        it('should close connection when shouldCloseConnection is true', async () => {
            mockGetConnectionForDocument.mockResolvedValue({
                connection: mockConn,
                shouldCloseConnection: true,
            });
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockConn.close).toHaveBeenCalled();
        });

        it('should not close connection when shouldCloseConnection is false', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockConn.close).not.toHaveBeenCalled();
        });

        it('should register and remove notice handler', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockConn.on).toHaveBeenCalledWith('notice', expect.any(Function));
            expect(mockConn.removeListener).toHaveBeenCalledWith('notice', expect.any(Function));
        });

        it('should handle empty columns as "Query executed successfully"', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
            });

            const results = await runQueriesSequentially(
                mockContext,
                ['CREATE TABLE foo (id int)'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(results).toHaveLength(1);
            expect(results[0].message).toBe('Query executed successfully');
            expect(results[0].columns).toEqual([]);
            expect(results[0].data).toEqual([]);
        });

        it('should use default keepConnectionOpen=true when no documentUri', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                undefined,
            );

            expect(mockConnManager.getDocumentKeepConnectionOpen).not.toHaveBeenCalled();
        });

        it('should log query to history after successful execution', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockHistoryManager.addEntry).toHaveBeenCalledWith(
                'localhost',
                'testdb',
                'unknown',
                'SELECT 1',
                'testConn',
                undefined,
                undefined,
                true,
                'success',
                expect.any(Number),
                expect.any(Number),
                undefined,
            );
        });
    });

    // ── runQueriesWithStreaming ─────────────────────────────────────

    describe('runQueriesWithStreaming', () => {
        it('should execute a single query with streaming', async () => {
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 100,
                limitReached: false,
                error: null,
                recordsAffected: undefined,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockExecuteWithStreaming).toHaveBeenCalledTimes(1);
        });

        it('should throw when no connection selected', async () => {
            const cm = createMockConnManager({
                getConnectionForExecution: jest.fn().mockReturnValue(undefined),
                getActiveConnectionName: jest.fn().mockReturnValue(undefined),
            });

            await expect(
                runQueriesWithStreaming(mockContext, ['SELECT 1'], cm, 'file:///test.sql'),
            ).rejects.toThrow('No connection selected');
        });

        it('should throw when connection not found', async () => {
            const cm = createMockConnManager({
                getConnection: jest.fn().mockResolvedValue(null),
            });

            await expect(
                runQueriesWithStreaming(mockContext, ['SELECT 1'], cm, 'file:///test.sql'),
            ).rejects.toThrow();
        });

        it('should call chunkCallback during streaming', async () => {
            mockExecuteWithStreaming.mockImplementation(
                async (
                    _conn: any,
                    _q: any,
                    _rl: any,
                    _cs: any,
                    _t: any,
                    _du: any,
                    onChunk: (chunk: any) => void,
                ) => {
                    onChunk({ columns: [{ name: 'x' }], rows: [[1]], isFirst: true, isFinal: true });
                    return { totalRows: 1, limitReached: false, error: null };
                },
            );

            const chunkCallback = jest.fn();

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                chunkCallback,
            );

            expect(chunkCallback).toHaveBeenCalledWith(
                0,
                expect.objectContaining({ isFirst: true }),
                'SELECT 1',
            );
        });

        it('should call logCallback with row count and limit info', async () => {
            const logCallback = jest.fn();
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 5000,
                limitReached: true,
                error: null,
                recordsAffected: undefined,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT * FROM big'],
                mockConnManager,
                'file:///test.sql',
                logCallback,
            );

            const calls = logCallback.mock.calls.map((c: any[]) => c[0]);
            const rowsCall = calls.find((c: string) => c.includes('5000 rows'));
            expect(rowsCall).toContain('limit reached');
        });

        it('should call logCallback with recordsAffected when > 0', async () => {
            const logCallback = jest.fn();
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 0,
                limitReached: false,
                error: null,
                recordsAffected: 42,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['DELETE FROM foo'],
                mockConnManager,
                'file:///test.sql',
                logCallback,
            );

            const calls = logCallback.mock.calls.map((c: any[]) => c[0]);
            const execCall = calls.find((c: string) => c.includes('records affected: 42'));
            expect(execCall).toBeDefined();
        });

        it('should call queryStartCallback and queryEndCallback', async () => {
            const queryStartCallback = jest.fn().mockReturnValue('stream-001');
            const queryEndCallback = jest.fn();
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 10,
                limitReached: false,
                error: null,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                undefined,
                5000,
                undefined,
                false,
                undefined,
                queryStartCallback,
                queryEndCallback,
            );

            expect(queryStartCallback).toHaveBeenCalledWith(0, 'SELECT 1', 'testConn');
            expect(queryEndCallback).toHaveBeenCalledWith('stream-001', 10, expect.any(Number), 'success');
        });

        it('should handle streaming error from executeWithStreaming', async () => {
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 0,
                limitReached: false,
                error: new Error('streaming failure'),
            });

            await expect(
                runQueriesWithStreaming(
                    mockContext,
                    ['SELECT 1'],
                    mockConnManager,
                    'file:///test.sql',
                ),
            ).rejects.toThrow('streaming failure');
        });

        it('should handle query execution error with queryEndCallback', async () => {
            const queryStartCallback = jest.fn().mockReturnValue('stream-err');
            const queryEndCallback = jest.fn();
            mockExecuteWithStreaming.mockRejectedValue(new Error('Connection lost'));

            await expect(
                runQueriesWithStreaming(
                    mockContext,
                    ['SELECT 1'],
                    mockConnManager,
                    'file:///test.sql',
                    undefined,
                    undefined,
                    5000,
                    undefined,
                    false,
                    undefined,
                    queryStartCallback,
                    queryEndCallback,
                ),
            ).rejects.toThrow();

            expect(queryEndCallback).toHaveBeenCalledWith(
                'stream-err',
                0,
                expect.any(Number),
                'error',
                'Connection lost',
            );
        });

        it('should emit retrying status during streaming reconnect retry', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValueOnce(true);

            const queryStartCallback = jest.fn().mockReturnValue('stream-retry');
            const queryEndCallback = jest.fn();
            mockExecuteWithStreaming
                .mockRejectedValueOnce(new Error('Connection lost'))
                .mockResolvedValueOnce({
                    totalRows: 10,
                    limitReached: false,
                    error: null,
                    recordsAffected: undefined,
                });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                undefined,
                5000,
                undefined,
                false,
                undefined,
                queryStartCallback,
                queryEndCallback,
            );

            expect(queryStartCallback).toHaveBeenCalledTimes(1);
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                1,
                'stream-retry',
                0,
                expect.any(Number),
                'error',
                'Connection lost',
            );
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                2,
                'stream-retry',
                0,
                0,
                'retrying',
                'Connection was closed by server. Reconnecting and retrying...',
            );
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                3,
                'stream-retry',
                10,
                expect.any(Number),
                'success',
            );
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledWith(
                'file:///test.sql',
            );
        });

        it('should close connection when shouldCloseConnection is true', async () => {
            mockGetConnectionForDocument.mockResolvedValue({
                connection: mockConn,
                shouldCloseConnection: true,
            });
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 1,
                limitReached: false,
                error: null,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockConn.close).toHaveBeenCalled();
        });

        it('should register and remove notice handler', async () => {
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 0,
                limitReached: false,
                error: null,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockConn.on).toHaveBeenCalledWith('notice', expect.any(Function));
            expect(mockConn.removeListener).toHaveBeenCalledWith('notice', expect.any(Function));
        });

        it('should execute multiple queries in sequence', async () => {
            mockExecuteWithStreaming
                .mockResolvedValueOnce({ totalRows: 5, limitReached: false, error: null })
                .mockResolvedValueOnce({ totalRows: 10, limitReached: false, error: null });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1', 'SELECT 2'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockExecuteWithStreaming).toHaveBeenCalledTimes(2);
        });

        it('should stop remaining streaming queries when cancellation is requested', async () => {
            // isAborted is now checked multiple times per iteration:
            // 1. At loop start, 2. After queryStartCallback, 3. After executeWithStreaming
            // We want: first query executes fully, then cancel detected at start of second iteration
            mockIsAborted
                .mockReturnValueOnce(false)   // loop start, query 1
                .mockReturnValueOnce(false)   // after queryStartCallback, query 1
                .mockReturnValueOnce(false)   // after executeWithStreaming, query 1
                .mockReturnValueOnce(true);   // loop start, query 2 → cancel
            mockExecuteWithStreaming.mockResolvedValueOnce({ totalRows: 5, limitReached: false, error: null });

            await expect(
                runQueriesWithStreaming(
                    mockContext,
                    ['SELECT 1', 'SELECT 2'],
                    mockConnManager,
                    'file:///test.sql',
                ),
            ).rejects.toThrow('Query cancelled');

            expect(mockExecuteWithStreaming).toHaveBeenCalledTimes(1);
        });

        it('should log query to history after execution', async () => {
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 1,
                limitReached: false,
                error: null,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockHistoryManager.addEntry).toHaveBeenCalledWith(
                'localhost',
                'testdb',
                'unknown',
                'SELECT 1',
                'testConn',
                undefined,
                undefined,
                true,
                'success',
                expect.any(Number),
                expect.any(Number),
                undefined,
            );
        });

        it('should use default keepConnectionOpen=true when no documentUri', async () => {
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 0,
                limitReached: false,
                error: null,
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT 1'],
                mockConnManager,
                undefined,
            );

            expect(mockConnManager.getDocumentKeepConnectionOpen).not.toHaveBeenCalled();
        });
    });
});

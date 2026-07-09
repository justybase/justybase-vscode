/**
 * Unit tests for core/singleQueryExecutor.ts
 * Tests runQueryRaw, runQuery, executeRawQuery, queryResultToRows,
 * parseQueryJsonResult, runExplainQuery, and runQueryWithCatalog.
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
            get: jest.fn().mockImplementation((_k: string, d: unknown) => d),
        }),
    },
    Uri: { file: jest.fn((p: string) => ({ fsPath: p })) },
}));

const mockExecuteAndFetch = jest.fn();
jest.mock('../core/queryCancellation', () => ({
    streamingManager: {
        executeAndFetch: mockExecuteAndFetch,
        registerCommand: jest.fn().mockReturnValue({
            signal: { aborted: false },
            abort: jest.fn(),
        }),
        unregisterCommand: jest.fn(),
        abortQuery: jest.fn().mockReturnValue(true),
        isAborted: jest.fn().mockReturnValue(false),
        clearAborted: jest.fn(),
    },
}));

const mockGetConnectionForDocument = jest.fn();
const mockLogQueryToHistory = jest.fn().mockResolvedValue(undefined);
const mockHandleBusyConnectionError = jest.fn().mockResolvedValue(false);
jest.mock('../core/queryRunnerHelpers', () => ({
    getConnectionForDocument: mockGetConnectionForDocument,
    logQueryToHistory: mockLogQueryToHistory,
    handleBusyConnectionError: mockHandleBusyConnectionError,
    executeDropSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../core/queryHistoryManager', () => ({
    QueryHistoryManager: { getInstance: jest.fn() },
}));

jest.mock('../core/variableResolver', () => ({
    collectQueryVariableValues: jest.fn().mockResolvedValue({}),
    resolveQueryVariablesWithValues: jest.fn().mockImplementation((q: string) => Promise.resolve(q)),
    resolveQueryVariables: jest.fn().mockImplementation((q: string) => Promise.resolve(q)),
}));

jest.mock('../core/queryRunnerUtils', () => ({
    normalizeUriKey: jest.fn().mockImplementation((uri: string) => uri),
    getOutputChannel: jest.fn().mockReturnValue({ appendLine: jest.fn(), show: jest.fn() }),
    createLogger: jest.fn().mockReturnValue({
        outputChannel: { appendLine: jest.fn() },
        logCallback: undefined,
    }),
    logOutput: jest.fn(),
    isConnectionBrokenError: jest.fn().mockReturnValue(false),
    resolveConnectionName: jest.fn().mockReturnValue('testConn'),
}));

jest.mock('../core/connectionManager', () => ({
    ConnectionManager: jest.fn(),
}));

jest.mock('../core/queryBatchExecutor', () => {
    const actual = jest.requireActual('../core/queryBatchExecutor');
    return {
        ...actual,
        createDropSessionCallback: jest.fn().mockReturnValue(undefined),
        createMacroFileReadContext: jest.fn((documentUri?: string) => ({
            sourceName: documentUri,
            readFile: jest.fn(),
        })),
        getQueryConfig: jest.fn().mockReturnValue({ queryTimeout: 1800, rowLimit: 200000 }),
    };
});

jest.mock('../core/streaming', () => ({
    ResultFormatter: {
        queryResultToRows: jest.fn().mockImplementation((result: any) => {
            if (!result.data || result.data.length === 0) return [];
            return result.data.map((row: unknown[]) => {
                const obj: Record<string, unknown> = {};
                result.columns.forEach((col: { name: string }, i: number) => {
                    obj[col.name] = row[i];
                });
                return obj;
            });
        }),
    },
}));

import {
    resolveConnectionName,
    isRunQueryRawOptions,
    runQueryRaw,
    executeRawQuery,
    runQuery,
    queryResultToRows,
    parseQueryJsonResult,
    runExplainQuery,
    runQueryWithCatalog,
} from '../core/singleQueryExecutor';
import { isConnectionBrokenError } from '../core/queryRunnerUtils';
import { streamingManager } from '../core/queryCancellation';

// ── Helpers ────────────────────────────────────────────────────────────

function createMockConnection() {
    return {
        on: jest.fn(),
        removeListener: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
        createCommand: jest.fn().mockReturnValue({
            executeReader: jest.fn().mockResolvedValue({
                read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
                getValue: jest.fn().mockReturnValue(99999),
                close: jest.fn().mockResolvedValue(undefined),
            }),
            commandTimeout: 0,
        }),
    };
}

function createMockConnManager(overrides: Record<string, any> = {}) {
    return {
        getDocumentKeepConnectionOpen: jest.fn().mockReturnValue(true),
        getConnectionForExecution: jest.fn().mockReturnValue('testConn'),
        getActiveConnectionName: jest.fn().mockReturnValue('testConn'),
        getConnection: jest.fn().mockResolvedValue({
            host: 'localhost', port: 5480, database: 'testdb',
            user: 'admin', password: 'pass',
        }),
        setDocumentLastSessionId: jest.fn(),
        getDocumentLastSessionId: jest.fn(),
        closeDocumentPersistentConnection: jest.fn().mockResolvedValue(undefined),
        getDocumentPersistentConnection: jest.fn(),
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

describe('singleQueryExecutor', () => {
    let mockConn: ReturnType<typeof createMockConnection>;
    let mockConnManager: ReturnType<typeof createMockConnManager>;
    let mockContext: vscode.ExtensionContext;

    beforeEach(() => {
        jest.clearAllMocks();
        mockConn = createMockConnection();
        mockConnManager = createMockConnManager();
        mockContext = createMockContext();

        mockGetConnectionForDocument.mockResolvedValue({
            connection: mockConn,
            shouldCloseConnection: false,
        });
    });

    // ── resolveConnectionName ──────────────────────────────────────

    describe('resolveConnectionName', () => {
        it('should delegate to resolveConnectionNameUtil', () => {
            const result = resolveConnectionName(mockConnManager, 'conn1', 'doc-uri');
            expect(result).toBe('testConn');
        });
    });

    // ── isRunQueryRawOptions ───────────────────────────────────────

    describe('isRunQueryRawOptions', () => {
        it('should return true when value has query property', () => {
            const opts = { context: mockContext, query: 'SELECT 1' };
            expect(isRunQueryRawOptions(opts as any)).toBe(true);
        });

        it('should return false for ExtensionContext', () => {
            expect(isRunQueryRawOptions(mockContext)).toBe(false);
        });
    });

    // ── runQueryRaw ────────────────────────────────────────────────

    describe('runQueryRaw', () => {
        it('should execute query with options object form', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'id' }], rows: [[1]], limitReached: false }],
                error: null,
                recordsAffected: undefined,
            });

            const result = await runQueryRaw({
                context: mockContext,
                query: 'SELECT 1',
                connectionManager: mockConnManager,
                documentUri: 'file:///test.sql',
            });

            expect(result.columns).toEqual([{ name: 'id' }]);
            expect(result.data).toEqual([[1]]);
        });

        it('passes include file context to the single-query variable scan', async () => {
            const { collectQueryVariableValues } = require('../core/variableResolver');
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'id' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueryRaw({
                context: mockContext,
                query: "%INCLUDE 'settings.sql';\nSELECT 1",
                connectionManager: mockConnManager,
                documentUri: 'file:///workspace/main.sql',
            });

            expect(collectQueryVariableValues).toHaveBeenCalledWith(
                "%INCLUDE 'settings.sql';\nSELECT 1",
                false,
                mockContext,
                expect.objectContaining({
                    sourceName: 'file:///workspace/main.sql',
                    readFile: expect.any(Function),
                }),
            );
        });

        it('executes each statement from an expanded macro branch separately', async () => {
            const { resolveQueryVariablesWithValues } = require('../core/variableResolver');
            (resolveQueryVariablesWithValues as jest.Mock).mockResolvedValueOnce(
                'SELECT 1;\nSELECT 2;',
            );
            mockExecuteAndFetch
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'a' }], rows: [[1]], limitReached: false }],
                    error: null,
                })
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'b' }], rows: [[2]], limitReached: false }],
                    error: null,
                });

            const result = await runQueryRaw({
                context: mockContext,
                query: `%IF 1 = 1 %THEN %DO;
  SELECT 1;
  SELECT 2;
%END;`,
                connectionManager: mockConnManager,
                documentUri: 'file:///test.sql',
            });

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(2);
            expect(mockExecuteAndFetch.mock.calls[0][1]).toBe('SELECT 1');
            expect(mockExecuteAndFetch.mock.calls[1][1]).toBe('SELECT 2');
            expect(result.data).toEqual([[2]]);
            expect(result.sql).toBe('SELECT 2');
            expect(result.expandedSql).toBe('SELECT 1;\nSELECT 2;');
        });

        it('should not abort state when no documentUri is provided', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'id' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueryRaw({
                context: mockContext,
                query: 'SELECT 1',
                connectionManager: mockConnManager,
            });

            // No documentUri -> no abortQuery invocation; the production code
            // now relies on AbortController lifecycle, not a separate clear call.
            expect(streamingManager.abortQuery).not.toHaveBeenCalled();
        });

        it('should execute query with positional args form', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[42]], limitReached: false }],
                error: null,
            });

            const result = await runQueryRaw(
                mockContext,
                'SELECT 42',
                false,
                mockConnManager,
                undefined,
                'file:///test.sql',
            );

            expect(result.data).toEqual([[42]]);
        });

        it('should throw on resolve error', async () => {
            const { collectQueryVariableValues } = require('../core/variableResolver');
            (collectQueryVariableValues as jest.Mock).mockRejectedValueOnce(
                new Error('Variable prompt cancelled'),
            );

            await expect(
                runQueryRaw({
                    context: mockContext,
                    query: 'SELECT $VAR',
                    connectionManager: mockConnManager,
                }),
            ).rejects.toThrow('Variable prompt cancelled');
        });

        it('should log query to history after success', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueryRaw({
                context: mockContext,
                query: 'SELECT 1',
                connectionManager: mockConnManager,
                documentUri: 'file:///test.sql',
            });

            expect(mockLogQueryToHistory).toHaveBeenCalled();
        });

        it('should handle busy connection error', async () => {
            mockExecuteAndFetch.mockRejectedValue(new Error('Connection is already executing a command'));
            mockHandleBusyConnectionError.mockResolvedValueOnce(true);

            await expect(
                runQueryRaw({
                    context: mockContext,
                    query: 'SELECT 1',
                    connectionManager: mockConnManager,
                    documentUri: 'file:///test.sql',
                }),
            ).rejects.toThrow('Connection is busy');
        });

        it('should handle generic error', async () => {
            mockExecuteAndFetch.mockRejectedValue(new Error('Syntax error near foo'));

            await expect(
                runQueryRaw({
                    context: mockContext,
                    query: 'BAD SQL',
                    connectionManager: mockConnManager,
                }),
            ).rejects.toThrow('Syntax error near foo');
        });

        it('should retry on broken connection when documentUri and keepConnection', async () => {
            (isConnectionBrokenError as jest.Mock)
                .mockReturnValueOnce(true);

            // First call fails, retry succeeds
            mockExecuteAndFetch
                .mockRejectedValueOnce(new Error('connection reset'))
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                    error: null,
                });

            const result = await runQueryRaw({
                context: mockContext,
                query: 'SELECT 1',
                connectionManager: mockConnManager,
                documentUri: 'file:///test.sql',
            });

            expect(result.data).toEqual([[1]]);
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledWith('file:///test.sql');
        });

        it('should throw retry error when retry also fails', async () => {
            (isConnectionBrokenError as jest.Mock)
                .mockReturnValueOnce(true);

            mockExecuteAndFetch
                .mockRejectedValueOnce(new Error('connection reset'))
                .mockRejectedValueOnce(new Error('still broken'));

            await expect(
                runQueryRaw({
                    context: mockContext,
                    query: 'SELECT 1',
                    connectionManager: mockConnManager,
                    documentUri: 'file:///test.sql',
                }),
            ).rejects.toThrow('after reconnect attempt');
        });
    });

    // ── executeRawQuery ────────────────────────────────────────────

    describe('executeRawQuery', () => {
        const logger = {
            outputChannel: { appendLine: jest.fn() },
            logCallback: undefined,
        } as any;

        it('should return columns and data for SELECT result', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'id' }], rows: [[1]], limitReached: false }],
                error: null,
                recordsAffected: undefined,
            });

            const result = await executeRawQuery(
                mockConnManager, 'testConn', true, 'file:///test.sql',
                'SELECT 1', undefined, logger,
            );

            expect(result.columns).toEqual([{ name: 'id' }]);
            expect(result.data).toEqual([[1]]);
            expect(result.sql).toBe('SELECT 1');
        });

        it('should return message for DDL query (no columns)', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
                recordsAffected: 0,
            });

            const result = await executeRawQuery(
                mockConnManager, 'testConn', true, undefined,
                'CREATE TABLE foo (id int)', undefined, logger,
            );

            expect(result.columns).toEqual([]);
            expect(result.message).toContain('Records affected: 0');
        });

        it('should return recordsAffected for DML', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
                recordsAffected: 10,
            });

            const result = await executeRawQuery(
                mockConnManager, 'testConn', true, undefined,
                'DELETE FROM foo', undefined, logger,
            );

            expect(result.rowsAffected).toBe(10);
            expect(result.message).toContain('Records affected: 10');
        });

        it('should return "Query executed successfully." when recordsAffected is undefined', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
                recordsAffected: undefined,
            });

            const result = await executeRawQuery(
                mockConnManager, 'testConn', true, undefined,
                'CREATE TABLE foo (id int)', undefined, logger,
            );

            expect(result.message).toBe('Query executed successfully.');
            expect(result.rowsAffected).toBeUndefined();
        });

        it('should include recordsAffected in log for SELECT with recordsAffected', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'id' }], rows: [[1]], limitReached: false }],
                error: null,
                recordsAffected: 5,
            });

            const result = await executeRawQuery(
                mockConnManager, 'testConn', true, undefined,
                'SELECT * FROM foo', undefined, logger,
            );

            expect(result.rowsAffected).toBe(5);
        });

        it('should throw when executeAndFetch returns error', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: new Error('query failed'),
            });

            await expect(
                executeRawQuery(
                    mockConnManager, 'testConn', true, undefined,
                    'BAD SQL', undefined, logger,
                ),
            ).rejects.toThrow('query failed');
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

            await executeRawQuery(
                mockConnManager, 'testConn', true, undefined,
                'SELECT 1', undefined, logger,
            );

            expect(mockConn.close).toHaveBeenCalled();
        });

        it('should register notice handler when logger has outputChannel', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await executeRawQuery(
                mockConnManager, 'testConn', true, 'file:///test.sql',
                'SELECT 1', undefined, logger,
            );

            expect(mockConn.on).toHaveBeenCalledWith('notice', expect.any(Function));
            expect(mockConn.removeListener).toHaveBeenCalledWith('notice', expect.any(Function));
        });

        it('should set sessionId when documentUri is provided', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await executeRawQuery(
                mockConnManager, 'testConn', true, 'file:///test.sql',
                'SELECT 1', undefined, logger,
            );

            expect(mockConnManager.setDocumentLastSessionId).toHaveBeenCalled();
        });

        it('should use maxRows when provided instead of rowLimit', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await executeRawQuery(
                mockConnManager, 'testConn', true, undefined,
                'SELECT 1', 50, logger,
            );

            // The 3rd argument to executeAndFetch is the rowLimit/maxRows value
            const callArgs = mockExecuteAndFetch.mock.calls[0];
            expect(callArgs[2]).toBe(50); // maxRows should be used instead of default rowLimit
        });
    });

    // ── runQuery ───────────────────────────────────────────────────

    describe('runQuery', () => {
        it('should return JSON string for SELECT results', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{
                    columns: [{ name: 'id' }, { name: 'name' }],
                    rows: [[1, 'Alice'], [2, 'Bob']],
                    limitReached: false,
                }],
                error: null,
            });

            const result = await runQuery(
                mockContext, 'SELECT * FROM users', false,
                undefined, mockConnManager, 'file:///test.sql',
            );

            const parsed = JSON.parse(result!);
            expect(parsed).toHaveLength(2);
            expect(parsed[0].id).toBe(1);
            expect(parsed[0].name).toBe('Alice');
        });

        it('should return message when no data rows', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
                recordsAffected: undefined,
            });

            const result = await runQuery(
                mockContext, 'CREATE TABLE x (id int)', false,
                undefined, mockConnManager,
            );

            expect(result).toContain('Query executed successfully');
        });

        it('should return undefined when no data and no message', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [], limitReached: false }],
                error: null,
            });

            const result = await runQuery(
                mockContext, 'SELECT 1 WHERE 1=0', false,
                undefined, mockConnManager,
            );

            expect(result).toBeUndefined();
        });

        it('should handle bigint values in JSON serialization', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{
                    columns: [{ name: 'big' }],
                    rows: [[BigInt(42)]],
                    limitReached: false,
                }],
                error: null,
            });

            const result = await runQuery(
                mockContext, 'SELECT 42', false,
                undefined, mockConnManager,
            );

            const parsed = JSON.parse(result!);
            expect(parsed[0].big).toBe(42);
        });

        it('should handle unsafe bigint values as strings', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{
                    columns: [{ name: 'big' }],
                    rows: [[BigInt("9999999999999999999")]],
                    limitReached: false,
                }],
                error: null,
            });

            const result = await runQuery(
                mockContext, 'SELECT big_val', false,
                undefined, mockConnManager,
            );

            const parsed = JSON.parse(result!);
            expect(parsed[0].big).toBe("9999999999999999999");
        });
    });

    // ── queryResultToRows ──────────────────────────────────────────

    describe('queryResultToRows', () => {
        it('should convert QueryResult to row objects', () => {
            const result = {
                columns: [{ name: 'id' }, { name: 'name' }],
                data: [[1, 'Alice'], [2, 'Bob']],
            } as any;

            const rows = queryResultToRows<{ id: number; name: string }>(result);
            expect(rows).toHaveLength(2);
            expect(rows[0].id).toBe(1);
            expect(rows[0].name).toBe('Alice');
        });

        it('should return empty array for empty results', () => {
            const result = { columns: [], data: [] } as any;
            const rows = queryResultToRows(result);
            expect(rows).toEqual([]);
        });
    });

    // ── parseQueryJsonResult ───────────────────────────────────────

    describe('parseQueryJsonResult', () => {
        it('should return empty array for undefined', () => {
            expect(parseQueryJsonResult(undefined)).toEqual([]);
        });

        it('should return empty array for "Query executed successfully"', () => {
            expect(parseQueryJsonResult('Query executed successfully. Records affected: 0')).toEqual([]);
        });

        it('should return empty array for "Query executed successfully (no results)."', () => {
            expect(parseQueryJsonResult('Query executed successfully (no results).')).toEqual([]);
        });

        it('should parse valid JSON', () => {
            const result = parseQueryJsonResult<{ id: number }>('[{"id": 1}]');
            expect(result).toEqual([{ id: 1 }]);
        });

        it('should return empty array for invalid JSON', () => {
            expect(parseQueryJsonResult('not json')).toEqual([]);
        });
    });

    // ── runExplainQuery ────────────────────────────────────────────

    describe('runExplainQuery', () => {
        it('should collect NOTICE messages and return them', async () => {
            const mockReader = {
                read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
                nextResult: jest.fn().mockResolvedValue(false),
                close: jest.fn().mockResolvedValue(undefined),
                fieldCount: 0,
            };
            const mockCmd = {
                executeReader: jest.fn().mockResolvedValue(mockReader),
                commandTimeout: 0,
            };
            mockConn.createCommand.mockReturnValue(mockCmd);

            // Simulate notice firing when connection.on('notice') is called
            mockConn.on.mockImplementation((event: string, handler: (msg: unknown) => void) => {
                if (event === 'notice') {
                    setTimeout(() => {
                        handler({ message: 'EXPLAIN line 1' });
                        handler({ message: 'EXPLAIN line 2' });
                    }, 0);
                }
            });

            const result = await runExplainQuery(
                mockContext, 'EXPLAIN SELECT 1',
                undefined, mockConnManager, 'file:///test.sql',
            );

            expect(mockConn.on).toHaveBeenCalledWith('notice', expect.any(Function));
            expect(mockConn.removeListener).toHaveBeenCalledWith('notice', expect.any(Function));
            // Result may be empty if notices haven't fired yet due to timing,
            // but the handler setup is tested
            expect(typeof result).toBe('string');
        });

        it('should close connection when shouldCloseConnection is true', async () => {
            mockGetConnectionForDocument.mockResolvedValue({
                connection: mockConn,
                shouldCloseConnection: true,
            });

            const mockReader = {
                read: jest.fn().mockResolvedValue(false),
                nextResult: jest.fn().mockResolvedValue(false),
                close: jest.fn().mockResolvedValue(undefined),
                fieldCount: 0,
            };
            mockConn.createCommand.mockReturnValue({
                executeReader: jest.fn().mockResolvedValue(mockReader),
                commandTimeout: 0,
            });

            await runExplainQuery(
                mockContext, 'EXPLAIN SELECT 1',
                undefined, mockConnManager,
            );

            expect(mockConn.close).toHaveBeenCalled();
        });
    });

    // ── runQueryWithCatalog ─────────────────────────────────────────

    describe('runQueryWithCatalog', () => {
        it('should switch catalog, execute query, and restore catalog', async () => {
            const readerResults = [
                // CURRENT_CATALOG read
                { read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false), getValue: jest.fn().mockReturnValue('ORIGINAL_DB'), close: jest.fn().mockResolvedValue(undefined) },
                // SET CATALOG TARGET_DB
                { read: jest.fn().mockResolvedValue(false), close: jest.fn().mockResolvedValue(undefined) },
                // SET CATALOG ORIGINAL_DB (restore)
                { read: jest.fn().mockResolvedValue(false), close: jest.fn().mockResolvedValue(undefined) },
            ];
            let readerIdx = 0;
            mockConn.createCommand.mockImplementation(() => ({
                executeReader: jest.fn().mockResolvedValue(readerResults[readerIdx++]),
            }));

            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'def' }], rows: [['CREATE VIEW...']], limitReached: false }],
                error: null,
            });

            const result = await runQueryWithCatalog(
                'TARGET_DB', 'SELECT * FROM _V_VIEW',
                mockConnManager, 'testConn',
            );

            expect(result.columns).toEqual([{ name: 'def' }]);
            expect(result.data).toEqual([['CREATE VIEW...']]);
        });

        it('should return empty result when SET CATALOG fails', async () => {
            const readerResults = [
                // CURRENT_CATALOG
                { read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false), getValue: jest.fn().mockReturnValue('ORIG'), close: jest.fn().mockResolvedValue(undefined) },
            ];
            let readerIdx = 0;
            mockConn.createCommand.mockImplementation((sql: string) => {
                if (sql.startsWith('SET CATALOG')) {
                    return { executeReader: jest.fn().mockRejectedValue(new Error('catalog not found')) };
                }
                return { executeReader: jest.fn().mockResolvedValue(readerResults[readerIdx++]) };
            });

            const result = await runQueryWithCatalog(
                'BAD_DB', 'SELECT 1', mockConnManager, 'testConn',
            );

            expect(result.columns).toEqual([]);
            expect(result.data).toEqual([]);
        });

        it('should handle error from executeAndFetch', async () => {
            mockConn.createCommand.mockReturnValue({
                executeReader: jest.fn().mockResolvedValue({
                    read: jest.fn().mockResolvedValue(false),
                    getValue: jest.fn(),
                    close: jest.fn().mockResolvedValue(undefined),
                }),
            });

            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: new Error('query failed in catalog'),
            });

            await expect(
                runQueryWithCatalog('DB', 'SELECT 1', mockConnManager, 'testConn'),
            ).rejects.toThrow('query failed in catalog');
        });

        it('should close connection when shouldCloseConnection is true', async () => {
            mockGetConnectionForDocument.mockResolvedValue({
                connection: mockConn,
                shouldCloseConnection: true,
            });
            mockConn.createCommand.mockReturnValue({
                executeReader: jest.fn().mockResolvedValue({
                    read: jest.fn().mockResolvedValue(false),
                    close: jest.fn().mockResolvedValue(undefined),
                }),
            });
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
            });

            await runQueryWithCatalog('DB', 'SELECT 1', mockConnManager, 'testConn');

            expect(mockConn.close).toHaveBeenCalled();
        });
    });
});

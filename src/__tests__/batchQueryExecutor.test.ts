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

jest.mock('../core/variableUtils', () => {
    const actual = jest.requireActual('../core/variableUtils');
    return {
        ...actual,
        extractVariables: jest.fn().mockReturnValue(new Set()),
        parseSetVariables: jest.fn().mockImplementation((sql: string) => ({
            sql,
            setValues: {},
        })),
        replaceVariablesInSql: jest.fn().mockImplementation((sql: string) => sql),
    };
});

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
import { isSafeToRetryAfterBrokenConnection } from '../core/queryRetrySafety';
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
        const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
        (isConnectionBrokenError as jest.Mock).mockReset().mockReturnValue(false);
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

    describe('retry safety classification', () => {
        it.each([
            'SELECT 1',
            '\uFEFF -- reason\n /* nested /* note */ done */ SELECT * FROM T',
            'VALUES (1)',
            "SELECT 'mutate_customer(42)'",
            'SELECT $$mutate_customer(42)$$',
            'SELECT $body$mutate_customer(42)$body$',
            'SELECT 1 /* mutate_customer(42) */',
            'SELECT 1 -- mutate_customer(42)\n',
            '--compact comment\nSELECT * FROM T',
            'SELECT * FROM T WHERE id = $1',
            "SELECT payload #> '{customer}' FROM T",
            "SELECT payload #>> '{customer,name}' FROM T",
            'SHOW TABLES',
            'DESCRIBE T',
            'EXPLAIN SELECT * FROM T',
            'EXPLAIN VERBOSE SELECT * FROM T',
        ])('allows one unambiguous read-only statement: %s', sql => {
            expect(isSafeToRetryAfterBrokenConnection(sql)).toBe(true);
        });

        it.each([
            'INSERT INTO T VALUES (1)',
            'UPDATE T SET X = 1',
            'DELETE FROM T',
            'CREATE TABLE T (X INT)',
            'CALL MUTATE_STATE()',
            'WITH X AS (SELECT 1) SELECT * FROM X',
            'SELECT * INTO CUSTOMER_COPY FROM CUSTOMER',
            "SELECT nextval('customer_seq')",
            'SELECT customer_seq.NEXTVAL FROM dual',
            'SELECT mutate_customer(42)',
            'SELECT "mutate_customer"(42)',
            'SELECT [mutate_customer](42)',
            'SELECT `mutate_customer`(42)',
            'SELECT функция(42)',
            "SELECT $$'$$, mutate_customer(42), $$'$$",
            'SELECT 1 # mutate_customer(42)',
            'SELECT 1--mutate_customer(42)',
            'SELECT 1 /*! mutate_customer(42) */',
            '/*! SET @state = 1 */ SELECT 1',
            "SELECT '{\"a\": 1}'::jsonb # mutate_customer(42)",
            'SELECT * FROM CUSTOMER FOR UPDATE',
            'VALUES NEXT VALUE FOR customer_seq',
            'VALUES mutate_customer(42)',
            'SELECT 1; SELECT 2',
            'EXPLAIN ANALYZE SELECT * FROM T',
            'EXPLAIN SELECT * INTO CUSTOMER_COPY FROM CUSTOMER',
            'EXPLAIN INSERT INTO T VALUES (1)',
            '/* unterminated',
        ])('rejects unsafe or ambiguous replay: %s', sql => {
            expect(isSafeToRetryAfterBrokenConnection(sql)).toBe(false);
        });
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

        it('executes an expanded macro branch as one payload', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                [`%IF 1 = 1 %THEN %DO;
  SELECT 1;
  SELECT 2;
%END;`],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
            expect(mockExecuteAndFetch.mock.calls[0][1]).toBe('\n  SELECT 1;\n  SELECT 2;\n');
        });

        it('executes a Netezza procedure as one unchanged payload', async () => {
            const procedure = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
 BEGIN RAISE NOTICE 'The customer name is alpha'; RAISE NOTICE 'The customer location is beta'; END;
END_PROC;`;
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [], rows: [], limitReached: false }],
                error: null,
            });

            await runQueriesSequentially(
                mockContext,
                [procedure],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
            expect(mockExecuteAndFetch.mock.calls[0][1]).toBe(procedure);
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

        it('keeps a SQL error containing the word cancel as an error', async () => {
            mockExecuteAndFetch
                .mockResolvedValueOnce({
                    results: [],
                    error: new Error('column "cancel" does not exist'),
                    status: 'error',
                })
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'value' }], rows: [[2]], limitReached: false }],
                    error: null,
                });

            const results = await runQueriesSequentially(
                mockContext,
                ['SELECT cancel', 'SELECT 2'],
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

            expect(results[0]?.isError).toBe(true);
            expect(results[0]?.message).toBe('column "cancel" does not exist');
            expect(results[1]?.data).toEqual([[2]]);
            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(2);
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
            const onStatementFailed = jest.fn();

            await expect(
                runQueriesSequentially(
                    mockContext,
                    ['SELECT 1', 'SELECT 2'],
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
                    { onStatementFailed },
                ),
            ).rejects.toThrow('Query cancelled');

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
            expect(onStatementFailed).toHaveBeenCalledWith({
                sql: 'SELECT 2',
                connectionName: 'testConn',
                documentUri: 'file:///test.sql',
                errorMessage: 'Query cancelled',
            });
        });

        it('runs transaction cleanup when safe-execute confirmation cancels the batch', async () => {
            const confirmSafeExecute = jest.fn().mockResolvedValue(false);
            const onStatementFailed = jest.fn();

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
                undefined,
                undefined,
                undefined,
                0,
                undefined,
                [],
                { confirmSafeExecute, onStatementFailed },
            );

            expect(results).toEqual([]);
            expect(mockExecuteAndFetch).not.toHaveBeenCalled();
            expect(onStatementFailed).toHaveBeenCalledWith({
                sql: 'SELECT 1',
                connectionName: 'testConn',
                documentUri: 'file:///test.sql',
                errorMessage: 'Query execution cancelled by user',
            });
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

        it('should preserve rowsAffected for a DML statement without result columns', async () => {
            const resultCallback = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: null,
                recordsAffected: 1,
            });

            const results = await runQueriesSequentially(
                mockContext,
                ['UPDATE fixture SET amount = 11.5 WHERE id = 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                resultCallback,
            );

            expect(results).toEqual([
                expect.objectContaining({
                    columns: [],
                    data: [],
                    rowsAffected: 1,
                    message: 'Records affected: 1',
                }),
            ]);
            expect(resultCallback).toHaveBeenCalledWith([
                expect.objectContaining({ rowsAffected: 1 }),
            ]);
        });

        it.each([
            ['-- leading comment\nUPDATE fixture SET amount = 11.5', 'UPDATE'],
            ['/* leading comment */ DELETE FROM fixture WHERE id = 1', 'DELETE'],
            ['\uFEFFTRUNCATE TABLE fixture', 'TRUNCATE'],
        ])('preserves rowsAffected for %s statements', async (sql) => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: null,
                recordsAffected: 3,
            });

            const results = await runQueriesSequentially(
                mockContext,
                [sql],
                mockConnManager,
                'file:///test.sql',
            );

            expect(results[0]).toEqual(expect.objectContaining({
                rowsAffected: 3,
                message: 'Records affected: 3',
            }));
        });

        it('does not attach DML rowsAffected to result sets with columns', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [
                    { columns: [{ name: 'id' }], rows: [[1]], limitReached: false },
                    { columns: [], rows: [], limitReached: false },
                    { columns: [{ name: 'id' }], rows: [[2]], limitReached: false },
                ],
                error: null,
                recordsAffected: 2,
            });

            const results = await runQueriesSequentially(
                mockContext,
                ['UPDATE fixture SET amount = 11.5 RETURNING id'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(results.map(result => result.rowsAffected)).toEqual([undefined, 2, undefined]);
            expect(results[0].message).toBeUndefined();
            expect(results[1].message).toBe('Records affected: 2');
            expect(results[2].message).toBeUndefined();
        });

        it('does not reuse one command-level rowsAffected value across a multi-statement batch', async () => {
            mockExecuteAndFetch.mockResolvedValue({
                results: [
                    { columns: [], rows: [], limitReached: false },
                    { columns: [], rows: [], limitReached: false },
                ],
                error: null,
                recordsAffected: 2,
            });

            const results = await runQueriesSequentially(
                mockContext,
                ['UPDATE fixture SET amount = 11.5 WHERE id = 1; DELETE FROM fixture WHERE id = 2'],
                mockConnManager,
                'file:///test.sql',
            );

            expect(results.map(result => result.rowsAffected)).toEqual([undefined, undefined]);
            expect(results.every(result => result.message === 'Query executed successfully')).toBe(true);
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

        it('should invoke the statement-success hook only after a successful fetch', async () => {
            const onStatementSucceeded = jest.fn().mockResolvedValue(undefined);
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: null,
                recordsAffected: 0,
            });

            await runQueriesSequentially(
                mockContext,
                ['CREATE TABLE T1 (ID INTEGER)'],
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
                { onStatementSucceeded },
            );

            expect(onStatementSucceeded).toHaveBeenCalledWith({
                sql: 'CREATE TABLE T1 (ID INTEGER)',
                connectionName: 'testConn',
                documentUri: 'file:///test.sql',
                connection: mockConn,
            });
        });

        it('should invoke the statement-failure hook instead of the success hook', async () => {
            const onStatementSucceeded = jest.fn().mockResolvedValue(undefined);
            const onStatementFailed = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [],
                error: new Error('DDL failed'),
            });

            await expect(runQueriesSequentially(
                mockContext,
                ['CREATE TABLE T1 (ID INTEGER)'],
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
                { onStatementSucceeded, onStatementFailed },
            )).rejects.toThrow('DDL failed');

            expect(onStatementSucceeded).not.toHaveBeenCalled();
            expect(onStatementFailed).toHaveBeenCalledWith(expect.objectContaining({
                sql: 'CREATE TABLE T1 (ID INTEGER)',
                connectionName: 'testConn',
                errorMessage: 'DDL failed',
            }));
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
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);

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
                0,
                'retrying',
                'Connection was closed by server. Reconnecting and retrying...',
            );
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                2,
                'exec-retry',
                1,
                expect.any(Number),
                'success',
            );
            expect(queryEndCallback).toHaveBeenCalledTimes(2);
            expect(mockHistoryManager.addEntry).toHaveBeenCalledTimes(1);
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledWith(
                'file:///test.sql',
            );
            expect(mockClearAborted).toHaveBeenCalledTimes(1);
        });

        it('does not replay a sequential query when cancellation races reconnect cleanup', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);
            const queryStartCallback = jest.fn().mockReturnValue('exec-cancel-race');
            const queryEndCallback = jest.fn();
            const onStatementFailed = jest.fn();
            mockExecuteAndFetch.mockRejectedValueOnce(new Error('Connection lost'));
            mockConnManager.closeDocumentPersistentConnection.mockImplementationOnce(async () => {
                mockIsAborted.mockReturnValue(true);
            });

            await expect(runQueriesSequentially(
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
                undefined,
                0,
                undefined,
                [],
                { onStatementFailed },
            )).rejects.toThrow('Query cancelled');

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledTimes(1);
            expect(queryEndCallback.mock.calls.map((call: unknown[]) => call[3])).toEqual([
                'retrying',
                'cancelled',
            ]);
            expect(onStatementFailed).toHaveBeenCalledTimes(1);
        });

        it('emits one terminal error when the read-only reconnect retry also fails', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);

            const queryStartCallback = jest.fn().mockReturnValue('exec-retry-failed');
            const queryEndCallback = jest.fn();
            mockExecuteAndFetch
                .mockRejectedValueOnce(new Error('Connection lost'))
                .mockRejectedValueOnce(new Error('Connection still unavailable'));

            await expect(runQueriesSequentially(
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
            )).rejects.toThrow('after reconnect attempt');

            expect(queryEndCallback.mock.calls.map((call: unknown[]) => call[3])).toEqual([
                'retrying',
                'error',
            ]);
            expect(queryEndCallback).toHaveBeenLastCalledWith(
                'exec-retry-failed',
                0,
                expect.any(Number),
                'error',
                'Connection still unavailable',
            );
            expect(mockHistoryManager.addEntry).toHaveBeenCalledTimes(1);
        });

        it('emits cancellation as the only terminal status', async () => {
            const queryStartCallback = jest.fn().mockReturnValue('exec-cancelled');
            const queryEndCallback = jest.fn();
            const onStatementFailed = jest.fn();
            mockExecuteAndFetch.mockResolvedValue({
                results: [{ columns: [{ name: 'x' }], rows: [[1]], limitReached: false }],
                error: new Error('Query cancelled'),
                status: 'cancelled',
            });

            await expect(runQueriesSequentially(
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
                undefined,
                0,
                undefined,
                [],
                { onStatementFailed },
            )).rejects.toThrow('Query cancelled');

            expect(queryEndCallback).toHaveBeenCalledTimes(1);
            expect(queryEndCallback).toHaveBeenCalledWith(
                'exec-cancelled',
                1,
                expect.any(Number),
                'cancelled',
                'Query cancelled',
            );
            expect(onStatementFailed).toHaveBeenCalledWith(expect.objectContaining({
                connectionName: 'testConn',
                documentUri: 'file:///test.sql',
                errorMessage: 'Query cancelled',
            }));
        });

        it('does not retry a write after a broken connection and reports an unknown outcome', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);

            const queryStartCallback = jest.fn().mockReturnValue('exec-write');
            const queryEndCallback = jest.fn();
            mockExecuteAndFetch.mockRejectedValue(new Error('Connection lost'));

            await expect(runQueriesSequentially(
                mockContext,
                ['UPDATE CUSTOMER SET ACTIVE = 1'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                undefined,
                undefined,
                false,
                undefined,
                queryStartCallback,
                queryEndCallback,
            )).rejects.toThrow('database outcome may be unknown');

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
            expect(mockConnManager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
            expect(queryEndCallback).toHaveBeenCalledTimes(1);
            expect(queryEndCallback).toHaveBeenCalledWith(
                'exec-write',
                0,
                expect.any(Number),
                'error',
                expect.stringContaining('could not be proven safe to retry'),
            );
        });

        it('does not retry a macro branch after a broken connection', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);
            mockExecuteAndFetch.mockRejectedValue(new Error('Connection lost'));

            await expect(runQueriesSequentially(
                mockContext,
                [`%IF 1 = 1 %THEN %DO;
  INSERT INTO audit_log VALUES (1);
  UPDATE customer SET active = 1;
%END;`],
                mockConnManager,
                'file:///test.sql',
            )).rejects.toThrow('could not be proven safe to retry');

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(1);
            expect(mockConnManager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
        });

        it('does not retry after an executable SQL macro was expanded', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);
            mockExecuteAndFetch
                .mockResolvedValueOnce({
                    results: [{ columns: [{ name: 'id' }], rows: [[1]], limitReached: false }],
                    error: null,
                })
                .mockRejectedValueOnce(new Error('Connection lost'));

            await expect(runQueriesSequentially(
                mockContext,
                ['SELECT %SQL(DELETE FROM audit_log RETURNING id)'],
                mockConnManager,
                'file:///test.sql',
            )).rejects.toThrow('could not be proven safe to retry');

            expect(mockExecuteAndFetch).toHaveBeenCalledTimes(2);
            expect(mockExecuteAndFetch.mock.calls[0][1]).toBe('DELETE FROM audit_log RETURNING id');
            expect(mockExecuteAndFetch.mock.calls[1][1]).toBe('SELECT 1');
            expect(mockConnManager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
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

        it('closes a transient connection opened after the execution is retired', async () => {
            let executionCurrent = true;
            let resolveConnection!: (value: { connection: typeof mockConn; shouldCloseConnection: boolean }) => void;
            let signalConnectionRequested!: () => void;
            const connectionRequested = new Promise<void>(resolve => {
                signalConnectionRequested = resolve;
            });
            const pendingConnection = new Promise<{ connection: typeof mockConn; shouldCloseConnection: boolean }>(resolve => {
                resolveConnection = resolve;
            });
            mockConnManager.getDocumentKeepConnectionOpen.mockReturnValue(false);
            mockGetConnectionForDocument.mockImplementationOnce(() => {
                signalConnectionRequested();
                return pendingConnection;
            });

            const execution = runQueriesSequentially(
                mockContext,
                ['SELECT 1'],
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
                { isExecutionCurrent: () => executionCurrent },
            );
            await connectionRequested;
            executionCurrent = false;
            resolveConnection({ connection: mockConn, shouldCloseConnection: true });

            await expect(execution).rejects.toThrow('execution superseded');
            expect(mockConn.close).toHaveBeenCalledTimes(1);
            expect(mockExecuteAndFetch).not.toHaveBeenCalled();
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

        it('streams an expanded macro branch as one payload', async () => {
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 1,
                limitReached: false,
                error: null,
                recordsAffected: undefined,
            });

            await runQueriesWithStreaming(
                mockContext,
                [`%IF 1 = 1 %THEN %DO;
  SELECT 1;
  SELECT 2;
%END;`],
                mockConnManager,
                'file:///test.sql',
            );

            expect(mockExecuteWithStreaming).toHaveBeenCalledTimes(1);
            expect(mockExecuteWithStreaming.mock.calls[0]?.[1]).toBe('\n  SELECT 1;\n  SELECT 2;\n');
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

        it('logs slow streaming cleanup phases without including SQL text', async () => {
            const logCallback = jest.fn();
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 102000,
                limitReached: false,
                error: null,
                status: 'success',
                timing: {
                    rowsRead: 102000,
                    executeReaderMs: 80,
                    resultCompletionWaitMs: 12000,
                    readerCloseMs: 3,
                    chunkDeliveryMs: 250,
                    totalMs: 12600,
                },
            });

            await runQueriesWithStreaming(
                mockContext,
                ['SELECT secret_column FROM private_table'],
                mockConnManager,
                'file:///test.sql',
                logCallback,
            );

            const timingLog = logCallback.mock.calls
                .map((call: unknown[]) => String(call[0]))
                .find((message: string) => message.includes('[StreamingTiming]'));
            expect(timingLog).toContain('rows=102000');
            expect(timingLog).toContain('resultCompletionWaitMs=12000');
            expect(timingLog).not.toContain('secret_column');
            expect(timingLog).not.toContain('private_table');
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
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);

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
                0,
                'retrying',
                'Connection was closed by server. Reconnecting and retrying...',
            );
            expect(queryEndCallback).toHaveBeenNthCalledWith(
                2,
                'stream-retry',
                10,
                expect.any(Number),
                'success',
            );
            expect(queryEndCallback).toHaveBeenCalledTimes(2);
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledWith(
                'file:///test.sql',
            );
            expect(mockClearAborted).toHaveBeenCalledTimes(1);
        });

        it('does not replay a streaming query when cancellation races reconnect cleanup', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);
            const queryStartCallback = jest.fn().mockReturnValue('stream-cancel-race');
            const queryEndCallback = jest.fn();
            const onStatementFailed = jest.fn();
            mockExecuteWithStreaming.mockRejectedValueOnce(new Error('Connection lost'));
            mockConnManager.closeDocumentPersistentConnection.mockImplementationOnce(async () => {
                mockIsAborted.mockReturnValue(true);
            });

            await expect(runQueriesWithStreaming(
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
                undefined,
                0,
                undefined,
                { onStatementFailed },
            )).rejects.toThrow('Query cancelled');

            expect(mockExecuteWithStreaming).toHaveBeenCalledTimes(1);
            expect(mockConnManager.closeDocumentPersistentConnection).toHaveBeenCalledTimes(1);
            expect(queryEndCallback.mock.calls.map((call: unknown[]) => call[3])).toEqual([
                'retrying',
                'cancelled',
            ]);
            expect(onStatementFailed).toHaveBeenCalledTimes(1);
        });

        it('keeps partial streamed rows and does not retry after a chunk was delivered', async () => {
            const { isConnectionBrokenError } = require('../core/queryRunnerUtils');
            (isConnectionBrokenError as jest.Mock).mockReturnValue(true);

            const queryStartCallback = jest.fn().mockReturnValue('stream-partial');
            const queryEndCallback = jest.fn();
            const chunkCallback = jest.fn();
            const partialChunk = {
                columns: [{ name: 'id' }],
                rows: [[1], [2]],
                isFirstChunk: true,
                isLastChunk: false,
                totalRowsSoFar: 2,
                limitReached: false,
            };
            mockExecuteWithStreaming.mockImplementationOnce(async (...args: any[]) => {
                await args[6](partialChunk);
                return {
                    totalRows: 2,
                    limitReached: false,
                    error: new Error('Connection lost'),
                    status: 'error',
                };
            });

            await expect(runQueriesWithStreaming(
                mockContext,
                ['SELECT * FROM CUSTOMER'],
                mockConnManager,
                'file:///test.sql',
                undefined,
                chunkCallback,
                2,
                undefined,
                false,
                undefined,
                queryStartCallback,
                queryEndCallback,
            )).rejects.toThrow('partial result was kept');

            expect(chunkCallback).toHaveBeenCalledWith(0, partialChunk, 'SELECT * FROM CUSTOMER');
            expect(mockExecuteWithStreaming).toHaveBeenCalledTimes(1);
            expect(mockConnManager.closeDocumentPersistentConnection).not.toHaveBeenCalled();
            expect(queryEndCallback).toHaveBeenCalledTimes(1);
            expect(queryEndCallback).toHaveBeenCalledWith(
                'stream-partial',
                2,
                expect.any(Number),
                'error',
                expect.stringContaining('partial result was kept'),
            );
        });

        it('emits one cancelled terminal status for a cancelled stream', async () => {
            const queryStartCallback = jest.fn().mockReturnValue('stream-cancelled');
            const queryEndCallback = jest.fn();
            const onStatementFailed = jest.fn();
            mockExecuteWithStreaming.mockResolvedValue({
                totalRows: 3,
                limitReached: false,
                error: new Error('Query cancelled'),
                status: 'cancelled',
            });

            await expect(runQueriesWithStreaming(
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
                undefined,
                0,
                undefined,
                { onStatementFailed },
            )).rejects.toThrow('Query cancelled');

            expect(queryEndCallback).toHaveBeenCalledTimes(1);
            expect(queryEndCallback).toHaveBeenCalledWith(
                'stream-cancelled',
                3,
                expect.any(Number),
                'cancelled',
                'Query cancelled',
            );
            expect(onStatementFailed).toHaveBeenCalledWith(expect.objectContaining({
                connectionName: 'testConn',
                documentUri: 'file:///test.sql',
                errorMessage: 'Query cancelled',
            }));
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

        it('closes a transient streaming connection opened after the execution is retired', async () => {
            let executionCurrent = true;
            let resolveConnection!: (value: { connection: typeof mockConn; shouldCloseConnection: boolean }) => void;
            let signalConnectionRequested!: () => void;
            const connectionRequested = new Promise<void>(resolve => {
                signalConnectionRequested = resolve;
            });
            const pendingConnection = new Promise<{ connection: typeof mockConn; shouldCloseConnection: boolean }>(resolve => {
                resolveConnection = resolve;
            });
            mockConnManager.getDocumentKeepConnectionOpen.mockReturnValue(false);
            mockGetConnectionForDocument.mockImplementationOnce(() => {
                signalConnectionRequested();
                return pendingConnection;
            });

            const execution = runQueriesWithStreaming(
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
                undefined,
                undefined,
                undefined,
                0,
                undefined,
                { isExecutionCurrent: () => executionCurrent },
            );
            await connectionRequested;
            executionCurrent = false;
            resolveConnection({ connection: mockConn, shouldCloseConnection: true });

            await expect(execution).rejects.toThrow('execution superseded');
            expect(mockConn.close).toHaveBeenCalledTimes(1);
            expect(mockExecuteWithStreaming).not.toHaveBeenCalled();
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

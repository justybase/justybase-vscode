import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ExportMetadata } from '../export/exportManager';
import type { ConnectionDetails, ResultSet } from '../types';

const mockExecuteWithStreaming = jest.fn();
const mockUnregisterCommand = jest.fn();
const mockRegisterCommand = jest.fn().mockReturnValue({
    signal: { aborted: false },
    abort: jest.fn(),
    unregister: mockUnregisterCommand,
});
const mockGetConnectionForDocument = jest.fn().mockResolvedValue({
    connection: { close: jest.fn().mockResolvedValue(undefined) },
    shouldCloseConnection: false,
});

jest.mock('../core/queryCancellation', () => ({
    streamingManager: {
        executeWithStreaming: mockExecuteWithStreaming,
        registerCommand: mockRegisterCommand,
    },
}));

jest.mock('../core/queryRunnerHelpers', () => ({
    getConnectionForDocument: mockGetConnectionForDocument,
}));

jest.mock('../core/queryBatchExecutor', () => ({
    getQueryConfig: jest.fn().mockReturnValue({ queryTimeout: 1800 }),
    createDropSessionCallback: jest.fn().mockReturnValue(undefined),
}));

jest.mock(
    'vscode',
    () => ({
        window: {
            withProgress: jest.fn((_options, task) => task({ report: jest.fn() })),
            showErrorMessage: jest.fn(),
            showInformationMessage: jest.fn(),
            showTextDocument: jest.fn().mockResolvedValue(undefined),
        },
        workspace: {
            openTextDocument: jest.fn().mockResolvedValue({
                uri: {
                    toString: () => 'untitled:duckdb-bridge.sql',
                },
            }),
        },
        ProgressLocation: {
            Notification: 1,
        },
    }),
    { virtual: true },
);

import { DuckDbResultBridge } from '../services/duckdbResultBridge';

describe('DuckDbResultBridge', () => {
    const metadata: ExportMetadata = {
        sourceUri: 'file:///results.sql',
        resultSetIndex: 0,
    };

    const resultSet: ResultSet = {
        columns: [
            { name: 'id', type: 'INTEGER' },
            { name: 'name', type: 'VARCHAR' },
        ],
        data: [
            [1, 'Alice'],
            [2, 'Bob'],
        ],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let connectionManager: any;
    const exportResultSet = jest.fn().mockResolvedValue(undefined);
    const execute = jest.fn().mockResolvedValue(undefined);
    const close = jest.fn().mockResolvedValue(undefined);
    const createConnection = jest.fn().mockResolvedValue({
        createCommand: jest.fn().mockReturnValue({
            execute,
        }),
        close,
    });
    const deleteFile = jest.fn().mockResolvedValue(undefined);

    beforeEach(() => {
        jest.clearAllMocks();
        mockExecuteWithStreaming.mockResolvedValue({
            totalRows: 0,
            limitReached: false,
            status: 'success',
        });
        mockRegisterCommand.mockReturnValue({
            signal: { aborted: false },
            abort: jest.fn(),
            unregister: mockUnregisterCommand,
        });

        connectionManager = {
            getConnection: jest.fn().mockResolvedValue(undefined),
            saveConnection: jest.fn().mockResolvedValue(undefined),
            setDocumentConnection: jest.fn(),
        };
    });

    function createBridge(resultsMap: Map<string, ResultSet[]>) {
        return new DuckDbResultBridge(resultsMap, connectionManager, {
            createConnection,
            exportResultSet,
            openTextDocument: vscode.workspace.openTextDocument,
            showTextDocument: vscode.window.showTextDocument,
            deleteFile,
            tmpDir: () => '/tmp',
            now: () => 12345,
        });
    }

    it('exports the result set, loads DuckDB, and opens a bound SQL document', async () => {
        const resultsMap = new Map<string, ResultSet[]>([[metadata.sourceUri, [resultSet]]]);
        const bridge = createBridge(resultsMap);

        await bridge.queryLocally(metadata);

        expect(exportResultSet).toHaveBeenCalledWith(
            resultSet,
            '/tmp/justybase-duckdb-bridge-12345.csv',
            expect.objectContaining({ format: 'csv' }),
        );
        expect(connectionManager.saveConnection).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'DuckDB Bridge',
                dbType: 'duckdb',
                database: '/tmp/justybase-duckdb-bridge.duckdb',
            }),
        );
        expect(createConnection).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'DuckDB Bridge',
                dbType: 'duckdb',
            }),
        );
        expect(execute).toHaveBeenCalled();
        expect(connectionManager.setDocumentConnection).toHaveBeenCalledWith(
            'untitled:duckdb-bridge.sql',
            'DuckDB Bridge',
        );
        expect(vscode.window.showTextDocument).toHaveBeenCalled();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
            'Loaded the active result set into DuckDB table "results".',
        );
        expect(deleteFile).toHaveBeenCalledWith('/tmp/justybase-duckdb-bridge-12345.csv');
    });

    it('shows an error when the result set cannot be found', async () => {
        const bridge = createBridge(new Map());

        await bridge.queryLocally(metadata);

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
            'DuckDB bridge failed: Result set not found.',
        );
        expect(exportResultSet).not.toHaveBeenCalled();
    });

    it('surfaces a conflicting saved connection name', async () => {
      const bridge = createBridge(new Map<string, ResultSet[]>([[metadata.sourceUri, [resultSet]]]));
      const conflictingConnection: ConnectionDetails = {
        name: 'DuckDB Bridge',
        host: 'localhost',
        database: 'local.db',
        user: 'sqlite',
        dbType: 'sqlite',
      };
      connectionManager.getConnection.mockResolvedValue(conflictingConnection);
  
      await bridge.queryLocally(metadata);
  
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('configured for sqlite'),
      );
      expect(createConnection).not.toHaveBeenCalled();
    });
  
    it('normalizes Windows-style temp directory paths for DuckDB compatibility', async () => {
      // Simulate a Windows temp directory path
      const windowsTempDir = 'C:\\Users\\TestUser\\AppData\\Local\\Temp';
      const bridge = new DuckDbResultBridge(
        new Map<string, ResultSet[]>([[metadata.sourceUri, [resultSet]]]),
        connectionManager,
        {
          createConnection,
          exportResultSet,
          openTextDocument: vscode.workspace.openTextDocument,
          showTextDocument: vscode.window.showTextDocument,
          deleteFile,
          tmpDir: () => windowsTempDir,
          now: () => 12345,
        }
      );
  
      await bridge.queryLocally(metadata);
  
      // The database path should be normalized with forward slashes (no backslashes)
      const savedConnection = connectionManager.saveConnection.mock.calls[0][0];
      expect(savedConnection.database).not.toContain('\\');
      // Should contain the expected filename
      expect(savedConnection.database).toContain('justybase-duckdb-bridge.duckdb');
    });

    it('registers the local DuckDB load command for cancellation under the source lease', async () => {
      const bridge = createBridge(new Map());
      deleteFile.mockImplementationOnce((filePath: string) => fs.promises.unlink(filePath));

      await bridge.streamToDuckDb(
        'SELECT 1',
        connectionManager,
        'Warehouse',
        'target_table',
        'overwrite',
        'file:///source.sql',
        () => true,
      );

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(mockRegisterCommand).toHaveBeenCalledWith(
        'file:///source.sql',
        expect.objectContaining({ execute: expect.any(Function) }),
      );
      expect(mockUnregisterCommand).toHaveBeenCalledTimes(1);
    });

    it('does not start the local DuckDB write when cancellation arrived between phases', async () => {
      const bridge = createBridge(new Map());
      deleteFile.mockImplementationOnce((filePath: string) => fs.promises.unlink(filePath));
      mockRegisterCommand.mockReturnValueOnce({
        signal: { aborted: true },
        abort: jest.fn(),
        unregister: mockUnregisterCommand,
      });

      await bridge.streamToDuckDb(
        'SELECT 1',
        connectionManager,
        'Warehouse',
        'target_table',
        'overwrite',
        'file:///source.sql',
        () => true,
      );

      expect(execute).not.toHaveBeenCalled();
      expect(mockUnregisterCommand).toHaveBeenCalledTimes(1);
      expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'DuckDB stream failed: Query cancelled',
      );
    });

    it('reports success when cancellation arrives after the DuckDB load committed', async () => {
      const bridge = createBridge(new Map());
      const lateAbortSignal = { aborted: false };
      mockRegisterCommand.mockReturnValueOnce({
        signal: lateAbortSignal,
        abort: jest.fn(),
        unregister: mockUnregisterCommand,
      });
      execute.mockImplementationOnce(async () => {
        lateAbortSignal.aborted = true;
      });

      await bridge.streamToDuckDb(
        'SELECT 1',
        connectionManager,
        'Warehouse',
        'target_table',
        'append',
        'file:///source.sql',
        () => true,
      );

      expect(execute).toHaveBeenCalledTimes(1);
      expect(mockUnregisterCommand).toHaveBeenCalledTimes(1);
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Successfully loaded query results into DuckDB table "target_table".',
      );
    });
  });

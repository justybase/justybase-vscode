/**
 * Unit tests for export/xlsbExporter.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */


import * as os from 'os';
// import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import {
  exportQueryToXlsb,
  exportCsvToXlsb,
  exportStructuredToXlsb,
  copyFileToClipboard,
  getTempFilePath
} from '../export/xlsbExporter';
import { ExportCancelledError } from '../core/cancellation';

// Mock dependencies
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  statSync: jest.fn().mockReturnValue({ size: 1024 * 1024 })
}));
jest.mock('os');
jest.mock('child_process');
jest.mock('../core/connectionFactory', () => ({
  createConnectedDatabaseConnectionFromDetails: jest.fn()
}));
jest.mock('vscode', () => ({
  CancellationTokenSource: jest.fn().mockImplementation(() => ({
    token: { isCancellationRequested: false, onCancellationRequested: jest.fn() }
  })),
  Disposable: jest.fn()
}), { virtual: true });

// Helper to get mock instances
const mockAddSheet = jest.fn();
const mockWriteSheet = jest.fn();
const mockStartSheet = jest.fn();
const mockWriteRow = jest.fn();
const mockEndSheet = jest.fn();
const mockFinalize = jest.fn().mockResolvedValue(undefined);

jest.mock('@justybase/spreadsheet-tasks', () => {
  return {
    XlsbWriter: jest.fn().mockImplementation(() => ({
      addSheet: (...args: any[]) => mockAddSheet(...args),
      writeSheet: (...args: any[]) => mockWriteSheet(...args),
      startSheet: (...args: any[]) => mockStartSheet(...args),
      writeRow: (...args: any[]) => mockWriteRow(...args),
      endSheet: (...args: any[]) => mockEndSheet(...args),
      finalize: (...args: any[]) => mockFinalize(...args)
    }))
  };
});

// Mock @justybase/netezza-driver
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockCancel = jest.fn().mockResolvedValue(undefined);
const mockExecuteReader = jest.fn();
const mockCreateCommand = jest.fn().mockImplementation(() => ({
  executeReader: mockExecuteReader,
  cancel: mockCancel,
  commandTimeout: 0
}));

jest.mock('@justybase/netezza-driver', () => ({
  NzConnection: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    close: mockClose,
    createCommand: mockCreateCommand
  }))
}), { virtual: true });

// Mock sqlParser
jest.mock('../sql/sqlParser', () => ({
  SqlParser: {
    splitStatements: jest.fn().mockImplementation((q) => [q])
  }
}));

describe('xlsbExporter', () => {
  const mockConnDetails = {
    host: 'localhost',
    port: 5480,
    database: 'db',
    user: 'user',
    password: 'password'
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (os.platform as jest.Mock).mockReturnValue('win32');
    (os.tmpdir as jest.Mock).mockReturnValue('C:\\temp');
    (createConnectedDatabaseConnectionFromDetails as jest.Mock).mockImplementation(async () => {
      await mockConnect();
      return {
        close: mockClose,
        createCommand: mockCreateCommand
      };
    });
  });

  describe('exportQueryToXlsb', () => {
    it('should export query results successfully using streaming API', async () => {
      const mockReader = {
        fieldCount: 2,
        getName: jest.fn().mockImplementation((i) => `Col${i}`),
        getTypeName: jest.fn().mockImplementation(() => 'VARCHAR'),
        read: jest.fn()
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
        getValue: jest.fn().mockImplementation((i) => `Val${i}`),
        close: jest.fn().mockResolvedValue(undefined)
      };
      mockExecuteReader.mockResolvedValue(mockReader);

      const result = await exportQueryToXlsb(mockConnDetails, 'SELECT *', 'out.xlsb');

      expect(result.success).toBe(true);
      expect(mockStartSheet).toHaveBeenCalledWith('Query Results', 2, ['Col0', 'Col1'], { doAutofilter: true });
      expect(mockWriteRow).toHaveBeenCalledTimes(4); // 2 data rows + 'SQL Query:' + 1 SQL line
      expect(mockFinalize).toHaveBeenCalled();
    });

    it('should handle numeric conversion for specific types', async () => {
      const mockReader = {
        fieldCount: 1,
        getName: (_i: any) => 'Col0',
        getTypeName: (_i: any) => 'INT4',
        read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        getValue: (_i: any) => '123',
        close: jest.fn().mockResolvedValue(undefined)
      };
      mockExecuteReader.mockResolvedValue(mockReader);

      await exportQueryToXlsb(mockConnDetails, 'SELECT 123', 'out.xlsb');
      expect(mockWriteRow).toHaveBeenCalledWith([123]);
    });

    it('should convert numeric strings for broader numeric aliases in query export', async () => {
      const mockReader = {
        fieldCount: 1,
        getName: (_i: any) => 'Col0',
        getTypeName: (_i: any) => 'INTEGER',
        read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        getValue: (_i: any) => '123',
        close: jest.fn().mockResolvedValue(undefined)
      };
      mockExecuteReader.mockResolvedValue(mockReader);

      await exportQueryToXlsb(mockConnDetails, 'SELECT 123', 'out.xlsb');
      expect(mockWriteRow).toHaveBeenCalledWith([123]);
    });

    it('should convert padded NUMERIC strings in query export', async () => {
      const mockReader = {
        fieldCount: 1,
        getName: (_i: any) => 'Col0',
        getTypeName: (_i: any) => 'NUMERIC(20,4)',
        read: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
        getValue: (_i: any) => '0000000000000002.5000',
        close: jest.fn().mockResolvedValue(undefined)
      };
      mockExecuteReader.mockResolvedValue(mockReader);

      await exportQueryToXlsb(mockConnDetails, 'SELECT 2.5::numeric(20,4)', 'out.xlsb');
      expect(mockWriteRow).toHaveBeenCalledWith([2.5]);
    });

    it('should handle cancellation', async () => {
      const tokenSource = new (require('vscode').CancellationTokenSource)();
      tokenSource.token.isCancellationRequested = true;

      await expect(exportQueryToXlsb(mockConnDetails, 'SELECT 1', 'out.xlsb', false, undefined, undefined, tokenSource.token))
        .rejects.toBeInstanceOf(ExportCancelledError);
    });

    it('should handle runtime cancellation', async () => {
      const tokenSource = {
        isCancellationRequested: false,
        onCancellationRequested: jest.fn().mockImplementation((cb) => {
          // Simulate cancellation trigger
          setTimeout(() => {
            tokenSource.isCancellationRequested = true;
            cb();
          }, 50);
          return { dispose: jest.fn() };
        })
      };

      const mockReader = {
        fieldCount: 1,
        getName: () => 'A',
        getTypeName: () => 'INT4',
        read: jest.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 100)); // Delay to allow cancel
          return true;
        }),
        close: jest.fn().mockResolvedValue(undefined)
      };
      mockExecuteReader.mockResolvedValue(mockReader);

      await expect(exportQueryToXlsb(mockConnDetails, 'SELECT 1', 'out.xlsb', false, undefined, undefined, tokenSource as any))
        .rejects.toBeInstanceOf(ExportCancelledError);
    });

    it('should handle empty result sets', async () => {
      const mockReader = {
        fieldCount: 0,
        read: jest.fn().mockResolvedValue(false),
        close: jest.fn().mockResolvedValue(undefined)
      };
      mockExecuteReader.mockResolvedValue(mockReader);

      const result = await exportQueryToXlsb(mockConnDetails, 'CREATE TABLE X', 'out.xlsb');
      expect(result.success).toBe(true);
      expect(mockStartSheet).not.toHaveBeenCalledWith('Query Results', expect.any(Number), expect.any(Array), expect.any(Object));
    });

    it('should handle query failure and create error sheet', async () => {
      mockExecuteReader.mockRejectedValue(new Error('Syntax Error'));

      const result = await exportQueryToXlsb(mockConnDetails, 'BAD SQL', 'out.xlsb');
      expect(result.success).toBe(true); // Overall success of file creation
      expect(mockStartSheet).toHaveBeenCalledWith('Error 1', 1, ['Error'], { doAutofilter: false });
    });
  });

  describe('exportCsvToXlsb', () => {
    it('should export CSV to XLSB successfully', async () => {
      const csv = 'A,B\n1,2\n3,4';
      const result = await exportCsvToXlsb(csv, 'out.xlsb');
      expect(result.success).toBe(true);
      expect(mockStartSheet).toHaveBeenCalledWith('Query Results', 2, ['A', 'B'], { doAutofilter: true });
      expect(mockWriteRow).toHaveBeenCalledTimes(4); // 2 rows + source info?
    });

    it('should export multiple CSV items', async () => {
      const items = [
        { name: 'S1', csv: 'A\n1' },
        { name: 'S2', csv: 'B\n2', sql: 'SEL' }
      ];
      await exportCsvToXlsb(items, 'out.xlsb');
      expect(mockStartSheet).toHaveBeenCalledWith('S1', 1, ['A'], { doAutofilter: true });
      expect(mockStartSheet).toHaveBeenCalledWith('S2', 1, ['B'], { doAutofilter: true });
    });
  });

  describe('exportStructuredToXlsb', () => {
    it('should export structured data successfully', async () => {
      const items = [{
        name: 'Sheet',
        columns: [{ name: 'N', type: 'INT4' }, { name: 'T', type: 'VARCHAR' }],
        rows: [['123', 'Text']]
      }];
      const result = await exportStructuredToXlsb(items, 'out.xlsb');
      expect(result.success).toBe(true);
      expect(mockWriteRow).toHaveBeenCalledWith([123, 'Text']);
    });

    it('should skip empty sheets', async () => {
      const items = [{ name: 'Empty', columns: [], rows: [] }];
      await exportStructuredToXlsb(items, 'out.xlsb');
      expect(mockStartSheet).not.toHaveBeenCalledWith('Empty', expect.any(Number), expect.any(Array), expect.any(Object));
    });

    it('should handle failure', async () => {
      mockFinalize.mockRejectedValueOnce(new Error('Finalize failed'));
      const result = await exportStructuredToXlsb([], 'out.xlsb');
      expect(result.success).toBe(false);
    });
  });

  describe('copyFileToClipboard', () => {
    it('should return false if PowerShell exits with error', async () => {
      (os.platform as jest.Mock).mockReturnValue('win32');
      (spawn as jest.Mock).mockReturnValue({
        stderr: { on: (_evt: any, cb: any) => cb('Err') },
        on: (evt: any, cb: any) => { if (evt === 'close') cb(1); }
      });
      const result = await copyFileToClipboard('file.xlsb');
      expect(result).toBe(false);
    });
  });

  describe('getTempFilePath', () => {
    it('should return .xlsb path in temp dir', () => {
      const p = getTempFilePath();
      expect(p).toContain('.xlsb');
    });
  });
});

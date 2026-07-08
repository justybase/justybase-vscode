/**
 * Unit tests for export/xlsxExporter.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import {
  exportCsvToXlsx,
  exportStructuredToXlsx,
  copyFileToClipboard,
  getTempFilePath,
  validateExportPath
} from '../export/xlsxExporter';

// Mock dependencies
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  statSync: jest.fn().mockReturnValue({ size: 1024 * 1024 }),
  existsSync: jest.fn().mockReturnValue(true),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn()
}));
jest.mock('os');
jest.mock('child_process');

// Helper to get mock instances
const mockAddSheet = jest.fn();
const mockWriteSheet = jest.fn();
const mockStartSheet = jest.fn();
const mockWriteRow = jest.fn();
const mockEndSheet = jest.fn();
const mockFinalize = jest.fn().mockResolvedValue(undefined);

jest.mock('@justybase/spreadsheet-tasks', () => {
  return {
    XlsxWriter: jest.fn().mockImplementation(() => ({
      addSheet: (...args: any[]) => mockAddSheet(...args),
      writeSheet: (...args: any[]) => mockWriteSheet(...args),
      startSheet: (...args: any[]) => mockStartSheet(...args),
      writeRow: (...args: any[]) => mockWriteRow(...args),
      endSheet: (...args: any[]) => mockEndSheet(...args),
      finalize: (...args: any[]) => mockFinalize(...args)
    }))
  };
});

describe('xlsxExporter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (os.platform as jest.Mock).mockReturnValue('win32');
    (os.tmpdir as jest.Mock).mockReturnValue('C:\\temp');
    // Reset fs mocks for path validation - default to valid path
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.writeFileSync as jest.Mock).mockImplementation(() => { });
    (fs.unlinkSync as jest.Mock).mockImplementation(() => { });
    (fs.statSync as jest.Mock).mockReturnValue({ size: 1024 * 1024 });
  });

  describe('validateExportPath', () => {
    it('should not throw for valid writable directory', () => {
      expect(() => validateExportPath('C:\\temp\\test.xlsx')).not.toThrow();
    });

    it('should throw if directory does not exist', () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      expect(() => validateExportPath('Z:\\nonexistent\\test.xlsx')).toThrow('Export directory does not exist');
    });

    it('should throw if directory is not writable', () => {
      (fs.writeFileSync as jest.Mock).mockImplementation(() => { throw new Error('Permission denied'); });
      expect(() => validateExportPath('C:\\readonly\\test.xlsx')).toThrow('Export directory is not writable');
    });
  });

  describe('convertToNumberIfNumericString (internal logic)', () => {
    it('should correctly convert numeric strings to numbers', async () => {
      const items = [{
        name: 'Test',
        columns: [{ name: 'col1', type: 'INTEGER' }],
        rows: [['123'], ['0'], ['-45.6']]
      }];
      await exportStructuredToXlsx(items, 'path.xlsx');

      // Streaming API: each row is written individually
      expect(mockWriteRow).toHaveBeenCalledWith([123]);
      expect(mockWriteRow).toHaveBeenCalledWith([0]);
      expect(mockWriteRow).toHaveBeenCalledWith([-45.6]);
    });

    it('should NOT convert long numeric strings (precision safety)', async () => {
      const longNum = '12345678901234567'; // 17 digits
      const items = [{
        name: 'Test',
        columns: [{ name: 'col1', type: 'BIGINT' }],
        rows: [[longNum]]
      }];
      await exportStructuredToXlsx(items, 'path.xlsx');

      expect(mockWriteRow).toHaveBeenCalledWith([longNum]);
    });

    it('should convert padded NUMERIC strings using Excel number precision', async () => {
      const items = [{
        name: 'Test',
        columns: [{ name: 'col1', type: 'NUMERIC(20,4)' }],
        rows: [['0000000000000002.5000']]
      }];
      await exportStructuredToXlsx(items, 'path.xlsx');

      expect(mockWriteRow).toHaveBeenCalledWith([2.5]);
    });

    it('should convert leading-zero numeric strings (padding from driver)', async () => {
      const items = [{
        name: 'Test',
        columns: [{ name: 'col1', type: 'INT4' }],
        rows: [['0123'], ['0'], ['0.123']]
      }];
      await exportStructuredToXlsx(items, 'path.xlsx');

      expect(mockWriteRow).toHaveBeenCalledWith([123]);
      expect(mockWriteRow).toHaveBeenCalledWith([0]);
      expect(mockWriteRow).toHaveBeenCalledWith([0.123]);
    });
  });

  describe('exportCsvToXlsx', () => {
    it('should export single CSV string successfully using streaming API', async () => {
      const csv = 'Header1,Header2\nValue1,100\nValue2,200';
      const result = await exportCsvToXlsx(csv, 'output.xlsx');

      expect(result.success).toBe(true);
      expect(result.details?.rows_exported).toBe(2);
      expect(mockStartSheet).toHaveBeenCalledWith('Query Results', 2, ['Header1', 'Header2'], { doAutofilter: true });
      expect(mockWriteRow).toHaveBeenCalledTimes(2);
      expect(mockEndSheet).toHaveBeenCalled();
    });

    it('should export array of CsvExportItem successfully', async () => {
      const csvItems = [
        { name: 'Sheet1', csv: 'A,B\n1,2', sql: 'SELECT 1' },
        { name: 'Sheet2', csv: 'C,D\n3,4' }
      ];
      const result = await exportCsvToXlsx(csvItems, 'output.xlsx');

      expect(result.success).toBe(true);
      expect(mockStartSheet).toHaveBeenCalledWith('Sheet1', 2, ['A', 'B'], { doAutofilter: true });
      expect(mockStartSheet).toHaveBeenCalledWith('Sheet2', 2, ['C', 'D'], { doAutofilter: true });
      expect(mockStartSheet).toHaveBeenCalledWith('SQL Code', 1, undefined, { doAutofilter: false });
    });

    it('should handle CSV with quotes and escapes', async () => {
      const csv = 'Col 1,"Col, 2"\n"Value ""with"" quotes",123';
      await exportCsvToXlsx(csv, 'output.xlsx');

      expect(mockWriteRow).toHaveBeenCalledWith(['Value "with" quotes', 123]);
    });

    it('should handle empty CSV lines', async () => {
      const csv = '\n\nHeader1\n\nRow1\n';
      await exportCsvToXlsx(csv, 'output.xlsx');
      expect(mockWriteRow).toHaveBeenCalledWith(['Row1']);
    });

    it('should call progressCallback if provided', async () => {
      const progress = jest.fn();
      await exportCsvToXlsx('A\n1', 'output.xlsx', false, { source: 't' }, progress);
      expect(progress).toHaveBeenCalled();
    });

    it('should copy to clipboard if requested', async () => {
      (spawn as jest.Mock).mockReturnValue({
        stderr: { on: jest.fn() },
        on: (event: string, cb: any) => { if (event === 'close') cb(0); },
      });

      const result = await exportCsvToXlsx('A\n1', 'output.xlsx', true);
      expect(result.details?.clipboard_success).toBe(true);
    });

    it('should return failure on error', async () => {
      mockFinalize.mockRejectedValueOnce(new Error('Write failed'));
      const result = await exportCsvToXlsx('A\n1', 'output.xlsx');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Write failed');
    });

    it('should return failure on invalid export path', async () => {
      (fs.existsSync as jest.Mock).mockReturnValue(false);
      const result = await exportCsvToXlsx('A\n1', 'Z:\\bad\\output.xlsx');
      expect(result.success).toBe(false);
      expect(result.message).toContain('Export directory does not exist');
    });
  });

  describe('exportStructuredToXlsx', () => {
    it('should export structured data with different types using streaming', async () => {
      const items = [{
        name: 'Data',
        columns: [
          { name: 'Text', type: 'VARCHAR' },
          { name: 'Number', type: 'INTEGER' }
        ],
        rows: [
          ['Plain Text', '123'],
          ['No Convert', 456]
        ],
        sql: 'SELECT * FROM TABLE'
      }];

      const result = await exportStructuredToXlsx(items, 'structured.xlsx');
      expect(result.success).toBe(true);
      expect(mockStartSheet).toHaveBeenCalledWith('Data', 2, ['Text', 'Number'], { doAutofilter: true });
      expect(mockWriteRow).toHaveBeenCalledWith(['Plain Text', 123]);
      expect(mockWriteRow).toHaveBeenCalledWith(['No Convert', 456]);
      expect(mockEndSheet).toHaveBeenCalled();
    });

    it('should handle export with no SQL', async () => {
      const items = [{
        name: 'No SQL',
        columns: [{ name: 'A' }],
        rows: [[1]]
      }];
      await exportStructuredToXlsx(items, 'nosql.xlsx');
      // SQL Code sheet should not be created
      const startSheetCalls = mockStartSheet.mock.calls.map((c: any[]) => c[0]);
      expect(startSheetCalls).not.toContain('SQL Code');
    });

    it('should skip empty items (no columns)', async () => {
      const items = [{
        name: 'Empty',
        columns: [],
        rows: []
      }];
      await exportStructuredToXlsx(items, 'empty.xlsx');
      // No data sheet should be created for empty item
      const startSheetCalls = mockStartSheet.mock.calls.map((c: any[]) => c[0]);
      expect(startSheetCalls).not.toContain('Empty');
    });

    it('should handle export error', async () => {
      mockFinalize.mockRejectedValueOnce(new Error('Panic'));
      const result = await exportStructuredToXlsx([], 'fail.xlsx');
      expect(result.success).toBe(false);
    });
  });

  describe('copyFileToClipboard', () => {
    it('should return false on non-Windows platform', async () => {
      (os.platform as jest.Mock).mockReturnValue('linux');
      const result = await copyFileToClipboard('file.xlsx');
      expect(result).toBe(false);
    });

    it('should return false if PowerShell exits with error', async () => {
      (spawn as jest.Mock).mockReturnValue({
        stderr: { on: (_evt: any, cb: any) => cb('Some error') },
        on: (event: string, cb: any) => { if (event === 'close') cb(1); },
      });
      const result = await copyFileToClipboard('file.xlsx');
      expect(result).toBe(false);
    });

    it('should return false on spawn error', async () => {
      (spawn as jest.Mock).mockReturnValue({
        stderr: { on: jest.fn() },
        on: (event: string, cb: any) => { if (event === 'error') cb(new Error('Spawn failed')); },
      });
      const result = await copyFileToClipboard('file.xlsx');
      expect(result).toBe(false);
    });

    it('should handle generic exception during clipboard copy', async () => {
      (spawn as jest.Mock).mockImplementation(() => { throw new Error('Dead'); });
      const result = await copyFileToClipboard('file.xlsx');
      expect(result).toBe(false);
    });
  });

  describe('getTempFilePath', () => {
    it('should return a valid path in temp directory', () => {
      const path = getTempFilePath();
      expect(path).toContain('C:\\temp');
      expect(path).toContain('netezza_export_');
      expect(path).toContain('.xlsx');
    });
  });
});

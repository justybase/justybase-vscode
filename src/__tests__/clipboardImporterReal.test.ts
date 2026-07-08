import * as vscode from 'vscode';
import { ClipboardDataProcessor, importClipboardDataToNetezza } from '../import/clipboardImporter';

const mockRegisterImportStream = jest.fn();
const mockUnregisterImportStream = jest.fn();
const mockExecute = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockCreateCommand = jest.fn(() => ({ commandTimeout: 0, execute: mockExecute }));

jest.mock('vscode', () => ({
    env: {
        clipboard: {
            readText: jest.fn()
        }
    }
}));

jest.mock('fs', () => ({
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn()
}));

jest.mock('@justybase/netezza-driver', () => ({
    NzConnection: class {
        static registerImportStream = mockRegisterImportStream;
        static unregisterImportStream = mockUnregisterImportStream;
        _connected = true;
        connect = mockConnect;
        createCommand = mockCreateCommand;
        close = mockClose;
        constructor(_cfg: unknown) {}
    }
}));

describe('import/clipboardImporter real module', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should analyze clipboard data and detect delimiter', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a,b\n1,2\n3,4');
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getHeaders()).toEqual(['a', 'b']);
        expect(analyzer.getDelimiter()).toBe(',');
        expect(analyzer.getRowCount()).toBe(2);
    });

    it('should keep leading-zero clipboard columns as text', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('code\tname\n0123\tAlice\n1234\tBob');
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('NVARCHAR(20)');
    });

    it('should force text type for PESEL-like clipboard headers', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('PESEL\tamount\n12345678901\t1\n22345678901\t2');
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('NVARCHAR(20)');
        expect(analyzer.getDataTypes()[1]?.currentType.toString()).toBe('BIGINT');
    });

    it('should import clipboard data successfully', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('col1\tcol2\n1\t2\n3\t4');

        const result = await importClipboardDataToNetezza(
            'DB1.ADMIN.T_IMPORT',
            {
                host: 'localhost',
                port: 5480,
                database: 'DB1',
                user: 'user',
                password: 'pass'
            },
            null,
            {},
            jest.fn()
        );

        expect(result.success).toBe(true);
        expect(result.details?.rowsProcessed).toBe(2);
        expect(mockRegisterImportStream).toHaveBeenCalled();
        expect(mockConnect).toHaveBeenCalled();
        expect(mockCreateCommand).toHaveBeenCalled();
        expect(mockExecute).toHaveBeenCalled();
        expect(mockUnregisterImportStream).toHaveBeenCalled();
    });

    it('should fail fast for invalid parameters', async () => {
        const missingTarget = await importClipboardDataToNetezza(
            '',
            {
                host: 'localhost',
                database: 'DB1',
                user: 'u',
                password: 'p'
            },
            null
        );
        expect(missingTarget.success).toBe(false);
        expect(missingTarget.message).toContain('Target table name is required');

        const missingConnection = await importClipboardDataToNetezza(
            'A.B.C',
            {
                host: '',
                database: 'DB1',
                user: 'u',
                password: 'p'
            },
            null
        );
        expect(missingConnection.success).toBe(false);
        expect(missingConnection.message).toContain('Connection details are required');
    });

    it('should return import failure when clipboard is empty', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('');
        const result = await importClipboardDataToNetezza(
            'A.B.C',
            {
                host: 'localhost',
                database: 'DB1',
                user: 'u',
                password: 'p'
            },
            null
        );

        expect(result.success).toBe(false);
        expect(result.message).toContain('No data found in clipboard');
    });
});


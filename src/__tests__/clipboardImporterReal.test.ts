import * as vscode from 'vscode';
import { ClipboardDataProcessor, importClipboardDataToNetezza } from '../import/clipboardImporter';

const mockRegisterImportStream = jest.fn();
const mockUnregisterImportStream = jest.fn();
const mockExecute = jest.fn().mockResolvedValue(undefined);
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockCreateCommand = jest.fn((_sql: string) => ({ commandTimeout: 0, execute: mockExecute }));

jest.mock('vscode', () => ({
    env: {
        clipboard: {
            readText: jest.fn()
        }
    }
}));

jest.mock('fs', () => ({
    existsSync: jest.fn(() => true),
    mkdirSync: jest.fn(),
    createWriteStream: jest.requireActual('fs').createWriteStream,
    unlinkSync: jest.requireActual('fs').unlinkSync
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

    it('uses consistent tab-separated records when a header contains extra commas', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'id\tCity, Region, Country, Postal, Code\tamount\n' +
            '1\tWarsaw\t12\n' +
            '2\tKrakow\t34',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDelimiter()).toBe('\t');
        expect(analyzer.getHeaders()).toEqual(['id', 'City, Region, Country, Postal, Code', 'amount']);
        expect([...analyzer.dataRowIterator()]).toEqual([
            ['1', 'Warsaw', '12'],
            ['2', 'Krakow', '34'],
        ]);
    });

    it('should parse the multiline quoted header example from Excel', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'COL1\t"COL2\n""dasdasdasd"""\tCOL3\n1\t2\t3\n1\t2\t3',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDelimiter()).toBe('\t');
        expect(analyzer.getHeaders()).toEqual(['COL1', 'COL2\n"dasdasdasd"', 'COL3']);
        expect(analyzer.getRowCount()).toBe(2);
        expect([...analyzer.dataRowIterator()]).toEqual([
            ['1', '2', '3'],
            ['1', '2', '3'],
        ]);
    });

    it('should preserve quoted line endings, escaped quotes, and tabs in clipboard cells', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'COL1\t"COL2\n"\tCOL3\n1\t"first\n""quoted""\r\nlast"\t3\n2\t"has\ttab and ; delimiter\n"\t4',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getHeaders()).toEqual(['COL1', 'COL2\n', 'COL3']);
        expect(analyzer.getRowCount()).toBe(2);
        expect([...analyzer.dataRowIterator()]).toEqual([
            ['1', 'first\n"quoted"\r\nlast', '3'],
            ['2', 'has\ttab and ; delimiter\n', '4'],
        ]);
    });

    it('should reject clipboard data with an unterminated quoted field', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('A\tB\n1\t"unfinished');
        const processor = new ClipboardDataProcessor();

        await expect(processor.analyzeClipboardData()).rejects.toThrow(
            'Unterminated quoted field',
        );
    });

    it('should keep leading-zero clipboard columns as text', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('code\tname\n0123\tAlice\n1234\tBob');
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('NVARCHAR(20)');
    });

    it('should ignore a PESEL header and infer 11-digit values as numeric', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('PESEL\tamount\n12345678901\t1\n22345678901\t2');
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('BIGINT');
        expect(analyzer.getDataTypes()[1]?.currentType.toString()).toBe('BIGINT');
    });

    it('should import clipboard data successfully', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('col1\tcol2\n1\ta\n2\tb\n3\tc');

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
        expect(result.details?.rowsProcessed).toBe(3);
        expect(mockRegisterImportStream).toHaveBeenCalledTimes(1);
        expect(mockConnect).toHaveBeenCalled();
        expect(mockCreateCommand).toHaveBeenCalled();
        expect(mockExecute).toHaveBeenCalled();
        expect(mockUnregisterImportStream).toHaveBeenCalledTimes(1);

        const executedSql = mockCreateCommand.mock.calls[0]?.[0] ?? '';
        expect(executedSql).toContain('CREATE TABLE "DB1"."ADMIN"."T_IMPORT" AS');
        expect(executedSql).toContain('SELECT\n        "COL1",\n        "COL2"\n    FROM EXTERNAL');
        expect(executedSql).toContain('"COL2" NVARCHAR(20)');
        expect(executedSql).toMatch(/FROM EXTERNAL 'virtual_clipboard_import_[^']+\.txt'/);
    });

    it('quotes the clipboard target and preserves Netezza DB..TABLE notation', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('a b\n1');

        const result = await importClipboardDataToNetezza(
            'DB1..T_IMPORT',
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
        const executedSql = mockCreateCommand.mock.calls[0]?.[0] ?? '';
        expect(executedSql).toContain('CREATE TABLE "DB1".."T_IMPORT" AS');
        expect(executedSql).not.toContain('""');
        expect(executedSql).toContain('"A_B"');
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

    it('should keep a single spaced Polish number in one column', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('col1\n 123 456,78   \n');
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDelimiter()).toBe('\t');
        expect(analyzer.getHeaders()).toEqual(['col1']);
        expect(analyzer.getRowCount()).toBe(1);
        expect(analyzer.getDecimalDelimiter()).toBe(',');
        expect([...analyzer.dataRowIterator()]).toEqual([[' 123 456,78   ']]);
        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toMatch(/^NUMERIC\(/);
    });

    it('should infer Polish currency/percent/parens as numeric and ignore lone dashes', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'kwota\n123 456,78 zł\n(1 234,56)\n-\n12,8%',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDecimalDelimiter()).toBe(',');
        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toMatch(/^NUMERIC\(/);
    });

    it('should infer integer currency columns (zł) as NUMERIC', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'kwota\n123 457 zł\n223 457 zł\n323 457 zł',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('NUMERIC(16,0)');
    });

    it('should infer GBP values (£123,456.78) as NUMERIC', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'amount\n£123,456.78\n£123,457',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDecimalDelimiter()).toBe('.');
        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('NUMERIC(16,2)');
    });

    it('should infer Anglo-Saxon thousands as numeric', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'amount\n123,456.78\n($1,234.56)',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDecimalDelimiter()).toBe('.');
        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toMatch(/^NUMERIC\(/);
    });

    it('should infer a PESEL-valued column as text regardless of the header', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'LICZBA\timie\n44051401359\tJan\n92071314764\tAnna\n55030101193\tEwa\n02070803628\tOla',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toMatch(/^NVARCHAR/);
        expect([...analyzer.dataRowIterator()][3]).toEqual(['02070803628', 'Ola']);
    });

    it('should keep leading-zero PESEL values as text under a non-generic header', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'nr_klienta\n02070803628\n44051401359\n55030101193',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toMatch(/^NVARCHAR/);
    });

    it('should keep an 11-digit column numeric when values fail PESEL validation', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'LICZBA\n12345678901\n22345678901\n32345678901',
        );
        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getDataTypes()[0]?.currentType.toString()).toBe('BIGINT');
    });

    it('streams formatted rows for text, numeric and datetime columns', async () => {
        const registeredStreams: NodeJS.ReadableStream[] = [];
        mockRegisterImportStream.mockImplementation((_name: string, stream: NodeJS.ReadableStream) => {
            registeredStreams.push(stream);
        });
        let payload = '';
        mockExecute.mockImplementationOnce(async () => {
            for await (const chunk of registeredStreams[0]) {
                payload += String(chunk);
            }
        });
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(
            'when\tamount\tnote\n05.02.2024 10:00:00\t12.34\tAda\n06.02.2024 11:00:00\t-\t-\n',
        );

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
        expect(registeredStreams).toHaveLength(1);
        expect(payload).toContain('2024-02-05 10:00:00');
        expect(payload).toContain('12.34');
        expect(payload).toContain('Ada');

        mockRegisterImportStream.mockReset();
    });

    it('caps decimal sampling at one thousand cells', async () => {
        const columnCount = 1005;
        const header = Array.from({ length: columnCount }, (_unused, index) => `c${index}`).join('\t');
        const dataRow = Array.from({ length: columnCount }, (_unused, index) => String(index)).join('\t');
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue(`${header}\n${dataRow}\n${dataRow}`);

        const processor = new ClipboardDataProcessor();
        const analyzer = await processor.analyzeClipboardData();

        expect(analyzer.getHeaders()).toHaveLength(columnCount);
        expect(analyzer.getRowCount()).toBe(2);
    });

    it('should transliterate Polish diacritics in column names', async () => {
        (vscode.env.clipboard.readText as jest.Mock).mockResolvedValue('Śląsk\tZażółć\n1\t2');

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
        const executedSql = mockCreateCommand.mock.calls[0]?.[0] ?? '';
        expect(executedSql).toContain('SLASK');
        expect(executedSql).toContain('ZAZOLC');
        expect(executedSql).not.toContain('Ś');
    });
});


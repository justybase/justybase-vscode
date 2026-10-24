import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    columnLetter,
    FilePreviewEditor,
    INITIAL_SPREADSHEET_ROWS,
    readExcelSheetPreview,
    streamDelimitedRows,
    streamExcelSheetRows,
    toSpreadsheetGrid,
} from '../editors/filePreviewEditor';
import { DataWorkspaceService } from '../services/dataWorkspaceService';

describe('FilePreviewEditor Data Workspace action', () => {
    const tempFile = path.join('/tmp', `justybase-file-preview-${process.pid}.csv`);

    beforeAll(() => {
        fs.writeFileSync(tempFile, 'id,name\n1,Ada\n', 'utf8');
        fs.writeFileSync(tempFile.replace(/\.csv$/, '.xlsx'), 'placeholder', 'utf8');
        fs.writeFileSync(tempFile.replace(/\.csv$/, '.parquet'), 'placeholder', 'utf8');
    });

    afterAll(() => {
        fs.rmSync(tempFile, { force: true });
        fs.rmSync(tempFile.replace(/\.csv$/, '.xlsx'), { force: true });
        fs.rmSync(tempFile.replace(/\.csv$/, '.parquet'), { force: true });
    });

    function render(filePath: string): string {
        const editor = new FilePreviewEditor(
            vscode.Uri.file('/test-extension'),
            { globalStorageUri: vscode.Uri.file('/tmp/workspace-preview-test') } as unknown as vscode.ExtensionContext,
            {} as never,
        );
        const panel = {
            webview: {
                cspSource: 'mock-csp',
                asWebviewUri: jest.fn((uri: unknown) => uri),
            },
        } as unknown as vscode.WebviewPanel;
        return (editor as unknown as {
            _buildHtml(panel: vscode.WebviewPanel, filePath: string, data: unknown[]): string;
        })._buildHtml(panel, filePath, [{ columns: [{ name: 'id' }], rows: [[1]], totalRows: 1, limitReached: false, filePath, fileSizeBytes: 10, formatLabel: 'CSV' }]);
    }

    it('offers adding CSV and XLSX previews to a Data Workspace', () => {
        // The Excel-like view renders its toolbar in the bundle; the host passes the availability flag.
        expect(render(tempFile)).toContain('"canAddToWorkspace":true');
        expect(render(tempFile.replace(/\.csv$/, '.xlsx'))).toContain('"canAddToWorkspace":true');
    });

    it('does not show the file-source action for other preview formats', () => {
        expect(render(tempFile.replace(/\.csv$/, '.parquet'))).not.toContain('id="add-file-to-data-workspace"');
    });

    interface PreviewResult {
        columns: Array<{ name: string }>;
        rows: unknown[][];
        totalRows: number;
        limitReached: boolean;
        done?: boolean;
    }

    function createEditor(): FilePreviewEditor {
        return new FilePreviewEditor(
            vscode.Uri.file('/test-extension'),
            { globalStorageUri: vscode.Uri.file('/tmp/workspace-preview-test') } as unknown as vscode.ExtensionContext,
            {} as never,
        );
    }

    async function readFile(filePath: string): Promise<PreviewResult[]> {
        return (createEditor() as unknown as {
            _readFile(path: string): Promise<PreviewResult[]>;
        })._readFile(filePath);
    }

    it('reads quoted CSV records with embedded newlines without splitting rows', async () => {
        const csvPath = path.join('/tmp', `justybase-preview-quoted-${process.pid}.csv`);
        fs.writeFileSync(csvPath, 'id,note\n1,"first\nsecond"\n\n2,"has,comma"\n', 'utf8');

        try {
            const data = await readFile(csvPath);
            expect(data[0].columns.map(column => column.name)).toEqual(['id', 'note']);
            expect(data[0].rows).toEqual([
                ['1', 'first\nsecond'],
                ['2', 'has,comma'],
            ]);
            expect(data[0].totalRows).toBe(2);
            expect(data[0].limitReached).toBe(false);
        } finally {
            fs.rmSync(csvPath, { force: true });
        }
    });

    it('detects tab-delimited .tsv previews', async () => {
        const tsvPath = path.join('/tmp', `justybase-preview-${process.pid}.tsv`);
        fs.writeFileSync(tsvPath, 'id\tname\n1\tAda\n', 'utf8');

        try {
            const data = await readFile(tsvPath);
            expect(data[0].columns.map(column => column.name)).toEqual(['id', 'name']);
            expect(data[0].rows).toEqual([['1', 'Ada']]);
        } finally {
            fs.rmSync(tsvPath, { force: true });
        }
    });

    it('generates positional names for empty header cells', async () => {
        const csvPath = path.join('/tmp', `justybase-preview-empty-${process.pid}.csv`);
        fs.writeFileSync(csvPath, 'a,,c\n1,2,3\n', 'utf8');

        try {
            const data = await readFile(csvPath);
            expect(data[0].columns.map(column => column.name)).toEqual(['a', 'Column 2', 'c']);
        } finally {
            fs.rmSync(csvPath, { force: true });
        }
    });

    it('keeps all CSV rows for the spreadsheet view even when the Parquet row setting is low', async () => {
        const csvPath = path.join('/tmp', `justybase-preview-limit-${process.pid}.csv`);
        fs.writeFileSync(csvPath, 'id\n1\n2\n3\n', 'utf8');

        const originalGetConfiguration = (vscode.workspace.getConfiguration as jest.Mock).getMockImplementation();
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: (key: string, defaultValue?: unknown) => (key === 'maxRows' ? 1 : defaultValue),
        });

        try {
            const data = await readFile(csvPath);
            expect(data[0].rows).toHaveLength(3);
            expect(data[0].totalRows).toBe(3);
            expect(data[0].limitReached).toBe(false);
            expect(data[0].done).toBe(true);
        } finally {
            if (originalGetConfiguration) {
                (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(originalGetConfiguration);
            } else {
                (vscode.workspace.getConfiguration as jest.Mock).mockReset();
            }
            fs.rmSync(csvPath, { force: true });
        }
    });

    it('reads only the initial page of a large CSV and lets the stream finish it', async () => {
        const csvPath = path.join('/tmp', `justybase-preview-stream-${process.pid}.csv`);
        const lines = ['id'];
        for (let i = 1; i <= INITIAL_SPREADSHEET_ROWS + 5; i++) {
            lines.push(String(i));
        }
        fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');

        try {
            const data = await readFile(csvPath);
            expect(data[0].rows).toHaveLength(INITIAL_SPREADSHEET_ROWS);
            expect(data[0].done).toBe(false);

            const streamed: unknown[][] = [];
            let done = false;
            await streamDelimitedRows(
                csvPath,
                ',',
                'utf8',
                data[0].rows.length,
                512,
                (rows, isDone) => {
                    streamed.push(...rows);
                    done = isDone;
                },
            );

            expect(streamed).toHaveLength(5);
            expect(streamed[0]).toEqual([String(INITIAL_SPREADSHEET_ROWS + 1)]);
            expect(done).toBe(true);
        } finally {
            fs.rmSync(csvPath, { force: true });
        }
    });

    it('adds a previewed file to a selected existing workspace', async () => {
        const workspace = {
            name: 'Reporting',
            host: 'local',
            database: '/tmp/reporting.duckdb',
            user: 'duckdb',
            dbType: 'duckdb',
            options: {
                dataWorkspace: JSON.stringify({ version: 2, workspaceId: 'reporting-12345678', sources: [] }),
            },
        };
        const manager = {
            getConnections: jest.fn().mockResolvedValue([workspace]),
            getConnection: jest.fn().mockResolvedValue(workspace),
        };
        const inputBox = (vscode.window as unknown as { showInputBox?: jest.Mock });
        inputBox.showInputBox ??= jest.fn();
        inputBox.showInputBox.mockResolvedValue('sales');
        (vscode.window.showQuickPick as jest.Mock).mockImplementation(async (choices: Array<{ label: string }>) => choices[1]);
        const addFileSource = jest.spyOn(DataWorkspaceService.prototype, 'addFileSource').mockResolvedValue({
            id: 'source-12345678', kind: 'file', path: tempFile, tableName: 'sales', lastRefresh: { status: 'never' },
        });
        const refreshSource = jest.spyOn(DataWorkspaceService.prototype, 'refreshSource').mockResolvedValue({
            status: 'success', rowCount: 2,
        });
        const editor = new FilePreviewEditor(
            vscode.Uri.file('/test-extension'),
            { globalStorageUri: vscode.Uri.file('/tmp/workspace-preview-test') } as unknown as vscode.ExtensionContext,
            manager as never,
        );

        await (editor as unknown as { _addFileToDataWorkspace(filePath: string): Promise<void> })
            ._addFileToDataWorkspace(tempFile);

        expect(addFileSource).toHaveBeenCalledWith('Reporting', tempFile, 'sales');
        expect(refreshSource).toHaveBeenCalledWith('Reporting', 'source-12345678');
        addFileSource.mockRestore();
        refreshSource.mockRestore();
    });
});

describe('FilePreviewEditor spreadsheet presentation', () => {
    type ExcelReader = Parameters<typeof readExcelSheetPreview>[0];

    /** Minimal reader that mimics how the real one grows `fieldCount` as rows are read. */
    function makeReader(rows: unknown[][]): { reader: ExcelReader; reads: () => number } {
        let index = -1;
        let readCount = 0;
        let current: unknown[] = [];
        const reader: ExcelReader = {
            open: async () => { },
            close: async () => { },
            fieldCount: 0,
            _currentRow: [],
            getValue: (i: number) => current[i] ?? null,
            read: async () => {
                readCount++;
                index++;
                current = rows[index] ?? [];
                reader._currentRow = current;
                if (index >= rows.length) {
                    return false;
                }
                reader.fieldCount = Math.max(reader.fieldCount, current.length);
                return true;
            },
        };
        return { reader, reads: () => readCount };
    }

    it('labels columns the way Excel does, including past Z', () => {
        expect(columnLetter(0)).toBe('A');
        expect(columnLetter(25)).toBe('Z');
        expect(columnLetter(26)).toBe('AA');
        expect(columnLetter(701)).toBe('ZZ');
        expect(columnLetter(702)).toBe('AAA');
    });

    it('shows the file first row as data row 1 under column letters', () => {
        const grid = toSpreadsheetGrid({
            columns: [{ name: 'id' }, { name: 'name' }],
            rows: [[2, 'Grace']],
            headerRow: ['id', 'name'],
            totalRows: 1,
            limitReached: false,
            filePath: 'x.csv',
            fileSizeBytes: 1,
            formatLabel: 'CSV',
        });

        expect(grid.columns.map(c => c.name)).toEqual(['A', 'B']);
        expect(grid.rows).toEqual([['id', 'name'], [2, 'Grace']]);
    });

    it('pads ragged rows to the widest row so every column has a letter', () => {
        const grid = toSpreadsheetGrid({
            columns: [],
            rows: [[1], [1, 2, 3]],
            headerRow: ['a'],
            totalRows: 2,
            limitReached: false,
            filePath: 'x.csv',
            fileSizeBytes: 1,
            formatLabel: 'CSV',
        });

        expect(grid.columns).toHaveLength(3);
        expect(grid.rows[0]).toEqual(['a', null, null]);
        expect(grid.rows[1]).toEqual([1, null, null]);
        expect(grid.rows[2]).toEqual([1, 2, 3]);
    });

    it('stops reading a sheet as soon as the preview row limit is reached', async () => {
        const { reader, reads } = makeReader([
            ['id', 'name'],
            [1, 'a'],
            [2, 'b'],
            [3, 'c'],
            [4, 'd'],
        ]);

        const preview = await readExcelSheetPreview(reader, 2, 512, 1_000_000);

        expect(preview.headerRow).toEqual(['id', 'name']);
        expect(preview.rows).toEqual([[1, 'a'], [2, 'b']]);
        expect(preview.totalRows).toBe(2);
        expect(preview.limitReached).toBe(true);
        // Header + two preview rows + one look-ahead row that proves more data exists.
        expect(reads()).toBe(4);
    });

    it('trims trailing empty cells and reports when the column limit was reached', async () => {
        const { reader } = makeReader([
            ['A', 'B', '', ''],
            [1, 2, null, ''],
            [3, 4, 5, 6],
        ]);

        const preview = await readExcelSheetPreview(reader, 10, 3, 1_000_000);

        expect(preview.headerRow).toEqual(['A', 'B']);
        expect(preview.rows[0]).toEqual([1, 2]);
        expect(preview.rows[1]).toEqual([3, 4, 5]);
        expect(preview.columnsTruncated).toBe(true);
    });

    it('stops adding rows when the shared preview cell budget is spent', async () => {
        const { reader } = makeReader([
            ['a', 'b'],
            [1, 2],
            [3, 4],
            [5, 6],
        ]);

        const preview = await readExcelSheetPreview(reader, 10, 512, 5);

        expect(preview.rows).toEqual([[1, 2]]);
        expect(preview.cellsUsed).toBe(4);
        expect(preview.limitReached).toBe(true);
    });

    it('streams the remaining Excel rows after the initial page without duplicating them', async () => {
        const { reader } = makeReader([
            ['h1', 'h2'],
            [1, 'a'],
            [2, 'b'],
            [3, 'c'],
            [4, 'd'],
        ]);

        const chunks: Array<{ rows: unknown[][]; done: boolean }> = [];
        await streamExcelSheetRows(reader, 2, 512, (rows, done) => {
            chunks.push({ rows, done });
        });

        expect(chunks.flatMap(chunk => chunk.rows)).toEqual([[3, 'c'], [4, 'd']]);
        expect(chunks[chunks.length - 1]?.done).toBe(true);
    });

    it('keeps cell text that looks like markup from closing the data script block', () => {
        const csvFile = path.join('/tmp', `justybase-sheet-escape-${process.pid}.csv`);
        fs.writeFileSync(csvFile, 'a\n1\n', 'utf8');
        try {
            const editor = new FilePreviewEditor(
                vscode.Uri.file('/test-extension'),
                { globalStorageUri: vscode.Uri.file('/tmp/workspace-preview-test') } as unknown as vscode.ExtensionContext,
                {} as never,
            );
            const panel = {
                webview: { cspSource: 'mock-csp', asWebviewUri: jest.fn((uri: unknown) => uri) },
            } as unknown as vscode.WebviewPanel;
            const html = (editor as unknown as {
                _buildHtml(p: vscode.WebviewPanel, f: string, d: unknown[]): string;
            })._buildHtml(panel, csvFile, [{
                columns: [{ name: 'a' }],
                rows: [['</script><img src=x onerror=alert(1)>']],
                totalRows: 1,
                limitReached: false,
                filePath: csvFile,
                fileSizeBytes: 10,
                formatLabel: 'CSV',
            }]);

            expect(html.match(/<\/script>/g)?.length).toBe(2);
            expect(html).toContain('\\u003c/script>\\u003cimg');
        } finally {
            fs.rmSync(csvFile, { force: true });
        }
    });

    it('loads the separate Excel-like bundle for CSV and keeps the result grid for Parquet', () => {
        const csvFile = path.join('/tmp', `justybase-sheet-preview-${process.pid}.csv`);
        const parquetFile = csvFile.replace(/\.csv$/, '.parquet');
        fs.writeFileSync(csvFile, 'id\n1\n', 'utf8');
        fs.writeFileSync(parquetFile, 'placeholder', 'utf8');
        const editor = new FilePreviewEditor(
            vscode.Uri.file('/test-extension'),
            { globalStorageUri: vscode.Uri.file('/tmp/workspace-preview-test') } as unknown as vscode.ExtensionContext,
            {} as never,
        );
        const panel = {
            webview: { cspSource: 'mock-csp', asWebviewUri: jest.fn((uri: unknown) => uri) },
        } as unknown as vscode.WebviewPanel;
        const build = (filePath: string): string => (editor as unknown as {
            _buildHtml(panel: vscode.WebviewPanel, filePath: string, data: unknown[]): string;
        })._buildHtml(panel, filePath, [{ columns: [{ name: 'id' }], rows: [[1]], totalRows: 1, limitReached: false, filePath, fileSizeBytes: 10, formatLabel: 'CSV' }]);

        try {
            const csvHtml = build(csvFile);
            expect(csvHtml).toContain('spreadsheetPreview.js');
            expect(csvHtml).toContain('spreadsheetPreview.css');
            expect(csvHtml).not.toContain('resultPanel.js');
            expect(csvHtml).toContain('<script id="sheet-data" type="application/json">');
            expect(csvHtml).toContain('"sheets"');

            const parquetHtml = build(parquetFile);
            expect(parquetHtml).toContain('resultPanel.js');
            expect(parquetHtml).not.toContain('spreadsheetPreview.js');
        } finally {
            fs.rmSync(csvFile, { force: true });
            fs.rmSync(parquetFile, { force: true });
        }
    });
});

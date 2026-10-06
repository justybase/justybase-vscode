import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilePreviewEditor } from '../editors/filePreviewEditor';
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
        expect(render(tempFile)).toContain('id="add-file-to-data-workspace"');
        expect(render(tempFile.replace(/\.csv$/, '.xlsx'))).toContain('id="add-file-to-data-workspace"');
    });

    it('does not show the file-source action for other preview formats', () => {
        expect(render(tempFile.replace(/\.csv$/, '.parquet'))).not.toContain('id="add-file-to-data-workspace"');
    });

    interface PreviewResult {
        columns: Array<{ name: string }>;
        rows: unknown[][];
        totalRows: number;
        limitReached: boolean;
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

    it('marks the preview as truncated when it exceeds the configured row limit', async () => {
        const csvPath = path.join('/tmp', `justybase-preview-limit-${process.pid}.csv`);
        fs.writeFileSync(csvPath, 'id\n1\n2\n3\n', 'utf8');

        const originalGetConfiguration = (vscode.workspace.getConfiguration as jest.Mock).getMockImplementation();
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: (key: string, defaultValue?: unknown) => (key === 'maxRows' ? 1 : defaultValue),
        });

        try {
            const data = await readFile(csvPath);
            expect(data[0].rows).toHaveLength(1);
            expect(data[0].totalRows).toBe(3);
            expect(data[0].limitReached).toBe(true);
        } finally {
            if (originalGetConfiguration) {
                (vscode.workspace.getConfiguration as jest.Mock).mockImplementation(originalGetConfiguration);
            } else {
                (vscode.workspace.getConfiguration as jest.Mock).mockReset();
            }
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

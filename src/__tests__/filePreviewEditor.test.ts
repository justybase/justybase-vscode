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

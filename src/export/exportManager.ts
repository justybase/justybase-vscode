import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ResultSet } from '../types';
import { exportResultSetToFile } from '../export/resultExporter';
import { exportStructuredToXlsb, copyFileToClipboard as copyXlsbToClipboard } from '../export/xlsbExporter';
import { exportStructuredToXlsx, StructuredExportItem } from '../export/xlsxExporter';
import * as fs from 'fs';
import { ResultFormattingPayload, ResultFormattingSettings } from '../results/resultFormattingTypes';

export interface ExportFormattingMetadata {
    useFormattedValues?: boolean;
    payload?: ResultFormattingPayload;
    resultOverride?: Partial<ResultFormattingSettings>;
}

export interface ExportMetadata {
    sourceUri: string;
    resultSetIndex: number;
    rowIndices?: number[];
    columnIds?: string[];
    formatting?: ExportFormattingMetadata;
}

export interface ExcelExportMetadata {
    sourceUri: string;
    results: {
        resultSetIndex: number;
        rowIndices: number[];
        columnIds: string[];
        name: string;
        isActive: boolean;
    }[];
}

export interface ExportRequest extends ExportMetadata {
    format: 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown' | 'parquet';
}

export interface HydratedExportItem {
    columns: { name: string; type?: string; scale?: number }[];
    rows: unknown[][];
    sql: string;
    name: string;
    isActive?: boolean;
}

import { escapeCsvField } from './csvExporter';
import { resolveExportRows } from '../core/resultDataProvider/resultDataReader';

export class ExportManager {
    constructor(private _resultsMap: Map<string, ResultSet[]>) { }

    public async handleExport(message: ExportRequest): Promise<void> {
        const { sourceUri, resultSetIndex, format, rowIndices, columnIds } = message;
        const results = this._resultsMap.get(sourceUri);
        if (!results || resultSetIndex === undefined || results[resultSetIndex] === undefined) {
            vscode.window.showErrorMessage('Export failed: Result set not found');
            return;
        }

        const resultSet = results[resultSetIndex];
        const extensions: Record<string, string> = {
            csv: 'csv',
            'csv.gz': 'csv.gz',
            'csv.zst': 'csv.zst',
            json: 'json',
            xml: 'xml',
            sql: 'sql',
            markdown: 'md',
            parquet: 'parquet'
        };

        const uri = await vscode.window.showSaveDialog({
            filters: { [`${format.toUpperCase()} Files`]: [extensions[format] || format] },
            saveLabel: `Export ${format.toUpperCase()}`
        });

        if (!uri) return;

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: `Exporting to ${format.toUpperCase()}...`,
                    cancellable: false
                },
                async () => {
                    if (format === 'parquet') {
                        const { exportStructuredToParquet } = await import('../export/parquetExporter');
                        const columns = resultSet.columns.map(c => ({ name: c.name, type: c.type, scale: c.scale }));
                        const visibleColumnIndices = columnIds
                            ? columnIds.map(id => parseInt(id)).filter(idx => !isNaN(idx) && idx >= 0 && idx < columns.length)
                            : columns.map((_, i) => i);
                        const filteredRows = resolveExportRows(resultSet, rowIndices, visibleColumnIndices);
                        await exportStructuredToParquet([{
                            columns: visibleColumnIndices.map(i => columns[i]),
                            rows: filteredRows,
                            sql: resultSet.sql || '',
                            name: resultSet.name || 'Result'
                        }], uri.fsPath);
                    } else {
                        await exportResultSetToFile(resultSet, uri.fsPath, {
                            format,
                            rowIndices,
                            columnIds,
                            formatting: message.formatting
                        });
                    }
                }
            );
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Export failed: ${errorMsg}`);
        }
    }

    public async exportCsv(data: string | ExportMetadata): Promise<void> {
        if (typeof data === 'object') {
            await this.handleExport({ format: 'csv', ...data });
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'CSV Files': ['csv'] },
            saveLabel: 'Export'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    public async exportJson(data: string | ExportMetadata): Promise<void> {
        if (typeof data === 'object') {
            await this.handleExport({ format: 'json', ...data });
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'JSON Files': ['json'] },
            saveLabel: 'Export JSON'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    public async exportXml(data: string | ExportMetadata): Promise<void> {
        if (typeof data === 'object') {
            await this.handleExport({ format: 'xml', ...data });
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'XML Files': ['xml'] },
            saveLabel: 'Export XML'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    public async exportSqlInsert(data: string | ExportMetadata): Promise<void> {
        if (typeof data === 'object') {
            await this.handleExport({ format: 'sql', ...data });
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'SQL Files': ['sql'] },
            saveLabel: 'Export SQL'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    public async exportMarkdown(data: string | ExportMetadata): Promise<void> {
        if (typeof data === 'object') {
            await this.handleExport({ format: 'markdown', ...data });
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'Markdown Files': ['md'] },
            saveLabel: 'Export Markdown'
        });

        if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
            vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
        }
    }

    public async exportParquet(data: string | ExportMetadata): Promise<void> {
        if (typeof data === 'object') {
            await this.handleExport({ format: 'parquet', ...data });
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'Parquet Files': ['parquet'] },
            saveLabel: 'Export Parquet'
        });

        if (uri) {
            vscode.window.showInformationMessage(`Parquet string export not supported. Saving as text.`);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(data));
        }
    }

    public async openInExcel(data: unknown, sql?: string): Promise<void> {
        if (data && typeof data === 'object' && 'results' in data) {
            data = this.hydrateExportData(data as ExcelExportMetadata);
        }
        vscode.commands.executeCommand('netezza.exportCurrentResultToXlsbAndOpen', data, sql);
    }

    public async openInFilePreview(data: unknown, _sql?: string): Promise<void> {
        let items: HydratedExportItem[];
        if (data && typeof data === 'object' && 'results' in data) {
            items = this.hydrateExportData(data as ExcelExportMetadata);
        } else {
            items = data as HydratedExportItem[];
        }

        if (!items || items.length === 0) {
            vscode.window.showErrorMessage('No data to open in previewer');
            return;
        }

        const timestamp = Date.now();
        const tempPath = path.join(os.tmpdir(), `netezza_preview_${timestamp}.nzpreview`);

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: 'Opening in Data File Preview...',
                    cancellable: true
                },
                async (progress) => {
                    progress.report({ message: 'Writing preview file...' });

                    const writeStream = fs.createWriteStream(tempPath, { encoding: 'utf8' });

                    for (const item of items) {
                        if (!item.columns || item.columns.length === 0) continue;

                        const headers = item.columns.map(c => escapeCsvField(c.name));
                        writeStream.write(headers.join(',') + '\n');

                        for (const row of item.rows) {
                            const values = row.map(v => escapeCsvField(v));
                            writeStream.write(values.join(',') + '\n');
                        }
                    }

                    await new Promise<void>((resolve, reject) => {
                        writeStream.end();
                        writeStream.on('finish', resolve);
                        writeStream.on('error', reject);
                    });

                    progress.report({ message: 'Opening file...' });
                }
            );

            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(tempPath));
            vscode.window.showInformationMessage(`Opened ${items.length} result set(s) in Data File Preview`);
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to open in previewer: ${errorMsg}`);
        }
    }

    public async copyAsExcel(data: unknown, sql?: string): Promise<void> {
        if (data && typeof data === 'object' && 'results' in data) {
            data = this.hydrateExportData(data as ExcelExportMetadata);
        }
        vscode.commands.executeCommand('netezza.copyCurrentResultToXlsbClipboard', data, sql);
    }

    public async openInExcelXlsx(data: unknown, sql?: string): Promise<void> {
        try {
            if (data && typeof data === 'object' && 'results' in data) {
                data = this.hydrateExportData(data as ExcelExportMetadata);
            }
            await vscode.commands.executeCommand('netezza.exportCurrentResultToXlsxAndOpen', data, sql);
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to export to XLSX: ${errorMsg}. Please try reloading the window.`);
        }
    }

    public hydrateExportData(metadata: ExcelExportMetadata): HydratedExportItem[] {
        if (!metadata || !metadata.results) return [];
        const { sourceUri, results } = metadata;
        const allResults = this._resultsMap.get(sourceUri);
        if (!allResults) return [];

        const hydrated: HydratedExportItem[] = [];

        for (const m of results) {
            const rs = allResults[m.resultSetIndex];
            if (!rs) continue;

            const selectedColumnIndices = m.columnIds
                .map(id => Number.parseInt(id, 10))
                .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < rs.columns.length);

            if (selectedColumnIndices.length === 0) {
                continue;
            }

            const visibleColumns = selectedColumnIndices.map(idx => {
                const originalCol = rs.columns[idx];
                return {
                    name: originalCol.name,
                    type: originalCol.type,
                    scale: originalCol.scale
                };
            });

            const rows = resolveExportRows(rs, m.rowIndices, selectedColumnIndices);

            if (rows.length === 0) continue;

            hydrated.push({
                columns: visibleColumns,
                rows: rows,
                sql: rs.sql || '',
                name: m.name,
                isActive: m.isActive
            });
        }

        return hydrated;
    }

    public async initiateExport(exportData: ExportMetadata): Promise<void> {
        const formatItems = [
            { label: 'Excel (XLSB)', description: 'Binary Excel Format', id: 'excel' },
            { label: 'Excel (XLSX)', description: 'Modern Excel Format', id: 'xlsx' },
            { label: 'CSV', description: 'Comma Separated Values', id: 'csv' },
            { label: 'CSV.GZ', description: 'Gzip-compressed CSV', id: 'csv.gz' },
            { label: 'CSV.ZST', description: 'Zstandard-compressed CSV', id: 'csv.zst' },
            { label: 'JSON', description: 'JavaScript Object Notation', id: 'json' },
            { label: 'XML', description: 'Extensible Markup Language', id: 'xml' },
            { label: 'SQL INSERT', description: 'SQL Insert Statements', id: 'sql' },
            { label: 'Markdown', description: 'Markdown Table', id: 'markdown' },
            { label: 'Parquet', description: 'Apache Parquet Columnar Format', id: 'parquet' }
        ];

        const selectedFormat = await vscode.window.showQuickPick(formatItems, { placeHolder: 'Select export format' });
        if (!selectedFormat) return;

        const destinationItems = [
            { label: 'Save to File', id: 'file', description: 'Save to a specific location' },
            { label: 'Copy File to Clipboard (Temp)', description: 'Save as temp file & copy path', id: 'temp' },
            { label: 'Open File', id: 'open', description: 'Save to temp & open in default program' }
        ];

        if (['json', 'xml', 'markdown', 'sql', 'parquet'].includes(selectedFormat.id)) {
            destinationItems.push({
                label: 'Copy Content to Clipboard',
                description: 'Copy text directly',
                id: 'clipboard'
            });
        }

        const selectedDestination = await vscode.window.showQuickPick(destinationItems, {
            placeHolder: 'Select destination'
        });
        if (!selectedDestination) return;

        await this.initiateExportWithSelection(
            exportData,
            selectedFormat.id,
            selectedDestination.id
        );
    }

    public async initiateExportWithSelection(
        exportData: ExportMetadata,
        formatId: string,
        destinationId: string
    ): Promise<void> {
        const resultSet = this._resultsMap.get(exportData.sourceUri)?.[exportData.resultSetIndex];
        if (!resultSet) {
            vscode.window.showErrorMessage('Result set not found');
            return;
        }

        try {
            if (formatId === 'excel' || formatId === 'xlsx') {
                await this._handleExcelExport(
                    exportData,
                    resultSet,
                    formatId as 'excel' | 'xlsx',
                    destinationId as 'file' | 'temp' | 'open'
                );
            } else if (formatId === 'parquet') {
                await this._handleParquetExport(
                    exportData,
                    resultSet,
                    destinationId as 'file' | 'temp' | 'open' | 'clipboard'
                );
            } else {
                await this._handleStandardExport(
                    exportData,
                    resultSet,
                    formatId as 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown',
                    destinationId as 'file' | 'temp' | 'open' | 'clipboard'
                );
            }
        } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Export failed: ${message}`);
        }
    }

    private async _handleExcelExport(
        exportData: ExportMetadata,
        resultSet: ResultSet,
        format: 'excel' | 'xlsx',
        destination: 'file' | 'temp' | 'open'
    ): Promise<void> {
        const dataToExport: ExcelExportMetadata = {
            sourceUri: exportData.sourceUri,
            results: [
                {
                    resultSetIndex: exportData.resultSetIndex,
                    rowIndices: exportData.rowIndices || [],
                    columnIds: exportData.columnIds || [],
                    name: resultSet.name || 'Result',
                    isActive: true
                }
            ]
        };
        const hydrated = this.hydrateExportData(dataToExport) as StructuredExportItem[];

        if (!hydrated || hydrated.length === 0) {
            vscode.window.showErrorMessage('Failed to prepare data for export');
            return;
        }

        const item = {
            columns: hydrated[0].columns,
            rows: hydrated[0].rows,
            sql: resultSet.sql,
            name: resultSet.name || 'Result'
        };

        const ext = format === 'excel' ? 'xlsb' : 'xlsx';
        let targetPath: string;

        if (destination === 'file') {
            const uri = await vscode.window.showSaveDialog({
                filters: { [`Excel ${ext.toUpperCase()}`]: [ext] },
                saveLabel: 'Export'
            });
            if (!uri) return;
            targetPath = uri.fsPath;
        } else {
            targetPath = path.join(os.tmpdir(), `netezza_export_${Date.now()}.${ext}`);
        }

        if (format === 'excel') {
            await exportStructuredToXlsb([item], targetPath, destination === 'temp');
        } else {
            await exportStructuredToXlsx([item], targetPath, destination === 'temp');
        }

        if (destination === 'temp') {
            vscode.window.showInformationMessage(`Exported to temp and copied to clipboard: ${targetPath}`);
        } else if (destination === 'open') {
            vscode.env.openExternal(vscode.Uri.file(targetPath));
            vscode.window.showInformationMessage(`Exported to temp and opened: ${targetPath}`);
        } else {
            vscode.window.showInformationMessage(`Exported to ${targetPath}`);
        }
    }

    private async _handleParquetExport(
        _exportData: ExportMetadata,
        resultSet: ResultSet,
        destination: 'file' | 'temp' | 'open' | 'clipboard'
    ): Promise<void> {
        const ext = 'parquet';

        if (destination === 'clipboard') {
            vscode.window.showWarningMessage('Clipboard is not supported for Parquet format. Saving to file instead.');
            destination = 'temp';
        }

        let targetPath: string;
        if (destination === 'file') {
            const uri = await vscode.window.showSaveDialog({
                filters: { 'Parquet Files': [ext] },
                saveLabel: 'Export Parquet'
            });
            if (!uri) return;
            targetPath = uri.fsPath;
        } else {
            targetPath = path.join(os.tmpdir(), `netezza_export_${Date.now()}.${ext}`);
        }

        const { exportStructuredToParquet } = await import('../export/parquetExporter');
        const visibleColumnIndices = _exportData.columnIds
            ? _exportData.columnIds
                .map(id => Number.parseInt(id, 10))
                .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < resultSet.columns.length)
            : resultSet.columns.map((_, i) => i);
        const rows = resolveExportRows(resultSet, _exportData.rowIndices, visibleColumnIndices);
        await exportStructuredToParquet([{
            columns: visibleColumnIndices.map(i => resultSet.columns[i]),
            rows,
            sql: resultSet.sql || '',
            name: resultSet.name || 'Result'
        }], targetPath, destination === 'temp');

        if (destination === 'temp') {
            if (os.platform() === 'win32') {
                const { copyFileToClipboard } = await import('../export/parquetExporter');
                const success = await copyFileToClipboard(targetPath);
                if (success) {
                    vscode.window.showInformationMessage(`Exported and file copied to clipboard: ${targetPath}`);
                } else {
                    vscode.window.showInformationMessage(`Exported to ${targetPath} (Clipboard copy failed)`);
                }
            } else {
                await vscode.env.clipboard.writeText(targetPath);
                vscode.window.showInformationMessage(`Exported to temp. Path copied: ${targetPath}`);
            }
        } else if (destination === 'open') {
            vscode.env.openExternal(vscode.Uri.file(targetPath));
            vscode.window.showInformationMessage(`Exported to temp and opened: ${targetPath}`);
        } else {
            vscode.window.showInformationMessage(`Exported to ${targetPath}`);
        }
    }

    private async _handleStandardExport(
        exportData: ExportMetadata,
        resultSet: ResultSet,
        format: 'csv' | 'csv.gz' | 'csv.zst' | 'json' | 'xml' | 'sql' | 'markdown',
        destination: 'file' | 'temp' | 'open' | 'clipboard'
    ): Promise<void> {
        const ext = format === 'markdown' ? 'md' : format;

        if (destination === 'clipboard') {
            const tempPath = path.join(os.tmpdir(), `export_content_${Date.now()}.${ext}`);

            await exportResultSetToFile(resultSet, tempPath, {
                format,
                rowIndices: exportData.rowIndices,
                columnIds: exportData.columnIds
            });

            const content = await fs.promises.readFile(tempPath, 'utf8');
            await vscode.env.clipboard.writeText(content);
            vscode.window.showInformationMessage('Content copied to clipboard');
            fs.unlink(tempPath, () => { });
            return;
        }

        let targetPath: string;
        if (destination === 'file') {
            const uri = await vscode.window.showSaveDialog({
                filters: { [format.toUpperCase()]: [ext] },
                saveLabel: 'Export'
            });
            if (!uri) return;
            targetPath = uri.fsPath;
        } else {
            targetPath = path.join(os.tmpdir(), `netezza_export_${Date.now()}.${ext}`);
        }

        await exportResultSetToFile(resultSet, targetPath, {
            format,
            rowIndices: exportData.rowIndices,
            columnIds: exportData.columnIds
        });

        if (destination === 'temp') {
            if (os.platform() === 'win32') {
                const success = await copyXlsbToClipboard(targetPath);
                if (success) {
                    vscode.window.showInformationMessage(`Exported and file copied to clipboard: ${targetPath}`);
                } else {
                    vscode.window.showInformationMessage(`Exported to ${targetPath} (Clipboard copy failed)`);
                }
            } else {
                await vscode.env.clipboard.writeText(targetPath);
                vscode.window.showInformationMessage(`Exported to temp. Path copied: ${targetPath}`);
            }
        } else if (destination === 'open') {
            vscode.env.openExternal(vscode.Uri.file(targetPath));
            vscode.window.showInformationMessage(`Exported to temp and opened: ${targetPath}`);
        } else {
            vscode.window.showInformationMessage(`Exported to ${targetPath}`);
        }
    }

    public async exportAllResultSetsToExcel(metadata: ExcelExportMetadata): Promise<void> {
        if (!metadata || !metadata.results || metadata.results.length === 0) {
            vscode.window.showErrorMessage('Export failed: No result sets to export');
            return;
        }

        // Let user choose format
        const formatItems = [
            { label: 'Excel (XLSX)', description: 'Modern Excel Format - Multiple Sheets', id: 'xlsx' },
            { label: 'Excel (XLSB)', description: 'Binary Excel Format - Multiple Sheets', id: 'xlsb' }
        ];

        const selectedFormat = await vscode.window.showQuickPick(formatItems, {
            placeHolder: 'Select Excel format for multi-sheet export'
        });

        if (!selectedFormat) return;

        const destinationItems = [
            { label: 'Save to File', id: 'file', description: 'Save to a specific location' },
            { label: 'Copy File to Clipboard (Temp)', description: 'Save as temp file & copy path', id: 'temp' },
            { label: 'Open File', id: 'open', description: 'Save to temp & open in default program' }
        ];

        const selectedDestination = await vscode.window.showQuickPick(destinationItems, {
            placeHolder: 'Select destination'
        });
        if (!selectedDestination) return;

        const ext = selectedFormat.id;
        let targetPath: string;

        if (selectedDestination.id === 'file') {
            const uri = await vscode.window.showSaveDialog({
                filters: { [`Excel ${ext.toUpperCase()}`]: [ext] },
                saveLabel: 'Export All to Excel'
            });
            if (!uri) return;
            targetPath = uri.fsPath;
        } else {
            targetPath = path.join(os.tmpdir(), `netezza_export_all_${Date.now()}.${ext}`);
        }

        try {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Window,
                    title: `Exporting all result sets to Excel (${ext.toUpperCase()})...`,
                    cancellable: false
                },
                async (progress) => {
                    // Hydrate the export data
                    const hydratedData = this.hydrateExportData(metadata);

                    if (hydratedData.length === 0) {
                        throw new Error('No data available to export');
                    }

                    progress.report({ message: `Exporting ${hydratedData.length} result sets...` });

                    if (selectedFormat.id === 'xlsb') {
                        await exportStructuredToXlsb(hydratedData, targetPath, selectedDestination.id === 'temp');
                    } else {
                        await exportStructuredToXlsx(hydratedData, targetPath, selectedDestination.id === 'temp');
                    }
                }
            );

            if (selectedDestination.id === 'temp') {
                if (os.platform() === 'win32') {
                    const success = await copyXlsbToClipboard(targetPath);
                    if (success) {
                        vscode.window.showInformationMessage(`Exported all results and copied file to clipboard: ${targetPath}`);
                    } else {
                        vscode.window.showWarningMessage(`Exported to ${targetPath} (Clipboard copy failed)`);
                    }
                } else {
                    await vscode.env.clipboard.writeText(targetPath);
                    vscode.window.showInformationMessage(`Exported to temp. Path copied: ${targetPath}`);
                }
            } else if (selectedDestination.id === 'open') {
                vscode.env.openExternal(vscode.Uri.file(targetPath));
                vscode.window.showInformationMessage(`Exported all results to temp and opened: ${targetPath}`);
            } else {
                // Ask user what to do next for 'file' destination
                const action = await vscode.window.showInformationMessage(
                    `Successfully exported ${metadata.results.length} result sets to ${targetPath}`,
                    'Open File',
                    'Open Folder',
                    'Close'
                );

                if (action === 'Open File') {
                    vscode.env.openExternal(vscode.Uri.file(targetPath));
                } else if (action === 'Open Folder') {
                    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(targetPath));
                }
            }
        } catch (error: unknown) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Export failed: ${errorMsg}`);
        }
    }
}

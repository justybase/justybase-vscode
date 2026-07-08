import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { readParquetFile } from '../export/parquetHyparquet';

interface ExcelReaderWithInit {
    open(path: string): Promise<void>;
    read(): boolean | Promise<boolean>;
    close(): Promise<void>;
    fieldCount: number;
    getValue(i: number): unknown;
    getSheetNames?(): string[];
    _initSheet?(index: number): void | Promise<void>;
}

interface ColumnInfo {
    name: string;
    type?: string;
    scale?: number;
}

interface FilePreviewData {
    columns: ColumnInfo[];
    rows: unknown[][];
    totalRows: number;
    limitReached: boolean;
    filePath: string;
    fileSizeBytes: number;
    formatLabel: string;
}

export class FilePreviewEditor implements vscode.CustomReadonlyEditorProvider {
    public static readonly viewType = 'netezza.filePreview';
    private static readonly _visiblePanels = new Set<vscode.WebviewPanel>();

    private static _updateContextKeys(filePath?: string): void {
        const isOpen = FilePreviewEditor._visiblePanels.size > 0;
        void vscode.commands.executeCommand('setContext', 'netezza.filePreviewOpen', isOpen);
        const ext = filePath ? path.extname(filePath).toLowerCase() : '';
        void vscode.commands.executeCommand('setContext', 'netezza.filePreviewExtname', ext);
    }

    constructor(private readonly _extensionUri: vscode.Uri) { }

    openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): vscode.CustomDocument {
        return { uri, dispose: () => { } };
    }

    async resolveCustomEditor(
        document: vscode.CustomDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media'),
                vscode.Uri.joinPath(this._extensionUri, 'dist', 'media'),
            ],
        };

        try {
            const allData = await this._readFile(document.uri.fsPath);
            const first = allData[0];
            webviewPanel.title = `${first.formatLabel} Preview: ${path.basename(document.uri.fsPath)}`;
            webviewPanel.webview.html = this._buildHtml(webviewPanel, document.uri.fsPath, allData);

            FilePreviewEditor._visiblePanels.add(webviewPanel);
            FilePreviewEditor._updateContextKeys(document.uri.fsPath);

            webviewPanel.onDidChangeViewState(e => {
                if (e.webviewPanel.visible) {
                    FilePreviewEditor._visiblePanels.add(webviewPanel);
                } else {
                    FilePreviewEditor._visiblePanels.delete(webviewPanel);
                }
                FilePreviewEditor._updateContextKeys(document.uri.fsPath);
            });

            webviewPanel.onDidDispose(() => {
                FilePreviewEditor._visiblePanels.delete(webviewPanel);
                FilePreviewEditor._updateContextKeys();
            });

            webviewPanel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'info') {
                    vscode.window.showInformationMessage(msg.text);
                } else if (msg.command === 'error') {
                    console.error('[FilePreview]', msg.text);
                    vscode.window.showErrorMessage(msg.text);
                } else if (msg.command === 'setContext') {
                    vscode.commands.executeCommand('setContext', msg.key, msg.value);
                } else if (msg.command === 'focusView') {
                    vscode.commands.executeCommand('netezza.results.focus');
                } else if (msg.command === 'copyToClipboard') {
                    vscode.env.clipboard.writeText(msg.text);
                } else if (msg.command === 'initiateExport' || msg.command === 'handleClickExport') {
                    void this._handleExport(allData, webviewPanel);
                } else if (msg.command === 'exportCsv' || msg.command === 'exportJson' || msg.command === 'exportXml' || msg.command === 'exportSqlInsert' || msg.command === 'exportMarkdown') {
                    void this._handleQuickExport(allData, msg.command as string);
                } else if (msg.command === 'openInExcel') {
                    void this._handleExcelExport(allData, 'xlsb', webviewPanel);
                } else if (msg.command === 'openInExcelXlsx') {
                    void this._handleExcelExport(allData, 'xlsx', webviewPanel);
                } else if (msg.command === 'copyAsExcel') {
                    void this._handleExcelExport(allData, 'xlsb', webviewPanel, true);
                } else if (msg.command === 'exportAllResultSetsToExcel') {
                    void this._handleExcelExport(allData, 'xlsx', webviewPanel);
                }
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            webviewPanel.title = `Error: ${path.basename(document.uri.fsPath)}`;
            webviewPanel.webview.html = this._buildErrorHtml(msg, document.uri.fsPath);
        }
    }

    private async _handleExport(allData: FilePreviewData[], _panel: vscode.WebviewPanel): Promise<void> {
        const formatItems = [
            { label: 'Excel (XLSB)', description: 'Binary Excel Format', id: 'xlsb' as const },
            { label: 'Excel (XLSX)', description: 'Modern Excel Format', id: 'xlsx' as const },
            { label: 'CSV', description: 'Comma Separated Values', id: 'csv' as const },
            { label: 'JSON', description: 'JavaScript Object Notation', id: 'json' as const },
            { label: 'XML', description: 'Extensible Markup Language', id: 'xml' as const },
            { label: 'SQL INSERT', description: 'SQL Insert Statements', id: 'sql' as const },
            { label: 'Markdown', description: 'Markdown Table', id: 'markdown' as const },
            { label: 'Parquet', description: 'Apache Parquet Columnar Format', id: 'parquet' as const },
        ];

        const selectedFormat = await vscode.window.showQuickPick(formatItems, { placeHolder: 'Select export format' });
        if (!selectedFormat) return;

        const ext = selectedFormat.id === 'markdown' ? 'md' : selectedFormat.id === 'parquet' ? 'parquet' : selectedFormat.id;
        const uri = await vscode.window.showSaveDialog({
            filters: { [`${selectedFormat.label} Files`]: [ext] },
            saveLabel: `Export ${selectedFormat.label}`
        });

        if (!uri) return;

        await this._writeExport(allData, uri.fsPath, selectedFormat.id);
    }

    private async _handleQuickExport(allData: FilePreviewData[], command: string): Promise<void> {
        const formatMap: Record<string, { label: string; ext: string; format: string }> = {
            exportCsv: { label: 'CSV', ext: 'csv', format: 'csv' },
            exportJson: { label: 'JSON', ext: 'json', format: 'json' },
            exportXml: { label: 'XML', ext: 'xml', format: 'xml' },
            exportSqlInsert: { label: 'SQL', ext: 'sql', format: 'sql' },
            exportMarkdown: { label: 'Markdown', ext: 'md', format: 'markdown' },
        };

        const info = formatMap[command];
        if (!info) return;

        const uri = await vscode.window.showSaveDialog({
            filters: { [`${info.label} Files`]: [info.ext] },
            saveLabel: `Export ${info.label}`
        });

        if (!uri) return;

        await this._writeExport(allData, uri.fsPath, info.format);
    }

    private async _handleExcelExport(allData: FilePreviewData[], format: 'xlsb' | 'xlsx', _panel: vscode.WebviewPanel, copyToClipboard: boolean = false): Promise<void> {
        const ext = format;
        const uri = await vscode.window.showSaveDialog({
            filters: { [`Excel ${ext.toUpperCase()}`]: [ext] },
            saveLabel: `Export Excel ${ext.toUpperCase()}`
        });

        if (!uri) return;

        const { exportStructuredToXlsb } = await import('../export/xlsbExporter');
        const { exportStructuredToXlsx } = await import('../export/xlsxExporter');

        const items = allData.map(d => ({
            columns: d.columns,
            rows: d.rows,
            sql: '',
            name: d.formatLabel || 'Sheet',
        }));

        const exporter = format === 'xlsb' ? exportStructuredToXlsb : exportStructuredToXlsx;
        const result = await exporter(items, uri.fsPath, copyToClipboard);

        if (result.success) {
            vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
        } else {
            vscode.window.showErrorMessage(`Export failed: ${result.message}`);
        }
    }

    private async _writeExport(allData: FilePreviewData[], outputPath: string, format: string): Promise<void> {
        const { columns, rows } = allData[0];

        switch (format) {
            case 'csv': {
                const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
                writeStream.write(columns.map(c => escapeCsvValue(c.name)).join(',') + '\n');
                for (const row of rows) {
                    writeStream.write(row.map(v => escapeCsvValue(v)).join(',') + '\n');
                }
                if (allData.length > 1) {
                    for (let si = 1; si < allData.length; si++) {
                        const sheet = allData[si];
                        writeStream.write('\n-- Sheet: ' + sheet.formatLabel + ' --\n');
                        writeStream.write(sheet.columns.map(c => escapeCsvValue(c.name)).join(',') + '\n');
                        for (const row of sheet.rows) {
                            writeStream.write(row.map(v => escapeCsvValue(v)).join(',') + '\n');
                        }
                    }
                }
                await new Promise<void>((resolve, reject) => {
                    writeStream.end();
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });
                break;
            }
            case 'json': {
                let jsonData: unknown[];
                if (allData.length === 1) {
                    jsonData = rows.map(row => {
                        const obj: Record<string, unknown> = {};
                        columns.forEach((col, i) => { obj[col.name] = row[i]; });
                        return obj;
                    });
                } else {
                    jsonData = allData.map(sheet => ({
                        sheet: sheet.formatLabel,
                        data: sheet.rows.map(row => {
                            const obj: Record<string, unknown> = {};
                            sheet.columns.forEach((col, i) => { obj[col.name] = row[i]; });
                            return obj;
                        })
                    }));
                }
                fs.writeFileSync(outputPath, JSON.stringify(jsonData, null, 2), 'utf8');
                break;
            }
            case 'xml': {
                let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<results>\n';
                for (const sheet of allData) {
                    if (allData.length > 1) {
                        xml += `  <sheet name="${escapeXml(sheet.formatLabel)}">\n`;
                    }
                    for (const row of sheet.rows) {
                        xml += '    <row>\n';
                        sheet.columns.forEach((col, i) => {
                            const tag = col.name.replace(/[^a-zA-Z0-9_-]/g, '_');
                            const val = row[i] === null || row[i] === undefined ? '' : escapeXml(String(row[i]));
                            xml += `      <${tag}>${val}</${tag}>\n`;
                        });
                        xml += '    </row>\n';
                    }
                    if (allData.length > 1) {
                        xml += '  </sheet>\n';
                    }
                }
                xml += '</results>';
                fs.writeFileSync(outputPath, xml, 'utf8');
                break;
            }
            case 'sql': {
                const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
                for (const sheet of allData) {
                    if (allData.length > 1) {
                        writeStream.write(`-- Sheet: ${sheet.formatLabel}\n`);
                    }
                    const colNames = sheet.columns.map(c => c.name.replace(/[^a-zA-Z0-9_]/g, '') || 'COL').join(', ');
                    for (const row of sheet.rows) {
                        const values = row.map((v, i) => formatSqlValue(v, sheet.columns[i].type));
                        writeStream.write(`INSERT INTO EXPORT_TABLE (${colNames}) VALUES (${values.join(', ')});\n`);
                    }
                }
                await new Promise<void>((resolve, reject) => {
                    writeStream.end();
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });
                break;
            }
            case 'markdown': {
                const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
                for (const sheet of allData) {
                    if (allData.length > 1) {
                        writeStream.write(`### ${sheet.formatLabel}\n\n`);
                    }
                    writeStream.write('| ' + sheet.columns.map(c => c.name.replace(/\|/g, '\\|')).join(' | ') + ' |\n');
                    writeStream.write('| ' + sheet.columns.map(() => '---').join(' | ') + ' |\n');
                    for (const row of sheet.rows) {
                        const vals = row.map(v => {
                            if (v === null || v === undefined) return '';
                            return String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
                        });
                        writeStream.write('| ' + vals.join(' | ') + ' |\n');
                    }
                    writeStream.write('\n');
                }
                await new Promise<void>((resolve, reject) => {
                    writeStream.end();
                    writeStream.on('finish', resolve);
                    writeStream.on('error', reject);
                });
                break;
            }
            case 'parquet': {
                const { exportStructuredToParquet } = await import('../export/parquetExporter');
                const items = allData.map(d => ({
                    columns: d.columns,
                    rows: d.rows,
                    sql: '',
                    name: d.formatLabel || 'Sheet',
                }));
                await exportStructuredToParquet(items, outputPath);
                break;
            }
        }

        vscode.window.showInformationMessage(`Exported to ${outputPath}`);
    }

    private _buildHtml(webviewPanel: vscode.WebviewPanel, filePath: string, allData: FilePreviewData[]): string {
        const ext = path.extname(filePath).toLowerCase();
        const formatLabel = ext === '.parquet' ? 'Parquet'
            : ext === '.xlsx' ? 'XLSX'
                : ext === '.xlsb' ? 'XLSB'
                    : ext === '.csv' ? 'CSV'
                        : ext === '.tsv' || ext === '.tab' ? 'TSV'
                            : ext === '.json' ? 'JSON'
                                : ext === '.nzpreview' ? 'Results Preview' : 'File';

        const cspSource = webviewPanel.webview.cspSource;
        const tanstackUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-table-core.js')
        );
        const virtualUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'tanstack-virtual-core.js')
        );
        const styleUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'media', 'resultPanel.css')
        );
        const mainScriptUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'resultPanel.js')
        );
        const workerUri = webviewPanel.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'dist', 'media', 'searchWorker.js')
        );

        const stats = fs.statSync(filePath);
        const fileSizeStr = stats.size < 1024 * 1024
            ? `${(stats.size / 1024).toFixed(1)} KB`
            : `${(stats.size / (1024 * 1024)).toFixed(2)} MB`;

        const resultSetsJson = JSON.stringify(allData.map(d => ({
            columns: d.columns,
            data: d.rows,
            executionTimestamp: Date.now(),
            name: d.formatLabel || 'Sheet',
            limitReached: d.limitReached,
        })));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-inline'; worker-src ${cspSource} blob:; connect-src ${cspSource}; style-src ${cspSource} 'unsafe-inline';">
    <title>${formatLabel} Preview</title>
    <script src="${tanstackUri}"></script>
    <script src="${virtualUri}"></script>
    <link rel="stylesheet" href="${styleUri}">
    <style>
        .file-header-info{flex-shrink:0;padding:2px 8px 4px;font-size:11px;color:var(--vscode-descriptionForeground,#888);border-bottom:1px solid var(--vscode-panel-border,#444);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        #sourceTabs{display:none!important}
        .source-tabs{display:none!important}
    </style>
</head>
<body>
    <div class="file-header-info">${escHtml(path.basename(filePath))} &middot; ${fileSizeStr} &middot; ${formatLabel}</div>
    <div id="sourceTabs" class="source-tabs"></div>
    <div id="resultSetTabs" class="result-set-tabs" style="display: none;"></div>
    <div id="executionStatusBanner" class="execution-status-banner" style="display: none;"></div>

    <div id="loadingOverlay" class="loading-overlay">
        <div class="spinner"></div>
        <div class="executing-text">Loading file...</div>
        <button id="cancelQueryBtn" class="secondary" title="Cancel">Cancel</button>
    </div>
    <div class="controls">
        <input type="text" id="globalFilter" class="global-filter-input" placeholder="Filter..." onkeyup="onFilterChanged()">
        <div class="column-search-wrapper">
            <input type="text" id="columnSearch" class="column-search-input" placeholder="Find column..." autocomplete="off" oninput="onColumnSearchChanged()" onkeydown="onColumnSearchKeydown(event)" onblur="onColumnSearchBlur()" onfocus="onColumnSearchFocus()">
            <div id="columnSearchDropdown" class="column-search-dropdown" style="display: none;"></div>
        </div>
        <button onclick="toggleRowView()" title="Toggle Row View"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3c-3 0-6 2.5-6 5s3 5 6 5 6-2.5 6-5-3-5-6-5zm0 9c-2.5 0-4.5-2-4.5-4S5.5 4 8 4s4.5 2 4.5 4-2 4.5-4.5 4.5z"/><circle cx="8" cy="8" r="2"/></svg> Row View</button>
        <div class="view-mode-group">
            <select id="viewModeSelect" class="view-mode-select" title="Switch result view mode">
                <option value="table">Table</option>
                <option value="chart">Charts</option>
            </select>
        </div>
        <button onclick="handleClickExport()" title="Export results"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 3h8v10H6V3zm-1 0H3v10h2V3zm-2-1h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M6 6h8v1H6V6zm0 2h8v1H6V8zm0 2h8v1H6v-1z"/></svg> Export</button>
        <button onclick="copySelection(false)" title="Copy selected cells to clipboard"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h7v2H4V4zm0 4h7v2H4V8zm0 4h7v2H4v-2zM2 1h12v14H2V1zm1 1v12h10V2H3z"/></svg> Copy</button>
        <button onclick="copySelection(true)" title="Copy selected cells with headers"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4h7v2H4V4zm0 4h7v2H4V8zm0 4h7v2H4v-2zM2 1h12v14H2V1zm1 1v12h10V2H3z"/></svg> Copy w/ Headers</button>
        <div class="toolbar-separator"></div>
        <button onclick="clearAllFilters()" title="Clear all filters"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 7.293l4.146-4.147.708.708L8.707 8l4.147 4.146-.708.708L8 8.707l-4.146 4.147-.708-.708L7.293 8 3.146 3.854l.708-.708L8 7.293z"/></svg> Clear Filters</button>
        <span id="rowCountInfo" class="row-count-info"></span>
    </div>

    <div id="groupingPanel" class="grouping-panel" ondragover="onDragOverGroup(event)" ondragleave="onDragLeaveGroup(event)" ondrop="onDropGroup(event)">
        <span class="drag-hint">Drag headers here to group</span>
    </div>

    <div id="mainSplitView" class="main-split-view">
        <div id="gridContainer"></div>
        <div id="analysisContainer" class="analysis-container" style="display: none;"></div>
        <div id="rowViewPanel" class="row-view-panel">
            <div class="row-view-header">
                <span>Row Details & Comparison</span>
                <span class="row-view-close" onclick="toggleRowView()">&times;</span>
            </div>
            <div id="rowViewContent" class="row-view-content">
                <div class="row-view-placeholder">Select 1 to 10 rows to view details or compare</div>
            </div>
        </div>
    </div>
    <div id="valueViewerOverlay" class="value-viewer-overlay">
        <div class="value-viewer-modal">
            <div class="value-viewer-header">
                <div>
                    <div id="valueViewerTitle" class="value-viewer-title">Cell Value</div>
                    <div id="valueViewerMeta" class="value-viewer-meta"></div>
                </div>
                <button id="valueViewerCloseBtn" class="value-viewer-close" title="Close Value Viewer">&times;</button>
            </div>
            <div id="valueViewerBody" class="value-viewer-body"></div>
            <div class="value-viewer-actions">
                <button id="valueViewerCopyBtn" class="primary">Copy Value</button>
                <button id="valueViewerDismissBtn">Close</button>
            </div>
        </div>
    </div>

    <script>
        window.sources = ['file-preview'];
        window.pinnedSources = new Set();
        window.pinnedResults = [];
        window.activeSource = 'file-preview';
        window.resultSets = ${resultSetsJson};
        window.executingSources = new Set();
        window.justybaseUseHostCopyShortcut = true;
        window.defaultCopyFormat = 'markdown';

        let grids = [];
        let activeGridIndex = 0;
        const workerUri = "${workerUri}";
    </script>
    <script src="${mainScriptUri}"></script>
    <script>
        init();
    </script>
</body>
</html>`;
    }

    private _buildErrorHtml(errorMsg: string, filePath: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<title>File Preview Error</title>
<style>
body{font-family:var(--vscode-editor-font-family,Menlo,Monaco,Consolas,monospace);font-size:13px;color:var(--vscode-editor-foreground,#ccc);background:var(--vscode-editor-background,#1e1e1e);padding:20px}
h2{color:var(--vscode-errorForeground,#f14c4c);margin-bottom:8px}
p{color:var(--vscode-descriptionForeground,#888);margin-bottom:4px}
code{background:var(--vscode-textBlockQuote-background,rgba(128,128,128,0.1));padding:2px 6px;border-radius:3px}
</style>
</head>
<body>
<h2>Error Opening File</h2>
<p>Could not read: <code>${escHtml(filePath)}</code></p>
<p>${escHtml(errorMsg)}</p>
</body>
</html>`;
    }

    private _getMaxRows(): number {
        return vscode.workspace.getConfiguration('justybase.filePreview').get<number>('maxRows', 20000);
    }

    private async _readFile(filePath: string): Promise<FilePreviewData[]> {
        const ext = path.extname(filePath).toLowerCase();
        const stats = await fs.promises.stat(filePath);
        const maxRows = this._getMaxRows();

        switch (ext) {
            case '.parquet':
                return [await this._readParquet(filePath, stats.size, maxRows)];
            case '.xlsx':
                return this._readExcel(filePath, stats.size, 'XLSX', maxRows);
            case '.xlsb':
                return this._readExcel(filePath, stats.size, 'XLSB', maxRows);
            case '.csv':
            case '.tsv':
            case '.tab':
            case '.nzpreview':
                return [await this._readCsv(filePath, stats.size, maxRows)];
            default:
                throw new Error(`Unsupported file format: ${ext}`);
        }
    }

    private async _readParquet(filePath: string, fileSizeBytes: number, maxRows: number): Promise<FilePreviewData> {
        const { columns, rows, totalRows } = await readParquetFile(filePath, maxRows);

        return {
            columns,
            rows,
            totalRows,
            limitReached: totalRows > maxRows,
            filePath,
            fileSizeBytes,
            formatLabel: 'Parquet',
        };
    }

    private async _readExcel(filePath: string, fileSizeBytes: number, formatLabel: string, maxRows: number): Promise<FilePreviewData[]> {
        const { ReaderFactory } = require('@justybase/spreadsheet-tasks');
        const reader = ReaderFactory.create(filePath);

        try {
            await reader.open(filePath);

            const sheetNames: string[] = typeof reader.getSheetNames === 'function'
                ? reader.getSheetNames()
                : ['Sheet 1'];

            const results: FilePreviewData[] = [];

            for (let sheetIdx = 0; sheetIdx < sheetNames.length; sheetIdx++) {
                const r = reader as ExcelReaderWithInit;
                if (sheetIdx > 0 && typeof r._initSheet === 'function') {
                    await r._initSheet(sheetIdx);
                }

                const rows: unknown[][] = [];
                let headerRow: string[] | null = null;
                let totalRows = 0;

                while (await reader.read()) {
                    totalRows++;
                    const row: unknown[] = [];
                    for (let i = 0; i < reader.fieldCount; i++) {
                        row.push(this._convertExcelValue(reader.getValue(i)));
                    }

                    if (!headerRow) {
                        headerRow = row.map(v => (v === null || v === undefined ? '' : String(v)));
                        continue;
                    }

                    if (rows.length < maxRows) {
                        rows.push(row);
                    }
                }

                const columns: ColumnInfo[] = headerRow
                    ? headerRow.map(name => ({ name: name || `Column ${headerRow.indexOf(name) + 1}` }))
                    : rows.length > 0
                        ? rows[0].map((_, i) => ({ name: `Column ${i + 1}` }))
                        : [{ name: 'Column 1' }];

                const sheetLabel = sheetNames.length > 1 ? sheetNames[sheetIdx] : formatLabel;
                results.push({
                    columns,
                    rows,
                    totalRows: totalRows > 0 ? totalRows - 1 : 0,
                    limitReached: totalRows - 1 > maxRows,
                    filePath,
                    fileSizeBytes,
                    formatLabel: sheetLabel,
                });
            }

            return results;
        } finally {
            if (reader && typeof reader.close === 'function') {
                try { await reader.close(); } catch { /* ignore */ }
            }
        }
    }

    private _convertExcelValue(val: unknown): unknown {
        if (val === null || val === undefined) return null;
        if (val instanceof Date) return val.toISOString();
        return val;
    }

    private async _readCsv(filePath: string, fileSizeBytes: number, maxRows: number): Promise<FilePreviewData> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split(/\r?\n/);

        const delimiter = this._detectCsvDelimiter(lines[0] || '');

        const columns: ColumnInfo[] = [];
        const rows: unknown[][] = [];
        let totalRows = 0;
        let headerParsed = false;

        for (const line of lines) {
            if (!line.trim()) continue;

            const parsed = this._parseCsvLine(line, delimiter);

            if (!headerParsed) {
                for (const name of parsed) {
                    columns.push({ name: name || `Column ${columns.length + 1}` });
                }
                headerParsed = true;
                continue;
            }

            totalRows++;
            if (rows.length < maxRows) {
                rows.push(parsed.map(v => (v === null || v === undefined ? null : v)));
            }
        }

        if (!headerParsed && rows.length > 0) {
            for (let i = 0; i < rows[0].length; i++) {
                columns.push({ name: `Column ${i + 1}` });
            }
        }

        return {
            columns,
            rows,
            totalRows,
            limitReached: totalRows > maxRows,
            filePath,
            fileSizeBytes,
            formatLabel: 'CSV',
        };
    }

    private _detectCsvDelimiter(firstLine: string): string {
        const delimiters = [';', '\t', '|', ','];
        let best = ',';
        let maxCount = 0;
        for (const delim of delimiters) {
            const escaped = delim === '|' ? '\\|' : delim === '\t' ? '\\t' : delim;
            const count = (firstLine.match(new RegExp(escaped, 'g')) || []).length;
            if (count > maxCount) {
                maxCount = count;
                best = delim;
            }
        }
        return best;
    }

    private _parseCsvLine(line: string, delimiter: string): string[] {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                if (inQuotes && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === delimiter && !inQuotes) {
                result.push(current);
                current = '';
            } else {
                current += char;
            }
        }
        result.push(current);
        return result;
    }
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeCsvValue(v: unknown): string {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatSqlValue(val: unknown, type?: string): string {
    if (val === null || val === undefined) return 'NULL';
    const upperType = (type || '').toUpperCase();
    if (upperType === 'BOOLEAN') return val ? 'TRUE' : 'FALSE';
    if (['INTEGER', 'BIGINT', 'SMALLINT', 'DECIMAL', 'NUMERIC', 'REAL', 'FLOAT', 'DOUBLE', 'INT'].some(t => upperType.includes(t))) {
        return String(val);
    }
    if (typeof val === 'number') return String(val);
    if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
    return `'${String(val).replace(/'/g, "''")}'`;
}

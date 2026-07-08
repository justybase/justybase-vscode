/**
 * Export Commands - commands for exporting data to various formats
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ConnectionManager } from '../core/connectionManager';
import { CsvExportItem, StructuredExportItem } from '../export/xlsbExporter';
import { resolveQueryVariables } from '../core/variableResolver';
import { getExtensionConfiguration } from '../compatibility/configuration';

export interface ExportCommandsDependencies {
    context: vscode.ExtensionContext;
    connectionManager: ConnectionManager;
    outputChannel: vscode.OutputChannel;
}

export type QueryExcelExportFormat = 'xlsb' | 'xlsx';

export type QueryExcelExportCommandArgs = {
    format?: QueryExcelExportFormat;
};

/**
 * Detect if export data uses structured columns/rows format (vs legacy CSV string).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isStructuredExportData(data: any): boolean {
    return Array.isArray(data) &&
        data.length > 0 &&
        'columns' in data[0] &&
        'rows' in data[0];
}

async function resolveActiveSqlQuery(
    context: vscode.ExtensionContext,
): Promise<{ editor: vscode.TextEditor; resolvedText: string } | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return undefined;
    }

    const selection = editor.selection;
    const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

    if (!text.trim()) {
        vscode.window.showWarningMessage('No SQL query to export');
        return undefined;
    }

    try {
        const resolvedText = await resolveQueryVariables(text, false, context);
        return { editor, resolvedText };
    } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('cancelled')) {
            return undefined;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Error resolving variables: ${errorMsg}`);
        return undefined;
    }
}

async function pickExcelExportFormat(
    format?: QueryExcelExportFormat,
): Promise<QueryExcelExportFormat | undefined> {
    if (format) {
        return format;
    }

    const excelFormat = await vscode.window.showQuickPick(
        [
            { label: '$(file-binary) XLSB', description: 'Excel Binary Workbook (faster, smaller)', value: 'xlsb' as const },
            { label: '$(file) XLSX', description: 'Excel Workbook (wider compatibility)', value: 'xlsx' as const },
        ],
        { placeHolder: 'Select Excel format' },
    );

    return excelFormat?.value;
}

async function exportActiveQueryToExcel(
    deps: ExportCommandsDependencies,
    format?: QueryExcelExportFormat,
    options: { saveLabelSuffix?: string } = {},
): Promise<void> {
    const { context, connectionManager, outputChannel } = deps;
    const resolved = await resolveActiveSqlQuery(context);
    if (!resolved) {
        return;
    }

    const { editor, resolvedText } = resolved;
    const excelFormat = await pickExcelExportFormat(format);
    if (!excelFormat) {
        return;
    }

    const filters: Record<string, string[]> = excelFormat === 'xlsb'
        ? { 'Excel Binary Workbook': ['xlsb'] }
        : { 'Excel Workbook': ['xlsx'] };

    const saveLabelSuffix = options.saveLabelSuffix ?? '';
    const uri = await vscode.window.showSaveDialog({
        filters,
        saveLabel: `Export to ${excelFormat.toUpperCase()}${saveLabelSuffix}`,
    });

    if (!uri) {
        return;
    }

    const startTime = Date.now();
    const formatLabel = excelFormat.toUpperCase();

    try {
        const documentUri = editor.document.uri.toString();
        const connectionName = connectionManager.getConnectionForExecution(documentUri);
        const connectionDetails = await connectionManager.getConnection(connectionName || '');
        if (!connectionDetails) {
            throw new Error('Connection not configured. Please connect via Netezza: Connect...');
        }

        const config = getExtensionConfiguration();
        const queryTimeout = config.get<number>('query.executionTimeout', 1800);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: `Exporting to ${formatLabel}${saveLabelSuffix ? ' and opening' : ''}...`,
                cancellable: true,
            },
            async (progress, token) => {
                if (excelFormat === 'xlsx') {
                    const { exportQueryToXlsx } = await import('../export/xlsxExporter');
                    const result = await exportQueryToXlsx(
                        connectionDetails,
                        resolvedText,
                        uri.fsPath,
                        false,
                        (message: string) => {
                            progress.report({ message });
                            outputChannel.appendLine(`[${formatLabel} Export] ${message}`);
                        },
                        queryTimeout,
                        token,
                    );
                    if (!result.success) {
                        throw new Error(result.message);
                    }
                } else {
                    const { exportQueryToXlsb } = await import('../export/xlsbExporter');
                    const result = await exportQueryToXlsb(
                        connectionDetails,
                        resolvedText,
                        uri.fsPath,
                        false,
                        (message: string) => {
                            progress.report({ message });
                            outputChannel.appendLine(`[${formatLabel} Export] ${message}`);
                        },
                        queryTimeout,
                        token,
                    );
                    if (!result.success) {
                        throw new Error(result.message);
                    }
                }
            },
        );

        logExecutionTime(outputChannel, `Export to ${formatLabel}`, startTime);
        vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Error exporting: ${errorMsg}`);
    }
}

async function exportActiveQueryAndOpenTemp(
    deps: ExportCommandsDependencies,
    format: QueryExcelExportFormat,
): Promise<void> {
    const { context, connectionManager, outputChannel } = deps;
    const resolved = await resolveActiveSqlQuery(context);
    if (!resolved) {
        return;
    }

    const { editor, resolvedText } = resolved;
    const formatLabel = format.toUpperCase();
    const startTime = Date.now();

    try {
        const documentUri = editor.document.uri.toString();
        const connectionName = connectionManager.getConnectionForExecution(documentUri);
        const connectionDetails = await connectionManager.getConnection(connectionName || '');
        if (!connectionDetails) {
            throw new Error('Connection not configured. Please connect via Netezza: Connect...');
        }

        const config = getExtensionConfiguration();
        const queryTimeout = config.get<number>('query.executionTimeout', 1800);

        let tempPath = '';

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Window,
                title: `Executing query and opening ${formatLabel}...`,
                cancellable: true,
            },
            async (progress, token) => {
                if (format === 'xlsx') {
                    const { exportQueryToXlsx, getTempFilePath } = await import('../export/xlsxExporter');
                    tempPath = getTempFilePath();
                    const result = await exportQueryToXlsx(
                        connectionDetails,
                        resolvedText,
                        tempPath,
                        false,
                        (message: string) => {
                            progress.report({ message });
                            outputChannel.appendLine(`[${formatLabel} Export] ${message}`);
                        },
                        queryTimeout,
                        token,
                    );
                    if (!result.success) {
                        throw new Error(result.message);
                    }
                } else {
                    const { exportQueryToXlsb, getTempFilePath } = await import('../export/xlsbExporter');
                    tempPath = getTempFilePath();
                    const result = await exportQueryToXlsb(
                        connectionDetails,
                        resolvedText,
                        tempPath,
                        false,
                        (message: string) => {
                            progress.report({ message });
                            outputChannel.appendLine(`[${formatLabel} Export] ${message}`);
                        },
                        queryTimeout,
                        token,
                    );
                    if (!result.success) {
                        throw new Error(result.message);
                    }
                }
            },
        );

        logExecutionTime(outputChannel, `Execute and Open ${formatLabel}`, startTime);
        await vscode.env.openExternal(vscode.Uri.file(tempPath));
        vscode.window.showInformationMessage(`Results exported and opened: ${tempPath}`);
    } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Error exporting: ${errorMsg}`);
    }
}

/**
 * Helper to log execution time
 */
function logExecutionTime(outputChannel: vscode.OutputChannel, operation: string, startTime: number): void {
    const duration = Date.now() - startTime;
    outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${operation} completed in ${duration}ms`);
    outputChannel.show(true);
}

/**
 * Register all export-related commands
 */
export function registerExportCommands(deps: ExportCommandsDependencies): vscode.Disposable[] {
    const { context, connectionManager, outputChannel } = deps;

    return [
        // Export to Excel (XLSB or XLSX). Optional args.format skips the format picker.
        vscode.commands.registerCommand(
            'netezza.exportToXlsb',
            async (args?: QueryExcelExportCommandArgs) => exportActiveQueryToExcel(deps, args?.format),
        ),

        vscode.commands.registerCommand(
            'netezza.exportToXlsx',
            async () => exportActiveQueryToExcel(deps, 'xlsx'),
        ),

        // Export to CSV (plain, gzip, or zstd — compression inferred from file extension)
        vscode.commands.registerCommand('netezza.exportToCsv', async (args?: { format?: 'csv' | 'csv.gz' | 'csv.zst' }) => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const selection = editor.selection;
            const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

            if (!text.trim()) {
                vscode.window.showWarningMessage('No SQL query to export');
                return;
            }

            // Resolve variables in the query before exporting
            let resolvedText: string;
            try {
                resolvedText = await resolveQueryVariables(text, false, context);
            } catch (err: unknown) {
                // User cancelled variable input or other error
                if (err instanceof Error && err.message.includes('cancelled')) {
                    return;
                }
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error resolving variables: ${errorMsg}`);
                return;
            }

            const csvFormatOptions = [
                { label: 'CSV', description: 'Uncompressed comma-separated values', value: 'csv' as const },
                { label: 'CSV.GZ', description: 'Gzip-compressed CSV (streaming)', value: 'csv.gz' as const },
                { label: 'CSV.ZST', description: 'Zstandard-compressed CSV (streaming)', value: 'csv.zst' as const },
            ];
            const csvFormat = args?.format
                ? csvFormatOptions.find(option => option.value === args.format)
                : await vscode.window.showQuickPick(csvFormatOptions, { placeHolder: 'Select CSV compression' });
            if (!csvFormat) return;

            const uri = await vscode.window.showSaveDialog({
                filters: { [`${csvFormat.label} Files`]: [csvFormat.value] },
                defaultUri: vscode.Uri.file(`export.${csvFormat.value}`),
                saveLabel: `Export to ${csvFormat.label}`,
            });

            if (!uri) return;

            const startTime = Date.now();

            try {
                const documentUri = editor.document.uri.toString();
                const connectionName = connectionManager.getConnectionForExecution(documentUri);
                const connectionDetails = await connectionManager.getConnection(connectionName || '');
                if (!connectionDetails) {
                    throw new Error('Connection not configured. Please connect via Netezza: Connect...');
                }

                // Get query timeout from configuration
                const config = getExtensionConfiguration();
                const queryTimeout = config.get<number>('query.executionTimeout', 1800);

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: `Exporting to ${csvFormat.label}...`,
                        cancellable: true
                    },
                    async (progress, token) => {
                        const { exportToCsv } = await import('../export/csvExporter');
                        await exportToCsv(connectionDetails, resolvedText, uri.fsPath, progress, queryTimeout, token);
                    }
                );

                logExecutionTime(outputChannel, 'Export to CSV', startTime);
                vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error exporting to CSV: ${errorMsg}`);
            }
        }),

        // Copy XLSB to Clipboard
        vscode.commands.registerCommand('netezza.copyXlsbToClipboard', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const selection = editor.selection;
            const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

            if (!text.trim()) {
                vscode.window.showWarningMessage('No SQL query to export');
                return;
            }

            // Resolve variables in the query before exporting
            let resolvedText: string;
            try {
                resolvedText = await resolveQueryVariables(text, false, context);
            } catch (err: unknown) {
                // User cancelled variable input or other error
                if (err instanceof Error && err.message.includes('cancelled')) {
                    return;
                }
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error resolving variables: ${errorMsg}`);
                return;
            }

            try {
                const documentUri = editor.document.uri.toString();
                const connectionName = connectionManager.getConnectionForExecution(documentUri);
                const connectionDetails = await connectionManager.getConnection(connectionName || '');
                if (!connectionDetails) {
                    throw new Error('Connection not configured. Please connect via Netezza: Connect...');
                }

                // Get query timeout from configuration
                const config = getExtensionConfiguration();
                const queryTimeout = config.get<number>('query.executionTimeout', 1800);

                const startTime = Date.now();

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: 'Exporting to XLSB and copying to clipboard...',
                        cancellable: true
                    },
                    async (progress, token) => {
                        const { exportQueryToXlsb, getTempFilePath } = await import('../export/xlsbExporter');

                        const tempPath = getTempFilePath();

                        const result = await exportQueryToXlsb(
                            connectionDetails,
                            resolvedText,
                            tempPath,
                            true,
                            (message: string) => {
                                progress.report({ message });
                                outputChannel.appendLine(`[XLSB Clipboard] ${message}`);
                            },
                            queryTimeout,
                            token
                        );

                        if (!result.success) {
                            throw new Error(result.message);
                        }

                        if (!result.details?.clipboard_success) {
                            throw new Error('Failed to copy file to clipboard');
                        }
                    }
                );

                logExecutionTime(outputChannel, 'Copy XLSB to Clipboard', startTime);

                const action = await vscode.window.showInformationMessage(
                    'Excel file copied to clipboard! You can now paste it into Excel or Windows Explorer.',
                    'Show Temp Folder',
                    'OK'
                );

                if (action === 'Show Temp Folder') {
                    const tempDir = os.tmpdir();
                    await vscode.env.openExternal(vscode.Uri.file(tempDir));
                }
            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error copying XLSB to clipboard: ${errorMsg}`);
            }
        }),

        // Execute query, export to temp Excel file, and open (no save dialog)
        vscode.commands.registerCommand('netezza.exportQueryAndOpenXlsb', async () => {
            await exportActiveQueryAndOpenTemp(deps, 'xlsb');
        }),

        vscode.commands.registerCommand('netezza.exportQueryAndOpenXlsx', async () => {
            await exportActiveQueryAndOpenTemp(deps, 'xlsx');
        }),

        // Export to Excel (XLSB or XLSX) and Open
        vscode.commands.registerCommand('netezza.exportToXlsbAndOpen', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const selection = editor.selection;
            const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

            if (!text.trim()) {
                vscode.window.showWarningMessage('No SQL query to export');
                return;
            }

            // Resolve variables in the query before exporting
            let resolvedText: string;
            try {
                resolvedText = await resolveQueryVariables(text, false, context);
            } catch (err: unknown) {
                // User cancelled variable input or other error
                if (err instanceof Error && err.message.includes('cancelled')) {
                    return;
                }
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error resolving variables: ${errorMsg}`);
                return;
            }

            // Ask for Excel format
            const excelFormat = await vscode.window.showQuickPick(
                [
                    { label: '$(file-binary) XLSB', description: 'Excel Binary Workbook (faster, smaller)', value: 'xlsb' as const },
                    { label: '$(file) XLSX', description: 'Excel Workbook (wider compatibility)', value: 'xlsx' as const },
                ],
                { placeHolder: 'Select Excel format' },
            );

            if (!excelFormat) return;

            const filters: Record<string, string[]> = excelFormat.value === 'xlsb'
                ? { 'Excel Binary Workbook': ['xlsb'] }
                : { 'Excel Workbook': ['xlsx'] };

            const uri = await vscode.window.showSaveDialog({
                filters,
                saveLabel: `Export to ${excelFormat.value.toUpperCase()} and Open`
            });

            if (!uri) return;

            const startTime = Date.now();
            const formatLabel = excelFormat.value.toUpperCase();

            try {
                const documentUri = editor.document.uri.toString();
                const connectionName = connectionManager.getConnectionForExecution(documentUri);
                const connectionDetails = await connectionManager.getConnection(connectionName || '');
                if (!connectionDetails) {
                    throw new Error('Connection not configured. Please connect via Netezza: Connect...');
                }

                const config = getExtensionConfiguration();
                const queryTimeout = config.get<number>('query.executionTimeout', 1800);

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: `Exporting to ${formatLabel} and opening...`,
                        cancellable: true
                    },
                    async (progress, token) => {
                        if (excelFormat.value === 'xlsx') {
                            const { exportQueryToXlsx } = await import('../export/xlsxExporter');
                            const result = await exportQueryToXlsx(
                                connectionDetails, resolvedText, uri.fsPath, false,
                                (message: string) => { progress.report({ message }); outputChannel.appendLine(`[${formatLabel} Export] ${message}`); },
                                queryTimeout, token
                            );
                            if (!result.success) { throw new Error(result.message); }
                        } else {
                            const { exportQueryToXlsb } = await import('../export/xlsbExporter');
                            const result = await exportQueryToXlsb(
                                connectionDetails, resolvedText, uri.fsPath, false,
                                (message: string) => { progress.report({ message }); outputChannel.appendLine(`[${formatLabel} Export] ${message}`); },
                                queryTimeout, token
                            );
                            if (!result.success) { throw new Error(result.message); }
                        }
                    }
                );

                logExecutionTime(outputChannel, `Export to ${formatLabel} and Open`, startTime);

                await vscode.env.openExternal(uri);
                vscode.window.showInformationMessage(`Results exported and opened: ${uri.fsPath}`);
            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error exporting: ${errorMsg}`);
            }
        }),

        // Export Current Result to XLSB and Open (from datagrid)
        vscode.commands.registerCommand(
            'netezza.exportCurrentResultToXlsbAndOpen',
            async (csvContent: string | (CsvExportItem & { isActive?: boolean })[], sql?: string) => {
                try {
                    if (!csvContent || (Array.isArray(csvContent) && csvContent.length === 0)) {
                        vscode.window.showErrorMessage('No data to export');
                        return;
                    }

                    let dataToExport = csvContent;

                    if (Array.isArray(csvContent) && csvContent.length > 1) {
                        const choice = await vscode.window.showQuickPick(
                            ['Export All Results', 'Export Active Result Only'],
                            { placeHolder: 'Multiple results available. What would you like to export?' }
                        );

                        if (!choice) return;

                        if (choice === 'Export Active Result Only') {
                            const activeItem = csvContent.find(item => item.isActive);
                            if (activeItem) {
                                dataToExport = [activeItem];
                            } else {
                                dataToExport = [csvContent[0]];
                            }
                        }
                    }

                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const tempPath = path.join(os.tmpdir(), `netezza_results_${timestamp}.xlsb`);

                    const startTime = Date.now();

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: 'Creating Excel file...',
                            cancellable: true
                        },
                        async (progress, token) => {
                            if (token.isCancellationRequested) return;

                            if (isStructuredExportData(dataToExport)) {
                                const { exportStructuredToXlsb } = await import('../export/xlsbExporter');
                                const result = await exportStructuredToXlsb(
                                    dataToExport as unknown as (StructuredExportItem & { isActive?: boolean })[],
                                    tempPath,
                                    false,
                                    (message: string) => {
                                        if (!token.isCancellationRequested) {
                                            progress.report({ message });
                                            outputChannel.appendLine(`[Structured to XLSB] ${message}`);
                                        }
                                    }
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            } else {
                                const { exportCsvToXlsb } = await import('../export/xlsbExporter');
                                const result = await exportCsvToXlsb(
                                    dataToExport,
                                    tempPath,
                                    false,
                                    { source: 'Query Results Panel', sql },
                                    (message: string) => {
                                        progress.report({ message });
                                        outputChannel.appendLine(`[CSV to XLSB] ${message}`);
                                    }
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            }
                        }
                    );

                    const duration = Date.now() - startTime;
                    outputChannel.appendLine(
                        `[${new Date().toLocaleTimeString()}] Export Current Result to Excel completed in ${duration}ms`
                    );

                    await vscode.env.openExternal(vscode.Uri.file(tempPath));
                    vscode.window.showInformationMessage(`Results exported and opened: ${tempPath}`);
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error exporting to Excel: ${errorMsg}`);
                }
            }
        ),

        // Copy Current Result to Clipboard as XLSB
        vscode.commands.registerCommand(
            'netezza.copyCurrentResultToXlsbClipboard',
            async (csvContent: string | (CsvExportItem & { isActive?: boolean })[], sql?: string) => {
                try {
                    if (!csvContent || (Array.isArray(csvContent) && csvContent.length === 0)) {
                        vscode.window.showErrorMessage('No data to copy');
                        return;
                    }

                    let dataToExport = csvContent;

                    if (Array.isArray(csvContent) && csvContent.length > 1) {
                        const choice = await vscode.window.showQuickPick(
                            ['Export All Results', 'Export Active Result Only'],
                            { placeHolder: 'Multiple results available. What would you like to export?' }
                        );

                        if (!choice) return;

                        if (choice === 'Export Active Result Only') {
                            const activeItem = csvContent.find(item => item.isActive);
                            if (activeItem) {
                                dataToExport = [activeItem];
                            } else {
                                dataToExport = [csvContent[0]];
                            }
                        }
                    }

                    const { getTempFilePath } = await import('../export/xlsbExporter');
                    const tempPath = getTempFilePath();

                    const startTime = Date.now();

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: 'Copying to clipboard as Excel...',
                            cancellable: true
                        },
                        async (progress, token) => {
                            if (token.isCancellationRequested) return;

                            if (isStructuredExportData(dataToExport)) {
                                const { exportStructuredToXlsb } = await import('../export/xlsbExporter');
                                const result = await exportStructuredToXlsb(
                                    dataToExport as unknown as (StructuredExportItem & { isActive?: boolean })[],
                                    tempPath,
                                    true,
                                    (message: string) => {
                                        if (!token.isCancellationRequested) {
                                            progress.report({ message });
                                            outputChannel.appendLine(`[Clipboard Structured XLSB] ${message}`);
                                        }
                                    }
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            } else {
                                const { exportCsvToXlsb } = await import('../export/xlsbExporter');
                                const result = await exportCsvToXlsb(
                                    dataToExport,
                                    tempPath,
                                    true,
                                    { source: 'Query Results Panel', sql },
                                    (message: string) => {
                                        progress.report({ message });
                                        outputChannel.appendLine(`[Clipboard XLSB] ${message}`);
                                    }
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            }
                        }
                    );

                    logExecutionTime(outputChannel, 'Copy Result as Excel', startTime);

                    const action = await vscode.window.showInformationMessage(
                        'Excel file copied to clipboard! You can now paste it into Excel or Windows Explorer.',
                        'Show Temp Folder',
                        'OK'
                    );

                    if (action === 'Show Temp Folder') {
                        const tempDir = os.tmpdir();
                        await vscode.env.openExternal(vscode.Uri.file(tempDir));
                    }
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error copying to Excel: ${errorMsg}`);
                }
            }
        ),

        // Export to Parquet
        vscode.commands.registerCommand('netezza.exportToParquet', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No active editor found');
                return;
            }

            const selection = editor.selection;
            const text = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);

            if (!text.trim()) {
                vscode.window.showWarningMessage('No SQL query to export');
                return;
            }

            let resolvedText: string;
            try {
                resolvedText = await resolveQueryVariables(text, false, context);
            } catch (err: unknown) {
                if (err instanceof Error && err.message.includes('cancelled')) {
                    return;
                }
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error resolving variables: ${errorMsg}`);
                return;
            }

            const uri = await vscode.window.showSaveDialog({
                filters: { 'Parquet Files': ['parquet'] },
                saveLabel: 'Export to Parquet'
            });

            if (!uri) return;

            const startTime = Date.now();

            try {
                const documentUri = editor.document.uri.toString();
                const connectionName = connectionManager.getConnectionForExecution(documentUri);
                const connectionDetails = await connectionManager.getConnection(connectionName || '');
                if (!connectionDetails) {
                    throw new Error('Connection not configured. Please connect via Netezza: Connect...');
                }

                const config = getExtensionConfiguration();
                const queryTimeout = config.get<number>('query.executionTimeout', 1800);

                await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: 'Exporting to Parquet...',
                        cancellable: true
                    },
                    async (progress, token) => {
                        const { exportQueryToParquet } = await import('../export/parquetExporter');
                        const result = await exportQueryToParquet(
                            connectionDetails, resolvedText, uri.fsPath, false,
                            (message: string) => { progress.report({ message }); outputChannel.appendLine(`[Parquet Export] ${message}`); },
                            queryTimeout, token
                        );
                        if (!result.success) { throw new Error(result.message); }
                    }
                );

                logExecutionTime(outputChannel, 'Export to Parquet', startTime);
                vscode.window.showInformationMessage(`Results exported to ${uri.fsPath}`);
            } catch (err: unknown) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Error exporting to Parquet: ${errorMsg}`);
            }
        }),

        // Export Current Result to XLSX and Open (from datagrid)
        vscode.commands.registerCommand(
            'netezza.exportCurrentResultToXlsxAndOpen',
            async (csvContent: string | (CsvExportItem & { isActive?: boolean })[], sql?: string) => {
                try {
                    if (!csvContent || (Array.isArray(csvContent) && csvContent.length === 0)) {
                        vscode.window.showErrorMessage('No data to export');
                        return;
                    }

                    let dataToExport = csvContent;

                    if (Array.isArray(csvContent) && csvContent.length > 1) {
                        const choice = await vscode.window.showQuickPick(
                            ['Export All Results', 'Export Active Result Only'],
                            { placeHolder: 'Multiple results available. What would you like to export?' }
                        );

                        if (!choice) return;

                        if (choice === 'Export Active Result Only') {
                            const activeItem = csvContent.find(item => item.isActive);
                            if (activeItem) {
                                dataToExport = [activeItem];
                            } else {
                                dataToExport = [csvContent[0]];
                            }
                        }
                    }

                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const tempPath = path.join(os.tmpdir(), `netezza_results_${timestamp}.xlsx`);

                    const startTime = Date.now();

                    await vscode.window.withProgress(
                        {
                            location: vscode.ProgressLocation.Window,
                            title: 'Creating Excel XLSX file...',
                            cancellable: true
                        },
                        async (progress, token) => {
                            if (token.isCancellationRequested) return;

                            if (isStructuredExportData(dataToExport)) {
                                const { exportStructuredToXlsx } = await import('../export/xlsxExporter');
                                const result = await exportStructuredToXlsx(
                                    dataToExport as unknown as (StructuredExportItem & { isActive?: boolean })[],
                                    tempPath,
                                    false,
                                    (message: string) => {
                                        if (!token.isCancellationRequested) {
                                            progress.report({ message });
                                            outputChannel.appendLine(`[Structured to XLSX] ${message}`);
                                        }
                                    }
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            } else {
                                const { exportCsvToXlsx } = await import('../export/xlsxExporter');
                                const result = await exportCsvToXlsx(
                                    dataToExport,
                                    tempPath,
                                    false,
                                    { source: 'Query Results Panel', sql },
                                    (message: string) => {
                                        progress.report({ message });
                                        outputChannel.appendLine(`[CSV to XLSX] ${message}`);
                                    }
                                );
                                if (!result.success) {
                                    throw new Error(result.message);
                                }
                            }
                        }
                    );

                    const duration = Date.now() - startTime;
                    outputChannel.appendLine(
                        `[${new Date().toLocaleTimeString()}] Export Current Result to XLSX completed in ${duration}ms`
                    );

                    await vscode.env.openExternal(vscode.Uri.file(tempPath));
                    vscode.window.showInformationMessage(`Results exported and opened: ${tempPath}`);
                } catch (err: unknown) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    vscode.window.showErrorMessage(`Error exporting to Excel XLSX: ${errorMsg}`);
                }
            }
        )
    ];
}

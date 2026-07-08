import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ConnectionManager } from '../core/connectionManager';
import { ResultPanelView } from '../views/resultPanelView';
import { resolveQueryVariables } from '../core/variableResolver';
import { getQueryConfig } from '../core/queryBatchExecutor';
import { createConnectedDatabaseConnectionFromDetails } from '../core/connectionFactory';
import { NzConnection, ColumnDefinition } from '../types';
import { SqlParser } from '../sql/sqlParser';

export interface ExportToMdDependencies {
    connectionManager: ConnectionManager;
    resultPanelProvider: ResultPanelView;
}

interface CollectedResultSet {
    columns: ColumnDefinition[];
    data: unknown[][];
    limitReached: boolean;
}

function formatCellValueForMd(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL';
    }
    const str = String(value);
    return str.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function buildMdTable(columns: ColumnDefinition[], rows: unknown[][]): string {
    const slicedRows = rows.slice(0, 1000);
    if (slicedRows.length === 0) {
        return '*No rows returned*';
    }

    const headerNames = columns.map(c => c.name);
    const lines: string[] = [];

    lines.push('| ' + headerNames.map(h => h.replace(/\|/g, '\\|')).join(' | ') + ' |');
    lines.push('| ' + headerNames.map(() => '---').join(' | ') + ' |');

    for (const row of slicedRows) {
        const cells = columns.map((_col, ci) => formatCellValueForMd(row[ci]));
        lines.push('| ' + cells.join(' | ') + ' |');
    }

    if (rows.length > 1000) {
        lines.push('');
        lines.push(`*Table truncated: ${rows.length} total rows, showing first 1000*`);
    }

    return lines.join('\n');
}

function buildMdHeader(connectionName: string, resolvedText: string): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('pl-PL', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeStr = now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let header = '# SQL Export\n\n';
    header += `**Connection:** ${connectionName}\n`;
    header += `**Generated:** ${dateStr} ${timeStr}\n\n`;
    header += `**Source SQL:**\n\n`;
    header += '```sql\n' + resolvedText + '\n```\n\n';
    header += '---\n\n';
    return header;
}

function buildMdDocument(connectionName: string, resolvedText: string, allResults: CollectedResultSet[]): string {
    let mdDocument = buildMdHeader(connectionName, resolvedText);

    const dataResults = allResults.filter(rs => rs.columns.length > 0);

    if (dataResults.length === 0) {
        mdDocument += '*No tabular results returned.*\n';
    } else {
        const statements = SqlParser.splitStatements(resolvedText).map(s => s.trim()).filter(Boolean);

        for (let i = 0; i < dataResults.length; i++) {
            const rs = dataResults[i];
            const sqlStatement = i < statements.length ? statements[i] : resolvedText;
            mdDocument += `## Query ${i + 1}\n\n`;
            mdDocument += '```sql\n' + sqlStatement + '\n```\n\n';
            mdDocument += `### Results\n\n`;
            mdDocument += buildMdTable(rs.columns, rs.data);
            mdDocument += '\n\n';
            if (rs.limitReached) {
                mdDocument += `*Row limit reached (${rs.data.length} rows shown)*\n\n`;
            }
            mdDocument += '---\n\n';
        }
    }

    return mdDocument;
}

async function executeAndCollectAll(
    connection: NzConnection,
    query: string,
    rowLimit: number,
    timeoutSeconds: number
): Promise<CollectedResultSet[]> {
    const cmd = connection.createCommand(query);
    cmd.commandTimeout = timeoutSeconds;

    const reader = await cmd.executeReader();
    const allResults: CollectedResultSet[] = [];

    try {
        do {
            const columns: ColumnDefinition[] = [];
            for (let i = 0; i < reader.fieldCount; i++) {
                const colName = String(reader.getName(i));
                const colType = String(reader.getTypeName(i) || '');
                columns.push({ name: colName, type: colType });
            }

            const rows: unknown[][] = [];
            if (reader.fieldCount > 0) {
                while (await reader.read() && rows.length < rowLimit) {
                    const row: unknown[] = [];
                    for (let i = 0; i < reader.fieldCount; i++) {
                        row.push(reader.getValue(i));
                    }
                    rows.push(row);
                }
            }

            allResults.push({
                columns,
                data: rows,
                limitReached: rows.length >= rowLimit
            });
        } while (await reader.nextResult());
    } finally {
        reader.close();
    }

    return allResults;
}

async function resolveFileUri(mode?: 'temp' | 'choose'): Promise<vscode.Uri | undefined> {
    if (mode === 'temp') {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tempPath = path.join(os.tmpdir(), `sql-export-${timestamp}.md`);
        return vscode.Uri.file(tempPath);
    }

    if (mode === 'choose') {
        return vscode.window.showSaveDialog({
            filters: { 'Markdown Files': ['md'] },
            saveLabel: 'Export as MD'
        });
    }

    const choice = await vscode.window.showQuickPick(
        [
            { label: '$(file-symlink-file) Save to temp file', description: 'Auto-save and open immediately', value: 'temp' as const },
            { label: '$(folder) Choose save location...', description: 'Pick a folder and filename', value: 'choose' as const },
        ],
        { placeHolder: 'Where to save the MD export?' }
    );

    if (!choice) return undefined;

    if (choice.value === 'temp') {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const tempPath = path.join(os.tmpdir(), `sql-export-${timestamp}.md`);
        return vscode.Uri.file(tempPath);
    }

    return vscode.window.showSaveDialog({
        filters: { 'Markdown Files': ['md'] },
        saveLabel: 'Export as MD'
    });
}

async function openFile(uri: vscode.Uri): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
}

interface MdExportContext {
    editor: vscode.TextEditor;
    selection: vscode.Selection;
    text: string;
    resolvedText: string;
    documentUri: string;
    connectionName: string;
}

async function prepareExportContext(deps: ExportToMdDependencies): Promise<MdExportContext | undefined> {
    const { connectionManager } = deps;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor found');
        return undefined;
    }

    const selection = editor.selection;
    const text = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

    if (!text.trim()) {
        vscode.window.showWarningMessage('No SQL query to export');
        return undefined;
    }

    let resolvedText: string;
    try {
        resolvedText = await resolveQueryVariables(text, false);
    } catch (err: unknown) {
        if (err instanceof Error && err.message.includes('cancelled')) {
            return undefined;
        }
        const errorMsg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Error resolving variables: ${errorMsg}`);
        return undefined;
    }

    const documentUri = editor.document.uri.toString();
    const connectionName = connectionManager.getConnectionForExecution(documentUri);
    if (!connectionName) {
        vscode.window.showErrorMessage('No database connection. Please connect via Netezza: Connect...');
        return undefined;
    }

    return { editor, selection, text, resolvedText, documentUri, connectionName };
}

async function executeAndBuildMd(
    deps: ExportToMdDependencies,
    ctx: MdExportContext
): Promise<string | undefined> {
    const connectionDetails = await deps.connectionManager.getConnection(ctx.connectionName);
    if (!connectionDetails) {
        throw new Error(`Connection '${ctx.connectionName}' not found`);
    }

    const { queryTimeout, rowLimit } = getQueryConfig();

    let allResults: CollectedResultSet[] = [];
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Window,
            title: 'Executing SQL for MD export...',
            cancellable: true
        },
        async (progress, token) => {
            const connection = await createConnectedDatabaseConnectionFromDetails(connectionDetails) as NzConnection;

            try {
                progress.report({ message: 'Executing queries...' });
                allResults = await executeAndCollectAll(connection, ctx.resolvedText, rowLimit, queryTimeout);
                if (token.isCancellationRequested) {
                    return;
                }
            } finally {
                try { connection.close(); } catch { /* ignore */ }
            }
        }
    );

    if (allResults.length === 0) {
        vscode.window.showWarningMessage('No result sets returned by the query');
        return undefined;
    }

    return buildMdDocument(ctx.connectionName, ctx.resolvedText, allResults);
}

export function registerExportToMdCommand(deps: ExportToMdDependencies): vscode.Disposable {
    const exportCmd = vscode.commands.registerCommand('netezza.exportToMdFile', async (args?: { mode?: 'temp' | 'choose' | 'clipboard' }) => {
        const { resultPanelProvider } = deps;

        const ctx = await prepareExportContext(deps);
        if (!ctx) return;

        let mode = args?.mode;

        if (!mode) {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: '$(file-symlink-file) Save to temp file', description: 'Auto-save and open immediately', value: 'temp' as const },
                    { label: '$(folder) Choose save location...', description: 'Pick a folder and filename', value: 'choose' as const },
                    { label: '$(clippy) Copy to clipboard', description: 'Copy Markdown text directly', value: 'clipboard' as const },
                ],
                { placeHolder: 'How do you want to export the Markdown?' }
            );
            if (!choice) return;
            mode = choice.value;
        }

        if (mode === 'clipboard') {
            const mdDocument = await executeAndBuildMd(deps, ctx);
            if (!mdDocument) return;
            await vscode.env.clipboard.writeText(mdDocument);
            vscode.window.showInformationMessage('MD content copied to clipboard');
            return;
        }

        const uri = await resolveFileUri(mode);
        if (!uri) return;

        const mdDocument = await executeAndBuildMd(deps, ctx);
        if (!mdDocument) return;

        await vscode.workspace.fs.writeFile(uri, Buffer.from(mdDocument, 'utf8'));
        resultPanelProvider.addMdExportResult(ctx.documentUri, mdDocument);

        await openFile(uri);
        vscode.window.showInformationMessage(`Exported to ${uri.fsPath}`);
    });

    return vscode.Disposable.from(exportCmd);
}

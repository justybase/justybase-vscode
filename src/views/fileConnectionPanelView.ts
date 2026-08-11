import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
    FileConnectionPanelFile,
    FileConnectionPanelHostToWebviewMessage,
    FileConnectionPanelState,
    FileConnectionPanelWebviewToHostMessage,
} from '../contracts/webviews/fileConnectionPanelContracts';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import type { ConnectionDetails } from '../types';
import {
    applyFilePathsToConnection,
    buildFileConnectionDetails,
    detectFileDataFormat,
    formatFileSize,
    getFilePaths,
    importFileConnections,
    isFileWorkspaceProfile,
    listXlsxSheetNames,
    normalizeFilePath,
    parseFileConnectionsExport,
    serializeFileConnectionExport,
    serializeFileConnectionsExport,
    saveFileConnectionDetails,
    toFileInfo,
} from '../services/fileConnectionProfileService';

const FILE_QUERY_COMMAND = 'netezza.openInFilePreview';
const DATA_FILE_FILTERS = { 'Data files': ['xlsx', 'csv', 'tsv', 'parquet', 'avro'] };

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function sanitizeViewName(filePath: string): string {
    const base = path.basename(filePath).replace(/\.[^.]+$/, '');
    const sanitized = base.replace(/[^\w]/g, '_').replace(/_+/g, '_');
    return sanitized || 'file';
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function buildQueryContent(
    connectionName: string,
    files: readonly string[],
    workspaceMode: boolean,
    sheetsByFile: ReadonlyMap<string, readonly string[]>,
    selectedFilePath?: string,
): string {
    const lines = workspaceMode
        ? [
            `-- ${connectionName} — File SQL Workspace (read-only)`,
            '-- Each source is a view named by its full path.',
            '-- For XLSX files, every discovered sheet is available as "<path>#sheet=<sheet>".',
            '',
            '-- Available sources:',
        ]
        : [
            `-- ${connectionName} — File SQL`,
            '-- Query the file like a table.',
        ];
    if (files.length === 0) {
        lines.push('-- No data files configured.');
    }
    for (const filePath of files) {
        lines.push(`-- ${quoteIdentifier(filePath)}`);
        if (workspaceMode && detectFileDataFormat(filePath) === 'xlsx') {
            for (const sheet of sheetsByFile.get(filePath) ?? []) {
                lines.push(`-- ${quoteIdentifier(`${filePath}#sheet=${sheet}`)}`);
            }
        }
    }
    if (files.length > 0) {
        const selectedFile = selectedFilePath
            ? files.find(filePath => normalizeFilePath(filePath) === normalizeFilePath(selectedFilePath))
            : undefined;
        const initialFile = selectedFile ?? files[0];
        const view = workspaceMode
            ? quoteIdentifier(initialFile)
            : quoteIdentifier(sanitizeViewName(initialFile));
        lines.push('', `SELECT * FROM ${view} LIMIT 100;`, '');
    }
    return lines.join('\n');
}

export class FileConnectionPanelView {
    public static readonly viewType = 'netezza.fileConnectionPanel';
    private static currentPanel: FileConnectionPanelView | undefined;

    private readonly disposables: vscode.Disposable[] = [];
    private selectedConnectionName: string | undefined;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly connectionManager: ConnectionManager,
        initialConnectionName?: string,
    ) {
        this.selectedConnectionName = initialConnectionName;
        this.panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
                vscode.Uri.joinPath(context.extensionUri, 'dist'),
            ],
        };
        this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);
        this.panel.webview.onDidReceiveMessage(
            (message: FileConnectionPanelWebviewToHostMessage) => this.handleMessage(message),
            null,
            this.disposables,
        );
        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
        this.connectionManager.onDidChangeConnections(
            () => this.refreshConnections(),
            null,
            this.disposables,
        );
    }

    public static createOrShow(
        context: vscode.ExtensionContext,
        connectionManager: ConnectionManager,
        options: { connectionName?: string } = {},
    ): FileConnectionPanelView {
        if (FileConnectionPanelView.currentPanel) {
            const panel = FileConnectionPanelView.currentPanel;
            panel.panel.reveal(vscode.ViewColumn.Beside);
            panel.loadSession(options.connectionName);
            return panel;
        }

        const column = vscode.window.activeTextEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One;
        const panel = vscode.window.createWebviewPanel(
            FileConnectionPanelView.viewType,
            'File Connection Manager',
            column,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        const view = new FileConnectionPanelView(panel, context, connectionManager, options.connectionName);
        FileConnectionPanelView.currentPanel = view;
        view.postState();
        return view;
    }

    /** Public accessor used by the schema tree drop handler to refresh an open panel. */
    public static getOpenPanel(): FileConnectionPanelView | undefined {
        return FileConnectionPanelView.currentPanel;
    }

    public getSelectedConnectionName(): string | undefined {
        return this.selectedConnectionName;
    }

    public async refreshConnections(): Promise<void> {
        const connections = await this.listFileConnections();
        if (
            this.selectedConnectionName
            && !connections.includes(this.selectedConnectionName)
        ) {
            this.selectedConnectionName = connections[0];
        }
        if (!this.selectedConnectionName) {
            this.selectedConnectionName = connections[0];
        }
        this.postState();
    }

    public async loadSession(connectionName?: string): Promise<void> {
        const connections = await this.listFileConnections();
        if (connectionName && connections.includes(connectionName)) {
            this.selectedConnectionName = connectionName;
        } else if (!this.selectedConnectionName || !connections.includes(this.selectedConnectionName)) {
            this.selectedConnectionName = connections[0];
        }
        this.postState();
    }

    public dispose(): void {
        if (FileConnectionPanelView.currentPanel === this) {
            FileConnectionPanelView.currentPanel = undefined;
        }
        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }
    }

    private async listFileConnections(): Promise<string[]> {
        const connections = await this.connectionManager.getConnections();
        return connections
            .filter(connection => tryNormalizeDatabaseKind(connection.dbType) === 'file')
            .map(connection => connection.name)
            .sort((a, b) => a.localeCompare(b));
    }

    private async getSelectedDetails(): Promise<ConnectionDetails | undefined> {
        if (!this.selectedConnectionName) {
            return undefined;
        }
        return this.connectionManager.getConnection(this.selectedConnectionName);
    }

    private async buildState(): Promise<FileConnectionPanelState> {
        const connections = await this.listFileConnections();
        if (
            !this.selectedConnectionName
            || !connections.includes(this.selectedConnectionName)
        ) {
            this.selectedConnectionName = connections[0];
        }
        if (!this.selectedConnectionName) {
            return { connections, selectedConnectionName: '', mode: undefined, editable: false, files: [] };
        }

        const details = await this.getSelectedDetails();
        if (!details) {
            return { connections, selectedConnectionName: this.selectedConnectionName, mode: undefined, editable: false, files: [] };
        }

        const filePaths = getFilePaths(details);
        const files: FileConnectionPanelFile[] = filePaths.map(filePath => {
            const info = toFileInfo(filePath);
            return {
                path: info.path,
                name: info.name,
                format: info.format,
                sizeLabel: info.sizeBytes === undefined ? '' : formatFileSize(info.sizeBytes),
                exists: info.exists,
            };
        });
        return {
            connections,
            selectedConnectionName: this.selectedConnectionName,
            mode: isFileWorkspaceProfile(details) ? 'workspace' : 'single',
            editable: details.options?.editable === true,
            files,
        };
    }

    private post(message: FileConnectionPanelHostToWebviewMessage): void {
        void this.panel.webview.postMessage(message).then(undefined, () => undefined);
    }

    private postState(): void {
        void this.buildState().then(
            state => this.post({ type: 'state', state }),
            error => this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
        );
    }

    private postNotice(message: string): void {
        this.post({ type: 'notice', message });
    }

    private async handleMessage(message: FileConnectionPanelWebviewToHostMessage): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.postState();
                return;
            case 'selectConnection':
                this.selectedConnectionName = message.connectionName;
                this.postState();
                return;
            case 'addFiles':
                await this.addFiles(message.paths);
                return;
            case 'removeFile':
                await this.removeFile(message.path);
                return;
            case 'setEditable':
                await this.setEditable(message.enabled);
                return;
            case 'deleteConnection':
                await this.deleteConnection();
                return;
            case 'previewFile':
                await this.previewFile(message.path);
                return;
            case 'requestSheets':
                await this.sendSheets(message.path);
                return;
            case 'queryFile':
                await this.queryFile(message.path);
                return;
            case 'resolveDroppedNames':
                await this.resolveDroppedNames(message.names);
                return;
            case 'exportConnections':
                await this.exportConnections();
                return;
            case 'importConnections':
                await this.importConnections();
                return;
            case 'refresh':
                this.postState();
                return;
            default:
                return;
        }
    }

    private async addFiles(providedPaths: readonly string[]): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }

        let paths = providedPaths.map(normalizeFilePath).filter(filePath => filePath.length > 0);
        if (paths.length === 0) {
            const result = await vscode.window.showOpenDialog({
                canSelectMany: true,
                canSelectFolders: false,
                openLabel: 'Add data files',
                filters: DATA_FILE_FILTERS,
            });
            paths = (result ?? []).map(uri => normalizeFilePath(uri.fsPath));
        }

        if (paths.length === 0) {
            return;
        }

        const supported = paths.filter(filePath => detectFileDataFormat(filePath) !== undefined);
        const unsupportedCount = paths.length - supported.length;

        const current = await this.connectionManager.getConnection(this.selectedConnectionName);
        if (!current) {
            this.post({ type: 'error', message: `Connection '${this.selectedConnectionName}' is no longer available.` });
            return;
        }
        const merged = Array.from(new Set([...getFilePaths(current), ...supported]));
        const { details, editableCleared } = buildFileConnectionDetails(this.selectedConnectionName, merged, current);
        await saveFileConnectionDetails(this.connectionManager, details);
        if (editableCleared) {
            this.postNotice('The connection is now a multi-file workspace (read-only); the editable copy was disabled.');
        }
        if (unsupportedCount > 0) {
            this.postNotice(`${unsupportedCount} unsupported file(s) were ignored. Supported formats: xlsx, csv, tsv, parquet, avro.`);
        }
        this.postState();
    }

    private async removeFile(filePath: string): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }
        const current = await this.connectionManager.getConnection(this.selectedConnectionName);
        if (!current) {
            return;
        }
        const remaining = getFilePaths(current).filter(existing => normalizeFilePath(existing) !== normalizeFilePath(filePath));
        if (remaining.length === 0) {
            this.postNotice('A File SQL connection must contain at least one data file. Delete the profile instead if it is no longer needed.');
            return;
        }
        await applyFilePathsToConnection(this.connectionManager, this.selectedConnectionName, remaining);
        this.postState();
    }

    private async setEditable(enabled: boolean): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }
        const current = await this.connectionManager.getConnection(this.selectedConnectionName);
        if (!current) {
            return;
        }
        const paths = getFilePaths(current);
        const { details } = buildFileConnectionDetails(this.selectedConnectionName, paths, {
            ...current,
            options: { ...(current.options ?? {}), editable: enabled },
        });
        await saveFileConnectionDetails(this.connectionManager, details);
        this.postState();
    }

    private async deleteConnection(): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }
        const name = this.selectedConnectionName;
        const confirmed = await vscode.window.showWarningMessage(
            `Delete connection profile '${name}'?`,
            { modal: true },
            'Delete',
        );
        if (confirmed !== 'Delete') {
            return;
        }
        await this.connectionManager.deleteConnection(name);
        this.selectedConnectionName = undefined;
        await this.refreshConnections();
        this.postNotice(`Connection '${name}' was deleted.`);
    }

    private async previewFile(filePath: string): Promise<void> {
        const uri = vscode.Uri.file(normalizeFilePath(filePath));
        await vscode.commands.executeCommand(FILE_QUERY_COMMAND, uri);
    }

    private async sendSheets(filePath: string): Promise<void> {
        const normalized = normalizeFilePath(filePath);
        try {
            const sheetNames = await listXlsxSheetNames(normalized);
            this.post({ type: 'sheets', path: normalized, sheetNames });
        } catch (error) {
            this.post({ type: 'error', message: `Could not read Excel sheets: ${error instanceof Error ? error.message : String(error)}` });
        }
    }

    private async queryFile(filePath: string): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }
        const details = await this.connectionManager.getConnection(this.selectedConnectionName);
        if (!details) {
            this.post({ type: 'error', message: `Connection '${this.selectedConnectionName}' is no longer available.` });
            return;
        }
        const workspaceMode = isFileWorkspaceProfile(details);
        const sheetsByFile = new Map<string, readonly string[]>();
        if (workspaceMode) {
            for (const sourcePath of getFilePaths(details)) {
                if (detectFileDataFormat(sourcePath) === 'xlsx') {
                    try {
                        sheetsByFile.set(sourcePath, await listXlsxSheetNames(sourcePath));
                    } catch {
                        sheetsByFile.set(sourcePath, []);
                    }
                }
            }
        }
        const content = buildQueryContent(
            this.selectedConnectionName,
            getFilePaths(details),
            workspaceMode,
            sheetsByFile,
            filePath,
        );
        const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await this.connectionManager.setDocumentConnection(editor.document.uri.toString(), this.selectedConnectionName);
    }

    private async resolveDroppedNames(names: readonly string[]): Promise<void> {
        if (!this.selectedConnectionName || names.length === 0) {
            return;
        }
        const resolved: string[] = [];
        const unresolved: string[] = [];
        for (const name of names) {
            if (/^file:/i.test(name)) {
                const parsedUri = vscode.Uri.parse(name);
                const filePath = normalizeFilePath(parsedUri.fsPath);
                if (filePath && fs.existsSync(filePath)) {
                    resolved.push(filePath);
                } else {
                    unresolved.push(name);
                }
                continue;
            }

            if (path.isAbsolute(name) && fs.existsSync(name)) {
                resolved.push(normalizeFilePath(name));
                continue;
            }

            const escaped = name.replace(/[\\[\]{}()*+?.^$|]/g, '\\$&');
            const matches = await vscode.workspace.findFiles(`**/${escaped}`, undefined, 2);
            const match = matches.length === 1 ? matches[0] : undefined;
            if (match?.scheme === 'file') {
                resolved.push(match.fsPath);
            } else {
                unresolved.push(name);
            }
        }
        if (resolved.length > 0) {
            await this.addFiles(resolved);
        }
        if (unresolved.length > 0) {
            const list = unresolved.slice(0, 5).join(', ');
            const more = unresolved.length > 5 ? ` (and ${unresolved.length - 5} more)` : '';
            this.postNotice(`Could not locate dropped file(s) in the current workspace: ${list}${more}. Use "Add files" to pick them manually.`);
        }
    }

    private async exportConnections(): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }
        const details = await this.getSelectedDetails();
        if (!details) {
            return;
        }
        const defaultName = `${this.selectedConnectionName.replace(/[^\w-]+/g, '_')}.file-connections.json`;
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = workspaceRoot
            ? vscode.Uri.joinPath(workspaceRoot, defaultName)
            : vscode.Uri.file(defaultName);
        const target = await vscode.window.showSaveDialog({
            saveLabel: 'Export connection profile',
            filters: { JSON: ['json'] },
            defaultUri,
        });
        if (!target) {
            return;
        }
        const json = serializeFileConnectionsExport([
            serializeFileConnectionExport(this.selectedConnectionName, details),
        ]);
        await fs.promises.writeFile(target.fsPath, json, 'utf8');
        this.postNotice(`Connection '${this.selectedConnectionName}' exported to ${target.fsPath}.`);
    }

    private async importConnections(): Promise<void> {
        const source = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFolders: false,
            openLabel: 'Import connection profiles',
            filters: { JSON: ['json'] },
        });
        const file = source?.[0];
        if (!file) {
            return;
        }
        try {
            const json = await fs.promises.readFile(file.fsPath, 'utf8');
            const entries = parseFileConnectionsExport(json);
            if (entries.length === 0) {
                this.post({ type: 'error', message: 'The export does not contain any connections.' });
                return;
            }
            const result = await importFileConnections(this.connectionManager, entries);
            const createdText = result.created.length > 0 ? `Created: ${result.created.join(', ')}.` : 'No new connections were created.';
            const skippedText = result.skipped.length > 0 ? ` Skipped: ${result.skipped.join(', ')}.` : '';
            const warnings = result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : '';
            this.postNotice(`${createdText}${skippedText}${warnings}`);
            await this.refreshConnections();
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'fileConnectionPanel.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'fileConnectionPanel.css'));
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" />
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link href="${styleUri}" rel="stylesheet" /></head><body>
            <div id="app"></div><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
    }
}

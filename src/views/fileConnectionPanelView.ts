import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type {
    FileConnectionPanelHostToWebviewMessage,
    FileConnectionPanelState,
    FileConnectionPanelWebviewToHostMessage,
} from '../contracts/webviews/fileConnectionPanelContracts';
import { tryNormalizeDatabaseKind } from '../contracts/database';
import type { ConnectionManager } from '../core/connectionManager';
import type { ConnectionDetails } from '../types';
import {
    DataWorkspaceService,
    defaultDataWorkspaceTableName,
    isDataWorkspaceProfile,
    parseDataWorkspace,
    parseDataWorkspaceProfileExport,
    serializeDataWorkspaceProfileExport,
} from '../services/dataWorkspaceService';
import {
    detectFileDataFormat,
    resolveFileSourceConnectionName,
} from '../services/fileConnectionProfileService';

const DATA_FILE_FILTERS = { 'Data files': ['xlsx', 'xlsb', 'csv', 'tsv', 'parquet', 'avro', 'mdb', 'accdb'] };
const ACCESS_EXTENSION_ID = 'krzysztof-d.justybaselite-access';
const EDITABLE_SOURCE_FORMATS = new Set(['xlsx', 'csv', 'tsv', 'access']);

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function quoteNetezzaObjectPart(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
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
            'Data Workspace Manager',
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
        const connections = await this.listDataWorkspaces();
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
        const connections = await this.listDataWorkspaces();
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

    private async listDataWorkspaces(): Promise<string[]> {
        const connections = await this.connectionManager.getConnections();
        return connections
            .filter(connection => isDataWorkspaceProfile(connection))
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
        const connections = await this.listDataWorkspaces();
        if (
            !this.selectedConnectionName
            || !connections.includes(this.selectedConnectionName)
        ) {
            this.selectedConnectionName = connections[0];
        }
        if (!this.selectedConnectionName) {
            return { connections, selectedConnectionName: '', mode: undefined, workspaceSources: [] };
        }

        const details = await this.getSelectedDetails();
        if (!details) {
            return { connections, selectedConnectionName: this.selectedConnectionName, mode: undefined, workspaceSources: [] };
        }

        const dataWorkspace = parseDataWorkspace(details.options?.dataWorkspace);
        if (dataWorkspace && isDataWorkspaceProfile(details)) {
            return {
                connections,
                selectedConnectionName: this.selectedConnectionName,
                mode: 'dataWorkspace',
                workspaceSources: dataWorkspace.sources.map(source => ({
                    id: source.id,
                    kind: source.kind,
                    ...(source.kind === 'file' ? { sourceFormat: detectFileDataFormat(source.path) } : {}),
                    canEditSource: source.kind === 'file'
                        && EDITABLE_SOURCE_FORMATS.has(detectFileDataFormat(source.path) ?? ''),
                    label: source.kind === 'file'
                        ? source.path
                        : source.sourceKind === 'query'
                            ? `${source.connectionName}: ${source.queryTemplate ?? ''}`
                            : `${source.connectionName}: ${source.objectName ?? ''}`,
                    tableName: source.tableName,
                    rowCount: source.lastRefresh?.rowCount,
                    lastRefresh: source.lastRefresh?.completedAt,
                    refreshStatus: source.lastRefresh?.status ?? 'never',
                    message: source.lastRefresh?.message,
                })),
            };
        }
        return {
            connections,
            selectedConnectionName: this.selectedConnectionName,
            mode: undefined,
            workspaceSources: [],
            notice: 'The selected profile is not a Data Workspace.',
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
            case 'createDataWorkspace':
                await this.createDataWorkspace();
                return;
            case 'addWorkspaceFile':
                await this.addWorkspaceFile();
                return;
            case 'addNetezzaSource':
                await this.addNetezzaSource();
                return;
            case 'editWorkspaceSource':
                await this.editWorkspaceSource(message.sourceId);
                return;
            case 'refreshWorkspaceSource':
                await this.refreshWorkspaceSource(message.sourceId);
                return;
            case 'removeWorkspaceSource':
                await this.removeWorkspaceSource(message.sourceId);
                return;
            case 'queryWorkspace':
                await this.queryWorkspace();
                return;
            case 'deleteConnection':
                await this.deleteConnection();
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

    private dataWorkspaceService(): DataWorkspaceService {
        return new DataWorkspaceService(this.context, this.connectionManager);
    }

    private async createDataWorkspace(): Promise<void> {
        const name = await vscode.window.showInputBox({
            prompt: 'Name for the persistent local DuckDB Data Workspace',
            value: 'Data Workspace',
            ignoreFocusOut: true,
        });
        if (!name?.trim()) return;
        try {
            const details = await this.dataWorkspaceService().createWorkspace(name);
            this.selectedConnectionName = details.name;
            this.postNotice(`Created Data Workspace '${details.name}'.`);
            this.postState();
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    }

    private async addWorkspaceFile(): Promise<void> {
        if (!this.selectedConnectionName) return;
        const details = await this.getSelectedDetails();
        if (!isDataWorkspaceProfile(details)) return;
        const files = await vscode.window.showOpenDialog({
            canSelectMany: true,
            canSelectFolders: false,
            openLabel: 'Add file source',
            filters: DATA_FILE_FILTERS,
        });
        if (!files?.length) return;
        try {
            const service = this.dataWorkspaceService();
            for (const file of files) {
                const suggestedName = defaultDataWorkspaceTableName(file.fsPath);
                const tableName = await vscode.window.showInputBox({
                    prompt: `Local DuckDB table name for ${path.basename(file.fsPath)}`,
                    value: suggestedName,
                    ignoreFocusOut: true,
                });
                if (!tableName?.trim()) continue;
                const source = await service.addFileSource(this.selectedConnectionName, file.fsPath, tableName);
                await service.refreshSource(this.selectedConnectionName, source.id);
            }
            this.postNotice(`Added and materialized ${files.length} file source(s).`);
            this.postState();
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            this.postState();
        }
    }

    private async addNetezzaSource(): Promise<void> {
        if (!this.selectedConnectionName) return;
        const workspace = await this.getSelectedDetails();
        if (!isDataWorkspaceProfile(workspace)) return;
        const connections = (await this.connectionManager.getConnections())
            .filter(connection => tryNormalizeDatabaseKind(connection.dbType) === 'netezza');
        if (connections.length === 0) {
            this.post({ type: 'error', message: 'Add a saved Netezza connection before adding an external source.' });
            return;
        }
        const connectionName = await vscode.window.showQuickPick(connections.map(connection => ({
            label: connection.name,
            description: `${connection.user}@${connection.host}/${connection.database}`,
        })), { placeHolder: 'Select saved Netezza connection' });
        if (!connectionName) return;
        const kind = await vscode.window.showQuickPick([
            { label: 'Table', value: 'table' as const, description: 'Materialize a table from cached metadata or enter its name.' },
            { label: 'View', value: 'view' as const, description: 'Materialize a view from cached metadata or enter its name.' },
            { label: 'Manual SELECT / WITH query', value: 'query' as const, description: 'Read-only SQL; $var parameters are requested on each refresh.' },
        ], { placeHolder: 'Choose source type' });
        if (!kind) return;

        let objectName: string | undefined;
        let queryTemplate: string | undefined;
        if (kind.value === 'query') {
            queryTemplate = await vscode.window.showInputBox({
                prompt: 'Single read-only SELECT or WITH query',
                placeHolder: 'SELECT * FROM schema.table WHERE date_col >= \'$from\'',
                ignoreFocusOut: true,
            });
            if (!queryTemplate?.trim()) return;
        } else {
            objectName = await this.pickNetezzaObject(connectionName.label, kind.value);
            if (!objectName) return;
        }
        const defaultName = defaultDataWorkspaceTableName(`${connectionName.label}_${objectName ?? 'query'}`);
        const tableName = await vscode.window.showInputBox({
            prompt: 'Local DuckDB table name',
            value: defaultName,
            ignoreFocusOut: true,
        });
        if (!tableName?.trim()) return;
        try {
            const service = this.dataWorkspaceService();
            const source = await service.addExternalSource(this.selectedConnectionName, {
                kind: 'external',
                connectionName: connectionName.label,
                sourceKind: kind.value,
                objectName,
                queryTemplate,
                tableName,
            });
            await service.refreshSource(this.selectedConnectionName, source.id);
            this.postNotice(`Materialized '${source.tableName}' from ${connectionName.label}.`);
            this.postState();
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
            this.postState();
        }
    }

    private async editWorkspaceSource(sourceId: string): Promise<void> {
        if (!this.selectedConnectionName) return;
        const details = await this.getSelectedDetails();
        const config = parseDataWorkspace(details?.options?.dataWorkspace);
        const source = config?.sources.find(candidate => candidate.id === sourceId);
        if (!source || source.kind !== 'file') {
            return;
        }

        const format = detectFileDataFormat(source.path);
        if (!format || !EDITABLE_SOURCE_FORMATS.has(format)) {
            this.post({
                type: 'error',
                message: 'This source format is read-only in the Data Workspace editor. Edit XLSX, CSV/TSV or Access files directly.',
            });
            return;
        }

        const confirmation = await vscode.window.showWarningMessage(
            `Edit '${path.basename(source.path)}'? Changes will be written to the original file.`,
            { modal: true },
            'Edit source',
        );
        if (confirmation !== 'Edit source') {
            return;
        }

        try {
            const connections = await this.connectionManager.getConnections();
            const targetKind = format === 'access' ? 'access' : 'file';
            const connectionName = resolveFileSourceConnectionName(connections, source.path, targetKind);
            if (format === 'access') {
                await this.openAccessSourceForEditing(source.path, connectionName);
            } else {
                await vscode.commands.executeCommand('justybase.duckdb.editFileSource', {
                    filePath: source.path,
                    connectionName,
                });
            }
            this.postNotice(`Opened '${path.basename(source.path)}' for editing. Refresh the source after saving the file.`);
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
    }

    private async openAccessSourceForEditing(filePath: string, connectionName: string): Promise<void> {
        const accessExtension = vscode.extensions.getExtension(ACCESS_EXTENSION_ID);
        if (!accessExtension) {
            throw new Error(
                'Editing Access files requires the optional JustyBase SQL Editor (Microsoft Access) extension.',
            );
        }
        await accessExtension.activate();

        const existing = await this.connectionManager.getConnection(connectionName);
        const profile: ConnectionDetails = {
            name: connectionName,
            host: '',
            database: filePath,
            user: '',
            password: existing?.password,
            dbType: 'access',
            options: { ...(existing?.options ?? {}), readOnly: false },
        };

        if (!profile.password) {
            let passwordRequired = false;
            try {
                await this.connectionManager.testConnection(profile);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!/password|encrypted|protected|decrypt/i.test(message)) {
                    throw error;
                }
                passwordRequired = true;
            }
            if (passwordRequired) {
                const password = await vscode.window.showInputBox({
                    prompt: `Password for Access database ${path.basename(filePath)} (optional)`,
                    password: true,
                    ignoreFocusOut: true,
                });
                if (password === undefined) {
                    throw new Error('Access database password prompt was cancelled.');
                }
                profile.password = password || undefined;
            }
        }

        await this.connectionManager.saveConnection(profile);
        try {
            await vscode.commands.executeCommand('netezza.refreshSchema', connectionName);
        } catch {
            // The schema command may not be registered during deferred activation.
        }
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: [
                `-- ${path.basename(filePath)} — Microsoft Access`,
                '-- INSERT/UPDATE/DELETE and supported DDL write to the original Access file.',
                '-- Refresh the related Data Workspace source after saving changes.',
                '',
            ].join('\n'),
        });
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await this.connectionManager.setDocumentConnection(editor.document.uri.toString(), connectionName);
    }

    private async pickNetezzaObject(connectionName: string, sourceKind: 'table' | 'view'): Promise<string | undefined> {
        const details = await this.connectionManager.getConnection(connectionName);
        const metadataCache = this.connectionManager.getMetadataCache();
        const cached = details && metadataCache
            ? metadataCache.getObjectsWithSchema(connectionName, details.database)
            : [];
        const choices: vscode.QuickPickItem[] = [];
        for (const entry of cached) {
            if ((entry.item.objType ?? entry.item.TYPE ?? '').toLowerCase() !== sourceKind) continue;
            const name = entry.item.OBJNAME ?? entry.item.TABLENAME;
            if (name) {
                choices.push({
                    label: `${quoteNetezzaObjectPart(entry.schema)}.${quoteNetezzaObjectPart(name)}`,
                    description: sourceKind,
                });
            }
            if (choices.length >= 500) break;
        }
        if (choices.length > 0) {
            const selected = await vscode.window.showQuickPick(choices, { placeHolder: `Select cached Netezza ${sourceKind}` });
            if (selected) return selected.label;
        }
        return vscode.window.showInputBox({
            prompt: `Netezza ${sourceKind} name`,
            placeHolder: 'schema.object (or DB..object)',
            ignoreFocusOut: true,
        });
    }

    private async refreshWorkspaceSource(sourceId: string): Promise<void> {
        if (!this.selectedConnectionName) return;
        const confirmation = await vscode.window.showWarningMessage(
            'Refreshing replaces this source table. Manual changes to that table are lost; other local tables and views are kept.',
            { modal: true },
            'Refresh',
        );
        if (confirmation !== 'Refresh') return;
        try {
            const result = await this.dataWorkspaceService().refreshSource(this.selectedConnectionName, sourceId);
            this.postNotice(`Source refreshed (${result.rowCount?.toLocaleString() ?? 0} rows).`);
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        this.postState();
    }

    private async removeWorkspaceSource(sourceId: string): Promise<void> {
        if (!this.selectedConnectionName) return;
        const confirmation = await vscode.window.showWarningMessage(
            'Remove this source and its materialized DuckDB table?', { modal: true }, 'Remove',
        );
        if (confirmation !== 'Remove') return;
        try {
            await this.dataWorkspaceService().removeSource(this.selectedConnectionName, sourceId);
            this.postNotice('Source and its materialized table were removed.');
        } catch (error) {
            this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        }
        this.postState();
    }

    private async queryWorkspace(): Promise<void> {
        if (!this.selectedConnectionName) return;
        const details = await this.getSelectedDetails();
        const config = parseDataWorkspace(details?.options?.dataWorkspace);
        if (!config) return;
        const table = config.sources[0]?.tableName;
        const document = await vscode.workspace.openTextDocument({
            language: 'sql',
            content: table ? `SELECT * FROM ${quoteIdentifier(table)} LIMIT 100;\n` : '-- Persistent Data Workspace (DuckDB)\n',
        });
        const editor = await vscode.window.showTextDocument(document, { preview: false });
        await this.connectionManager.setDocumentConnection(editor.document.uri.toString(), this.selectedConnectionName);
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

    private async exportConnections(): Promise<void> {
        if (!this.selectedConnectionName) {
            return;
        }
        const details = await this.getSelectedDetails();
        if (!details) {
            return;
        }
        if (!isDataWorkspaceProfile(details)) {
            this.post({ type: 'error', message: 'Only Data Workspace profiles can be exported from this manager.' });
            return;
        }
        const defaultName = `${this.selectedConnectionName.replace(/[^\w-]+/g, '_')}.data-workspace.json`;
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
        const json = serializeDataWorkspaceProfileExport([
            await this.dataWorkspaceService().exportProfile(this.selectedConnectionName),
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
            const workspaces = parseDataWorkspaceProfileExport(json);
            if (workspaces.length === 0) {
                this.post({ type: 'error', message: 'The export does not contain any Data Workspaces.' });
                return;
            }
            const service = this.dataWorkspaceService();
            const created: string[] = [];
            for (const workspace of workspaces) {
                created.push((await service.importProfile(workspace)).name ?? workspace.name);
            }
            this.postNotice(`Created Data Workspace: ${created.join(', ')}. Source data is not exported; refresh each source to materialize it locally.`);
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

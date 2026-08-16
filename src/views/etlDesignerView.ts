/**
 * ETL Designer View
 * Webview panel for visual ETL workflow design
 */

import * as vscode from 'vscode';
import {
    EtlProject,
    EtlNode,
    EtlNodeType,
    generateNodeId,
    generateConnectionId,
    getDefaultConfig
} from '../etl/etlTypes';
import { EtlProjectManager } from '../etl/etlProjectManager';
import { EtlExecutionEngine, ExecutionContext } from '../etl/etlExecutionEngine';
import { SqlTaskExecutor } from '../etl/tasks/sqlTask';
import { PythonTaskExecutor } from '../etl/tasks/pythonTask';
import { ExportTaskExecutor } from '../etl/tasks/exportTask';
import { ImportTaskExecutor } from '../etl/tasks/importTask';
import { ContainerTaskExecutor } from '../etl/tasks/containerTask';
import { VariableTaskExecutor } from '../etl/tasks/variableTask';
import { VariableManager } from '../etl/utils/variableManager';
import { ConnectionManager } from '../core/connectionManager';
import { getRootExecutionProject } from '../etl/projectStructure';

// Import refactored modules
import { generateEtlDesignerHtml } from './etl/etlDesignerTemplate';
import { NodeConfigurator } from './etl/nodeConfigurator';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function getConfiguredConnectionName(node: EtlNode): string | undefined {
    switch (node.config.type) {
        case 'sql':
        case 'import':
        case 'export':
            return node.config.connection && node.config.connection !== 'default'
                ? node.config.connection
                : undefined;
        default:
            return undefined;
    }
}

export class EtlDesignerView {
    public static currentPanel: EtlDesignerView | undefined;
    public static readonly viewType = 'netezza.etlDesigner';

    private readonly _panel: vscode.WebviewPanel;
    private readonly _context: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];
    private _projectManager: EtlProjectManager;
    private _executionEngine: EtlExecutionEngine;
    private _nodeConfigurator: NodeConfigurator;
    private static _connectionManager: ConnectionManager | undefined;
    private _cancellationTokenSource: vscode.CancellationTokenSource | undefined;

    public static setConnectionManager(connManager: ConnectionManager): void {
        EtlDesignerView._connectionManager = connManager;
    }

    public static createOrShow(
        context: vscode.ExtensionContext,
        project?: EtlProject
    ): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (EtlDesignerView.currentPanel) {
            EtlDesignerView.currentPanel._panel.reveal(column);
            if (project) {
                EtlDesignerView.currentPanel._updateProject(project);
            }
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            EtlDesignerView.viewType,
            'ETL Designer',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [context.extensionUri]
            }
        );

        EtlDesignerView.currentPanel = new EtlDesignerView(
            panel,
            context,
            project
        );
    }

    private constructor(
        panel: vscode.WebviewPanel,
        context: vscode.ExtensionContext,
        project?: EtlProject
    ) {
        this._panel = panel;
        this._context = context;
        this._projectManager = EtlProjectManager.getInstance();

        // Initialize node configurator
        this._nodeConfigurator = new NodeConfigurator(
            this._projectManager,
            () => this._sendProjectUpdate()
        );

        // Initialize execution engine with all task executors
        this._executionEngine = new EtlExecutionEngine();
        this._executionEngine.registerExecutor('sql', new SqlTaskExecutor());
        this._executionEngine.registerExecutor('python', new PythonTaskExecutor());
        this._executionEngine.registerExecutor('export', new ExportTaskExecutor());
        this._executionEngine.registerExecutor('import', new ImportTaskExecutor());
        this._executionEngine.registerExecutor('container', new ContainerTaskExecutor(this._executionEngine));
        this._executionEngine.registerExecutor('variable', new VariableTaskExecutor());

        // Initialize project
        const initialProject = project || this._projectManager.createProject('New ETL Project');
        this._updateWebview(initialProject);

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from webview
        this._panel.webview.onDidReceiveMessage(
            message => this._handleMessage(message),
            null,
            this._disposables
        );

        void this._sendConnectionOptions();
        const connectionManager = EtlDesignerView._connectionManager;
        if (connectionManager && typeof connectionManager.onDidChangeConnections === 'function') {
            this._disposables.push(connectionManager.onDidChangeConnections(() => {
                void this._sendConnectionOptions();
            }));
        }
        if (connectionManager && typeof connectionManager.onDidChangeActiveConnection === 'function') {
            this._disposables.push(connectionManager.onDidChangeActiveConnection(() => {
                void this._sendConnectionOptions();
            }));
        }
    }

    private async _handleMessage(message: { type: string; payload?: unknown }) {
        const project = this._projectManager.getCurrentProject();

        switch (message.type) {
            case 'addNode': {
                const payload = message.payload as {
                    type: EtlNodeType;
                    position: { x: number; y: number };
                    containerId?: string;
                };
                const node: EtlNode = {
                    id: generateNodeId(),
                    type: payload.type,
                    name: this._nodeConfigurator.getDefaultNodeName(payload.type),
                    position: payload.position,
                    ...(payload.containerId ? { containerId: payload.containerId } : {}),
                    config: getDefaultConfig(payload.type)
                };
                this._projectManager.addNode(node);
                this._sendProjectUpdate();
                break;
            }

            case 'confirmRemoveNode': {
                const nodeId = message.payload as string;
                const node = this._projectManager.getNode(nodeId);
                const confirm = await vscode.window.showWarningMessage(
                    node?.type === 'container'
                        ? 'Delete this container and all of its tasks?'
                        : 'Delete this task?',
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    this._projectManager.removeNode(nodeId);
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'removeNode': {
                const nodeId = message.payload as string;
                this._projectManager.removeNode(nodeId);
                this._sendProjectUpdate();
                break;
            }

            case 'updateNodePosition': {
                const { nodeId, position } = message.payload as { nodeId: string; position: { x: number; y: number } };
                this._projectManager.updateNode(nodeId, { position });
                break;
            }

            case 'updateNodeName': {
                const { nodeId, name } = message.payload as { nodeId: string; name: string };
                this._projectManager.updateNode(nodeId, { name });
                this._sendProjectUpdate();
                break;
            }

            case 'updateNodeDetails': {
                const payload = message.payload as {
                    nodeId?: unknown;
                    name?: unknown;
                    description?: unknown;
                    config?: unknown;
                };
                if (typeof payload?.nodeId !== 'string') {
                    break;
                }
                const node = this._projectManager.getNode(payload.nodeId);
                if (!node) {
                    vscode.window.showErrorMessage(`Node not found: ${payload.nodeId}`);
                    break;
                }

                try {
                    const updates: Partial<EtlNode> = {};
                    if (typeof payload.name === 'string') {
                        const name = payload.name.trim();
                        if (!name) {
                            throw new Error('Task name cannot be empty');
                        }
                        updates.name = name;
                    }
                    if (typeof payload.description === 'string') {
                        updates.description = payload.description.trim() || undefined;
                    }
                    if (payload.config !== undefined) {
                        if (!isRecord(payload.config) || payload.config.type !== node.config.type) {
                            throw new Error('Task configuration type does not match the selected task');
                        }
                        updates.config = payload.config as unknown as EtlNode['config'];
                    }
                    this._projectManager.updateNode(payload.nodeId, updates);
                    this._sendProjectUpdate();
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                }
                break;
            }

            case 'updateContainerSize': {
                const { containerId, width, height } = message.payload as { containerId: string; width: number; height: number };
                const container = this._projectManager.getNode(containerId);
                if (container?.config.type === 'container') {
                    this._projectManager.updateNode(containerId, {
                        config: { ...container.config, width, height },
                    });
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'addConnection': {
                const { from, to, connectionType } = message.payload as {
                    from: string;
                    to: string;
                    connectionType?: 'success' | 'failure';
                };
                try {
                    this._projectManager.addConnection({
                        id: generateConnectionId(),
                        from,
                        to,
                        ...(connectionType ? { connectionType } : {}),
                    });
                    this._sendProjectUpdate();
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                }
                break;
            }

            case 'confirmRemoveConnection': {
                const connectionId = message.payload as string;
                const confirm = await vscode.window.showWarningMessage(
                    'Delete this connection?',
                    { modal: true },
                    'Delete'
                );
                if (confirm === 'Delete') {
                    this._projectManager.removeConnection(connectionId);
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'removeConnection': {
                const connectionId = message.payload as string;
                this._projectManager.removeConnection(connectionId);
                this._sendProjectUpdate();
                break;
            }

            case 'toggleConnectionType': {
                const { connectionId, newType } = message.payload as { connectionId: string; newType: 'success' | 'failure' };
                const connection = project?.connections.find(c => c.id === connectionId);
                if (connection) {
                    connection.connectionType = newType;
                    this._projectManager.markDirty();
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'configureNode': {
                const nodeId = message.payload as string;
                await this._nodeConfigurator.configureNode(nodeId);
                break;
            }

            case 'moveNodesToContainer': {
                const payload = message.payload as {
                    containerId: string;
                    nodes: Array<{ id: string; position: { x: number; y: number } }>;
                };
                try {
                    this._projectManager.moveNodesToContainer(payload.containerId, payload.nodes);
                    this._sendProjectUpdate();
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                }
                break;
            }

            case 'removeNodesFromContainer': {
                const payload = message.payload as { nodes: Array<{ id: string; position: { x: number; y: number } }> };
                try {
                    this._projectManager.removeNodesFromContainer(payload.nodes);
                    this._sendProjectUpdate();
                } catch (error) {
                    vscode.window.showErrorMessage(String(error));
                }
                break;
            }

            case 'saveProject': {
                await this._saveProject();
                break;
            }

            case 'loadProject': {
                await this._loadProject();
                break;
            }

            case 'newProject': {
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter project name',
                    value: 'New ETL Project'
                });
                if (name) {
                    this._projectManager.createProject(name);
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'runProject': {
                if (project) {
                    await this._runProject(project);
                }
                break;
            }

            case 'stopProject': {
                this._stopExecution();
                break;
            }

            case 'getProject': {
                this._sendProjectUpdate();
                void this._sendConnectionOptions();
                break;
            }
        }
    }

    private async _sendConnectionOptions(): Promise<void> {
        const connectionManager = EtlDesignerView._connectionManager;
        if (!connectionManager || typeof connectionManager.getConnections !== 'function') {
            return;
        }

        try {
            const connections = await connectionManager.getConnections();
            this._panel.webview.postMessage({
                type: 'connectionOptions',
                payload: {
                    activeConnectionName: connectionManager.getActiveConnectionName() || undefined,
                    connections: connections
                        .filter(connection => !!connection.name)
                        .map(connection => ({
                            name: connection.name,
                            database: connection.database,
                            dbType: connection.dbType,
                        })),
                },
            });
        } catch {
            // A missing/temporarily unavailable connection list must not make
            // the designer unusable; the panel will keep the active fallback.
        }
    }

    private async _saveProject() {
        const project = this._projectManager.getCurrentProject();
        if (!project) {
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            filters: { 'ETL Project': ['etl.json'] },
            defaultUri: this._projectManager.getProjectPath()
                ? vscode.Uri.file(this._projectManager.getProjectPath()!)
                : undefined
        });

        if (uri) {
            try {
                await this._projectManager.saveProject(uri.fsPath);
                vscode.window.showInformationMessage(`Project saved to ${uri.fsPath}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to save project: ${error}`);
            }
        }
    }

    private async _loadProject() {
        const files = await vscode.window.showOpenDialog({
            filters: { 'ETL Project': ['etl.json'] },
            canSelectMany: false
        });

        if (files && files[0]) {
            try {
                const project = await this._projectManager.loadProject(files[0].fsPath);
                this._updateWebview(project);
                vscode.window.showInformationMessage(`Project loaded: ${project.name}`);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to load project: ${error}`);
            }
        }
    }

    private async _runProject(project: EtlProject) {
        // Validate project first
        const errors = this._projectManager.validateProject(project);
        if (errors.length > 0) {
            vscode.window.showErrorMessage(`Project validation failed:\n${errors.join('\n')}`);
            return;
        }

        // Get connection details
        const connManager = EtlDesignerView._connectionManager;
        if (!connManager) {
            vscode.window.showErrorMessage('Connection manager not initialized. Please reload the extension.');
            return;
        }

        const activeConnName = connManager.getActiveConnectionName() || undefined;
        const configuredConnectionName = project.nodes
            .map(getConfiguredConnectionName)
            .find((name): name is string => !!name);
        let runConnectionName = activeConnName || configuredConnectionName;

        if (!runConnectionName && typeof connManager.getConnections === 'function') {
            const availableConnections = await connManager.getConnections();
            runConnectionName = availableConnections.find(connection => !!connection.name)?.name;
        }

        if (!runConnectionName) {
            vscode.window.showErrorMessage('No database connection is configured for this ETL project.');
            return;
        }

        const connDetails = await connManager.getConnection(runConnectionName);
        if (!connDetails) {
            vscode.window.showErrorMessage(`Connection not found: ${runConnectionName}`);
            return;
        }

        const resolveConnection = async (connectionName?: string) => {
            const normalizedName = connectionName?.trim();
            const targetName = !normalizedName || normalizedName === 'default'
                ? runConnectionName
                : normalizedName;
            return connManager.getConnection(targetName);
        };

        // Create output channel for logging
        const outputChannel = vscode.window.createOutputChannel('ETL Execution');
        outputChannel.show();

        // Create cancellation token source
        this._cancellationTokenSource = new vscode.CancellationTokenSource();

        // Create variable manager with project variables
        const variableManager = new VariableManager(project.variables || {});

        // Create execution context
        const context: ExecutionContext = {
            extensionContext: this._context,
            variables: project.variables || {},
            nodeOutputs: new Map(),
            connectionDetails: connDetails,
            cancellationToken: this._cancellationTokenSource.token,
            resolveConnection,
            onProgress: (message) => {
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
            },
            variableManager: variableManager,
            project,
        };

        // Update UI when node status changes
        this._executionEngine.onStatusChange((nodeId, status, message) => {
            this._panel.webview.postMessage({
                type: 'nodeStatusUpdate',
                payload: { nodeId, status, message }
            });
        });

        // Notify webview that execution started
        this._panel.webview.postMessage({ type: 'executionStarted' });

        try {
            outputChannel.appendLine(`Starting ETL Project: ${project.name}`);
            outputChannel.appendLine(`Fallback connection: ${runConnectionName}`);
            outputChannel.appendLine('---');

            const result = await this._executionEngine.execute(getRootExecutionProject(project), context);

            outputChannel.appendLine('---');
            outputChannel.appendLine(`Execution ${result.status}`);
            outputChannel.appendLine(`Duration: ${result.endTime
                ? ((result.endTime.getTime() - result.startTime.getTime()) / 1000).toFixed(2)
                : 'N/A'
                } seconds`);

            // Notify webview that execution ended
            this._panel.webview.postMessage({
                type: 'executionEnded',
                payload: { status: result.status === 'completed' ? 'Completed ✓' : 'Failed ✗' }
            });

            if (result.status === 'completed') {
                vscode.window.showInformationMessage('ETL project completed successfully!');
            } else if (result.status === 'failed') {
                vscode.window.showErrorMessage('ETL project failed. Check output for details.');
            }

        } catch (error) {
            outputChannel.appendLine(`Error: ${error}`);
            vscode.window.showErrorMessage(`ETL execution error: ${error}`);

            // Notify webview that execution ended
            this._panel.webview.postMessage({
                type: 'executionEnded',
                payload: { status: 'Error ✗' }
            });
        } finally {
            this._cancellationTokenSource?.dispose();
            this._cancellationTokenSource = undefined;
        }
    }

    private _stopExecution(): void {
        if (this._cancellationTokenSource) {
            this._cancellationTokenSource.cancel();
            vscode.window.showInformationMessage('ETL execution cancellation requested...');
        }
    }

    private _updateProject(project: EtlProject) {
        this._projectManager.setProject(project);
        this._updateWebview(this._projectManager.getCurrentProject() || project);
    }

    private _updateWebview(project: EtlProject) {
        this._panel.webview.html = this._getHtml(project);
    }

    private _sendProjectUpdate() {
        const project = this._projectManager.getCurrentProject();
        if (project) {
            this._panel.webview.postMessage({
                type: 'projectUpdate',
                payload: project
            });
        }
    }

    private _getHtml(project: EtlProject): string {
        const styleUri = this._assetUri('etlDiagram.css');
        const scriptUri = this._assetUri('etlDiagram.js');
        return generateEtlDesignerHtml({
            project,
            nonce: this._getNonce(),
            styleUri,
            scriptUri,
            cspSource: this._panel.webview.cspSource || "'self'",
        });
    }

    private _assetUri(fileName: string): string {
        const uriApi = vscode.Uri as typeof vscode.Uri & { joinPath?: (base: vscode.Uri, ...pathSegments: string[]) => vscode.Uri };
        const webview = this._panel.webview as vscode.Webview & { asWebviewUri?: (resource: vscode.Uri) => vscode.Uri };
        if (!uriApi.joinPath || !webview.asWebviewUri) {
            return `./dist/media/${fileName}`;
        }
        return webview.asWebviewUri(uriApi.joinPath(this._context.extensionUri, 'dist', 'media', fileName)).toString();
    }

    private _getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose(): void {
        EtlDesignerView.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) {
                d.dispose();
            }
        }
    }
}

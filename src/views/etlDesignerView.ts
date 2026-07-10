/**
 * ETL Designer View
 * Webview panel for visual ETL workflow design
 */

import * as vscode from 'vscode';
import {
    EtlProject,
    EtlNode,
    EtlNodeType,
    EtlConnection,
    ContainerNodeConfig,
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

// Import refactored modules
import { generateEtlDesignerHtml } from './etl/etlDesignerTemplate';
import { NodeConfigurator } from './etl/nodeConfigurator';

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
    }

    private async _handleMessage(message: { type: string; payload?: unknown }) {
        const project = this._projectManager.getCurrentProject();

        switch (message.type) {
            case 'addNode': {
                const payload = message.payload as { type: EtlNodeType; position: { x: number; y: number } };
                const node: EtlNode = {
                    id: generateNodeId(),
                    type: payload.type,
                    name: this._nodeConfigurator.getDefaultNodeName(payload.type),
                    position: payload.position,
                    config: getDefaultConfig(payload.type)
                };
                this._projectManager.addNode(node);
                this._sendProjectUpdate();
                break;
            }

            case 'confirmRemoveNode': {
                const nodeId = message.payload as string;
                const confirm = await vscode.window.showWarningMessage(
                    'Delete this task?',
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

            case 'addConnection': {
                const { from, to } = message.payload as { from: string; to: string };
                try {
                    this._projectManager.addConnection({
                        id: generateConnectionId(),
                        from,
                        to
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
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'configureNode': {
                const nodeId = message.payload as string;
                await this._nodeConfigurator.configureNode(nodeId);
                break;
            }

            case 'updateContainerNodes': {
                const { containerId, nodes, connections } = message.payload as {
                    containerId: string;
                    nodes: EtlNode[];
                    connections: EtlConnection[];
                };
                const containerNode = this._projectManager.getNode(containerId);
                if (containerNode && containerNode.type === 'container') {
                    this._projectManager.updateNode(containerId, {
                        config: {
                            type: 'container',
                            nodes: nodes,
                            connections: connections
                        } as ContainerNodeConfig
                    });
                    this._sendProjectUpdate();
                }
                break;
            }

            case 'configureContainerChildNode': {
                const { containerId: cId, nodeId: childNodeId } = message.payload as { containerId: string; nodeId: string };
                const container = this._projectManager.getNode(cId);
                if (container && container.type === 'container') {
                    const config = container.config as ContainerNodeConfig;
                    const childNode = config.nodes.find(n => n.id === childNodeId);
                    if (childNode) {
                        await this._configureContainerChildNode(cId, childNode);
                    }
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
                break;
            }
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

        const activeConnName = connManager.getActiveConnectionName();

        if (!activeConnName) {
            vscode.window.showErrorMessage('No active connection. Please connect to a database first.');
            return;
        }

        const connDetails = await connManager.getConnection(activeConnName);
        if (!connDetails) {
            vscode.window.showErrorMessage(`Connection not found: ${activeConnName}`);
            return;
        }

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
            onProgress: (message) => {
                outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
            },
            variableManager: variableManager
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
            outputChannel.appendLine(`Connection: ${activeConnName}`);
            outputChannel.appendLine('---');

            const result = await this._executionEngine.execute(project, context);

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
        // Update the project manager with the new project
        this._projectManager.createProject(project.name);
        for (const node of project.nodes) {
            this._projectManager.addNode(node);
        }
        for (const conn of project.connections) {
            try {
                this._projectManager.addConnection(conn);
            } catch {
                // Ignore connection errors during load
            }
        }
        this._updateWebview(project);
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

    /**
     * Configure a child node inside a container
     */
    private async _configureContainerChildNode(containerId: string, childNode: EtlNode): Promise<void> {
        // For child nodes, we use a simplified configuration approach
        // The node configurator works on project-level nodes, so we need a custom handler

        const config = childNode.config;
        let updated = false;

        switch (childNode.type) {
            case 'sql': {
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter task name',
                    value: childNode.name
                });
                if (name === undefined) return;

                const query = await vscode.window.showInputBox({
                    prompt: 'Enter SQL query',
                    value: (config as { query?: string }).query || ''
                });
                if (query !== undefined) {
                    childNode.name = name;
                    (config as { query: string }).query = query;
                    updated = true;
                }
                break;
            }
            case 'python': {
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter task name',
                    value: childNode.name
                });
                if (name === undefined) return;

                const script = await vscode.window.showInputBox({
                    prompt: 'Enter Python script',
                    value: (config as { script?: string }).script || ''
                });
                if (script !== undefined) {
                    childNode.name = name;
                    (config as { script: string }).script = script;
                    updated = true;
                }
                break;
            }
            case 'variable': {
                const name = await vscode.window.showInputBox({
                    prompt: 'Enter task name',
                    value: childNode.name
                });
                if (name === undefined) return;

                const variableName = await vscode.window.showInputBox({
                    prompt: 'Enter variable name',
                    value: (config as { variableName?: string }).variableName || ''
                });
                if (variableName) {
                    childNode.name = name;
                    (config as { variableName: string }).variableName = variableName;
                    updated = true;
                }
                break;
            }
            default:
                vscode.window.showInformationMessage(`Configure ${childNode.type} nodes by double-clicking in the main designer.`);
                return;
        }

        if (updated) {
            // Update the container with the modified child node
            const container = this._projectManager.getNode(containerId);
            if (container && container.type === 'container') {
                const containerConfig = container.config as ContainerNodeConfig;
                const nodeIndex = containerConfig.nodes.findIndex(n => n.id === childNode.id);
                if (nodeIndex >= 0) {
                    containerConfig.nodes[nodeIndex] = childNode;
                    this._projectManager.updateNode(containerId, { config: containerConfig });
                    this._sendProjectUpdate();

                    // Also send update to webview to refresh the modal
                    this._panel.webview.postMessage({
                        type: 'containerChildUpdated',
                        payload: { containerId, childNode }
                    });
                }
            }
        }
    }

    private _getHtml(project: EtlProject): string {
        return generateEtlDesignerHtml({
            project,
            nonce: this._getNonce()
        });
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

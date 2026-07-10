import * as vscode from 'vscode';
import { EtlDesignerView } from '../views/etlDesignerView';
import { EtlProject } from '../etl/etlTypes';
import { EtlProjectManager } from '../etl/etlProjectManager';
import { EtlExecutionEngine } from '../etl/etlExecutionEngine';

jest.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        createWebviewPanel: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showInputBox: jest.fn(),
        showSaveDialog: jest.fn(),
        showOpenDialog: jest.fn(),
        createOutputChannel: jest.fn(() => ({ appendLine: jest.fn(), show: jest.fn() }))
    },
    ViewColumn: { One: 1 },
    Uri: {
        file: jest.fn((fsPath: string) => ({ fsPath }))
    },
    CancellationTokenSource: jest.fn().mockImplementation(() => ({
        token: { isCancellationRequested: false },
        cancel: jest.fn(),
        dispose: jest.fn()
    }))
}));

jest.mock('../etl/etlProjectManager', () => ({
    EtlProjectManager: {
        getInstance: jest.fn()
    }
}));

jest.mock('../etl/etlExecutionEngine', () => ({
    EtlExecutionEngine: jest.fn().mockImplementation(() => ({
        registerExecutor: jest.fn(),
        onStatusChange: jest.fn(),
        execute: jest.fn()
    }))
}));

jest.mock('../etl/tasks/sqlTask', () => ({ SqlTaskExecutor: jest.fn() }));
jest.mock('../etl/tasks/pythonTask', () => ({ PythonTaskExecutor: jest.fn() }));
jest.mock('../etl/tasks/exportTask', () => ({ ExportTaskExecutor: jest.fn() }));
jest.mock('../etl/tasks/importTask', () => ({ ImportTaskExecutor: jest.fn() }));
jest.mock('../etl/tasks/containerTask', () => ({ ContainerTaskExecutor: jest.fn() }));
jest.mock('../etl/tasks/variableTask', () => ({ VariableTaskExecutor: jest.fn() }));
jest.mock('../etl/utils/variableManager', () => ({ VariableManager: jest.fn() }));

jest.mock('../views/etl/nodeConfigurator', () => ({
    NodeConfigurator: jest.fn().mockImplementation(() => ({
        getDefaultNodeName: jest.fn((_type: string) => 'SQL Task'),
        configureNode: jest.fn().mockResolvedValue(undefined)
    }))
}));

jest.mock('../views/etl/etlDesignerTemplate', () => ({
    generateEtlDesignerHtml: jest.fn(() => '<html>etl-designer</html>')
}));

describe('views/etlDesignerView', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let projectManager: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let panel: any;
    let project: EtlProject;

    beforeEach(() => {
        jest.clearAllMocks();
        project = {
            name: 'P',
            version: '1',
            nodes: [],
            connections: []
        };
        projectManager = {
            createProject: jest.fn(() => project),
            getCurrentProject: jest.fn(() => project),
            addNode: jest.fn(),
            removeNode: jest.fn(),
            updateNode: jest.fn(),
            addConnection: jest.fn(),
            removeConnection: jest.fn(),
            getNode: jest.fn(),
            saveProject: jest.fn().mockResolvedValue(undefined),
            loadProject: jest.fn().mockResolvedValue(project),
            getProjectPath: jest.fn(() => undefined),
            validateProject: jest.fn(() => [])
        };
        (EtlProjectManager.getInstance as jest.Mock).mockReturnValue(projectManager);

        panel = {
            webview: {
                html: '',
                postMessage: jest.fn(),
                onDidReceiveMessage: jest.fn()
            },
            onDidDispose: jest.fn(),
            dispose: jest.fn(),
            reveal: jest.fn()
        };
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (EtlDesignerView as any).currentPanel = undefined;
    });

    it('should create panel and process add/remove message actions', async () => {
        EtlDesignerView.createOrShow({ extensionUri: {} as vscode.Uri } as vscode.ExtensionContext, project);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance = (EtlDesignerView as any).currentPanel as any;
        expect(instance).toBeDefined();
        expect(panel.webview.html).toContain('etl-designer');

        await instance._handleMessage({ type: 'addNode', payload: { type: 'sql', position: { x: 1, y: 2 } } });
        await instance._handleMessage({ type: 'removeNode', payload: 'n1' });
        await instance._handleMessage({ type: 'addConnection', payload: { from: 'a', to: 'b' } });
        await instance._handleMessage({ type: 'removeConnection', payload: 'c1' });

        expect(projectManager.addNode).toHaveBeenCalled();
        expect(projectManager.removeNode).toHaveBeenCalledWith('n1');
        expect(projectManager.addConnection).toHaveBeenCalled();
        expect(projectManager.removeConnection).toHaveBeenCalledWith('c1');
    });

    it('should save/load project and create new project from messages', async () => {
        EtlDesignerView.createOrShow({ extensionUri: {} as vscode.Uri } as vscode.ExtensionContext, project);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance = (EtlDesignerView as any).currentPanel as any;
        (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({ fsPath: 'D:\\tmp\\p.etl.json' });
        (vscode.window.showOpenDialog as jest.Mock).mockResolvedValue([{ fsPath: 'D:\\tmp\\p.etl.json' }]);
        (vscode.window.showInputBox as jest.Mock).mockResolvedValue('New P');

        await instance._handleMessage({ type: 'saveProject' });
        await instance._handleMessage({ type: 'loadProject' });
        await instance._handleMessage({ type: 'newProject' });

        expect(projectManager.saveProject).toHaveBeenCalled();
        expect(projectManager.loadProject).toHaveBeenCalled();
        expect(projectManager.createProject).toHaveBeenCalledWith('New P');
    });

    it('should execute runProject flow and stop execution', async () => {
        const engine = new EtlExecutionEngine() as unknown as { execute: jest.Mock };
        engine.execute.mockResolvedValue({
            status: 'completed',
            startTime: new Date(),
            endTime: new Date(),
            nodeResults: new Map()
        });
        (EtlExecutionEngine as unknown as jest.Mock).mockImplementation(() => engine);

        const connManager = {
            getActiveConnectionName: jest.fn(() => 'activeConn'),
            getConnection: jest.fn().mockResolvedValue({ name: 'activeConn' })
        };
        EtlDesignerView.setConnectionManager(connManager as never);

        EtlDesignerView.createOrShow({ extensionUri: {} as vscode.Uri } as vscode.ExtensionContext, project);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance = (EtlDesignerView as any).currentPanel as any;

        await instance._handleMessage({ type: 'runProject' });
        expect(engine.execute).toHaveBeenCalled();
        expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'executionStarted' });
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('ETL project completed successfully!');

        instance._cancellationTokenSource = { cancel: jest.fn() };
        await instance._handleMessage({ type: 'stopProject' });
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('ETL execution cancellation requested...');
    });
});


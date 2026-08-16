/** Message-handler tests for the Data Workspace Manager webview panel. */

import * as vscode from 'vscode';
import { DATA_WORKSPACE_OPTION, DATA_WORKSPACE_VERSION, DataWorkspaceService } from '../../services/dataWorkspaceService';
import type { FileConnectionPanelWebviewToHostMessage } from '../../contracts/webviews/fileConnectionPanelContracts';
import { FileConnectionPanelView } from '../../views/fileConnectionPanelView';

function workspaceProfile(
    name: string,
    sources: unknown[] = [],
): Record<string, unknown> {
    return {
        name,
        host: 'local',
        database: `/tmp/${name.replace(/\W+/g, '_')}.duckdb`,
        user: 'duckdb',
        dbType: 'duckdb',
        options: {
            mode: 'file',
            [DATA_WORKSPACE_OPTION]: JSON.stringify({
                version: DATA_WORKSPACE_VERSION,
                workspaceId: `${name.toLowerCase().replace(/\W+/g, '-')}-12345678`,
                sources,
            }),
        },
    };
}

function createFakePanel() {
    const posted: unknown[] = [];
    let messageHandler: ((message: unknown) => void) | undefined;
    const panel = {
        title: '',
        webview: {
            options: undefined,
            html: '',
            cspSource: 'mock-csp-source',
            asWebviewUri: jest.fn((uri: unknown) => uri),
            onDidReceiveMessage: jest.fn((handler: (message: unknown) => void) => {
                messageHandler = handler;
                return { dispose: jest.fn() };
            }),
            postMessage: jest.fn(async (message: unknown) => {
                posted.push(message);
                return true;
            }),
        },
        onDidDispose: jest.fn(() => ({ dispose: jest.fn() })),
        reveal: jest.fn(),
        dispose: jest.fn(),
    };
    return { panel, posted, getHandler: () => messageHandler };
}

interface MockManager {
    getConnections: jest.Mock;
    getConnection: jest.Mock;
    saveConnection: jest.Mock;
    deleteConnection: jest.Mock;
    setDocumentConnection: jest.Mock;
    onDidChangeConnections: jest.Mock;
    getMetadataCache?: jest.Mock;
}

function createMockManager(initialConnections: Array<Record<string, unknown>> = []): MockManager {
    const connections = initialConnections.map(connection => ({ ...connection }));
    return {
        getConnections: jest.fn(async () => connections.map(connection => ({ ...connection }))),
        getConnection: jest.fn(async (name: string) => {
            const connection = connections.find(entry => entry.name === name);
            return connection ? { ...connection } : undefined;
        }),
        saveConnection: jest.fn(async (details: Record<string, unknown>) => {
            const index = connections.findIndex(entry => entry.name === details.name);
            if (index >= 0) connections[index] = details;
            else connections.push(details);
        }),
        deleteConnection: jest.fn(async (name: string) => {
            const index = connections.findIndex(entry => entry.name === name);
            if (index >= 0) connections.splice(index, 1);
        }),
        setDocumentConnection: jest.fn().mockResolvedValue(undefined),
        onDidChangeConnections: jest.fn(() => ({ dispose: jest.fn() })),
    };
}

const mockedWindow = vscode.window as unknown as {
    createWebviewPanel: jest.Mock;
    activeTextEditor: unknown;
    showTextDocument: jest.Mock;
    showWarningMessage: jest.Mock;
    showQuickPick: jest.Mock;
    showOpenDialog: jest.Mock;
    showInputBox: jest.Mock;
};

const mockedWorkspace = vscode.workspace as unknown as {
    openTextDocument: jest.Mock;
};

async function flush(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 25));
}

async function sendMessage(view: FileConnectionPanelView, message: FileConnectionPanelWebviewToHostMessage): Promise<void> {
    await (view as unknown as {
        handleMessage(message: FileConnectionPanelWebviewToHostMessage): Promise<void>;
    }).handleMessage(message);
    await flush();
}

function stateMessage(posted: unknown[]): { type: 'state'; state: Record<string, unknown> } {
    const message = posted[posted.length - 1] as { type: 'state'; state: Record<string, unknown> };
    expect(message.type).toBe('state');
    return message;
}

describe('FileConnectionPanelView Data Workspace mode', () => {
    let manager: MockManager;

    beforeEach(() => {
        jest.clearAllMocks();
        (FileConnectionPanelView as unknown as { currentPanel?: { dispose(): void } }).currentPanel?.dispose();
        manager = createMockManager();
        mockedWindow.createWebviewPanel.mockReturnValue(createFakePanel().panel);
        mockedWindow.activeTextEditor = undefined;
        mockedWindow.showWarningMessage.mockResolvedValue(undefined);
        mockedWindow.showQuickPick.mockResolvedValue(undefined);
        mockedWindow.showOpenDialog.mockResolvedValue(undefined);
        mockedWindow.showInputBox ??= jest.fn();
        mockedWindow.showInputBox.mockResolvedValue(undefined);
        mockedWorkspace.openTextDocument.mockResolvedValue(undefined);
    });

    function createView(connectionName?: string) {
        const context = {
            extensionUri: vscode.Uri.file('/test'),
            globalStorageUri: vscode.Uri.file('/tmp/data-workspace-panel-test'),
        } as unknown as vscode.ExtensionContext;
        return FileConnectionPanelView.createOrShow(context, manager as unknown as never, { connectionName });
    }

    it('lists only persistent Data Workspaces and leaves legacy profiles hidden', async () => {
        manager = createMockManager([
            { name: 'Legacy File', host: 'local', database: '/data/sales.csv', user: 'file', dbType: 'file' },
            { name: 'Ordinary DuckDB', host: 'local', database: ':memory:', user: 'duckdb', dbType: 'duckdb' },
            workspaceProfile('Reporting'),
        ]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        createView('Reporting');
        await flush();

        const state = stateMessage(fake.posted).state;
        expect(state.connections).toEqual(['Reporting']);
        expect(state.selectedConnectionName).toBe('Reporting');
        expect(state.mode).toBe('dataWorkspace');
        expect(state.workspaceSources).toEqual([]);
    });

    it('opens an empty manager when only legacy File SQL profiles exist', async () => {
        manager = createMockManager([
            { name: 'Legacy File', host: 'local', database: '/data/sales.csv', user: 'file', dbType: 'file' },
        ]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        createView('Legacy File');
        await flush();

        const state = stateMessage(fake.posted).state;
        expect(state.connections).toEqual([]);
        expect(state.selectedConnectionName).toBe('');
        expect(manager.saveConnection).not.toHaveBeenCalled();
    });

    it('adds and materializes a local file through the workspace service', async () => {
        manager = createMockManager([workspaceProfile('Reporting')]);
        mockedWindow.showOpenDialog.mockResolvedValue([vscode.Uri.file('/data/sales.csv')]);
        mockedWindow.showInputBox.mockResolvedValue('sales');
        const addFileSource = jest.spyOn(DataWorkspaceService.prototype, 'addFileSource').mockResolvedValue({
            id: 'source-12345678', kind: 'file', path: '/data/sales.csv', tableName: 'sales', lastRefresh: { status: 'never' },
        });
        const refreshSource = jest.spyOn(DataWorkspaceService.prototype, 'refreshSource').mockResolvedValue({
            status: 'success', rowCount: 2,
        });
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Reporting');
        await flush();

        await sendMessage(view, { type: 'addWorkspaceFile' });

        expect(addFileSource).toHaveBeenCalledWith('Reporting', '/data/sales.csv', 'sales');
        expect(refreshSource).toHaveBeenCalledWith('Reporting', 'source-12345678');
        addFileSource.mockRestore();
        refreshSource.mockRestore();
    });

    it('quotes cached Netezza object names before storing the source reference', async () => {
        manager = createMockManager([workspaceProfile('Reporting'), {
            name: 'Netezza', host: 'nps', database: 'NZ', user: 'admin', dbType: 'netezza',
        }]);
        manager.getMetadataCache = jest.fn(() => ({
            getObjectsWithSchema: jest.fn(() => [{
                schema: 'Mixed Schema',
                item: { objType: 'TABLE', OBJNAME: 'Order Items' },
            }]),
        }));
        mockedWindow.showQuickPick.mockImplementation(async choices => choices[0]);
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Reporting');
        await flush();

        const selected = await (view as unknown as {
            pickNetezzaObject(connectionName: string, sourceKind: 'table' | 'view'): Promise<string | undefined>;
        }).pickNetezzaObject('Netezza', 'table');

        expect(selected).toBe('"Mixed Schema"."Order Items"');
    });

    it('opens SQL bound to the selected Data Workspace', async () => {
        manager = createMockManager([workspaceProfile('Reporting', [{
            id: 'source-12345678', kind: 'file', path: '/data/sales.csv', tableName: 'sales', lastRefresh: { status: 'success' },
        }])]);
        const sqlUri = vscode.Uri.file('/tmp/workspace-query.sql');
        const document = { uri: sqlUri, languageId: 'sql' };
        mockedWorkspace.openTextDocument.mockResolvedValue(document);
        mockedWindow.showTextDocument.mockResolvedValue({ document });
        const fake = createFakePanel();
        mockedWindow.createWebviewPanel.mockReturnValue(fake.panel);
        const view = createView('Reporting');
        await flush();

        await sendMessage(view, { type: 'queryWorkspace' });

        expect(mockedWorkspace.openTextDocument).toHaveBeenCalledWith(expect.objectContaining({
            content: 'SELECT * FROM "sales" LIMIT 100;\n',
        }));
        expect(manager.setDocumentConnection).toHaveBeenCalledWith(sqlUri.toString(), 'Reporting');
    });
});

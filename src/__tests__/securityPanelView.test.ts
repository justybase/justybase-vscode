import * as vscode from 'vscode';

import type { SecurityPanelInboundMessage } from '../contracts/webviews';
import { ConnectionManager } from '../core/connectionManager';
import { SecurityPanelView } from '../views/securityPanelView';

jest.mock('../core/queryRunner', () => ({
    runQueryRaw: jest.fn(),
    queryResultToRows: jest.fn(() => [
        { NAME: 'ALICE', TYPE: 'USER' },
        { NAME: 'ANALYSTS', TYPE: 'GROUP' }
    ])
}));

jest.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        createWebviewPanel: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn()
    },
    Uri: {
        joinPath: jest.fn((...parts: Array<{ fsPath?: string } | string>) => ({
            fsPath: parts.map(part => (typeof part === 'string' ? part : part.fsPath ?? '')).join('/')
        }))
    },
    ViewColumn: { One: 1, Beside: 2 }
}));

import { queryResultToRows, runQueryRaw } from '../core/queryRunner';

function createPanelMock() {
    let receiveMessageHandler: ((message: SecurityPanelInboundMessage) => Promise<void>) | undefined;
    const webview = {
        cspSource: 'vscode-resource:',
        html: '',
        postMessage: jest.fn().mockResolvedValue(true),
        asWebviewUri: jest.fn((uri: { fsPath?: string }) => `webview:${uri.fsPath ?? ''}`),
        onDidReceiveMessage: jest.fn((handler: (message: SecurityPanelInboundMessage) => Promise<void>) => {
            receiveMessageHandler = handler;
            return { dispose: jest.fn() };
        })
    };

    const panel = {
        webview,
        title: '',
        reveal: jest.fn(),
        onDidDispose: jest.fn((_handler: () => void, _ctx?: unknown, disposables?: { dispose: () => void }[]) => {
            if (disposables) {
                disposables.push({ dispose: jest.fn() });
            }
            return { dispose: jest.fn() };
        }),
        dispose: jest.fn()
    };

    return { panel, webview, getReceiveMessageHandler: () => receiveMessageHandler };
}

describe('views/securityPanelView', () => {
    const mockContext = {
        extensionUri: { fsPath: '/test-extension' }
    } as unknown as vscode.ExtensionContext;
    const mockConnectionManager = {} as ConnectionManager;

    beforeEach(() => {
        jest.clearAllMocks();
        (SecurityPanelView as unknown as { currentPanel?: SecurityPanelView }).currentPanel = undefined;
        (runQueryRaw as jest.Mock).mockResolvedValue({ data: [[1]] });
        (queryResultToRows as jest.Mock).mockReturnValue([
            { NAME: 'ALICE', TYPE: 'USER' },
            { NAME: 'ANALYSTS', TYPE: 'GROUP' }
        ]);
    });

    it('loads principals on create and posts typed loading/data states', async () => {
        const { panel, webview } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        SecurityPanelView.createOrShow(mockContext.extensionUri, mockContext, mockConnectionManager);
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(runQueryRaw).toHaveBeenCalled();
        expect(webview.postMessage).toHaveBeenCalledWith({ command: 'setLoading', loading: true });
        expect(webview.postMessage).toHaveBeenCalledWith({
            command: 'setData',
            data: {
                principals: [
                    { NAME: 'ALICE', TYPE: 'USER' },
                    { NAME: 'ANALYSTS', TYPE: 'GROUP' }
                ]
            }
        });
        expect(webview.postMessage).toHaveBeenCalledWith({ command: 'setLoading', loading: false });
    });

    it('previews SQL for a valid object grant payload', async () => {
        const { panel, webview, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        SecurityPanelView.createOrShow(mockContext.extensionUri, mockContext, mockConnectionManager);
        await new Promise(resolve => setTimeout(resolve, 0));

        const handler = getReceiveMessageHandler();
        expect(handler).toBeDefined();

        await handler!({
            command: 'previewSql',
            payload: {
                action: 'GRANT',
                grantVariant: 'object',
                objectPrivileges: 'SELECT',
                objectTarget: 'TABLE sales',
                principalType: 'USER',
                principal: 'analyst'
            }
        });

        expect(webview.postMessage).toHaveBeenCalledWith({
            command: 'previewSql',
            sql: 'GRANT SELECT ON TABLE sales TO ANALYST;'
        });
    });

    it('reports an error for invalid preview requests', async () => {
        const { panel, webview, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        SecurityPanelView.createOrShow(mockContext.extensionUri, mockContext, mockConnectionManager);
        await new Promise(resolve => setTimeout(resolve, 0));

        const handler = getReceiveMessageHandler();
        await handler!({ command: 'previewSql', payload: { action: 'GRANT' } });

        expect(webview.postMessage).toHaveBeenCalledWith({
            command: 'error',
            text: 'Invalid permission request. Use valid Netezza identifiers and fields.'
        });
    });

    it('executes SQL for a valid payload and reports completion', async () => {
        const { panel, webview, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);

        SecurityPanelView.createOrShow(mockContext.extensionUri, mockContext, mockConnectionManager);
        await new Promise(resolve => setTimeout(resolve, 0));

        const handler = getReceiveMessageHandler();
        await handler!({
            command: 'executeSql',
            payload: {
                action: 'REVOKE',
                grantVariant: 'admin',
                adminPrivileges: 'CREATE TABLE',
                adminScope: 'MYDB.ALL',
                principalType: 'GROUP',
                principal: 'analysts'
            }
        });

        expect(runQueryRaw).toHaveBeenCalledWith(
            mockContext,
            'REVOKE CREATE TABLE IN MYDB.ALL FROM GROUP ANALYSTS;',
            true,
            mockConnectionManager,
            undefined
        );
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Security command executed successfully.');
        expect(webview.postMessage).toHaveBeenCalledWith({
            command: 'executed',
            sql: 'REVOKE CREATE TABLE IN MYDB.ALL FROM GROUP ANALYSTS;'
        });
    });
});
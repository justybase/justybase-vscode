import * as vscode from 'vscode';
import { ResultView } from '../views/resultView';

jest.mock('vscode', () => ({
    window: {
        createWebviewPanel: jest.fn(),
        showErrorMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showSaveDialog: jest.fn()
    },
    workspace: {
        fs: { writeFile: jest.fn() }
    },
    env: {
        clipboard: { writeText: jest.fn() }
    },
    Uri: {
        joinPath: jest.fn((...parts: unknown[]) => ({ path: parts.map(p => String(p)).join('/') }))
    },
    ViewColumn: { Two: 2 }
}));

function createPanelMock() {
    let receiveMessageHandler: ((message: { command: string; data?: string; text?: string }) => void) | undefined;
    const webview = {
        cspSource: 'vscode-resource:',
        html: '',
        asWebviewUri: jest.fn((uri: { path?: string }) => `webview:${uri.path ?? ''}`),
        onDidReceiveMessage: jest.fn(
            (handler: (message: { command: string; data?: string; text?: string }) => void) => {
                receiveMessageHandler = handler;
                return { dispose: jest.fn() };
            }
        )
    };
    const panel = {
        webview,
        reveal: jest.fn(),
        onDidDispose: jest.fn((_handler: () => void, _ctx?: unknown, disposables?: { dispose: () => void }[]) => {
            if (disposables) disposables.push({ dispose: jest.fn() });
            return { dispose: jest.fn() };
        }),
        dispose: jest.fn()
    };
    return { panel, getReceiveMessageHandler: () => receiveMessageHandler };
}

describe('views/resultView', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ResultView as any).currentPanel = undefined;
    });

    it('should create and then reuse panel for subsequent calls', () => {
        const first = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(first.panel);

        ResultView.createOrShow({} as vscode.Uri, [{ id: 1, name: 'A' }]);
        expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
        expect(first.panel.webview.html).toContain('initializeResultView');
        expect(first.panel.webview.html).toContain('"id"');

        ResultView.createOrShow({} as vscode.Uri, [{ id: 2, name: 'B' }]);
        expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
        expect(first.panel.reveal).toHaveBeenCalled();
    });

    it('should export csv and copy to clipboard via webview messages', async () => {
        const { panel, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        (vscode.window.showSaveDialog as jest.Mock).mockResolvedValue({ fsPath: 'D:\\out\\results.csv' });
        (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
        (vscode.env.clipboard.writeText as jest.Mock).mockResolvedValue(undefined);

        ResultView.createOrShow({} as vscode.Uri, [{ col: 'v' }]);
        const handler = getReceiveMessageHandler();
        expect(handler).toBeDefined();

        await handler!({ command: 'exportCsv', data: 'a,b\n1,2' });
        await handler!({ command: 'copyToClipboard', text: 'copied' });
        handler!({ command: 'info', text: 'done' });
        handler!({ command: 'error', text: 'err' });

        expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('copied');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('done');
        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('err');
    });

    it('should report clipboard copy errors', async () => {
        const { panel, getReceiveMessageHandler } = createPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        (vscode.env.clipboard.writeText as jest.Mock).mockRejectedValue(new Error('clipboard fail'));

        ResultView.createOrShow({} as vscode.Uri, []);
        const handler = getReceiveMessageHandler();
        await handler!({ command: 'copyToClipboard', text: 'x' });

        expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to copy to clipboard'));
    });
});


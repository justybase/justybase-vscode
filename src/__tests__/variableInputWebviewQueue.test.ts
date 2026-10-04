import * as vscode from 'vscode';
import { VariableInputWebviewPanel } from '../views/variableInputWebviewPanel';

describe('queued variable input lifecycle', () => {
    it('serializes concurrent dialogs and aborts removed requests without replacing other values', async () => {
        const created: Array<{ dispose: jest.Mock; message: (input: { command: string; values?: Record<string, string> }) => void }> = [];
        let opened!: () => void;
        let nextOpened = new Promise<void>(resolve => { opened = resolve; });
        (vscode.window.createWebviewPanel as jest.Mock).mockImplementation(() => {
            let disposed = false;
            let onDispose: () => void = () => undefined;
            const entry = { dispose: jest.fn(() => { if (!disposed) { disposed = true; onDispose(); } }), message: (_message: { command: string; values?: Record<string, string> }) => undefined };
            created.push(entry);
            const panel = {
                dispose: entry.dispose,
                webview: { html: '', asWebviewUri: () => 'style', cspSource: 'test',
                    onDidReceiveMessage: (callback: typeof entry.message) => { entry.message = callback; return { dispose: jest.fn() }; } },
                onDidDispose: (callback: () => void) => { onDispose = callback; return { dispose: jest.fn() }; },
            };
            opened();
            return panel;
        });
        const context = { extensionUri: vscode.Uri.file('/workspace'), globalState: {
            get: () => ({}), update: jest.fn(async () => undefined),
        } } as unknown as vscode.ExtensionContext;
        const first = VariableInputWebviewPanel.show(['A'], {}, context);
        await nextOpened;
        const abort = new AbortController();
        const second = VariableInputWebviewPanel.show(['B'], {}, context, abort.signal);
        expect(created).toHaveLength(1);
        expect(created[0].dispose).not.toHaveBeenCalled();
        nextOpened = new Promise<void>(resolve => { opened = resolve; });
        created[0].message({ command: 'submit', values: { A: '42' } });
        expect(await first).toEqual({ A: '42' });
        await nextOpened;
        expect(created).toHaveLength(2);
        abort.abort();
        expect(await second).toBeUndefined();
        expect(created[1].dispose).toHaveBeenCalledTimes(1);
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        expect(await VariableInputWebviewPanel.show(['C'], {}, context, alreadyAborted.signal)).toBeUndefined();
        expect(created).toHaveLength(2);
    });
});

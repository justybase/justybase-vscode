import * as vscode from 'vscode';
import { showCopilotPromptPreview, getCopilotPromptPreviewHtml } from '../services/copilotPromptPreview';

interface FakeWebviewPanel {
    webview: {
        cspSource: string;
        html: string;
        onDidReceiveMessage: jest.Mock;
    };
    onDidDispose: jest.Mock;
    reveal: jest.Mock;
    dispose: jest.Mock;
    postMessageToWebview: (message: unknown) => void;
}

const createdPanels: FakeWebviewPanel[] = [];

jest.mock('vscode', () => ({
    ViewColumn: { Beside: 3 },
    window: {
        createWebviewPanel: jest.fn(),
    },
}), { virtual: true });

function installFakePanel(): FakeWebviewPanel {
    let messageHandler: ((message: unknown) => void) | undefined;
    let disposeHandler: (() => void) | undefined;
    const panel: FakeWebviewPanel = {
        webview: {
            cspSource: 'vscode-resource://preview',
            html: '',
            onDidReceiveMessage: jest.fn((handler: (message: unknown) => void) => {
                messageHandler = handler;
                return { dispose: jest.fn() };
            }),
        },
        onDidDispose: jest.fn((handler: () => void) => {
            disposeHandler = handler;
            return { dispose: jest.fn() };
        }),
        reveal: jest.fn(),
        dispose: jest.fn(() => {
            disposeHandler?.();
        }),
        postMessageToWebview: (message: unknown) => {
            messageHandler?.(message);
        },
    };
    createdPanels.push(panel);
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValueOnce(panel);
    return panel;
}

function previewOptions() {
    return {
        operation: 'Discuss SQL error with Copilot',
        prompt: 'SELECT 1',
        items: ['Executed SQL (8 characters)'],
    };
}

describe('Copilot prompt preview', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        createdPanels.length = 0;
    });

    it('renders a copy-only preview and escapes markup', () => {
        const prompt = '**Error**\nSELECT * FROM users;\n<script>alert(1)</script>';
        const html = getCopilotPromptPreviewHtml({
            operation: 'Discuss SQL error with Copilot',
            prompt,
            items: ['Error message (12 characters)', 'Executed SQL (24 characters)'],
        }, 'test-nonce', 'vscode-resource://preview');

        expect(html).toContain('Discuss SQL error with Copilot');
        expect(html).toContain('SELECT * FROM users;');
        expect(html).toContain('Error message (12 characters)');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('Copy prompt');
        expect(html).not.toContain('Send to Copilot');
        expect(html).toContain('JustyBase does not send this prompt anywhere');
        expect(html).toContain("script-src 'nonce-test-nonce'");
    });

    it('reports copied only after the user copies the prompt', async () => {
        const panel = installFakePanel();
        const pending = showCopilotPromptPreview(previewOptions());

        expect(panel.webview.html).toContain('SELECT 1');
        panel.postMessageToWebview({ type: 'copied' });

        await expect(pending).resolves.toBe('copied');
        expect(panel.dispose).toHaveBeenCalled();
    });

    it('reports closed when the user closes the preview', async () => {
        const panel = installFakePanel();
        const pending = showCopilotPromptPreview(previewOptions());

        panel.postMessageToWebview({ type: 'close' });

        await expect(pending).resolves.toBe('closed');
        expect(panel.dispose).toHaveBeenCalled();
    });

    it('treats disposing the panel as closed', async () => {
        const panel = installFakePanel();
        const pending = showCopilotPromptPreview(previewOptions());

        panel.dispose();

        await expect(pending).resolves.toBe('closed');
    });

    it('closes the previous preview when a new one opens', async () => {
        const firstPanel = installFakePanel();
        const first = showCopilotPromptPreview(previewOptions());
        const secondPanel = installFakePanel();
        const second = showCopilotPromptPreview(previewOptions());

        await expect(first).resolves.toBe('closed');
        expect(firstPanel.dispose).toHaveBeenCalled();

        secondPanel.postMessageToWebview({ type: 'close' });
        await expect(second).resolves.toBe('closed');
    });
});

jest.mock('vscode');

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SettingsView } from '../views/settingsView';

describe('SettingsView webview shell', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses external media assets and a nonce-protected CSP', () => {
        const WebviewPanelMock = (vscode as unknown as {
            WebviewPanel: new () => vscode.WebviewPanel;
        }).WebviewPanel;
        const panel = new WebviewPanelMock();
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        const context = {
            extensionUri: vscode.Uri.file('/extension'),
            extensionPath: '/extension'
        } as vscode.ExtensionContext;

        SettingsView.createOrShow(context.extensionUri, context);

        expect(panel.webview.html).toContain('media/settingsView.css');
        expect(panel.webview.html).toContain('media/settingsView.js');
        expect(panel.webview.html).toContain("id=\"settingsConfig\"");
        expect(panel.webview.html).toMatch(/script-src mock-csp-source 'nonce-[A-Za-z0-9]+'/);
        expect(panel.webview.html).not.toContain('<style>');
        expect(panel.webview.html).toContain('src="webview-uri:///extension/media/settingsView.js"');
    });

    it('styles text settings with theme-aware input colors', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../media/settingsView.css'), 'utf8');

        expect(css).toMatch(/\.text-input\s*\{[\s\S]*background:\s*var\(--bg-input\)/);
        expect(css).toMatch(/\.text-input\s*\{[\s\S]*color:\s*var\(--fg\)/);
    });
});

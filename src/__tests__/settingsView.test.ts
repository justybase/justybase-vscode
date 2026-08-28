jest.mock('vscode');

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SettingsView, validateJsonSettingValue } from '../views/settingsView';

describe('SettingsView webview shell', () => {
    beforeEach(() => {
        (SettingsView as unknown as { currentPanel?: { dispose(): void } }).currentPanel?.dispose();
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
        expect(panel.webview.html).toContain('"id":"mcp-connection-name"');
        expect(panel.webview.html).toContain('"type":"select"');

        const settingsScript = fs.readFileSync(path.join(__dirname, '../../media/settingsView.js'), 'utf8');
        expect(settingsScript).toContain("'mcp': '<svg");
        expect(settingsScript).toContain('function renderMcpStatus()');
    });

    it('styles text settings with theme-aware input colors', () => {
        const css = fs.readFileSync(path.join(__dirname, '../../media/settingsView.css'), 'utf8');

        expect(css).toMatch(/\.text-input\s*\{[\s\S]*background:\s*var\(--bg-input\)/);
        expect(css).toMatch(/\.text-input\s*\{[\s\S]*color:\s*var\(--fg\)/);
    });

    it('keeps the custom settings registry in parity with the extension manifest', () => {
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

        const configMatch = panel.webview.html.match(
            /<script id="settingsConfig" type="application\/json">([\s\S]*?)<\/script>/
        );
        expect(configMatch).not.toBeNull();
        const config = JSON.parse(configMatch?.[1] ?? '{}') as {
            sections: { id: string; settings: { configKey?: string }[] }[];
        };
        expect(config.sections.length).toBeGreaterThan(0);
        expect(config.sections.every(section => section.settings.length > 0)).toBe(true);

        const configuredKeys = new Set(
            config.sections.flatMap(section =>
                section.settings
                    .map(setting => setting.configKey)
                    .filter((key): key is string => Boolean(key))
            )
        );
        const manifestKeys = Object.keys(
            (require('../../package.json') as {
                contributes: { configuration: { properties: Record<string, unknown> } };
            }).contributes.configuration.properties
        ).map(key => key.replace(/^justybase\./, ''));
        expect(configuredKeys).toEqual(new Set(manifestKeys));
    });

    it('validates JSON-backed setting values before configuration updates', () => {
        expect(() => validateJsonSettingValue(['--flag', 'value'], 'array')).not.toThrow();
        expect(() => validateJsonSettingValue({ NZ001: 'warning' }, 'severityMap')).not.toThrow();
        expect(() => validateJsonSettingValue(['--flag', 42], 'array')).toThrow(/array of strings/);
        expect(() => validateJsonSettingValue({ NZ001: 'verbose' }, 'severityMap')).toThrow(/error, warning/);
        expect(() => validateJsonSettingValue([], 'severityMap')).toThrow(/JSON object/);
    });
});

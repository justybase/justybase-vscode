import * as vscode from 'vscode';
import { MetadataRefreshDetailsPanel } from '../services/metadataRefreshDetailsPanel';
import type { MetadataPrefetchRefreshDetails } from '../metadata/prefetch';

jest.mock('vscode');

describe('MetadataRefreshDetailsPanel', () => {
    it('opens a live panel and publishes executed, running and planned SQL state', () => {
        const postMessage = jest.fn();
        const onDidReceiveMessage = jest.fn();
        const panel = {
            webview: { html: '', postMessage, onDidReceiveMessage },
            reveal: jest.fn(),
            onDidDispose: jest.fn(),
            dispose: jest.fn(),
        } as unknown as vscode.WebviewPanel;
        (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
        const details: MetadataPrefetchRefreshDetails = {
            connectionName: 'NZ',
            refreshId: 'NZ:1:1',
            stage: 'columns',
            percent: 80,
            message: 'Fetching columns',
            startedAt: 1,
            updatedAt: 2,
            longestSqlDurationMs: 0,
            queries: [
                {
                    id: 'q1', state: 'completed', sql: 'SELECT DATABASE FROM _V_DATABASE',
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'databases' }, queuedAt: 1,
                },
                {
                    id: 'q2', state: 'running', sql: 'SELECT * FROM JUST_DATA.._V_OBJECT_DATA',
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'objects', database: 'JUST_DATA' }, queuedAt: 2,
                },
                {
                    id: 'q3', state: 'planned', sql: 'SELECT * FROM JUST_DATA.._V_RELATION_COLUMN',
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'columns', database: 'JUST_DATA' }, queuedAt: 3,
                },
            ],
        };
        const repeatFullRefresh = jest.fn();
        const detailsPanel = new MetadataRefreshDetailsPanel(repeatFullRefresh);

        detailsPanel.update([details]);
        detailsPanel.show();

        expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
            'netezza.metadataRefreshDetails',
            'Schema Refresh Details',
            expect.objectContaining({ viewColumn: vscode.ViewColumn.Beside }),
            expect.objectContaining({ enableScripts: true }),
        );
        expect(panel.webview.html).toContain('Schema refresh diagnostics');
        expect(panel.webview.html).toContain('status-filter');
        expect(panel.webview.html).toContain('duration-desc');
        expect(panel.webview.html).toContain('Longest single SQL');
        expect(panel.webview.html).toContain('slowQueryThresholdMs = 5000');
        expect(panel.webview.html).toContain('Copy SQL');
        expect(panel.webview.html).toContain('Repeat full metadata refresh');
        expect(postMessage).toHaveBeenCalledWith({ type: 'refresh-state', details: [details] });
        expect(panel.reveal).toHaveBeenCalledWith(vscode.ViewColumn.Beside, true);

        const receiveMessage = onDidReceiveMessage.mock.calls[0]?.[0] as ((message: unknown) => void) | undefined;
        receiveMessage?.({ type: 'repeat-full-refresh', connectionName: 'NZ' });
        expect(repeatFullRefresh).toHaveBeenCalledWith('NZ');
    });
});

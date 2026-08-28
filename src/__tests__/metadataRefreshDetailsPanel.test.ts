import * as vscode from 'vscode';
import { createContext, Script } from 'node:vm';
import { getMetadataRefreshDetailsHtml, MetadataRefreshDetailsPanel } from '../services/metadataRefreshDetailsPanel';
import type { MetadataPrefetchRefreshDetails } from '../metadata/prefetch';

jest.mock('vscode');

describe('MetadataRefreshDetailsPanel', () => {
    it('renders degraded snapshots as complete with warnings', () => {
        const html = getMetadataRefreshDetailsHtml();
        expect(html).toContain('Snapshot complete with warnings');
        expect(html).toContain('unavailableColumnCount');
        expect(html).toContain('removedStaleObjectCount');
    });

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
            revision: 1,
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

    it('uses driver execution timing and ignores stale refresh snapshots', () => {
        const html = getMetadataRefreshDetailsHtml();
        const scriptSource = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
        expect(scriptSource).toBeDefined();

        const elements = new Map<string, { value: string; innerHTML: string; addEventListener: jest.Mock }>([
            ['content', { value: '', innerHTML: '', addEventListener: jest.fn() }],
            ['status-filter', { value: 'all', innerHTML: '', addEventListener: jest.fn() }],
            ['sort-order', { value: 'duration-desc', innerHTML: '', addEventListener: jest.fn() }],
        ]);
        let messageListener: ((event: { data?: unknown }) => void) | undefined;
        let now = 36_700;
        const TestDate = class extends Date {
            static now(): number {
                return now;
            }
        };
        const context = createContext({
            Date: TestDate,
            Element: class {},
            acquireVsCodeApi: () => ({ postMessage: jest.fn() }),
            document: {
                getElementById: (id: string) => elements.get(id),
                addEventListener: jest.fn(),
                body: {},
            },
            navigator: {},
            setInterval: jest.fn(),
            setTimeout: jest.fn(),
            window: {
                addEventListener: (_type: string, listener: (event: { data?: unknown }) => void) => {
                    messageListener = listener;
                },
            },
        });
        new Script(scriptSource!).runInContext(context);

        const refresh = {
            connectionName: 'NZ',
            refreshId: 'NZ:1:1',
            stage: 'complete',
            percent: 100,
            message: 'Metadata refresh complete',
            startedAt: 1_000,
            completedAt: 36_700,
            updatedAt: 36_700,
            revision: 2,
            longestSqlDurationMs: 10_600,
            longestSqlQueryId: 'slow',
            queries: [
                {
                    id: 'slow', state: 'completed', sql: 'SELECT slow', startedAt: 1_000, completedAt: 11_600,
                    executionDurationMs: 10_600, queuedAt: 1_000,
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'columns' },
                },
                {
                    id: 'fast', state: 'completed', sql: 'SELECT fast', startedAt: 12_000, completedAt: 14_200,
                    executionDurationMs: 2_200, queuedAt: 12_000,
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'objects' },
                },
            ],
        };
        messageListener?.({ data: { type: 'refresh-state', details: [refresh] } });

        // A delayed pre-completion message must not turn a completed query into
        // a long-running one or inflate the aggregate after the refresh froze.
        now = 900_000;
        messageListener?.({
            data: {
                type: 'refresh-state',
                details: [{
                    ...refresh,
                    stage: 'columns',
                    percent: 80,
                    completedAt: undefined,
                    updatedAt: 20_000,
                    revision: 1,
                    queries: refresh.queries.map(query => query.id === 'slow'
                        ? { ...query, state: 'running', executionDurationMs: undefined, completedAt: undefined }
                        : query),
                }],
            },
        });

        const rendered = elements.get('content')!.innerHTML;
        const slowPosition = rendered.indexOf('SELECT slow');
        const fastPosition = rendered.indexOf('SELECT fast');
        expect(slowPosition).toBeGreaterThanOrEqual(0);
        expect(slowPosition).toBeLessThan(fastPosition);
        expect(rendered.slice(rendered.lastIndexOf('<article', slowPosition), rendered.indexOf('</article>', slowPosition)))
            .toContain('10.6 s');
        expect(rendered).toContain('Longest single SQL');
        expect(rendered).toContain('35.7 s');
        expect(rendered).not.toContain('899.0 s');
    });
});

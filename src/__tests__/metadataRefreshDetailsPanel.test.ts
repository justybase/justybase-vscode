import * as vscode from 'vscode';
import { createContext, Script } from 'node:vm';
import { getMetadataRefreshDetailsHtml, MetadataRefreshDetailsPanel } from '../services/metadataRefreshDetailsPanel';
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

    it('keeps the first duration-sorted SQL equal to the global longest-SQL statistic', () => {
        const html = getMetadataRefreshDetailsHtml();
        const scriptSource = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
        expect(scriptSource).toBeDefined();

        const elements = new Map<string, { value: string; innerHTML: string; addEventListener: jest.Mock }>([
            ['content', { value: '', innerHTML: '', addEventListener: jest.fn() }],
            ['status-filter', { value: 'all', innerHTML: '', addEventListener: jest.fn() }],
            ['sort-order', { value: 'duration-desc', innerHTML: '', addEventListener: jest.fn() }],
        ]);
        let messageListener: ((event: { data?: unknown }) => void) | undefined;
        let now = 3_850;
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
            stage: 'columns',
            percent: 80,
            message: 'Fetching columns',
            startedAt: 1_000,
            updatedAt: 3_850,
            longestSqlDurationMs: 2_850,
            longestSqlQueryId: 'slow',
            queries: [
                {
                    id: 'slow', state: 'running', sql: 'SELECT slow', startedAt: 1_000, queuedAt: 1_000,
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'columns' },
                },
                {
                    id: 'fast', state: 'completed', sql: 'SELECT fast', startedAt: 1_000, completedAt: 2_710, queuedAt: 1_000,
                    context: { connectionName: 'NZ', source: 'connection-prefetch', kind: 'columns' },
                },
            ],
        };
        messageListener?.({ data: { type: 'refresh-state', details: [refresh] } });

        // The next lifecycle snapshot reports a smaller terminal duration for
        // the same query. The panel must retain the larger sampled value.
        now = 5_000;
        messageListener?.({
            data: {
                type: 'refresh-state',
                details: [{
                    ...refresh,
                    updatedAt: now,
                    longestSqlDurationMs: 2_850,
                    queries: refresh.queries.map(query => query.id === 'slow'
                        ? { ...query, state: 'completed', completedAt: 2_710 }
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
            .toContain('2.85 s');
        expect(rendered).toContain('Longest single SQL');
        expect(rendered).toContain('2.85 s');
    });
});

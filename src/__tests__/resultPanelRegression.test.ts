import * as vscode from 'vscode';
import { runExtensionHostFilterPerformance } from '../activation/resultPanelFilterPerformance';
import { buildReport, registerResultPanelRegressionCommand } from '../activation/resultPanelRegression';

jest.mock('vscode');
jest.mock('../activation/resultPanelFilterPerformance', () => ({
    runExtensionHostFilterPerformance: jest.fn(),
}));

describe('result panel regression command registration', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTraceEnv = process.env.JUSTYBASE_RESULT_PANEL_TRACE;

    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        process.env.JUSTYBASE_RESULT_PANEL_TRACE = '1';
        (vscode.commands.registerCommand as jest.Mock).mockReset().mockReturnValue({ dispose: jest.fn() });
    });

    afterEach(() => {
        if (previousNodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = previousNodeEnv;
        }
        if (previousTraceEnv === undefined) {
            delete process.env.JUSTYBASE_RESULT_PANEL_TRACE;
        } else {
            process.env.JUSTYBASE_RESULT_PANEL_TRACE = previousTraceEnv;
        }
    });

    it('registers the traced Extension Host commands and disposes them', async () => {
        const runRegressionScenario = jest.fn().mockResolvedValue({ status: 'passed' });
        const resultPanelProvider = {
            runResultPanelRegressionScenario: runRegressionScenario,
            beginColdResultPanelRegressionScenario: jest.fn(),
        } as never;
        const connectionManager = {} as never;
        const context = { subscriptions: [] } as never;

        const disposable = registerResultPanelRegressionCommand(resultPanelProvider, connectionManager, context);

        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'justybase.test.extensionHostFilterPerformance',
            expect.any(Function),
        );
        const registrations = (vscode.commands.registerCommand as jest.Mock).mock.calls;
        const regressionHandler = registrations.find(call => call[0] === 'justybase.test.resultPanelRegression')?.[1] as () => Promise<unknown>;
        await expect(regressionHandler()).resolves.toEqual({ status: 'passed' });
        expect(runRegressionScenario).toHaveBeenCalledWith(undefined);

        const performanceHandler = registrations.find(call => call[0] === 'justybase.test.extensionHostFilterPerformance')?.[1] as (args?: unknown) => Promise<unknown>;
        const performanceReport = { status: 'passed' };
        (runExtensionHostFilterPerformance as jest.Mock).mockResolvedValue(performanceReport);
        await expect(performanceHandler({ tableName: 'fixture' })).resolves.toBe(performanceReport);
        await expect(performanceHandler()).resolves.toBe(performanceReport);
        expect(runExtensionHostFilterPerformance).toHaveBeenCalledWith(
            context,
            resultPanelProvider,
            connectionManager,
            { tableName: 'fixture' },
        );

        process.env.JUSTYBASE_RESULT_PANEL_TRACE = '0';
        expect(() => performanceHandler()).toThrow(/requires result-panel tracing/);

        disposable?.dispose();
        expect((vscode.commands.registerCommand as jest.Mock).mock.results[0]?.value.dispose).toHaveBeenCalled();
    });

    it('includes runtime diagnostics in the scenario report', () => {
        const provider = {
            getResultPanelTraceSnapshot: () => [],
            getResultsForSource: () => [{ isLog: false, data: [[1], [2]] }],
            getResultPanelTestBridgePendingRequestCount: () => 3,
            getResultPanelRuntimeDiagnostics: () => ({
                activeCommandCount: 1,
                executingSourceCount: 2,
                streamingResultCount: 3,
                streamingTransportCount: 4,
                pendingResultSyncCount: 5,
            }),
        } as never;

        expect(buildReport(provider, 'sqlite', 'file:///fixture.sql', Date.now(), 'passed', true, {
            resultSetIndex: 1,
            requestedRowIndex: 75,
            requestedScrollLeft: 320,
            scrolled: { scrollTop: 2250, scrollLeft: 320, anchorRow: 75 },
            restoredFromLogs: { scrollTop: 2250, scrollLeft: 320, anchorRow: 75 },
            restoredFromSource: { scrollTop: 2250, scrollLeft: 320, anchorRow: 75 },
        })).toEqual(expect.objectContaining({
            resultSetCount: 1,
            rowCounts: [2],
            pendingRequestCount: 3,
            activeCommandCount: 1,
            executingSourceCount: 2,
            streamingResultCount: 3,
            streamingTransportCount: 4,
            pendingResultSyncCount: 5,
            viewportContract: expect.objectContaining({ requestedRowIndex: 75 }),
        }));
    });

    it('writes a sanitized trace artifact without SQL, rows, or raw errors', () => {
        const fs = require('node:fs') as typeof import('node:fs');
        const os = require('node:os') as typeof import('node:os');
        const path = require('node:path') as typeof import('node:path');
        const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justybase-trace-'));
        const tracePath = path.join(traceDir, 'trace.json');
        process.env.JUSTYBASE_EXTENSION_HOST_TRACE_PATH = tracePath;

        try {
            const provider = {
                getResultPanelTraceSnapshot: () => [{
                    seq: 1,
                    at: 1,
                    origin: 'webview',
                    phase: 'hydrate_applied',
                    sourceUri: 'file:///secret/fixture.sql',
                    error: 'syntax error near secret_col',
                    sql: 'SELECT secret_col FROM secret_table',
                    rows: [[1, 'secret']],
                }],
                getResultsForSource: () => [],
                getResultPanelTestBridgePendingRequestCount: () => 0,
                getResultPanelRuntimeDiagnostics: () => ({
                    activeCommandCount: 0,
                    executingSourceCount: 0,
                    streamingResultCount: 0,
                    streamingTransportCount: 0,
                    pendingResultSyncCount: 0,
                }),
            } as never;

            buildReport(provider, 'sqlite', 'file:///fixture.sql', Date.now(), 'passed', true);

            const written = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as Array<Record<string, unknown>>;
            expect(written).toHaveLength(1);
            expect(written[0].error).toBeUndefined();
            expect(written[0].sql).toBeUndefined();
            expect(written[0].rows).toBeUndefined();
            expect(written[0].sourceUri).toMatch(/^sha256:[0-9a-f]{64}$/u);
            expect(JSON.stringify(written)).not.toContain('secret');
        } finally {
            delete process.env.JUSTYBASE_EXTENSION_HOST_TRACE_PATH;
            fs.rmSync(traceDir, { recursive: true, force: true });
        }
    });

    it('does not register commands outside test sessions', () => {
        process.env.NODE_ENV = 'production';

        expect(registerResultPanelRegressionCommand({} as never, {} as never)).toBeUndefined();
        expect(vscode.commands.registerCommand).not.toHaveBeenCalled();
    });
});

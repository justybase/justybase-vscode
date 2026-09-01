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

        expect(buildReport(provider, 'sqlite', 'file:///fixture.sql', Date.now(), 'passed', true)).toEqual(expect.objectContaining({
            resultSetCount: 1,
            rowCounts: [2],
            pendingRequestCount: 3,
            activeCommandCount: 1,
            executingSourceCount: 2,
            streamingResultCount: 3,
            streamingTransportCount: 4,
            pendingResultSyncCount: 5,
        }));
    });

    it('does not register commands outside test sessions', () => {
        process.env.NODE_ENV = 'production';

        expect(registerResultPanelRegressionCommand({} as never, {} as never)).toBeUndefined();
        expect(vscode.commands.registerCommand).not.toHaveBeenCalled();
    });
});

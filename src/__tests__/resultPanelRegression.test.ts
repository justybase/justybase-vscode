import * as vscode from 'vscode';
import { registerResultPanelRegressionCommand } from '../activation/resultPanelRegression';

jest.mock('vscode');

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

        disposable?.dispose();
        expect((vscode.commands.registerCommand as jest.Mock).mock.results[0]?.value.dispose).toHaveBeenCalled();
    });

    it('does not register commands outside test sessions', () => {
        process.env.NODE_ENV = 'production';

        expect(registerResultPanelRegressionCommand({} as never, {} as never)).toBeUndefined();
        expect(vscode.commands.registerCommand).not.toHaveBeenCalled();
    });
});

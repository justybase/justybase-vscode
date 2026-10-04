import * as vscode from 'vscode';
import { registerResultPanelRegressionCommand } from '../activation/resultPanelRegression';
import { runQueryQueueRegression, runQueryQueueLogsRegression } from '../activation/queryQueueRegression';
import { getQueryExecutionCoordinator, clearQueryExecutionGateForTests } from '../commands/query/queryExecutionGate';
import type { ResultPanelView } from '../views/resultPanelView';

jest.mock('vscode', () => {
    const original = jest.requireActual('./__mocks__/vscode');
    return { ...original, languages: { ...original.languages, setTextDocumentLanguage: jest.fn() } };
});

describe('Extension Host queue fixture contract', () => {
    beforeEach(() => clearQueryExecutionGateForTests());
    afterEach(() => clearQueryExecutionGateForTests());

    function fixture(resultValue?: number) {
        let sql = '';
        let independent = false;
        let request = 0;
        let rows: unknown[][] = [];
        const executed: string[] = [];
        const document = { uri: { scheme: 'untitled', toString: () => 'untitled:QueueFixture' }, languageId: 'sql',
            getText: () => sql, positionAt: (offset: number) => ({ line: 0, character: offset }) } as vscode.TextDocument;
        const editor = { document, edit: jest.fn(async (callback: (builder: { replace: (_range: vscode.Range, text: string) => void }) => void) => {
            callback({ replace: (_range, text) => { sql = text; } });
            return true;
        }) } as unknown as vscode.TextEditor;
        (vscode.window as unknown as { activeTextEditor: vscode.TextEditor }).activeTextEditor = editor;
        (vscode.window.showTextDocument as jest.Mock).mockResolvedValue(editor);
        (vscode.languages.setTextDocumentLanguage as jest.Mock).mockResolvedValue(document);
        (vscode.commands.executeCommand as jest.Mock).mockImplementation(async (command: string) => {
            if (command !== 'netezza.runQuery' && command !== 'netezza.runQueryBatch') return;
            const captured = sql;
            await getQueryExecutionCoordinator().enqueue({ sourceUri: document.uri.toString(), executionUri: independent ? `execution:${++request}` : undefined, sql: captured }, { document, independentConnection: independent }, async () => async lease => {
                lease.markRunning();
                executed.push(captured);
                if (independent) await new Promise<void>(resolve => setImmediate(resolve));
                rows = [[resultValue ?? Number(captured.match(/\d+/)?.[0])]];
                return 'completed';
            });
        });
        const provider = {
            getResultsForSource: () => [{ isLog: false, isError: false, data: rows }],
            getResultPanelTraceSnapshot: () => [],
            getResultPanelTestBridgePendingRequestCount: () => 0,
            getResultPanelRuntimeDiagnostics: () => ({}),
            ensureResultPanelTestBridgeReady: async () => { throw new Error('Stop after queue fixture'); },
        } as unknown as ResultPanelView;
        return { document, provider, executed, editor, setIndependent: (value: boolean) => { independent = value; } };
    }

    it('runs the queue fixture before the main scenario and releases documents/connections on later failure', async () => {
        const previous = process.env.JUSTYBASE_RESULT_PANEL_TRACE;
        process.env.JUSTYBASE_RESULT_PANEL_TRACE = '1';
        const { document, provider, executed, setIndependent } = fixture();
        Object.assign(provider, {
            ensureResultPanelTestBridgeReady: async () => undefined,
            setActiveSource: jest.fn(),
            runResultPanelTestBridge: async () => { throw new Error('Stop after queue fixture'); },
        });
        const manager = { saveConnection: jest.fn(async () => undefined), setDocumentConnection: jest.fn(async () => undefined),
            setDocumentKeepConnectionOpen: jest.fn((_uri: string, value: boolean) => setIndependent(!value)),
            clearDocumentConnection: jest.fn(async () => undefined), deleteConnection: jest.fn(async () => undefined) };
        (vscode.commands.registerCommand as jest.Mock).mockReturnValue({ dispose: jest.fn() });
        const registrations = (vscode.commands.registerCommand as jest.Mock).mock.calls.length;
        const disposable = registerResultPanelRegressionCommand(provider, manager as never, { subscriptions: [] } as never);
        const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.slice(registrations)
            .find(call => call[0] === 'justybase.test.extensionHostScenario')[1];
        try {
            await expect(handler({ engine: 'sqlite', sqliteDatabasePath: '/tmp/queue-fixture.sqlite', workDir: '/tmp' })).rejects.toThrow('Stop after queue fixture');
            expect(executed).toEqual(['SELECT 101;', 'SELECT 202;', 'SELECT 101;', 'SELECT 202;']);
            expect(manager.clearDocumentConnection).toHaveBeenCalledWith(document.uri.toString());
            expect(manager.deleteConnection).toHaveBeenCalledWith('extension-host-sqlite');
            expect(getQueryExecutionCoordinator().getSnapshot()[0].queued).toHaveLength(0);
        } finally {
            disposable?.dispose();
            if (previous === undefined) delete process.env.JUSTYBASE_RESULT_PANEL_TRACE;
            else process.env.JUSTYBASE_RESULT_PANEL_TRACE = previous;
        }
    });

    it('rejects mismatched results instead of reporting a passing FIFO contract', async () => {
        const { document, provider } = fixture(999);
        await expect(runQueryQueueRegression(document, provider)).rejects.toThrow('captured SQL results');
        expect(getQueryExecutionCoordinator().getSnapshot()[0].queued).toHaveLength(0);
    });

    it('cleans up when the SQL editor cannot accept the fixture text', async () => {
        const { document, provider, editor } = fixture();
        (editor.edit as jest.Mock).mockResolvedValue(false);
        await expect(runQueryQueueRegression(document, provider)).rejects.toThrow('edit queue fixture');
        expect(getQueryExecutionCoordinator().getSnapshot()).toHaveLength(0);
    });

    it('checks renderer Logs preferences in both modes and restores connection policy', async () => {
        const { document } = fixture();
        let selected = 0;
        const provider = {setActiveSource: jest.fn(),runResultPanelTestBridge: jest.fn(async (action: string, args?: {resultSetIndex:number}) => {
            if(action === 'switchResultSet') selected=args!.resultSetIndex;
            return {activeResultSetIndex:selected};
        })} as unknown as ResultPanelView;
        const mode=jest.fn();
        await runQueryQueueLogsRegression(document,provider,mode);
        expect(mode.mock.calls).toEqual([[true],[false],[true]]);
        expect(provider.runResultPanelTestBridge).toHaveBeenCalledTimes(8);
        expect(provider.setActiveSource).toHaveBeenCalledTimes(2);
    });
    it.each([0, 1])('rejects renderer selection regressions and restores connection mode (%s)', async wrongIndex => {
        const {document}=fixture();
        const provider={setActiveSource:jest.fn(),runResultPanelTestBridge:jest.fn(async()=>({activeResultSetIndex:wrongIndex}))} as unknown as ResultPanelView;
        const mode=jest.fn();
        await expect(runQueryQueueLogsRegression(document,provider,mode)).rejects.toThrow(wrongIndex ? 'displaced' : 'did not resume');
        expect(mode.mock.calls.slice(-1)[0]).toEqual([true]);
    });
});

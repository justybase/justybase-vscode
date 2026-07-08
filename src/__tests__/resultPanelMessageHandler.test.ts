import * as vscode from 'vscode';
import type { ResultPanelInboundMessage } from '../contracts/webview';
import { ResultPanelMessageHandler, MessageHandlerCallbacks } from '../views/resultPanelMessageHandler';
import { ResultStateManager } from '../state/resultStateManager';
import { ExportManager } from '../export/exportManager';
import { DuckDbResultBridge } from '../services/duckdbResultBridge';
import { ResultSet } from '../types';

// Mock logger
jest.mock('../utils/logger', () => ({
    getLogger: jest.fn().mockReturnValue({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    })
}));

// Mock vscode
jest.mock(
    'vscode',
    () => ({
        EventEmitter: jest.fn().mockImplementation(() => {
            const listeners: Array<(data: unknown) => void> = [];
            return {
                event: jest.fn().mockImplementation((callback: (data: unknown) => void) => {
                    listeners.push(callback);
                    return { dispose: jest.fn() };
                }),
                fire: jest.fn().mockImplementation((data: unknown) => {
                    listeners.forEach(callback => callback(data));
                })
            };
        }),
        commands: {
            executeCommand: jest.fn().mockResolvedValue(undefined)
        },
        window: {
            showInformationMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showWarningMessage: jest.fn(),
            showSaveDialog: jest.fn(),
            showQuickPick: jest.fn(),
            showTextDocument: jest.fn(),
            activeTextEditor: undefined
        },
        env: {
            clipboard: {
                writeText: jest.fn().mockResolvedValue(undefined)
            }
        },
        workspace: {
            getConfiguration: jest.fn(() => ({
                get: jest.fn((_key, defaultValue) => defaultValue)
            }))
        },
        Uri: {
            parse: jest.fn().mockImplementation(s => ({ toString: () => s }))
        },
        Selection: jest.fn().mockImplementation((start, end) => ({ start, end }))
    }),
    { virtual: true }
);

function createMockActiveEditor() {
    const insert = jest.fn();
    const position = {
        line: 0,
        character: 0,
        translate: jest.fn((_lineDelta: number, characterDelta: number) => ({
            line: 0,
            character: characterDelta
        }))
    };
    const editor = {
        document: { uri: { toString: () => 'file:///active.sql' } },
        selection: { active: position },
        edit: jest.fn((callback: (editBuilder: { insert: jest.Mock }) => void) => {
            callback({ insert });
            return Promise.resolve(true);
        })
    };

    return { editor, insert, position };
}

describe('ResultPanelMessageHandler', () => {
    let handler: ResultPanelMessageHandler;
    let stateManager: ResultStateManager;
    let exportManager: ExportManager;
    let callbacks: MessageHandlerCallbacks;
    let postedMessages: Array<Record<string, unknown>>;
    let webviewUpdates: number;
    let forceHydrateCalls: number;
    let duckDbResultBridge: DuckDbResultBridge | undefined;
    let consoleLogSpy: jest.SpiedFunction<typeof console.log>;

    beforeEach(() => {
        jest.clearAllMocks();
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

        // Create real instances for integration testing
        stateManager = new ResultStateManager();

        // Use stateManager's resultsMap for ExportManager (not a separate map)
        exportManager = new ExportManager(stateManager.resultsMap);

        postedMessages = [];
        webviewUpdates = 0;
        forceHydrateCalls = 0;

        callbacks = {
            onUpdateWebview: jest.fn().mockImplementation(() => {
                webviewUpdates++;
            }),
            onPostMessage: jest.fn().mockImplementation(msg => {
                postedMessages.push(msg);
            }),
            onForceHydrate: jest.fn().mockImplementation(() => {
                forceHydrateCalls++;
            })
        };

        duckDbResultBridge = undefined;
        handler = new ResultPanelMessageHandler(stateManager, exportManager, callbacks, duckDbResultBridge);
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
    });

    describe('ready message', () => {
        it('should trigger force hydrate on ready', () => {
            handler.handleMessage({ command: 'ready' });
            expect(forceHydrateCalls).toBe(1);
            expect(callbacks.onForceHydrate).toHaveBeenCalled();
        });
    });

    describe('reportHydrationMetrics message', () => {
        it('should log first-paint perf events from the webview', () => {
            const hydrationCallback = jest.fn();
            callbacks.onRecordHydrationMetrics = hydrationCallback;
            handler.handleMessage({
                command: 'reportHydrationMetrics',
                metrics: {
                    durationMs: 12.7,
                    payloadBytes: 120_000,
                    activeSource: 'file:///test.sql',
                    resultSetCount: 2,
                    totalRowCount: 1500,
                    executionState: 'success'
                }
            });

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('"operation":"result_panel.first_paint"')
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('"payload_size_bucket":"l"')
            );
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('"execution_state":"success"')
            );
            expect(hydrationCallback).toHaveBeenCalledWith(
                expect.objectContaining({
                    durationMs: 12.7,
                    totalRowCount: 1500
                })
            );
        });
    });

    describe('copilot commands', () => {
        it('should execute describeWithCopilot command', () => {
            const data = { rows: [] };
            const sql = 'SELECT * FROM test';

            handler.handleMessage({ command: 'describeWithCopilot', data, sql });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.describeDataWithCopilot', data, sql);
        });

        it('should execute fixSqlError command', () => {
            const errorMessage = 'Syntax error';
            const sql = 'SELECT * FORM test';

            handler.handleMessage({ command: 'fixSqlError', errorMessage, sql });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.fixSqlError', errorMessage, sql);
        });
    });

    describe('insertCellContent message', () => {
        it('should insert provided sqlText verbatim into the active editor', async () => {
            const { editor, insert, position } = createMockActiveEditor();
            (vscode.window as typeof vscode.window & { activeTextEditor: unknown }).activeTextEditor = editor as unknown as vscode.TextEditor;

            handler.handleMessage({
                command: 'insertCellContent',
                text: '1 234.50',
                dataType: 'numeric',
                sqlText: '1234.50'
            });

            expect(insert).toHaveBeenCalledWith(position, '1234.50');

            await Promise.resolve();
            expect(vscode.window.showTextDocument).toHaveBeenCalledWith(editor.document);
        });

        it('should normalize legacy grouped numeric text when sqlText is missing', () => {
            const { editor, insert, position } = createMockActiveEditor();
            (vscode.window as typeof vscode.window & { activeTextEditor: unknown }).activeTextEditor = editor as unknown as vscode.TextEditor;

            handler.handleMessage({
                command: 'insertCellContent',
                text: '1 234.50',
                dataType: 'numeric'
            });

            expect(insert).toHaveBeenCalledWith(position, '1234.50');
        });
    });

    describe('switchSource message', () => {
        it('should switch to new source', () => {
            const sourceUri = 'file:///test.sql';
            handler.handleMessage({ command: 'switchSource', sourceUri });

            expect(stateManager.activeSourceUri).toBe(sourceUri);
            expect(webviewUpdates).toBe(1);
        });

        it('should still update webview even if source is invalid', () => {
            const sourceUri = 'vscode-chat-code-block://test';
            handler.handleMessage({ command: 'switchSource', sourceUri });

            expect(stateManager.activeSourceUri).toBeUndefined();
            // Handler always calls onUpdateWebview regardless of whether source changed
            expect(webviewUpdates).toBe(1);
        });
    });

    describe('togglePin message', () => {
        it('should toggle pin for source', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.setActiveSource(sourceUri);
            webviewUpdates = 0; // Reset after setup

            expect(stateManager.pinnedSources.has(sourceUri)).toBe(false);

            handler.handleMessage({ command: 'togglePin', sourceUri });

            expect(stateManager.pinnedSources.has(sourceUri)).toBe(true);
            expect(webviewUpdates).toBe(1); // togglePin calls onUpdateWebview
        });
    });

    describe('toggleResultPin message', () => {
        it('should toggle pin for result set', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            // Add a result set which will be auto-pinned
            stateManager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );
            webviewUpdates = 0; // Reset after setup

            const initialPinnedCount = stateManager.pinnedResults.size;
            // Get the auto-pinned result ID for the first result set (index 1, since index 0 is log)
            const autoPinnedId = Array.from(stateManager.pinnedResults.entries()).find(
                ([_, info]) => info.sourceUri === sourceUri && info.resultSetIndex === 1
            )?.[0];

            expect(autoPinnedId).toBeDefined();
            expect(stateManager.pinnedResults.has(autoPinnedId!)).toBe(true);

            // Toggle the pin (should remove it since it's auto-pinned)
            handler.handleMessage({ command: 'toggleResultPin', sourceUri, resultSetIndex: 1 });

            // After toggling, it should be unpinned (removed)
            expect(stateManager.pinnedResults.size).toBe(initialPinnedCount - 1);
            expect(stateManager.pinnedResults.has(autoPinnedId!)).toBe(false);
            expect(webviewUpdates).toBe(1); // toggleResultPin calls onUpdateWebview
        });
    });

    describe('switchToPinnedResult message', () => {
        it('should switch to pinned result and send message', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            // Add a result set which will be auto-pinned
            stateManager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            // Get the first pinned result ID
            const firstPinnedId = Array.from(stateManager.pinnedResults.keys())[0];
            expect(firstPinnedId).toBeDefined();

            postedMessages = [];
            handler.handleMessage({ command: 'switchToPinnedResult', resultId: firstPinnedId });

            expect(stateManager.activeSourceUri).toBe(sourceUri);
            expect(postedMessages).toContainEqual(
                expect.objectContaining({
                    command: 'switchToResultSet'
                })
            );
        });

        it('should not send message for invalid result ID', () => {
            handler.handleMessage({ command: 'switchToPinnedResult', resultId: 'invalid_id' });

            const switchMessages = postedMessages.filter(
                (m: Record<string, unknown>) => m.command === 'switchToResultSet'
            );
            expect(switchMessages.length).toBe(0);
        });
    });

    describe('closeSource message', () => {
        it('should close source and update webview', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            webviewUpdates = 0; // Reset after setup

            expect(stateManager.resultsMap.has(sourceUri)).toBe(true);

            handler.handleMessage({ command: 'closeSource', sourceUri });

            expect(stateManager.resultsMap.has(sourceUri)).toBe(false);
            expect(forceHydrateCalls).toBe(1); // closeSource calls onForceHydrate
        });
    });

    describe('closeResult message', () => {
        it('should close specific result set', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            stateManager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );
            webviewUpdates = 0; // Reset after setup

            const initialCount = stateManager.resultsMap.get(sourceUri)!.length;

            handler.handleMessage({ command: 'closeResult', sourceUri, resultSetIndex: 1 });

            expect(stateManager.resultsMap.get(sourceUri)!.length).toBe(initialCount - 1);
            expect(forceHydrateCalls).toBe(1); // closeResult calls onForceHydrate
        });
    });

    describe('closeAllResults message', () => {
        it('should close all results except log', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            stateManager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet,
                    {
                        columns: [{ name: 'name', type: 'string' }],
                        data: [['test']],
                        name: 'Result 2'
                    } as ResultSet
                ],
                sourceUri
            );
            webviewUpdates = 0; // Reset after setup

            expect(stateManager.resultsMap.get(sourceUri)!.length).toBe(3); // log + 2 results

            handler.handleMessage({ command: 'closeAllResults', sourceUri });

            // Only log should remain
            expect(stateManager.resultsMap.get(sourceUri)!.length).toBe(1);
            expect(stateManager.resultsMap.get(sourceUri)![0].isLog).toBe(true);
            expect(forceHydrateCalls).toBe(1); // closeAllResults calls onForceHydrate
        });
    });

    describe('cancelQuery message', () => {
        it('should execute cancel query command', () => {
            const sourceUri = 'file:///test.sql';
            const currentRowCounts = [100, 50];

            handler.handleMessage({ command: 'cancelQuery', sourceUri, currentRowCounts });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.cancelQuery',
                sourceUri,
                currentRowCounts
            );
        });

        it('should not execute command without sourceUri', () => {
            handler.handleMessage({ command: 'cancelQuery' } as unknown as ResultPanelInboundMessage);

            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });
    });

    describe('clipboard operations', () => {
        it('should copy to clipboard', () => {
            const text = 'test content';

            handler.handleMessage({ command: 'copyToClipboard', text });

            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(text);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Copied to clipboard');
        });
    });

    describe('info and error messages', () => {
        it('should show info message', () => {
            const text = 'Info message';

            handler.handleMessage({ command: 'info', text });

            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(text);
        });

        it('should show error message', () => {
            const text = 'Error message';

            handler.handleMessage({ command: 'error', text });

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(`Webview Error: ${text}`);
        });
    });

    describe('setContext message', () => {
        it('should set context value', () => {
            const key = 'netezza.showResults';
            const value = true;

            handler.handleMessage({ command: 'setContext', key, value });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('setContext', key, value);
        });
    });

    describe('focusView message', () => {
        it('should focus the results view', () => {
            handler.handleMessage({ command: 'focusView' });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('netezza.results.focus');
        });
    });

    describe('clearLogs message', () => {
        it('should clear logs and update webview', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            stateManager.log(sourceUri, 'Test message');
            webviewUpdates = 0; // Reset after setup

            const initialLogLength = stateManager.resultsMap.get(sourceUri)![0].data.length;
            expect(initialLogLength).toBeGreaterThan(0);

            handler.handleMessage({ command: 'clearLogs', sourceUri });

            const logResult = stateManager.resultsMap.get(sourceUri)!.find(r => r.isLog);
            expect(logResult!.data.length).toBe(1); // Only "Logs Cleared" message
            expect(webviewUpdates).toBe(1); // clearLogs calls onUpdateWebview
        });
    });

    describe('switchResultSet message', () => {
        it('should set active result set index', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            stateManager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );

            handler.handleMessage({ command: 'switchResultSet', sourceUri, resultSetIndex: 1 });

            expect(stateManager.getActiveResultSetIndex(sourceUri)).toBe(1);
        });
    });

    describe('export messages', () => {
        beforeEach(() => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1], [2]],
                name: 'Test'
            } as ResultSet;
            stateManager.resultsMap.set(sourceUri, [resultSet]);
        });

        it('should handle initiateExport', () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0,
                rowIndices: [0, 1],
                columnIds: ['0']
            };

            // Mock showQuickPick to cancel immediately
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);

            handler.handleMessage({ command: 'initiateExport', data: exportData });

            expect(vscode.window.showQuickPick).toHaveBeenCalled();
        });

        it('should handle initiateExportWithSelection without quick pick', () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0,
                rowIndices: [0, 1],
                columnIds: ['0']
            };
            const initiateExportWithSelection = jest
                .spyOn(exportManager, 'initiateExportWithSelection')
                .mockResolvedValue(undefined);

            handler.handleMessage({
                command: 'initiateExportWithSelection',
                data: exportData,
                format: 'csv',
                destination: 'file'
            });

            expect(initiateExportWithSelection).toHaveBeenCalledWith(exportData, 'csv', 'file');
            initiateExportWithSelection.mockRestore();
        });

        it('should handle exportCsv with metadata', async () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            };

            // Mock showSaveDialog to cancel
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

            await handler.handleMessage({ command: 'exportCsv', data: exportData });

            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
        });

        it('should handle exportJson with metadata', async () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            };

            // Mock showSaveDialog to cancel
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

            await handler.handleMessage({ command: 'exportJson', data: exportData });

            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
        });

        it('should handle exportXml with metadata', async () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            };

            // Mock showSaveDialog to cancel
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

            await handler.handleMessage({ command: 'exportXml', data: exportData });

            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
        });

        it('should handle exportSqlInsert with metadata', async () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            };

            // Mock showSaveDialog to cancel
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

            await handler.handleMessage({ command: 'exportSqlInsert', data: exportData });

            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
        });

        it('should handle exportMarkdown with metadata', async () => {
            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0
            };

            // Mock showSaveDialog to cancel
            (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

            await handler.handleMessage({ command: 'exportMarkdown', data: exportData });

            expect(vscode.window.showSaveDialog).toHaveBeenCalled();
        });

        it('should route queryLocallyDuckDB to the bridge service', async () => {
            const queryLocally = jest.fn().mockResolvedValue(undefined);
            duckDbResultBridge = {
                queryLocally,
            } as unknown as DuckDbResultBridge;
            handler = new ResultPanelMessageHandler(stateManager, exportManager, callbacks, duckDbResultBridge);

            const exportData = {
                sourceUri: 'file:///test.sql',
                resultSetIndex: 0,
            };

            handler.handleMessage({ command: 'queryLocallyDuckDB', data: exportData });

            expect(queryLocally).toHaveBeenCalledWith(exportData);
        });
    });

    describe('excel operations', () => {
        beforeEach(() => {
            const sourceUri = 'file:///test.sql';
            const resultSet: ResultSet = {
                columns: [{ name: 'id', type: 'int' }],
                data: [[1], [2]],
                name: 'Test',
                sql: 'SELECT 1'
            } as ResultSet;
            stateManager.resultsMap.set(sourceUri, [resultSet]);
        });

        it('should handle openInExcel', () => {
            const data = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            handler.handleMessage({ command: 'openInExcel', data, sql: 'SELECT 1' });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.exportCurrentResultToXlsbAndOpen',
                expect.any(Array),
                'SELECT 1'
            );
        });

        it('should handle copyAsExcel', () => {
            const data = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            handler.handleMessage({ command: 'copyAsExcel', data, sql: 'SELECT 1' });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.copyCurrentResultToXlsbClipboard',
                expect.any(Array),
                'SELECT 1'
            );
        });

        it('should handle openInExcelXlsx', async () => {
            const data = {
                sourceUri: 'file:///test.sql',
                results: [
                    {
                        resultSetIndex: 0,
                        rowIndices: [0],
                        columnIds: ['0'],
                        name: 'Test',
                        isActive: true
                    }
                ]
            };

            await handler.handleMessage({ command: 'openInExcelXlsx', data, sql: 'SELECT 1' });

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'netezza.exportCurrentResultToXlsxAndOpen',
                expect.any(Array),
                'SELECT 1'
            );
        });
    });

    describe('unpinResult message', () => {
        it('should unpin result and update webview', () => {
            const sourceUri = 'file:///test.sql';
            stateManager.startExecution(sourceUri);
            // Add a result set which will be auto-pinned
            stateManager.updateResults(
                [
                    {
                        columns: [{ name: 'id', type: 'int' }],
                        data: [[1]],
                        name: 'Result 1'
                    } as ResultSet
                ],
                sourceUri
            );
            const updatesAfterStart = webviewUpdates;

            const firstPinnedId = Array.from(stateManager.pinnedResults.keys())[0];
            expect(firstPinnedId).toBeDefined();
            expect(stateManager.pinnedResults.has(firstPinnedId)).toBe(true);

            handler.handleMessage({ command: 'unpinResult', resultId: firstPinnedId });

            expect(stateManager.pinnedResults.has(firstPinnedId)).toBe(false);
            expect(webviewUpdates - updatesAfterStart).toBe(1); // handler calls onUpdateWebview
        });
    });
});

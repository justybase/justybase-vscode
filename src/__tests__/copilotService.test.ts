/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { CopilotService } from '../services/copilotService';
import { showCopilotPromptPreview } from '../services/copilotPromptPreview';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';

jest.mock('vscode', () => {
    class MockEventEmitter {
        private _listeners: ((e: unknown) => void)[] = [];
        event = (listener: (e: unknown) => void) => {
            this._listeners.push(listener);
            return { dispose: () => { const index = this._listeners.indexOf(listener); if (index !== -1) { this._listeners.splice(index, 1); } } };
        };
        fire(data: unknown): void { this._listeners.forEach((listener) => listener(data)); }
        dispose(): void { this._listeners = []; }
    }

    return {
        Uri: { parse: jest.fn(), joinPath: jest.fn(), file: jest.fn() },
        window: {
            activeTextEditor: undefined,
            createStatusBarItem: jest.fn().mockReturnValue({
                show: jest.fn(),
                hide: jest.fn(),
                text: '',
                tooltip: '',
                command: ''
            }),
            showWarningMessage: jest.fn().mockResolvedValue('Yes, Send to Copilot'),
            showInformationMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showQuickPick: jest.fn(),
            showInputBox: jest.fn(),
            withProgress: jest.fn(async (_options: unknown, task: (progress: { report: (value: unknown) => void }) => unknown) =>
                task({ report: jest.fn() })),
            createTextEditorDecorationType: jest.fn(),
            showTextDocument: jest.fn()
        },
        commands: {
            executeCommand: jest.fn(),
            registerCommand: jest.fn()
        },
        workspace: {
            getConfiguration: jest.fn().mockReturnValue({
                get: jest.fn(),
                update: jest.fn()
            }),
            openTextDocument: jest.fn(),
            applyEdit: jest.fn(),
            onDidChangeTextDocument: jest.fn(),
            onDidChangeConfiguration: jest.fn()
        },
        Range: jest.fn(),
        Position: jest.fn(),
        StatusBarAlignment: { Right: 1, Left: 2 },
        lm: {
            selectChatModels: jest.fn().mockResolvedValue([]),
            LanguageModelChatMessage: {
                User: jest.fn()
            }
        },
        LanguageModelChatMessage: {
            User: jest.fn(),
            Assistant: jest.fn()
        },
        CancellationTokenSource: jest.fn().mockImplementation(() => ({
            token: {
                isCancellationRequested: false,
                onCancellationRequested: jest.fn()
            },
            dispose: jest.fn(),
            cancel: jest.fn()
        })),
        ProgressLocation: { Notification: 1, Window: 2 },
        ViewColumn: { One: 1, Two: 2, Beside: 3 },
        WorkspaceEdit: jest.fn().mockImplementation(() => ({
            replace: jest.fn()
        })),
        env: {
            language: 'en'
        },
        EventEmitter: MockEventEmitter
    };
}, { virtual: true });

jest.mock('../ddl/helpers', () => ({
    createConnectionFromDetails: jest.fn(),
    executeQueryHelper: jest.requireActual('../ddl/helpers').executeQueryHelper
}));

jest.mock('../services/copilotPromptPreview', () => ({
    showCopilotPromptPreview: jest.fn().mockResolvedValue('copied')
}));

describe('CopilotService', () => {
    let service: CopilotService;
    let mockContext: any;
    let mockCache: any;
    let mockConnManager: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockContext = {
            extensionUri: { fsPath: '/test', toString: () => 'file:///test' },
            globalState: {
                get: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined)
            },
            workspaceState: {
                get: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined)
            },
            subscriptions: []
        };

        mockCache = {};

        mockConnManager = {
            getActiveConnectionName: jest.fn().mockReturnValue('test-connection'),
            getConnectionForExecution: jest.fn().mockReturnValue('test-connection'),
            getDocumentConnection: jest.fn().mockReturnValue('test-connection'),
            getConnection: jest.fn().mockResolvedValue({
                host: 'test-host',
                database: 'TEST_DB',
                user: 'test-user',
                password: 'test-password',
                dbType: 'netezza'
            }),
            getCurrentDatabase: jest.fn().mockResolvedValue('TEST_DB')
        };

        service = new CopilotService(
            mockConnManager as ConnectionManager,
            mockContext as vscode.ExtensionContext,
            mockCache as MetadataCache
        );
    });

    describe('Netezza reference', () => {
        it('returns optimization guidance', () => {
            const reference = service.getNetezzaReference('optimization');
            expect(reference).toContain('OPTIMIZATION');
        });

        it('returns NZPLSQL guidance', () => {
            const reference = service.getNetezzaReference('nzplsql');
            expect(reference).toContain('NZPLSQL');
        });

        it('returns all guidance', () => {
            const reference = service.getNetezzaReference('all');
            expect(reference).toContain('OPTIMIZATION');
            expect(reference).toContain('NZPLSQL');
        });
    });

    describe('DDL cache', () => {
        it('clears the DDL cache', () => {
            const clearSpy = jest.spyOn(service['ddlCacheManager'], 'clear');
            service.clearDDLCache();
            expect(clearSpy).toHaveBeenCalled();
        });
    });

    describe('Tool context', () => {
        it('includes dialect, connection, and SQL without optional sections', async () => {
            const context = await service.getToolContext('SELECT * FROM users', false, false);

            expect(context).toContain('Dialect:');
            expect(context).toContain('Connection: test-connection');
            expect(context).toContain('SELECT * FROM users');
            expect(context).not.toContain('Diagnostics:');
        });

        it('reports missing editor content without throwing', async () => {
            const context = await service.getToolContext(undefined, false, false);
            expect(context).toContain('no active SQL editor content');
        });

        it('validates supplied SQL instead of reading editor diagnostics', async () => {
            const validateSpy = jest.spyOn(service, 'validateSql').mockResolvedValue('parser: ok');

            const context = await service.getToolContext('SELECT 1', false, true);

            expect(validateSpy).toHaveBeenCalledWith('SELECT 1');
            expect(context).toContain('parser: ok');
            validateSpy.mockRestore();
        });
    });

    describe('Describe data with Copilot', () => {
        const data = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' }
        ];

        it('opens Copilot Chat with a markdown table after confirmation', async () => {
            await service.describeDataWithCopilot(data, 'SELECT * FROM users');

            expect(vscode.window.showWarningMessage).toHaveBeenCalled();
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'workbench.action.chat.open',
                expect.objectContaining({
                    query: expect.stringContaining('| id | name |')
                })
            );
        });

        it('does nothing for empty data', async () => {
            await service.describeDataWithCopilot([], 'SELECT * FROM users');

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No data to describe');
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it('does not open chat when the user cancels', async () => {
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Cancel');

            await service.describeDataWithCopilot(data);

            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });
    });

    describe('Fix SQL error preview', () => {
        it('warns when there is no SQL', async () => {
            await service.fixSqlError('Some error', '');

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL to fix');
            expect(showCopilotPromptPreview).not.toHaveBeenCalled();
        });

        it('shows a copy-ready preview including the error and SQL', async () => {
            service['contextBuilder']['getSchemaForSql'] = jest.fn().mockResolvedValue('No tables found in SQL.');

            await service.fixSqlError('Syntax error', 'SELECT * FROM users');

            expect(showCopilotPromptPreview).toHaveBeenCalledWith(expect.objectContaining({
                operation: 'Discuss SQL error with Copilot',
                prompt: expect.stringContaining('Syntax error')
            }));
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'Prompt copied to clipboard. Paste it into your Copilot Chat thread to continue.'
            );
        });

        it('includes NZPLSQL reference for procedure code', async () => {
            service['contextBuilder']['getSchemaForSql'] = jest.fn().mockResolvedValue('No tables found in SQL.');

            await service.fixSqlError(
                'compile error',
                'CREATE OR REPLACE PROCEDURE p() RETURNS INT LANGUAGE NZPLSQL AS BEGIN_PROC RETURN 1; END_PROC;'
            );

            expect(showCopilotPromptPreview).toHaveBeenCalledWith(expect.objectContaining({
                items: expect.arrayContaining(['NZPLSQL language reference'])
            }));
        });
    });
});

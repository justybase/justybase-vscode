/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { CopilotService } from '../services/copilotService';
import { ConnectionManager } from '../core/connectionManager';
import { MetadataCache } from '../metadataCache';

jest.mock('vscode', () => {
    // EventEmitter mock class defined inline
    class MockEventEmitter {
        private _listeners: ((e: unknown) => void)[] = [];
        event = (listener: (e: unknown) => void) => {
            this._listeners.push(listener);
            return { dispose: () => { const index = this._listeners.indexOf(listener); if (index !== -1) { this._listeners.splice(index, 1); } } };
        };
        fire(data: unknown): void { this._listeners.forEach((listener) => listener(data)); }
        dispose(): void { this._listeners = []; }
    }

    class MockLanguageModelTextPart {
        constructor(public value: string) { }
    }

    class MockLanguageModelToolCallPart {
        constructor(public name: string, public input: unknown, public callId: string = 'call-1') { }
    }

    class MockLanguageModelToolResultPart {
        constructor(public callId: string, public content: unknown) { }
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
            showWarningMessage: jest.fn().mockResolvedValue('Yes, Proceed'),
            showInformationMessage: jest.fn(),
            showErrorMessage: jest.fn(),
            showQuickPick: jest.fn(),
            showInputBox: jest.fn(),
            withProgress: jest.fn(),
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
            invokeTool: jest.fn(),
            tools: [],
            LanguageModelChatMessage: {
                User: jest.fn()
            }
        },
        LanguageModelTextPart: MockLanguageModelTextPart,
        LanguageModelToolCallPart: MockLanguageModelToolCallPart,
        LanguageModelToolResultPart: MockLanguageModelToolResultPart,
        LanguageModelChatMessage: {
            User: jest.fn(),
            Assistant: jest.fn()
        },
        chat: {
            createChatParticipant: jest.fn()
        },
        ChatResponseStream: class {
            progress = jest.fn();
            markdown = jest.fn();
            reference = jest.fn();
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

describe('CopilotService - Comprehensive Tests', () => {
    let service: CopilotService;
    let mockContext: any;
    let mockCache: any;
    let mockConnManager: any;
    let mockModel: any;

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
                password: 'test-password'
            }),
            getCurrentDatabase: jest.fn().mockResolvedValue('TEST_DB')
        };

        mockModel = {
            id: 'test-model-id',
            name: 'Test Model',
            family: 'gpt-4',
            vendor: 'copilot',
            maxInputTokens: 128000,
            sendRequest: jest.fn().mockResolvedValue({
                text: (async function* () {
                    yield 'Optimized SQL query';
                })()
            })
        };

        (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([mockModel]);
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({
            get: jest.fn((_key: string, defaultValue: any) => defaultValue),
            update: jest.fn().mockResolvedValue(undefined)
        });

        service = new CopilotService(
            mockConnManager as ConnectionManager,
            mockContext as vscode.ExtensionContext,
            mockCache as MetadataCache
        );
    });

    describe('Initialization', () => {
        it('should initialize successfully', async () => {
            const result = await service.init();
            expect(result).toBe(true);
        });

        it('should initialize with no models available', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);
            const result = await service.init();
            expect(result).toBe(false);
        });

        it('should init and set default model', async () => {
            await service.init();
            const modelId = service.getSelectedModelId();
            expect(modelId).toBe('test-model-id');
        });
    });

    describe('AI tool execution policy', () => {
        it('advertises only explicitly allowed tools', () => {
            (vscode.lm.tools as unknown[]) = [
                { name: 'netezza_execute_query', description: 'Run query', inputSchema: {} },
                { name: 'netezza_get_sample_data', description: 'Get samples', inputSchema: {} },
                { name: 'netezza_get_tables', description: 'Get tables', inputSchema: {} }
            ];

            const tools = service['getAvailableLanguageModelTools']();

            expect(tools.map(tool => tool.name)).toEqual(['netezza_get_tables']);
        });
    });

    describe('Model Selection', () => {
        it('should get selected model ID', () => {
            service['modelSelector']['selectedModelId'] = 'custom-model-id';
            const modelId = service.getSelectedModelId();
            expect(modelId).toBe('custom-model-id');
        });

        it('should clear persisted model', async () => {
            await service.clearPersistedModel();
            const modelId = service.getSelectedModelId();
            expect(modelId).toBeUndefined();
            expect(mockContext.workspaceState.update).toHaveBeenCalledWith('copilot.selectedModelId', undefined);
        });
    });

    describe('Netezza Reference', () => {
        it('should get optimization reference', () => {
            const reference = service.getNetezzaReference('optimization');
            expect(reference).toContain('NETEZZA SQL NAMING CONVENTIONS');
            expect(reference).toContain('OPTIMIZATION');
        });

        it('should get nzplsql reference', () => {
            const reference = service.getNetezzaReference('nzplsql');
            expect(reference).toContain('NZPLSQL');
        });

        it('should get all reference', () => {
            const reference = service.getNetezzaReference('all');
            expect(reference).toContain('OPTIMIZATION');
            expect(reference).toContain('NZPLSQL');
        });
    });

    describe('DDL Cache', () => {
        it('should clear DDL cache', () => {
            const clearSpy = jest.spyOn(service['ddlCacheManager'], 'clear');
            service.clearDDLCache();
            expect(clearSpy).toHaveBeenCalled();
        });
    });

    describe('Fix SQL', () => {
        it('should fix SQL with auto mode', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Auto', value: 'auto' });

            await service.fixSql();

            expect(vscode.window.showQuickPick).toHaveBeenCalled();
        });

        it('should fix SQL with chat mode', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Chat', value: 'chat' });

            await service.fixSql();

            expect(vscode.window.showQuickPick).toHaveBeenCalled();
        });

        it('should handle fix SQL when no mode selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await service.fixSql();

            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.chat.open');
        });


    });

    describe('Optimize SQL', () => {
        it('should optimize SQL with auto mode', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Auto', value: 'auto' });
            service['modelSelector']['getModel'] = jest.fn().mockResolvedValue(mockModel);
            service['responseHandler']['sendToLanguageModel'] = jest.fn().mockResolvedValue('```sql\nSELECT id FROM users;\n```');
            service['responseHandler']['applyModelResponseToEditor'] = jest.fn().mockResolvedValue(undefined);
            service['toolsHandler']['validateSqlParser'] = jest
                .fn()
                .mockResolvedValue('SQL parser validation passed. No syntax, semantic, or lint issues found.');
            service['toolsHandler']['getExplainPlan'] = jest
                .fn()
                .mockResolvedValue('Nested Loop (cost=10.00..8.00 rows=100 width=8 conf=1)');

            await service.optimizeSql();

            expect(vscode.window.showQuickPick).toHaveBeenCalled();
            expect(service['toolsHandler']['validateSqlParser']).toHaveBeenCalledWith('SELECT id FROM users;');
            expect(service['toolsHandler']['getExplainPlan']).toHaveBeenCalledTimes(2);
            expect(service['responseHandler']['applyModelResponseToEditor']).toHaveBeenCalled();
        });

        it('should block auto optimize apply when parser/linter reports blocking errors', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Auto', value: 'auto' });
            service['modelSelector']['getModel'] = jest.fn().mockResolvedValue(mockModel);
            service['responseHandler']['sendToLanguageModel'] = jest.fn().mockResolvedValue('```sql\nSELECT * FROM users;\n```');
            service['responseHandler']['applyModelResponseToEditor'] = jest.fn().mockResolvedValue(undefined);
            service['toolsHandler']['validateSqlParser'] = jest.fn().mockResolvedValue(
                'SQL parser validation found 1 error(s) and 0 warning(s); unified quality checks found 1 issue(s):\n' +
                '- NZ002 [error] L1:C1 - blocking test'
            );
            service['toolsHandler']['getExplainPlan'] = jest
                .fn()
                .mockResolvedValue('Nested Loop (cost=10.00..8.00 rows=100 width=8 conf=1)');

            await service.optimizeSql();

            expect(service['responseHandler']['applyModelResponseToEditor']).not.toHaveBeenCalled();
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                expect.objectContaining({
                    language: 'markdown',
                    content: expect.stringContaining('BLOCKED')
                })
            );
        });

        it('should block auto optimize apply when explain cost regression exceeds threshold', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT id FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Auto', value: 'auto' });
            service['modelSelector']['getModel'] = jest.fn().mockResolvedValue(mockModel);
            service['responseHandler']['sendToLanguageModel'] = jest.fn().mockResolvedValue('```sql\nSELECT id FROM users;\n```');
            service['responseHandler']['applyModelResponseToEditor'] = jest.fn().mockResolvedValue(undefined);
            service['toolsHandler']['validateSqlParser'] = jest
                .fn()
                .mockResolvedValue('SQL parser validation passed. No syntax, semantic, or lint issues found.');
            service['toolsHandler']['getExplainPlan'] = jest
                .fn()
                .mockResolvedValueOnce('Nested Loop (cost=10.00..100.00 rows=100 width=8 conf=1)')
                .mockResolvedValueOnce('Nested Loop (cost=10.00..180.00 rows=100 width=8 conf=1)');

            await service.optimizeSql();

            expect(service['responseHandler']['applyModelResponseToEditor']).not.toHaveBeenCalled();
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Estimated plan cost increased')
                })
            );
        });

    });

    describe('Best Practices SQL', () => {
        it('should apply best practices with auto mode', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Auto', value: 'auto' });

            await service.bestPracticesSql();

            expect(vscode.window.showQuickPick).toHaveBeenCalled();
        });

    });

    describe('Explain SQL', () => {
        it('should explain SQL in chat mode', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ label: 'Chat', value: 'chat' });

            await service.explainSql();

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', expect.any(Object));
        });

        it('should handle explain SQL when no mode selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await service.explainSql();

            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith('workbench.action.chat.open');
        });
    });

    describe('Ask Custom Question', () => {
        it('should ask custom question with edit mode', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('How can I improve this query?');
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ label: 'Apply Changes', value: 'edit' });

            await service.askCustomQuestion();

            expect(vscode.window.showInputBox).toHaveBeenCalled();
        });

        it('should handle when no question entered', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

            await service.askCustomQuestion();

            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        });

        it('should handle when no action selected', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('Test question');
            (vscode.window.showQuickPick as jest.Mock)
                .mockResolvedValueOnce({ label: 'Apply Changes', value: 'edit' })
                .mockResolvedValueOnce(undefined);

            await service.askCustomQuestion();

            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it('should handle custom question error', async () => {
            (vscode.window.showInputBox as jest.Mock).mockRejectedValue(new Error('Input error'));

            await service.askCustomQuestion();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error: Input error');
        });
    });

    describe('Generate SQL Interactive', () => {
        it('should handle when no description entered', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

            await service.generateSqlInteractive();

            expect(vscode.window.withProgress).not.toHaveBeenCalled();
        });

        it('should handle generate SQL error', async () => {
            (vscode.window.showInputBox as jest.Mock).mockRejectedValue(new Error('Generation error'));

            await service.generateSqlInteractive();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error generating SQL: Generation error');
        });

        it('generates SQL with parser validation and opens a report document', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('List top 10 customers');
            (vscode.window.withProgress as jest.Mock).mockImplementation(
                async (_options: unknown, task: (progress: unknown) => Promise<void>) => task({})
            );

            const gatherSchemaOverviewMock = jest.fn().mockResolvedValue('DATABASE: DB\nTABLES: 1');
            const buildGenerateSqlPromptMock = jest.fn().mockReturnValue('Generate SQL prompt');
            service['contextBuilder']['gatherSchemaOverview'] = gatherSchemaOverviewMock;
            service['contextBuilder']['buildGenerateSqlPrompt'] = buildGenerateSqlPromptMock;
            service['modelSelector']['getModel'] = jest.fn().mockResolvedValue(mockModel);
            service['responseHandler']['sendToLanguageModel'] = jest.fn().mockResolvedValue('```sql\nSELECT 1;\n```');
            service['toolsHandler']['validateSqlParser'] = jest
                .fn()
                .mockResolvedValue('SQL parser validation passed. No syntax or semantic issues found.');

            const openedDocument = { uri: { toString: () => 'file:///generated-sql.md' } };
            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue(openedDocument);

            await service.generateSqlInteractive();

            expect(gatherSchemaOverviewMock).toHaveBeenCalled();
            expect(service['responseHandler']['sendToLanguageModel']).toHaveBeenCalledWith(
                expect.objectContaining({ ddlContext: 'DATABASE: DB\nTABLES: 1' }),
                'Generate SQL prompt',
                false,
                mockModel
            );
            expect(service['toolsHandler']['validateSqlParser']).toHaveBeenCalledWith('SELECT 1;');
            expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
                expect.objectContaining({
                    language: 'markdown',
                    content: expect.stringContaining('```sql\nSELECT 1;\n```')
                })
            );
            expect(vscode.window.showTextDocument).toHaveBeenCalledWith(openedDocument, vscode.ViewColumn.Beside);
        });

        it('falls back to interactive chat when response does not contain SQL', async () => {
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('List top 10 customers');
            (vscode.window.withProgress as jest.Mock).mockImplementation(
                async (_options: unknown, task: (progress: unknown) => Promise<void>) => task({})
            );

            service['contextBuilder']['gatherSchemaOverview'] = jest.fn().mockResolvedValue('DATABASE: DB\nTABLES: 1');
            service['contextBuilder']['buildGenerateSqlPrompt'] = jest.fn().mockReturnValue('Generate SQL prompt');
            service['modelSelector']['getModel'] = jest.fn().mockResolvedValue(mockModel);
            service['responseHandler']['sendToLanguageModel'] = jest
                .fn()
                .mockResolvedValue('I recommend joining CUSTOMER and ORDERS tables.');
            service['responseHandler']['sendToChatInteractiveWithCustomPrompt'] = jest.fn().mockResolvedValue(undefined);

            await service.generateSqlInteractive();

            expect(service['responseHandler']['sendToChatInteractiveWithCustomPrompt']).toHaveBeenCalledWith(
                'Generate SQL prompt',
                'Generate SQL'
            );
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'Copilot response did not include SQL code. Opened interactive chat to refine generation.'
            );
        });
    });

    describe('Describe Data with Copilot', () => {
        it('should describe data successfully', async () => {
            const testData = [
                { id: 1, name: 'John', amount: 100 },
                { id: 2, name: 'Jane', amount: 200 }
            ];

            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Yes, Send to Copilot');

            await service.describeDataWithCopilot(testData, 'SELECT * FROM users');

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.chat.open', expect.any(Object));
        });

        it('should handle empty data', async () => {
            await service.describeDataWithCopilot([], 'SELECT * FROM users');

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No data to describe');
            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
        });

        it('should handle when user cancels data send', async () => {
            const testData = [{ id: 1, name: 'John' }];
            (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Cancel');

            await service.describeDataWithCopilot(testData);

            expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Data analysis cancelled - no data was sent.');
        });

        it('should handle describe data error', async () => {
            const testData = [{ id: 1, name: 'John' }];
            const showWarningMock = jest.fn().mockImplementation(() => {
                throw new Error('Send error');
            });
            (vscode.window.showWarningMessage as any) = showWarningMock;

            await service.describeDataWithCopilot(testData);

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Failed to send data to Copilot: Send error');
        });
    });

    describe('Fix SQL Error', () => {
    it('should handle empty SQL', async () => {
        await service.fixSqlError('Some error', '');

        expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL to fix');
    });

    it('should cancel operation when user declines privacy confirmation', async () => {
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Cancel');

        await service.fixSqlError('Syntax error', 'SELECT * FROM users');

        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Operation cancelled - no data was sent.');
    });

    it('should proceed when user selects "Don\'t ask again"', async () => {
        const mockConfig = {
            get: jest.fn().mockReturnValue(false),
            update: jest.fn().mockResolvedValue(undefined)
        };
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue(mockConfig);
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce("Don't ask again");

        await service.fixSqlError('Syntax error', 'SELECT * FROM users');

        // Verify the setting was updated - check first call arguments
        const firstCall = mockConfig.update.mock.calls[0];
        expect(firstCall[0]).toBe('skipPrivacyConfirmation');
        expect(firstCall[1]).toBe(true);
    });
});



    describe('Show Available Models', () => {
        it('should show available models', async () => {
            const models = [
                { id: 'model-1', name: 'Model 1', vendor: 'copilot', family: 'gpt-4', maxInputTokens: 128000 },
                { id: 'model-2', name: 'Model 2', vendor: 'copilot', family: 'gpt-3', maxInputTokens: 32000 }
            ];
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue(models as any);
            (vscode.workspace.openTextDocument as jest.Mock).mockResolvedValue({
                uri: { toString: () => 'file:///models.md' }
            });

            await service.showAvailableModels();

            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
            expect(vscode.window.showTextDocument).toHaveBeenCalled();
        });

        it('should handle no models available', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

            await service.showAvailableModels();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No Language Models available');
            expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
        });

        it('should handle show available models error', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockRejectedValue(new Error('Models error'));

            await service.showAvailableModels();

            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith('Error getting models: Models error');
        });
    });

    describe('Chat Participant Registration', () => {
        it('should register chat participant successfully', () => {
            const mockParticipant = {
                iconPath: undefined,
                followupProvider: undefined
            };
            (vscode.chat.createChatParticipant as jest.Mock).mockReturnValue(mockParticipant);
            (vscode.Uri.joinPath as jest.Mock).mockReturnValue({ toString: () => 'file:///icon.png' });

            const result = service.registerChatParticipant(mockContext);

            expect(result).toBeDefined();
            expect(vscode.chat.createChatParticipant).toHaveBeenCalledWith('netezza.sqlcopilot', expect.any(Function));
        });

        it('should handle chat participant registration error', () => {
            (vscode.chat.createChatParticipant as jest.Mock).mockImplementation(() => {
                throw new Error('Registration failed');
            });

            const result = service.registerChatParticipant(mockContext);

            expect(result).toBeUndefined();
        });
    });

    describe('Gather Context', () => {
        it('should gather context from active editor', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            const context = await service.gatherContext();

            expect(context.selectedSql).toBe('SELECT * FROM users');
            expect(context.connectionInfo).toContain('test-connection');
        });

        it('should handle no active editor', async () => {
            (vscode.window.activeTextEditor as any) = undefined;

            await expect(service.gatherContext()).rejects.toThrow('No active editor');
        });

        it('should handle empty SQL', async () => {
            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue(''),
                    uri: { toString: () => 'file:///test.sql' }
                },
                selection: { isEmpty: true }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            await expect(service.gatherContext()).rejects.toThrow('No SQL selected or document is empty');
        });
    });

    describe('Tool call stream handling', () => {
        it('should stream text parts when no tool calls are present', async () => {
            const response = {
                stream: (async function* () {
                    yield new (vscode as unknown as { LanguageModelTextPart: new (value: string) => unknown }).LanguageModelTextPart('Hello from model');
                })()
            };
            const stream = { markdown: jest.fn(), progress: jest.fn() };
            const request = {
                model: { sendRequest: jest.fn() },
                toolInvocationToken: 'token-1'
            };

            await service['handleToolCalls'](
                response as unknown as vscode.LanguageModelChatResponse,
                [],
                stream as unknown as vscode.ChatResponseStream,
                request as unknown as vscode.ChatRequest,
                {},
                {} as vscode.CancellationToken
            );

            expect(stream.markdown).toHaveBeenCalledWith('Hello from model');
            expect(request.model.sendRequest).not.toHaveBeenCalled();
        });

        it('should execute tool calls and stream follow-up text', async () => {
            const toolCall = new (vscode as unknown as { LanguageModelToolCallPart: new (name: string, input: unknown, callId: string) => unknown }).LanguageModelToolCallPart(
                'netezza_get_tables',
                { database: 'DB1' },
                'call-42'
            );
            const response = {
                stream: (async function* () {
                    yield new (vscode as unknown as { LanguageModelTextPart: new (value: string) => unknown }).LanguageModelTextPart('Initial text');
                    yield toolCall;
                })()
            };
            const stream = { markdown: jest.fn(), progress: jest.fn() };
            const request = {
                toolInvocationToken: 'token-2',
                model: {
                    sendRequest: jest.fn().mockResolvedValue({
                        text: (async function* () {
                            yield 'Follow-up text';
                        })()
                    })
                }
            };

            (vscode.lm.invokeTool as jest.Mock).mockResolvedValue({
                content: [new (vscode as unknown as { LanguageModelTextPart: new (value: string) => unknown }).LanguageModelTextPart('tool output')]
            });

            await service['handleToolCalls'](
                response as unknown as vscode.LanguageModelChatResponse,
                [],
                stream as unknown as vscode.ChatResponseStream,
                request as unknown as vscode.ChatRequest,
                {},
                {} as vscode.CancellationToken
            );

            expect(vscode.lm.invokeTool).toHaveBeenCalledWith(
                'netezza_get_tables',
                expect.objectContaining({
                    input: { database: 'DB1' },
                    toolInvocationToken: 'token-2'
                }),
                expect.anything()
            );
            expect(request.model.sendRequest).toHaveBeenCalledTimes(1);
            expect(stream.markdown).toHaveBeenCalledWith('Initial text');
            expect(stream.markdown).toHaveBeenCalledWith('Follow-up text');
        });
    });



    describe('Change Model', () => {
        it('should handle change model when no model selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            await service.changeModel();

            expect(mockContext.workspaceState.update).not.toHaveBeenCalled();
        });

        it('should handle change model with no models available', async () => {
            (vscode.lm.selectChatModels as jest.Mock).mockResolvedValue([]);

            await service.changeModel();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No AI models detected. Ensure GitHub Copilot is installed and you are signed in.');
        });
    });
});

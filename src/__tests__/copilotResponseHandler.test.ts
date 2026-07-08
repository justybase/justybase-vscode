/* eslint-disable @typescript-eslint/no-explicit-any */

import * as vscode from 'vscode';
import { CopilotResponseHandler } from '../services/copilot/CopilotResponseHandler';
import { CopilotPromptManager } from '../services/copilot/CopilotPromptManager';

jest.mock('vscode', () => ({
    Uri: { parse: jest.fn(), joinPath: jest.fn(), file: jest.fn() },
    window: {
        activeTextEditor: undefined,
        createStatusBarItem: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        showErrorMessage: jest.fn(),
        showQuickPick: jest.fn()
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
        openTextDocument: jest.fn().mockResolvedValue({
            uri: { toString: () => 'file:///test.sql' },
            fileName: '/test/test.sql',
            languageId: 'sql',
            lineCount: 1,
            getText: jest.fn().mockReturnValue('SELECT * FROM users')
        }),
        applyEdit: jest.fn()
    },
    Range: jest.fn(),
    Position: jest.fn(),
    StatusBarAlignment: { Right: 1, Left: 2 },
    ViewColumn: { One: 1, Two: 2, Beside: 3 },
    WorkspaceEdit: jest.fn().mockImplementation(() => ({
        replace: jest.fn()
    })),
    env: {
        language: 'en'
    },
    LanguageModelChatMessage: {
        User: jest.fn()
    },
    CancellationTokenSource: jest.fn().mockImplementation(() => {
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: jest.fn().mockReturnValue({
                dispose: jest.fn()
            })
        };
        return {
            token,
            dispose: jest.fn(),
            cancel: jest.fn()
        };
    })
}), { virtual: true });

describe('CopilotResponseHandler', () => {
    let handler: CopilotResponseHandler;
    let mockPromptManager: jest.Mocked<CopilotPromptManager>;

    beforeEach(() => {
        jest.clearAllMocks();

        mockPromptManager = {
            getPrompt: jest.fn(),
            buildSystemPrompt: jest.fn()
        } as any;

        handler = new CopilotResponseHandler(mockPromptManager);
    });

    describe('selectCopilotMode', () => {
        it('should return auto mode when selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Auto',
                value: 'auto'
            });

            const result = await handler.selectCopilotMode('Fix SQL');

            expect(result).toBe('auto');
            expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({ label: expect.stringContaining('Auto') }),
                    expect.objectContaining({ label: expect.stringContaining('Chat') })
                ]),
                { placeHolder: 'Fix SQL - Select mode' }
            );
        });

        it('should return chat mode when selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({
                label: 'Chat',
                value: 'chat'
            });

            const result = await handler.selectCopilotMode('Optimize SQL');

            expect(result).toBe('chat');
        });

        it('should return undefined when no mode selected', async () => {
            (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

            const result = await handler.selectCopilotMode('Fix SQL');

            expect(result).toBeUndefined();
        });
    });

    describe('sendToLanguageModel', () => {
        it('should throw error when no model provided', async () => {
            const copilotContext = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };

            await expect(
                handler.sendToLanguageModel(copilotContext as any, 'Test', false, undefined as any)
            ).rejects.toThrow('No language model available');
        });
    });

    describe('sendToChatInteractive', () => {
        it('should send to chat with context', async () => {
            const copilotContext = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: 'CREATE TABLE users (id INT);',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };
            const userPrompt = 'Explain this query';

            mockPromptManager.buildSystemPrompt.mockReturnValue('System prompt');

            await handler.sendToChatInteractive(copilotContext as any, userPrompt, 'Explain SQL');

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'workbench.action.chat.open',
                { query: expect.stringContaining('System prompt') }
            );
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                '✅ Explain SQL sent to Copilot Chat. Check the Chat panel for interactive discussion.'
            );
        });
    });

    describe('sendToChatInteractiveWithCustomPrompt', () => {
        it('should send custom prompt to chat', async () => {
            const customPrompt = 'Generate SQL for user request';
            const title = 'Generate SQL';

            await handler.sendToChatInteractiveWithCustomPrompt(customPrompt, title);

            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'workbench.action.chat.open',
                { query: customPrompt }
            );
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                '✅ Generate SQL sent to Copilot Chat. Describe your query requirements for interactive SQL generation.'
            );
        });
    });

    describe('isProcedureCode', () => {
        it('should detect procedure code with CREATE PROCEDURE', () => {
            const sql = 'CREATE PROCEDURE test_proc() BEGIN SELECT 1; END;';
            expect(handler.isProcedureCode(sql)).toBe(true);
        });

        it('should detect procedure code with CREATE OR REPLACE PROCEDURE', () => {
            const sql = 'CREATE OR REPLACE PROCEDURE test_proc() BEGIN SELECT 1; END;';
            expect(handler.isProcedureCode(sql)).toBe(true);
        });

        it('should detect procedure code with lowercase create', () => {
            const sql = 'create procedure test_proc() BEGIN SELECT 1; END;';
            expect(handler.isProcedureCode(sql)).toBe(true);
        });

        it('should return false for regular SELECT', () => {
            const sql = 'SELECT * FROM users;';
            expect(handler.isProcedureCode(sql)).toBe(false);
        });

        it('should return false for CREATE TABLE', () => {
            const sql = 'CREATE TABLE users (id INT);';
            expect(handler.isProcedureCode(sql)).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(handler.isProcedureCode('')).toBe(false);
        });
    });

    describe('convertDataToMarkdown', () => {
        it('should convert data to markdown table', () => {
            const data = [
                { id: 1, name: 'John', email: 'john@test.com' },
                { id: 2, name: 'Jane', email: 'jane@test.com' }
            ];

            const result = handler.convertDataToMarkdown(data);

            expect(result).toContain('| id | name | email |');
            expect(result).toContain('| --- | --- | --- |');
            expect(result).toContain('| 1 | John | john@test.com |');
            expect(result).toContain('| 2 | Jane | jane@test.com |');
        });

        it('should handle null and undefined values', () => {
            const data = [
                { id: 1, name: 'John', email: null },
                { id: 2, name: undefined, email: 'jane@test.com' }
            ];

            const result = handler.convertDataToMarkdown(data);

            expect(result).toContain('| NULL |');
        });

        it('should limit to 50 rows', () => {
            const data = Array.from({ length: 100 }, (_, i) => ({
                id: i,
                name: `User${i}`
            }));

            const result = handler.convertDataToMarkdown(data);

            expect(result).toContain('... and 50 more rows (total: 100 rows)');
        });

        it('should return message for empty data', () => {
            const result = handler.convertDataToMarkdown([]);

            expect(result).toBe('*No data*');
        });

        it('should escape pipe characters', () => {
            const data = [
                { id: 1, description: 'test|pipe' }
            ];

            const result = handler.convertDataToMarkdown(data);

            expect(result).toContain('\\|');
        });

        it('should truncate long values', () => {
            const data = [
                { id: 1, description: 'a'.repeat(150) }
            ];

            const result = handler.convertDataToMarkdown(data);

            expect(result).toContain('...');
            expect(result).not.toContain('a'.repeat(150));
        });
    });

    describe('edge cases and error handling', () => {
        it('should handle empty response from model', async () => {
            const copilotContext = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };
            const userPrompt = 'Test';
            const mockModel = {
                id: 'test-model',
                sendRequest: jest.fn().mockResolvedValue({
                    text: (async function* () {})()
                })
            };

            mockPromptManager.buildSystemPrompt.mockReturnValue('System prompt');

            const result = await handler.sendToLanguageModel(
                copilotContext as any,
                userPrompt,
                false,
                mockModel as any
            );

            expect(result).toBe('');
        });

        it('should handle model with no code block in response', async () => {
            const copilotContext = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };
            const userPrompt = 'Test';
            const mockModel = {
                id: 'test-model',
                sendRequest: jest.fn().mockResolvedValue({
                    text: (async function* () {
                        yield 'Here is your SQL:\nSELECT * FROM users';
                    })()
                })
            };

            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' },
                    fileName: '/test/test.sql',
                    languageId: 'sql',
                    lineCount: 1
                },
                selection: {
                    isEmpty: true,
                    start: new vscode.Position(0, 0),
                    end: new vscode.Position(0, 0)
                }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockPromptManager.buildSystemPrompt.mockReturnValue('System prompt');

            await handler.sendToLanguageModel(
                copilotContext as any,
                userPrompt,
                true,
                mockModel as any
            );

            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
        });

        it('should handle multiple code blocks in response', async () => {
            const copilotContext = {
                selectedSql: 'SELECT * FROM users',
                ddlContext: '',
                variables: '',
                recentQueries: '',
                connectionInfo: 'Connected'
            };
            const userPrompt = 'Test';
            const mockModel = {
                id: 'test-model',
                sendRequest: jest.fn().mockResolvedValue({
                    text: (async function* () {
                        yield '```sql\nSELECT 1\n```\n\nExplanation\n\n```sql\nSELECT 2\n```';
                    })()
                })
            };

            const mockEditor = {
                document: {
                    getText: jest.fn().mockReturnValue('SELECT * FROM users'),
                    uri: { toString: () => 'file:///test.sql' },
                    fileName: '/test/test.sql',
                    languageId: 'sql',
                    lineCount: 1
                },
                selection: {
                    isEmpty: true,
                    start: new vscode.Position(0, 0),
                    end: new vscode.Position(0, 0)
                }
            };
            (vscode.window.activeTextEditor as any) = mockEditor;

            mockPromptManager.buildSystemPrompt.mockReturnValue('System prompt');

            await handler.sendToLanguageModel(
                copilotContext as any,
                userPrompt,
                true,
                mockModel as any
            );

            expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
        });
    });
});

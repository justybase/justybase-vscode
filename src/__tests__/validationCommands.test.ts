/**
 * Unit tests for commands/validationCommands.ts
 * Tests SQL validation command registration and parser diagnostic publishing
 */

import * as vscode from 'vscode';
import {
    registerValidationCommands,
    initializeSqlValidator,
    getInitializedSqlValidator
} from '../commands/validationCommands';

const mockLinter = {
    lintDocument: jest.fn().mockResolvedValue([]),
    lintSql: jest.fn().mockResolvedValue([]),
    publishValidationErrors: jest.fn(),
    clearDiagnostics: jest.fn(),
    clearAllDiagnostics: jest.fn()
};

const validateMock = jest.fn();

// Mock vscode module
jest.mock('vscode', () => ({
    commands: {
        registerCommand: jest.fn((_id, _callback) => ({ dispose: jest.fn() })),
        executeCommand: jest.fn()
    },
    window: {
        activeTextEditor: undefined,
        showErrorMessage: jest.fn(),
        showWarningMessage: jest.fn(),
        showInformationMessage: jest.fn(),
        withProgress: jest.fn(async (_options, task) => task(
            { report: jest.fn() },
            {
                isCancellationRequested: false,
                onCancellationRequested: jest.fn(() => ({ dispose: jest.fn() }))
            }
        ))
    },
    ProgressLocation: {
        Notification: 15
    },
    workspace: {
        onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() }))
    },
    languages: {
        createDiagnosticCollection: jest.fn(() => ({
            set: jest.fn(),
            delete: jest.fn(),
            clear: jest.fn(),
            dispose: jest.fn()
        }))
    },
    Diagnostic: jest.fn().mockImplementation((range, message, severity) => ({
        range,
        message,
        severity,
        code: undefined,
        source: 'Netezza SQL Validator'
    })),
    Range: jest.fn().mockImplementation((startLine, startCol, endLine, endCol) => ({
        start: { line: startLine, character: startCol },
        end: { line: endLine, character: endCol }
    })),
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
    }
}));

jest.mock('../sqlParser', () => ({
    SqlValidator: jest.fn().mockImplementation(() => ({
        validate: validateMock
    })),
    ValidationError: {}
}));

jest.mock('../sqlParser/sqlCoreBackedValidator', () => ({
    SqlCoreBackedValidator: jest.fn().mockImplementation(() => ({
        validate: validateMock
    }))
}));

jest.mock('../sqlParser/metadataCacheAdapter', () => ({
    createMetadataCacheSchemaProvider: jest.fn()
}));

jest.mock('../core/connectionFactory', () => ({
    getDatabaseSqlAuthoring: jest.fn(() => ({
        validation: {},
        qualityRules: []
    }))
}));

jest.mock('../utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn()
    }))
}));

jest.mock('../providers/sqlLinterProvider', () => ({
    getSqlLinter: jest.fn(() => mockLinter)
}));

jest.mock('../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(() => ({
        get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue)
    }))
}));

function makeDocument(text: string): vscode.TextDocument {
    return {
        uri: { toString: () => 'file:///validate.sql' },
        languageId: 'sql',
        version: 1,
        lineCount: text.split('\n').length,
        getText: jest.fn((range?: vscode.Range) => {
            if (!range) {
                return text;
            }
            return text.slice(range.start.character, range.end.character);
        }),
        positionAt: jest.fn((offset: number) => ({ line: 0, character: offset })),
        offsetAt: jest.fn((position: vscode.Position) => position.character)
    } as unknown as vscode.TextDocument;
}

function getValidateHandler(): () => Promise<void> {
    registerValidationCommands();
    return (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
        call => call[0] === 'netezza.validateSelectedSql'
    )?.[1] as () => Promise<void>;
}

function makeValidationResult(errors: unknown[] = []): unknown {
    return {
        valid: errors.length === 0,
        errors,
        warnings: [],
        scope: { tables: new Map(), ctes: new Map(), level: 0 }
    };
}

describe('commands/validationCommands', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        validateMock.mockReset();
        validateMock.mockReturnValue(makeValidationResult());
        mockLinter.publishValidationErrors.mockReset();
    });

    describe('registerValidationCommands', () => {
        it('should register two commands (validate + clear)', () => {
            const disposables = registerValidationCommands();

            // Should register 2 items: validateSelectedSql and clearValidationResults
            expect(disposables).toHaveLength(2);
        });

        it('should register netezza.validateSelectedSql command', () => {
            registerValidationCommands();

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.validateSelectedSql',
                expect.any(Function)
            );
        });

        it('should register netezza.clearValidationResults command', () => {
            registerValidationCommands();

            expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
                'netezza.clearValidationResults',
                expect.any(Function)
            );
        });

        it('should NOT create its own diagnostic collection (uses linter collection)', () => {
            registerValidationCommands();

            expect(vscode.languages.createDiagnosticCollection).not.toHaveBeenCalled();
        });

        it('should return disposables for cleanup', () => {
            const disposables = registerValidationCommands();

            disposables.forEach(d => {
                expect(d).toHaveProperty('dispose');
            });
        });
    });

    describe('validateSelectedSql command handler', () => {
        it('should show warning when no active editor', async () => {
            const handler = getValidateHandler();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No active editor found');
        });

        it('should show warning for non-SQL files', async () => {
            const handler = getValidateHandler();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'javascript',
                    getText: jest.fn()
                },
                selection: { isEmpty: true }
            };
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'This command only works with supported SQL files'
            );
        });

        it('should show warning for empty SQL', async () => {
            const handler = getValidateHandler();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: makeDocument('   '),
                selection: { isEmpty: true }
            };
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL code to validate');
        });

        it('publishes whole-document parser findings to Problems', async () => {
            const document = makeDocument('SELECT FROM T;');
            validateMock.mockReturnValue(makeValidationResult([
                {
                    code: 'SQL003',
                    message: 'Syntax error',
                    severity: 'error',
                    position: {
                        offset: 7,
                        startLine: 1,
                        startColumn: 8,
                        endLine: 1,
                        endColumn: 9
                    }
                }
            ]));

            const handler = getValidateHandler();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document,
                selection: { isEmpty: true }
            };
            await handler();

            expect(validateMock).toHaveBeenCalledWith('SELECT FROM T;');
            expect(mockLinter.publishValidationErrors).toHaveBeenCalledWith(
                document,
                [expect.objectContaining({ code: 'SQL003' })],
                { baseOffset: 0, source: 'Netezza Parser (on demand)' }
            );
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
                expect.stringMatching(/found 1 error/i)
            );
            expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
                'workbench.actions.view.problems'
            );
        });

        it('publishes selection-relative findings with an absolute offset', async () => {
            const text = 'SELECT FROM T;';
            const document = makeDocument(text);
            const selection = {
                isEmpty: false,
                start: { line: 0, character: 7 },
                end: { line: 0, character: 12 }
            };
            validateMock.mockReturnValue(makeValidationResult([
                {
                    code: 'SQL003',
                    message: 'Syntax error',
                    severity: 'error',
                    position: {
                        offset: 0,
                        startLine: 1,
                        startColumn: 1,
                        endLine: 1,
                        endColumn: 2
                    }
                }
            ]));

            const handler = getValidateHandler();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = { document, selection };
            await handler();

            expect(document.getText).toHaveBeenCalledWith(selection);
            expect(mockLinter.publishValidationErrors).toHaveBeenCalledWith(
                document,
                [expect.objectContaining({ code: 'SQL003' })],
                { baseOffset: 7, source: 'Netezza Parser (selection)' }
            );
        });

        it('treats a full-document selection as whole-document validation', async () => {
            const text = 'SELECT FROM T;';
            const document = makeDocument(text);
            const selection = {
                isEmpty: false,
                start: { line: 0, character: 0 },
                end: { line: 0, character: text.length }
            };

            const handler = getValidateHandler();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = { document, selection };
            await handler();

            expect(mockLinter.publishValidationErrors).toHaveBeenCalledWith(
                document,
                [],
                { baseOffset: 0, source: 'Netezza Parser (on demand)' }
            );
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                'SQL validation passed! No errors or warnings found.'
            );
            expect(vscode.commands.executeCommand).not.toHaveBeenCalledWith(
                'workbench.actions.view.problems'
            );
        });

        it('accepts MSSQL files as supported SQL documents', async () => {
            const handler = getValidateHandler();

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'mssql',
                    getText: jest.fn().mockReturnValue('   ')
                },
                selection: { isEmpty: true }
            };
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL code to validate');
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
                'This command only works with supported SQL files'
            );
        });
    });

    describe('clearValidationResults command handler', () => {
        it('should clear validation for active editor via linter', async () => {
            registerValidationCommands();

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.clearValidationResults'
            )?.[1];

            const mockUri = { toString: () => 'test.sql' };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    uri: mockUri
                }
            };
            await handler();

            expect(mockLinter.clearDiagnostics).toHaveBeenCalledWith(mockUri);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Validation results cleared');
        });

        it('should clear all validation when no active editor', async () => {
            registerValidationCommands();

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.clearValidationResults'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(mockLinter.clearAllDiagnostics).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('All validation results cleared');
        });
    });

    describe('initializeSqlValidator', () => {
        it('should initialize validator with metadata cache', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mockMetadataCache = {} as any;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mockConnectionManager = {} as any;

            initializeSqlValidator(mockMetadataCache, mockConnectionManager);

            // Verify validator instance is created
            expect(getInitializedSqlValidator()).toBeDefined();
        });
    });

    describe('getInitializedSqlValidator', () => {
        it('creates a document-scoped validator after initialization', () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            initializeSqlValidator({} as any, {} as any);
            expect(getInitializedSqlValidator('file:///unknown.sql')).toBeDefined();
        });
    });
});

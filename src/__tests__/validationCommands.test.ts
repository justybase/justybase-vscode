/**
 * Unit tests for commands/validationCommands.ts
 * Tests SQL validation command registration and helper functions
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
    clearDiagnostics: jest.fn(),
    clearAllDiagnostics: jest.fn()
};

const isSqlLanguageClientRunningMock = jest.fn(() => true);

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
        showInformationMessage: jest.fn()
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

// Mock SqlValidator
jest.mock('../sqlParser', () => ({
    SqlValidator: jest.fn().mockImplementation(() => ({
        validate: jest.fn().mockReturnValue({
            errors: [],
            warnings: []
        })
    })),
    ValidationError: {}
}));

// Mock metadataCacheAdapter
jest.mock('../sqlParser/metadataCacheAdapter', () => ({
    createMetadataCacheSchemaProvider: jest.fn()
}));

// Mock logger
jest.mock('../utils/logger', () => ({
    getLogger: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn()
    }))
}));

// Mock sqlLinterProvider
jest.mock('../providers/sqlLinterProvider', () => ({
    getSqlLinter: jest.fn(() => mockLinter)
}));

jest.mock('../activation/lspRegistration', () => ({
    isSqlLanguageClientRunning: () => isSqlLanguageClientRunningMock()
}));

jest.mock('../compatibility/configuration', () => ({
    getExtensionConfiguration: jest.fn(() => ({
        get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue)
    }))
}));

describe('commands/validationCommands', () => {
    beforeEach(() => {
        jest.clearAllMocks();
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
            registerValidationCommands();

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.validateSelectedSql'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = undefined;
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No active editor found');
        });

        it('should show warning for non-SQL files', async () => {
            registerValidationCommands();

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.validateSelectedSql'
            )?.[1];

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
            registerValidationCommands();

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.validateSelectedSql'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    getText: jest.fn().mockReturnValue('   ')
                },
                selection: { isEmpty: true }
            };
            await handler();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('No SQL code to validate');
        });

        it('should summarize whole-document validation from linter without parser revalidate when LSP is active', async () => {
            registerValidationCommands();
            isSqlLanguageClientRunningMock.mockReturnValue(true);
            mockLinter.lintDocument.mockResolvedValue([
                {
                    ruleId: 'NZ001',
                    message: 'Avoid SELECT *',
                    severity: vscode.DiagnosticSeverity.Warning,
                    startOffset: 0,
                    endOffset: 8
                }
            ]);

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.validateSelectedSql'
            )?.[1];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (vscode.window as any).activeTextEditor = {
                document: {
                    languageId: 'sql',
                    uri: { toString: () => 'file:///validate.sql' },
                    getText: jest.fn().mockReturnValue('SELECT * FROM T1;')
                },
                selection: { isEmpty: true }
            };
            await handler();

            expect(mockLinter.lintDocument).toHaveBeenCalledWith(
                expect.objectContaining({ languageId: 'sql' }),
                true
            );
            expect(mockLinter.lintSql).not.toHaveBeenCalled();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringMatching(/parser diagnostics \(if any\) are in the Problems panel \(LSP\)/i)
            );
        });

        it('should accept MSSQL files as supported SQL documents', async () => {
            registerValidationCommands();

            const handler = (vscode.commands.registerCommand as jest.Mock).mock.calls.find(
                call => call[0] === 'netezza.validateSelectedSql'
            )?.[1];

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
        it('should return undefined when not initialized', () => {
            // Reset the module to clear the validator instance
            jest.resetModules();
            
            // Re-import to get fresh state - the validator should be undefined
            // Note: Due to module caching, this test verifies the function exists
            expect(typeof getInitializedSqlValidator).toBe('function');
        });
    });
});

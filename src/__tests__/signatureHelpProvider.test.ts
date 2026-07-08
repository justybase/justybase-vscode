import * as vscode from 'vscode';
import { NetezzaSignatureHelpProvider } from '../providers/signatureHelpProvider';

// Mock vscode module
jest.mock('vscode', () => ({
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3
    },
    SignatureHelp: class SignatureHelp {
        signatures: unknown[] = [];
        activeSignature: number = 0;
        activeParameter: number = 0;
    },
    SignatureInformation: class SignatureInformation {
        label: string;
        documentation: unknown;
        parameters: unknown[] = [];
        constructor(label: string, documentation?: unknown) {
            this.label = label;
            this.documentation = documentation;
        }
    },
    ParameterInformation: class ParameterInformation {
        label: string;
        documentation?: string;
        constructor(label: string, documentation?: string) {
            this.label = label;
            this.documentation = documentation;
        }
    },
    MarkdownString: class MarkdownString {
        value: string;
        constructor(value: string) {
            this.value = value;
        }
    },
    Position: class Position {
        line: number;
        character: number;
        constructor(line: number, character: number) {
            this.line = line;
            this.character = character;
        }
    }
}));

describe('NetezzaSignatureHelpProvider', () => {
    let provider: NetezzaSignatureHelpProvider;

    const createMockDocument = (text: string, _cursorLine: number = 0, _cursorChar: number = 0): vscode.TextDocument => {
        return {
            getText: () => text,
            lineAt: (line: number) => ({
                text: text.split('\n')[line] || '',
                lineNumber: line,
                range: {} as vscode.Range,
                rangeIncludingLineBreak: {} as vscode.Range,
                firstNonWhitespaceCharacterIndex: 0,
                isEmptyOrWhitespace: false
            }),
            uri: {} as vscode.Uri,
            fileName: 'test.sql',
            isUntitled: false,
            languageId: 'sql',
            version: 1,
            isDirty: false,
            isClosed: false,
            save: jest.fn(),
            lineCount: text.split('\n').length,
            positionAt: jest.fn(),
            getWordRangeAtPosition: jest.fn(),
            validateRange: jest.fn(),
            validatePosition: jest.fn(),
            offsetAt: jest.fn()
        } as unknown as vscode.TextDocument;
    };

    beforeEach(() => {
        provider = new NetezzaSignatureHelpProvider();
    });

    describe('provideSignatureHelp', () => {
        it('returns undefined when not inside function call', async () => {
            const sql = 'SELECT id FROM users';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, 10);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeUndefined();
        });

        it('returns signature for COUNT function', async () => {
            const sql = 'SELECT COUNT(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.signatures.length).toBeGreaterThan(0);
            expect(result!.signatures[0].label).toContain('COUNT');
        });

        it('returns signature for SUBSTRING function', async () => {
            const sql = 'SELECT SUBSTRING(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.signatures.length).toBeGreaterThan(0);
            expect(result!.signatures[0].label).toContain('SUBSTRING');
        });

        it('returns correct active parameter for multiple arguments', async () => {
            const sql = 'SELECT SUBSTRING(\'hello\', ';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.activeParameter).toBe(1); // Second parameter
        });

        it('returns signature for COALESCE function', async () => {
            const sql = 'SELECT COALESCE(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.signatures[0].label).toContain('COALESCE');
        });

        it('returns signature for TO_DATE function', async () => {
            const sql = 'SELECT TO_DATE(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.signatures[0].label).toContain('TO_DATE');
            expect(result!.signatures[0].parameters.length).toBe(2);
        });

        it('returns undefined for unknown function', async () => {
            const sql = 'SELECT unknown_function(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeUndefined();
        });

        it('handles nested function calls', async () => {
            const sql = 'SELECT ROUND(AVG(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.signatures[0].label).toContain('AVG');
        });

        it('returns signature for window function LAG', async () => {
            const sql = 'SELECT LAG(';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeDefined();
            expect(result!.signatures[0].label).toContain('LAG');
        });

        it('handles function call after closing parenthesis', async () => {
            const sql = 'SELECT COUNT(*) ';
            const document = createMockDocument(sql);
            const position = new vscode.Position(0, sql.length);
            
            const result = await provider.provideSignatureHelp(document, position, {} as vscode.CancellationToken, {} as vscode.SignatureHelpContext);
            
            expect(result).toBeUndefined();
        });
    });
});

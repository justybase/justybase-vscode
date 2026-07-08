import * as vscode from 'vscode';
import { NetezzaDocumentSymbolProvider } from '../providers/documentSymbolProvider';

// Mock vscode module
jest.mock('vscode', () => ({
    DocumentSymbol: class DocumentSymbol {
        name: string;
        detail: string;
        kind: unknown;
        range: unknown;
        selectionRange: unknown;
        children: unknown[];
        constructor(name: string, detail: string, kind: unknown, range: unknown, selectionRange: unknown) {
            this.name = name;
            this.detail = detail;
            this.kind = kind;
            this.range = range;
            this.selectionRange = selectionRange;
            this.children = [];
        }
    },
    SymbolKind: {
        Struct: 'Struct',
        Variable: 'Variable',
        Class: 'Class',
        Object: 'Object',
        Field: 'Field'
    },
    Range: class Range {
        start: unknown;
        end: unknown;
        constructor(start: unknown, end: unknown) {
            this.start = start;
            this.end = end;
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

// Mock the symbols module to avoid depending on the Chevrotain parser
jest.mock('../sqlParser/symbols', () => ({
    collectSqlSymbolUsages: jest.fn(() => [])
}));

import { collectSqlSymbolUsages } from '../sqlParser/symbols';
const mockedCollect = collectSqlSymbolUsages as jest.MockedFunction<typeof collectSqlSymbolUsages>;

describe('NetezzaDocumentSymbolProvider', () => {
    let provider: NetezzaDocumentSymbolProvider;

    const createMockDocument = (text: string): vscode.TextDocument => {
        return {
            getText: () => text,
            positionAt: (offset: number) => {
                let line = 0;
                let character = 0;
                for (let i = 0; i < offset && i < text.length; i++) {
                    if (text[i] === '\n') {
                        line++;
                        character = 0;
                    } else {
                        character++;
                    }
                }
                return new vscode.Position(line, character);
            },
            uri: {} as vscode.Uri,
            fileName: 'test.sql',
            isUntitled: false,
            languageId: 'sql',
            version: 1,
            isDirty: false,
            isClosed: false,
            save: jest.fn(),
            lineCount: text.split('\n').length,
            lineAt: jest.fn(),
            getWordRangeAtPosition: jest.fn(),
            validateRange: jest.fn(),
            validatePosition: jest.fn(),
            offsetAt: jest.fn()
        } as unknown as vscode.TextDocument;
    };

    beforeEach(() => {
        provider = new NetezzaDocumentSymbolProvider();
        mockedCollect.mockReset();
        mockedCollect.mockReturnValue([]);
    });

    describe('provideDocumentSymbols', () => {
        it('returns empty array for empty document', async () => {
            const document = createMockDocument('');
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);
            expect(symbols).toEqual([]);
        });

        it('returns empty array for whitespace-only document', async () => {
            const document = createMockDocument('   \n   \n   ');
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);
            expect(symbols).toEqual([]);
        });

        it('returns CTE symbol for simple CTE', async () => {
            const sql = `WITH my_cte AS (
                SELECT id, name FROM users
            )
            SELECT * FROM my_cte;`;

            mockedCollect.mockReturnValue([
                {
                    kind: 'cte',
                    name: 'my_cte',
                    occurrences: [
                        { kind: 'cte', role: 'definition', startOffset: 5, endOffset: 11, text: 'my_cte' },
                        { kind: 'cte', role: 'reference', startOffset: 83, endOffset: 89, text: 'my_cte' }
                    ]
                }
            ]);

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);

            expect(symbols).toBeDefined();
            expect(symbols!.length).toBeGreaterThan(0);

            const cteSymbol = symbols!.find(s => s.name.toUpperCase() === 'MY_CTE');
            expect(cteSymbol).toBeDefined();
        });

        it('returns multiple CTE symbols for multiple CTEs', async () => {
            const sql = `WITH 
                cte1 AS (SELECT id FROM table1),
                cte2 AS (SELECT id FROM table2)
            SELECT * FROM cte1 JOIN cte2 ON cte1.id = cte2.id;`;

            mockedCollect.mockReturnValue([
                {
                    kind: 'cte',
                    name: 'cte1',
                    occurrences: [
                        { kind: 'cte', role: 'definition', startOffset: 22, endOffset: 26, text: 'cte1' },
                        { kind: 'cte', role: 'reference', startOffset: 110, endOffset: 114, text: 'cte1' }
                    ]
                },
                {
                    kind: 'cte',
                    name: 'cte2',
                    occurrences: [
                        { kind: 'cte', role: 'definition', startOffset: 55, endOffset: 59, text: 'cte2' },
                        { kind: 'cte', role: 'reference', startOffset: 120, endOffset: 124, text: 'cte2' }
                    ]
                }
            ]);

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);

            expect(symbols).toBeDefined();

            const cte1Symbol = symbols!.find(s => s.name.toUpperCase() === 'CTE1');
            const cte2Symbol = symbols!.find(s => s.name.toUpperCase() === 'CTE2');

            expect(cte1Symbol).toBeDefined();
            expect(cte2Symbol).toBeDefined();
        });

        it('returns table alias symbol', async () => {
            const sql = `SELECT u.id, u.name FROM users u WHERE u.active = 1;`;

            mockedCollect.mockReturnValue([
                {
                    kind: 'table_alias',
                    name: 'u',
                    occurrences: [
                        { kind: 'table_alias', role: 'definition', startOffset: 31, endOffset: 32, text: 'u' },
                        { kind: 'table_alias', role: 'reference', startOffset: 7, endOffset: 8, text: 'u' },
                        { kind: 'table_alias', role: 'reference', startOffset: 13, endOffset: 14, text: 'u' },
                        { kind: 'table_alias', role: 'reference', startOffset: 39, endOffset: 40, text: 'u' }
                    ]
                }
            ]);

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);

            expect(symbols).toBeDefined();

            const aliasSymbol = symbols!.find(s => s.name.toUpperCase() === 'U');
            expect(aliasSymbol).toBeDefined();
        });

        it('returns macro variable symbols for %let declarations', async () => {
            const sql = `%let x=5;

SELECT &x;`;

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);

            expect(symbols).toBeDefined();
            const macroSymbol = symbols!.find(s => s.name === 'x');
            expect(macroSymbol).toBeDefined();
            expect(macroSymbol!.detail).toBe('Macro variable (1 reference)');
            expect(macroSymbol!.kind).toBe('Variable');
            expect(macroSymbol!.children).toHaveLength(1);
            expect(macroSymbol!.children[0].name).toBe('&x');
        });

        it('counts all supported macro variable reference forms in outline details', async () => {
            const sql = `%let points_cutoff=5;
SELECT &points_cutoff, $points_cutoff, \${ points_cutoff };`;

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);
            const macroSymbol = symbols!.find(s => s.name === 'points_cutoff');

            expect(macroSymbol).toBeDefined();
            expect(macroSymbol!.detail).toBe('Macro variable (3 references)');
            expect(macroSymbol!.children.map(child => child.name)).toEqual([
                '&points_cutoff',
                '$points_cutoff',
                '${ points_cutoff }',
            ]);
        });

        it('returns every macro variable declaration when names are redefined', async () => {
            const sql = `%let x=5;
%let x=10;
SELECT &x;`;

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);
            const macroSymbols = symbols!.filter(s => s.name === 'x');

            expect(macroSymbols).toHaveLength(2);
            expect(macroSymbols[0].detail).toBe('Macro variable (0 references)');
            expect(macroSymbols[1].detail).toBe('Macro variable (1 reference)');
        });

        it('returns temp table symbol for CREATE TEMP TABLE', async () => {
            const sql = `CREATE TEMP TABLE temp_users AS SELECT id FROM users;
            SELECT * FROM temp_users;`;

            mockedCollect.mockReturnValue([
                {
                    kind: 'table',
                    name: 'temp_users',
                    occurrences: [
                        { kind: 'table', role: 'definition', startOffset: 18, endOffset: 28, text: 'temp_users' },
                        { kind: 'table', role: 'reference', startOffset: 80, endOffset: 90, text: 'temp_users' }
                    ]
                }
            ]);

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);

            expect(symbols).toBeDefined();

            const tempTableSymbol = symbols!.find(s => s.name.toUpperCase() === 'TEMP_USERS');
            expect(tempTableSymbol).toBeDefined();
        });

        it('includes reference count in symbol detail', async () => {
            const sql = `WITH my_cte AS (SELECT id FROM users)
            SELECT * FROM my_cte WHERE my_cte.id = 1;`;

            mockedCollect.mockReturnValue([
                {
                    kind: 'cte',
                    name: 'my_cte',
                    occurrences: [
                        { kind: 'cte', role: 'definition', startOffset: 5, endOffset: 11, text: 'my_cte' },
                        { kind: 'cte', role: 'reference', startOffset: 52, endOffset: 58, text: 'my_cte' },
                        { kind: 'cte', role: 'reference', startOffset: 65, endOffset: 71, text: 'my_cte' }
                    ]
                }
            ]);

            const document = createMockDocument(sql);
            const symbols = await provider.provideDocumentSymbols(document, {} as vscode.CancellationToken);

            expect(symbols).toBeDefined();

            const cteSymbol = symbols!.find(s => s.name.toUpperCase() === 'MY_CTE');
            expect(cteSymbol).toBeDefined();
            expect(cteSymbol!.detail).toContain('reference');
        });
    });
});

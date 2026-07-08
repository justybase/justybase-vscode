import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { performance } from 'perf_hooks';

jest.unmock('chevrotain');

import * as vscode from 'vscode';
import { NetezzaDocumentLinkProvider } from '../providers/documentLinkProvider';
import { NetezzaParserNavigationProvider } from '../providers/parserNavigationProvider';
import { NetezzaRegexReferenceProvider } from '../providers/regexReferenceProvider';
import { NetezzaRenameProvider } from '../providers/renameProvider';
import { NetezzaFoldingRangeProvider } from '../providers/foldingProvider';
import { SqlParser } from '../sql/sqlParser';

jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        getObjectAtPosition: jest.fn(),
        getStatementAtPosition: jest.fn(),
        splitStatementsWithPositions: jest.fn((text: string) => {
            const statements: Array<{
                sql: string;
                startOffset: number;
                endOffset: number;
            }> = [];
            let segmentStart = 0;

            for (let index = 0; index <= text.length; index += 1) {
                if (index !== text.length && text[index] !== ';') {
                    continue;
                }

                const raw = text.slice(segmentStart, index);
                const trimmed = raw.trim();
                if (trimmed) {
                    const startOffset = raw.indexOf(trimmed) + segmentStart;
                    statements.push({
                        sql: trimmed,
                        startOffset,
                        endOffset: index,
                    });
                }
                segmentStart = index + 1;
            }

            return statements.length > 0
                ? statements
                : [{ sql: text, startOffset: 0, endOffset: text.length }];
        }),
    },
}));

class MockLocation {
    constructor(
        public uri: vscode.Uri,
        public range: vscode.Range
    ) {}
}

class MockFoldingRange {
    constructor(
        public start: number,
        public end: number,
        public kind?: unknown
    ) {}
}

class MockWorkspaceEdit {
    public inserts: Array<{ uri: vscode.Uri; position: vscode.Position; text: string }> = [];
    public replacements: Array<{ uri: vscode.Uri; range: vscode.Range; text: string }> = [];
    public deletions: Array<{ uri: vscode.Uri; range: vscode.Range }> = [];

    insert(uri: vscode.Uri, position: vscode.Position, text: string): void {
        this.inserts.push({ uri, position, text });
    }

    replace(uri: vscode.Uri, range: vscode.Range, text: string): void {
        this.replacements.push({ uri, range, text });
    }

    delete(uri: vscode.Uri, range: vscode.Range): void {
        this.deletions.push({ uri, range });
    }
}

class MockCodeAction {
    public diagnostics?: vscode.Diagnostic[];
    public isPreferred?: boolean;
    public edit?: MockWorkspaceEdit;

    constructor(
        public title: string,
        public kind: unknown
    ) {}
}

type LinterCodeActionProviderType = typeof import('../providers/linterCodeActions').NetezzaLinterCodeActionProvider;
let NetezzaLinterCodeActionProvider: LinterCodeActionProviderType;

describe('provider utilities', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        (vscode as unknown as { Location: typeof MockLocation }).Location = MockLocation;
        (vscode as unknown as { FoldingRange: typeof MockFoldingRange }).FoldingRange = MockFoldingRange;
        (vscode as unknown as { FoldingRangeKind: { Region: string } }).FoldingRangeKind = { Region: 'region' };
        (vscode as unknown as { WorkspaceEdit: typeof MockWorkspaceEdit }).WorkspaceEdit = MockWorkspaceEdit;
        (vscode as unknown as { CodeAction: typeof MockCodeAction }).CodeAction = MockCodeAction;
        (vscode as unknown as { CodeActionKind: { QuickFix: string; SourceFixAll: string } }).CodeActionKind = {
            QuickFix: 'quickfix',
            SourceFixAll: 'source.fixAll'
        };
        NetezzaLinterCodeActionProvider = require('../providers/linterCodeActions').NetezzaLinterCodeActionProvider;
    });

    describe('NetezzaRenameProvider', () => {
        const createDocument = (text: string): vscode.TextDocument =>
            ({
                uri: { fsPath: 'D:\\test.sql', toString: () => 'file:///D:/test.sql' } as vscode.Uri,
                getText: jest.fn(() => text),
                positionAt: jest.fn((offset: number) => new vscode.Position(0, offset)),
                offsetAt: jest.fn((position: vscode.Position) => position.character)
            }) as unknown as vscode.TextDocument;

        it('renames CTE definition and references in statement scope', async () => {
            const sql = `WITH CTE AS (
    SELECT * FROM 
    JUST_DATA..DEPARTMENT
    WHERE ID > 0
)


SELECT * FROM CTE
WHERE ID > 0`;
            const document = createDocument(sql);
            const provider = new NetezzaRenameProvider();
            const position = new vscode.Position(0, sql.indexOf('CTE') + 1);

            const renameResult = await provider.provideRenameEdits(
                document,
                position,
                'CTE_NEW',
                {} as vscode.CancellationToken
            );

            expect(renameResult).toBeInstanceOf(MockWorkspaceEdit);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements).toHaveLength(2);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements.every(r => r.text === 'CTE_NEW')).toBe(true);
        });

        it('renames table alias definition and qualifier references', async () => {
            const sql = `SELECT * FROM 
JUST_DATA..DEPARTMENT ALIAS1
WHERE ALIAS1.ID > 0`;
            const document = createDocument(sql);
            const provider = new NetezzaRenameProvider();
            const position = new vscode.Position(0, sql.indexOf('ALIAS1') + 1);

            const renameResult = await provider.provideRenameEdits(
                document,
                position,
                'A2',
                {} as vscode.CancellationToken
            );

            expect(renameResult).toBeInstanceOf(MockWorkspaceEdit);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements).toHaveLength(2);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements.every(r => r.text === 'A2')).toBe(true);
        });

        it('supports cursor at end of symbol', async () => {
            const sql = 'WITH CTE AS (SELECT 1) SELECT * FROM CTE';
            const document = createDocument(sql);
            const provider = new NetezzaRenameProvider();
            const symbolEnd = sql.indexOf('CTE') + 3;
            const position = new vscode.Position(0, symbolEnd);

            const prepareResult = await provider.prepareRename(
                document,
                position,
                {} as vscode.CancellationToken
            );

            expect(prepareResult).toBeDefined();
        });

        it('renames created temp table references across document', async () => {
            const sql = `CREATE TEMP TABLE AVC AS
SELECT A.ACCOUNTKEY FROM JUST_DATA..DIMACCOUNT A;

SELECT Y.ACCOUNTKEY FROM AVC Y ;

DROP TABLE AVC IF EXISTS;`;
            const document = createDocument(sql);
            const provider = new NetezzaRenameProvider();
            const position = new vscode.Position(0, sql.indexOf('AVC') + 1);

            const renameResult = await provider.provideRenameEdits(
                document,
                position,
                'AVC_NEW',
                {} as vscode.CancellationToken
            );

            expect(renameResult).toBeInstanceOf(MockWorkspaceEdit);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements).toHaveLength(3);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements.every(r => r.text === 'AVC_NEW')).toBe(true);
        });

        it('returns undefined for non-renameable symbol', async () => {
            const sql = 'SELECT id FROM my_table';
            const document = createDocument(sql);
            const provider = new NetezzaRenameProvider();
            const position = new vscode.Position(0, sql.indexOf('my_table') + 1);

            const prepareResult = await provider.prepareRename(
                document,
                position,
                {} as vscode.CancellationToken
            );

            expect(prepareResult).toBeUndefined();
        });

        it('renames MERGE target alias without touching the source alias', async () => {
            const sql = `MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMDATE S
ON T.ACCOUNTKEY = S.DATEKEY
WHEN MATCHED THEN UPDATE SET T.ACCOUNTNAME = S.CALENDARQUARTER`;
            const document = createDocument(sql);
            const provider = new NetezzaRenameProvider();
            const position = new vscode.Position(0, sql.indexOf(' T\n') + 2);

            const renameResult = await provider.provideRenameEdits(
                document,
                position,
                'TARGET',
                {} as vscode.CancellationToken
            );

            expect(renameResult).toBeInstanceOf(MockWorkspaceEdit);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements).toHaveLength(3);
            expect((renameResult as unknown as MockWorkspaceEdit).replacements.every(r => r.text === 'TARGET')).toBe(true);
        });
    });

    describe('NetezzaParserNavigationProvider', () => {
        const createDocument = (text: string): vscode.TextDocument => {
            const lines = text.split('\n');
            const getOffsetFromPosition = (position: vscode.Position): number => {
                let offset = 0;
                for (let i = 0; i < position.line; i++) {
                    offset += lines[i].length + 1;
                }
                return offset + position.character;
            };
            const getPositionFromOffset = (offset: number): vscode.Position => {
                let remaining = offset;
                for (let i = 0; i < lines.length; i++) {
                    const lineLength = lines[i].length + 1;
                    if (remaining < lineLength) {
                        return new vscode.Position(i, remaining);
                    }
                    remaining -= lineLength;
                }
                const lastLine = lines.length - 1;
                return new vscode.Position(lastLine, lines[lastLine].length);
            };

            return {
                uri: { fsPath: 'D:\\test.sql', toString: () => 'file:///D:/test.sql' } as vscode.Uri,
                getText: jest.fn(() => text),
                offsetAt: jest.fn((position: vscode.Position) => getOffsetFromPosition(position)),
                positionAt: jest.fn((offset: number) => getPositionFromOffset(offset))
            } as unknown as vscode.TextDocument;
        };

        it('provides parser-based definition for CTE reference', async () => {
            const sql = 'WITH CTE AS (SELECT 1 AS ID) SELECT * FROM CTE';
            const document = createDocument(sql);
            const provider = new NetezzaParserNavigationProvider();
            const referenceOffset = sql.lastIndexOf('CTE') + 1;
            const position = document.positionAt(referenceOffset);

            const result = await provider.provideDefinition(document, position, {} as vscode.CancellationToken);

            expect(result).toBeInstanceOf(MockLocation);
            expect((result as MockLocation).range.start.character).toBe(sql.indexOf('CTE'));
        });

        it('provides parser-based references and honors includeDeclaration flag', async () => {
            const sql = 'WITH CTE AS (SELECT 1 AS ID) SELECT * FROM CTE';
            const document = createDocument(sql);
            const provider = new NetezzaParserNavigationProvider();
            const position = document.positionAt(sql.lastIndexOf('CTE') + 1);

            const refsWithoutDefinition = await provider.provideReferences(
                document,
                position,
                { includeDeclaration: false } as vscode.ReferenceContext,
                {} as vscode.CancellationToken
            );
            const refsWithDefinition = await provider.provideReferences(
                document,
                position,
                { includeDeclaration: true } as vscode.ReferenceContext,
                {} as vscode.CancellationToken
            );

            expect(refsWithoutDefinition).toHaveLength(1);
            expect(refsWithDefinition).toHaveLength(2);
        });

        it('provides parser-based definition and references for MERGE target aliases', async () => {
            const sql = `MERGE INTO JUST_DATA..DIMACCOUNT T
USING JUST_DATA..DIMDATE S
ON T.ACCOUNTKEY = S.DATEKEY
WHEN MATCHED THEN UPDATE SET T.ACCOUNTNAME = S.CALENDARQUARTER`;
            const document = createDocument(sql);
            const provider = new NetezzaParserNavigationProvider();
            const referenceOffset = sql.indexOf('T.ACCOUNTKEY') + 1;
            const definitionOffset = sql.indexOf(' T\n') + 1;
            const position = document.positionAt(referenceOffset);

            const definition = await provider.provideDefinition(
                document,
                position,
                {} as vscode.CancellationToken
            );
            const refsWithoutDefinition = await provider.provideReferences(
                document,
                position,
                { includeDeclaration: false } as vscode.ReferenceContext,
                {} as vscode.CancellationToken
            );
            const refsWithDefinition = await provider.provideReferences(
                document,
                position,
                { includeDeclaration: true } as vscode.ReferenceContext,
                {} as vscode.CancellationToken
            );

            expect(definition).toBeInstanceOf(MockLocation);
            expect((definition as MockLocation).range.start).toEqual(document.positionAt(definitionOffset));
            expect(refsWithoutDefinition).toHaveLength(2);
            expect(refsWithDefinition).toHaveLength(3);
        });
    });

    describe('NetezzaRegexReferenceProvider', () => {
        it('returns legacy regex references including declaration when requested', async () => {
            const sql = 'WITH CTE AS (SELECT 1) SELECT * FROM CTE';
            const document = {
                uri: { fsPath: 'D:\\test.sql', toString: () => 'file:///D:/test.sql' } as vscode.Uri,
                lineCount: 1,
                lineAt: jest.fn(() => ({ text: sql })),
                getText: jest.fn((range?: vscode.Range) => {
                    if (range) {
                        return sql.substring(range.start.character, range.end.character);
                    }
                    return sql;
                }),
                getWordRangeAtPosition: jest.fn(
                    () => new vscode.Range(new vscode.Position(0, 5), new vscode.Position(0, 8))
                ),
                positionAt: jest.fn((offset: number) => new vscode.Position(0, offset)),
                offsetAt: jest.fn((position: vscode.Position) => position.character)
            } as unknown as vscode.TextDocument;

            const provider = new NetezzaRegexReferenceProvider();
            const result = await provider.provideReferences(
                document,
                new vscode.Position(0, 5),
                { includeDeclaration: true } as vscode.ReferenceContext,
                {} as vscode.CancellationToken
            );

            expect(result).toBeDefined();
            expect((result as vscode.Location[]).length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('NetezzaFoldingRangeProvider', () => {
        it('creates folding ranges for REGION blocks', () => {
            const document = {
                lineCount: 5,
                lineAt: jest.fn((index: number) => {
                    const lines = ['-- REGION section', 'SELECT 1;', '-- ENDREGION', '-- ENDREGION', '-- REGION open'];
                    return { text: lines[index] };
                })
            } as unknown as vscode.TextDocument;
            const provider = new NetezzaFoldingRangeProvider();

            const ranges = provider.provideFoldingRanges(
                document,
                {} as vscode.FoldingContext,
                {} as vscode.CancellationToken
            ) as MockFoldingRange[];

            expect(ranges).toHaveLength(1);
            expect(ranges[0].start).toBe(0);
            expect(ranges[0].end).toBe(2);
        });
    });

    describe('NetezzaLinterCodeActionProvider', () => {
        const document = {
            uri: { fsPath: 'D:\\test.sql', toString: () => 'file:///D:/test.sql' } as vscode.Uri,
            getText: jest.fn((range?: vscode.Range) => {
                if (range) {
                    return 'DB.TABLE';
                }
                return 'CREATE TABLE DB.TABLE AS SELECT 1;';
            }),
            offsetAt: jest.fn(() => 0),
            positionAt: jest.fn(() => new vscode.Position(0, 32))
        } as unknown as vscode.TextDocument;

        const createDiagnostic = (code: string): vscode.Diagnostic =>
            ({
                code,
                range: new vscode.Range(new vscode.Position(0, 13), new vscode.Position(0, 21))
            }) as unknown as vscode.Diagnostic;

        it('returns quick fixes for NZ011, SQL007 and SQL012 diagnostics', () => {
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({ start: 0, end: 32 });
            const provider = new NetezzaLinterCodeActionProvider();
            const actions = provider.provideCodeActions(
                document,
                new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
                {
                    diagnostics: [createDiagnostic('NZ011'), createDiagnostic('SQL007'), createDiagnostic('SQL012')]
                } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            ) as MockCodeAction[];

            expect(actions.length).toBeGreaterThanOrEqual(8);
            expect(actions.map(action => action.title)).toEqual(
                expect.arrayContaining([
                    'Add DISTRIBUTE ON RANDOM',
                    'Template: Add DISTRIBUTE ON (<distribution_key>)',
                    'Convert to DB..TABLE format (Netezza syntax)',
                    'Add VARCHAR length (e.g., VARCHAR(100))',
                    'Fix all safe issues in file',
                    'Fix all safe issues in statement',
                    'Fix with Copilot'
                ])
            );
            const preferredTitles = actions.filter(action => action.isPreferred).map(action => action.title);
            expect(preferredTitles).toEqual(
                expect.arrayContaining([
                    'Add DISTRIBUTE ON RANDOM',
                    'Convert to DB..TABLE format (Netezza syntax)',
                    'Add VARCHAR length (e.g., VARCHAR(100))'
                ])
            );
        });

        it('skips NZ011 fix when parser cannot find statement', () => {
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue(undefined);
            const provider = new NetezzaLinterCodeActionProvider();
            const actions = provider.provideCodeActions(
                document,
                new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1)),
                {
                    diagnostics: [createDiagnostic('NZ011')]
                } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            expect(actions).toHaveLength(1);
            expect((actions as MockCodeAction[])[0].title).toBe('Fix with Copilot');
        });
    });

    describe('NetezzaDocumentLinkProvider', () => {
        class MockDocumentLink {
            public tooltip?: string;
            constructor(
                public range: vscode.Range,
                public target?: vscode.Uri
            ) { }
        }

        beforeEach(() => {
            (vscode as unknown as { DocumentLink: typeof MockDocumentLink }).DocumentLink = MockDocumentLink;
            const mockUri = { toString: () => 'command:test' };
            (vscode.Uri as unknown as { parse: jest.Mock }).parse = jest.fn(() => mockUri);
        });

        const createDocument = (text: string): vscode.TextDocument =>
            ({
                uri: { fsPath: 'D:\\test.sql', toString: () => 'file:///D:/test.sql' } as vscode.Uri,
                version: 1,
                getText: jest.fn(() => text),
                positionAt: jest.fn((offset: number) => {
                    const before = text.slice(0, offset);
                    const lines = before.split('\n');
                    return new vscode.Position(
                        lines.length - 1,
                        lines[lines.length - 1].length,
                    );
                }),
                offsetAt: jest.fn((position: vscode.Position) => {
                    const lines = text.split('\n');
                    let offset = 0;
                    for (let i = 0; i < position.line; i++) {
                        offset += lines[i].length + 1;
                    }
                    return offset + position.character;
                }),
            }) as unknown as vscode.TextDocument;

        it('creates link for DB..TABLE dotted identifier', () => {
            const sql = 'SELECT * FROM JUST_DATA..DIMACCOUNT';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            const expectedEnd = sql.indexOf('JUST_DATA..DIMACCOUNT') + 'JUST_DATA..DIMACCOUNT'.length;
            expect(links[0].range.end.character).toBe(expectedEnd);
        });

        it('creates link for SCHEMA.TABLE dotted identifier', () => {
            const sql = 'SELECT * FROM ADMIN.ORDERS';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('ADMIN.ORDERS'));
        });

        it('creates link for DB.SCHEMA.TABLE dotted identifier', () => {
            const sql = 'SELECT * FROM MYDB.ADMIN.ORDERS';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('MYDB.ADMIN.ORDERS'));
        });

        it('creates link for unqualified table name in FROM clause', () => {
            const sql = 'SELECT * FROM ORDERS';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('ORDERS'));
        });

        it('does NOT create link for EXECUTE AS in procedure header', () => {
            const sql = `CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.CUSTOMER_DOTNET_JS()
RETURNS INTEGER
EXECUTE AS OWNER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
  RETURN 1;
END;
END_PROC;`;
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            const executeAsStart = sql.indexOf('EXECUTE AS OWNER') + 'EXECUTE '.length;
            expect(links.some(
                (link) =>
                    link.range.start.line === document.positionAt(executeAsStart).line &&
                    link.range.start.character === document.positionAt(executeAsStart).character,
            )).toBe(false);
        });

        it('creates link for unqualified procedure name in EXECUTE call', () => {
            const sql = 'EXECUTE CUSTOMER_DOTNET_JS()';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('CUSTOMER_DOTNET_JS'));
        });

        it('creates link for unqualified procedure name in EXECUTE PROCEDURE call', () => {
            const sql = 'EXECUTE PROCEDURE CUSTOMER_DOTNET_JS()';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('CUSTOMER_DOTNET_JS'));
        });

        it('does NOT create link for bare identifier outside FROM/JOIN context', () => {
            const sql = 'SELECT ORDERS FROM DIMACCOUNT';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('DIMACCOUNT'));
        });

        it('creates link for table name but not for alias', () => {
            const sql = 'SELECT * FROM DIMACCOUNT A';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('DIMACCOUNT'));
        });

        it('skips ALIAS.COLUMN when first part is a known alias', () => {
            const sql = 'SELECT A.ACCOUNTCODEALTERNATEKEY FROM JUST_DATA..DIMACCOUNT A';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            // JUST_DATA..DIMACCOUNT should get a link;
            // A.ACCOUNTCODEALTERNATEKEY should NOT (A is an alias)
            expect(links).toHaveLength(1);
            expect(links[0].range.start.character).toBe(sql.indexOf('JUST_DATA..DIMACCOUNT'));
        });

        it('still creates link for SCHEMA.TABLE even when schema name matches alias', () => {
            // ADMIN is a schema name, not an alias — should get a link
            const sql = 'SELECT * FROM ADMIN.ORDERS';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            expect(links).toHaveLength(1);
        });

        it('does NOT create revealInSchema link for temp table defined in same document', () => {
            const sql = `CREATE TEMP TABLE CTAS_TEST AS (SELECT 1 AS COL1);

SELECT * FROM CTAS_TEST A`;
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            const ctasUsageStart = sql.indexOf('FROM CTAS_TEST') + 'FROM '.length;
            const ctasUsageEnd = ctasUsageStart + 'CTAS_TEST'.length;
            const ctasUsageLinks = links.filter(
                (link) =>
                    link.range.start.character === ctasUsageStart &&
                    link.range.end.character === ctasUsageEnd,
            );

            expect(ctasUsageLinks).toHaveLength(0);
        });

        it('creates catalog link when earlier statement CTE shares the name', () => {
            const sql = 'WITH CTE1 AS (SELECT 1 AS id) SELECT id FROM CTE1; SELECT * FROM ORDERS;';
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);

            const ordersStart = sql.lastIndexOf('FROM ORDERS') + 'FROM '.length;
            const ordersPosition = document.positionAt(ordersStart);
            expect(links.some(
                (link) =>
                    link.range.start.line === ordersPosition.line &&
                    link.range.start.character === ordersPosition.character,
            )).toBe(true);

            const cteUsageStart = sql.indexOf('FROM CTE1') + 'FROM '.length;
            const cteUsagePosition = document.positionAt(cteUsageStart);
            expect(links.some(
                (link) =>
                    link.range.start.line === cteUsagePosition.line &&
                    link.range.start.character === cteUsagePosition.character,
            )).toBe(false);
        });

        it('remains fast on many CREATE TABLE statements (no per-word catalog resolve)', () => {
            const blocks = Array.from(
                { length: 400 },
                (_, index) => `CREATE TABLE PUBLIC.TBL_${index} (ID INT);\n`,
            );
            const sql = blocks.join('');
            const document = createDocument(sql);

            const provider = new NetezzaDocumentLinkProvider();
            const t0 = performance.now();
            const links = provider.provideDocumentLinks(document, {} as vscode.CancellationToken);
            const elapsedMs = performance.now() - t0;

            expect(links.length).toBeGreaterThan(0);
            expect(elapsedMs).toBeLessThan(500);
        });
    });
});

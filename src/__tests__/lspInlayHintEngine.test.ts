jest.unmock('chevrotain');

import { InlayHintKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LspInlayHintEngine } from '../server/inlayHintEngine';
import { DocumentParseSession } from '../sqlParser/documentParseSession';
import * as parsingRuntime from '../sqlParser/parsingRuntime';

jest.mock('../providers/parsers/parserSqlContext', () => {
    const actual = jest.requireActual<typeof import('../providers/parsers/parserSqlContext')>(
        '../providers/parsers/parserSqlContext',
    );
    return {
        ...actual,
        parseSemanticScopeWithParser: jest.fn(actual.parseSemanticScopeWithParser),
    };
});

jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        splitStatementsWithPositions: jest.fn()
    }
}));

import { parseSemanticScopeWithParser } from '../providers/parsers/parserSqlContext';
import { SqlParser } from '../sql/sqlParser';

describe('LspInlayHintEngine', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('produces type hints for resolved qualified columns', async () => {
        const sql = 'SELECT U.ID, U.NAME FROM DB..USERS U WHERE U.ID > 0';
        const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
        const range = Range.create(document.positionAt(0), document.positionAt(sql.length));
        const metadataProvider = {
            getContext: jest.fn().mockResolvedValue({
                effectiveDatabase: 'DB',
                databaseKind: 'postgresql'
            }),
            getCachedTableInfo: jest.fn().mockResolvedValue({
                exists: true,
                table: 'USERS',
                database: 'DB',
                columns: [
                    { name: 'ID', type: 'INT8' },
                    { name: 'NAME', type: 'VARCHAR(100)' }
                ]
            })
        };

        (SqlParser.splitStatementsWithPositions as jest.Mock).mockReturnValue([
            {
                sql,
                startOffset: 0,
                endOffset: sql.length
            }
        ]);

        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map([
                ['U', { db: 'DB', table: 'USERS' }]
            ])
        });

        const engine = new LspInlayHintEngine(metadataProvider);
        const hints = await engine.provideInlayHints(document, range);

        expect(hints).toHaveLength(3);
        expect(hints.map(hint => hint.label)).toEqual(
            expect.arrayContaining([' INT8', ' VARCHAR(100)'])
        );
        expect(hints.every(hint => hint.kind === InlayHintKind.Type)).toBe(true);
        expect(parseSemanticScopeWithParser).toHaveBeenCalledWith(
            sql,
            sql.length - 1,
            'postgresql',
        );
        expect(metadataProvider.getCachedTableInfo).toHaveBeenCalledWith(
            'file:///test.sql',
            'DB',
            'USERS',
            undefined
        );
    });

    it('honors range filtering when a later qualified column falls outside the request range', async () => {
        const sql = 'SELECT U.ID, U.NAME FROM DB..USERS U WHERE U.ID > 0';
        const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
        const rangeEnd = sql.indexOf(' WHERE');
        const range = Range.create(document.positionAt(0), document.positionAt(rangeEnd));
        const metadataProvider = {
            getContext: jest.fn().mockResolvedValue({
                effectiveDatabase: 'DB',
                databaseKind: 'postgresql'
            }),
            getCachedTableInfo: jest.fn().mockResolvedValue({
                exists: true,
                table: 'USERS',
                database: 'DB',
                columns: [
                    { name: 'ID', type: 'INT8' },
                    { name: 'NAME', type: 'VARCHAR(100)' }
                ]
            })
        };

        (SqlParser.splitStatementsWithPositions as jest.Mock).mockReturnValue([
            {
                sql,
                startOffset: 0,
                endOffset: sql.length
            }
        ]);

        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map([
                ['U', { db: 'DB', table: 'USERS' }]
            ])
        });

        const engine = new LspInlayHintEngine(metadataProvider);
        const hints = await engine.provideInlayHints(document, range);

        expect(hints).toHaveLength(2);
        expect(hints.map(hint => hint.label)).toEqual([' INT8', ' VARCHAR(100)']);
    });

    it('returns no hints when cached metadata is unavailable', async () => {
        const sql = 'SELECT U.ID FROM DB..USERS U';
        const document = TextDocument.create('file:///test.sql', 'sql', 1, sql);
        const range = Range.create(document.positionAt(0), document.positionAt(sql.length));
        const metadataProvider = {
            getContext: jest.fn().mockResolvedValue({
                effectiveDatabase: 'DB',
                databaseKind: 'postgresql'
            }),
            getCachedTableInfo: jest.fn().mockResolvedValue(undefined)
        };

        (SqlParser.splitStatementsWithPositions as jest.Mock).mockReturnValue([
            {
                sql,
                startOffset: 0,
                endOffset: sql.length
            }
        ]);

        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map([
                ['U', { db: 'DB', table: 'USERS' }]
            ])
        });

        const engine = new LspInlayHintEngine(metadataProvider);
        const hints = await engine.provideInlayHints(document, range);

        expect(hints).toEqual([]);
        expect(metadataProvider.getCachedTableInfo).toHaveBeenCalledTimes(1);
    });

    it('reuses one full-document parse across multiple statements', async () => {
        const stmt1 = 'SELECT A.ID FROM DB..USERS A;';
        const stmt2 = 'SELECT B.NAME FROM DB..ORDERS B;';
        const sql = `${stmt1}\n${stmt2}`;
        const document = TextDocument.create('file:///multi-stmt.sql', 'sql', 1, sql);
        const range = Range.create(document.positionAt(0), document.positionAt(sql.length));
        const metadataProvider = {
            getContext: jest.fn().mockResolvedValue({
                effectiveDatabase: 'DB',
                databaseKind: 'netezza',
            }),
            getCachedTableInfo: jest.fn().mockImplementation(
                async (_uri: string, _db: string, table: string) => ({
                    exists: true,
                    table,
                    database: 'DB',
                    columns: [
                        { name: 'ID', type: 'INT' },
                        { name: 'NAME', type: 'VARCHAR(50)' },
                    ],
                }),
            ),
        };

        (SqlParser.splitStatementsWithPositions as jest.Mock).mockReturnValue([
            { sql: stmt1, startOffset: 0, endOffset: stmt1.length - 1 },
            {
                sql: stmt2,
                startOffset: stmt1.length + 1,
                endOffset: sql.length - 1,
            },
        ]);

        const parseSpy = jest.spyOn(parsingRuntime, 'parseSqlStatements');
        const session = new DocumentParseSession();

        try {
            const engine = new LspInlayHintEngine(metadataProvider, session);
            await engine.provideInlayHints(document, range);

            expect(parseSpy.mock.calls.length).toBe(1);

            parseSpy.mockClear();
            await engine.provideInlayHints(document, range);
            expect(parseSpy).not.toHaveBeenCalled();
        } finally {
            parseSpy.mockRestore();
        }
    });

    it('resolves reused alias names per statement with parse session', async () => {
        const realSqlParser = jest.requireActual<{ SqlParser: typeof SqlParser }>(
            '../sql/sqlParser',
        ).SqlParser;
        (SqlParser.splitStatementsWithPositions as jest.Mock).mockImplementation(
            (text: string) => realSqlParser.splitStatementsWithPositions(text),
        );

        const stmt1 = 'SELECT T.ID FROM DB..USERS T;';
        const stmt2 = 'SELECT T.NAME FROM DB..ORDERS T;';
        const sql = `${stmt1}\n${stmt2}`;
        const document = TextDocument.create('file:///alias-per-stmt.sql', 'sql', 1, sql);
        const range = Range.create(document.positionAt(0), document.positionAt(sql.length));
        const resolvedTables: string[] = [];
        const metadataProvider = {
            getContext: jest.fn().mockResolvedValue({
                effectiveDatabase: 'DB',
                databaseKind: 'netezza',
            }),
            getCachedTableInfo: jest.fn().mockImplementation(
                async (_uri: string, _db: string, table: string) => {
                    resolvedTables.push(table);
                    return {
                        exists: true,
                        table,
                        database: 'DB',
                        columns: [
                            { name: 'ID', type: 'INT' },
                            { name: 'NAME', type: 'VARCHAR(50)' },
                        ],
                    };
                },
            ),
        };

        const session = new DocumentParseSession();
        const engine = new LspInlayHintEngine(metadataProvider, session);
        const hints = await engine.provideInlayHints(document, range);

        expect(resolvedTables).toEqual(expect.arrayContaining(['USERS', 'ORDERS']));
        expect(hints.map((hint) => String(hint.label).trim())).toEqual(
            expect.arrayContaining(['INT', 'VARCHAR(50)']),
        );
    });
});
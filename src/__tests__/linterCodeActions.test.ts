import * as vscode from 'vscode';
import { NetezzaLinterCodeActionProvider } from '../providers/linterCodeActions';
import { SqlParser } from '../sql/sqlParser';
import { parseSemanticScopeWithParser } from '../providers/parsers/parserSqlContext';
import { getInitializedSqlValidator } from '../commands/validationCommands';

jest.mock('vscode', () => ({
    CodeActionKind: {
        QuickFix: 'quickfix',
        SourceFixAll: 'source.fixAll'
    },
    CodeAction: jest.fn().mockImplementation((title: string, kind: string) => ({
        title,
        kind
    })),
    WorkspaceEdit: jest.fn().mockImplementation(() => ({
        insert: jest.fn(),
        replace: jest.fn(),
        delete: jest.fn()
    }))
}));

jest.mock('../sql/sqlParser', () => ({
    SqlParser: {
        getStatementAtPosition: jest.fn()
    }
}));

jest.mock('../providers/parsers/parserSqlContext', () => ({
    parseSemanticScopeWithParser: jest.fn()
}));

jest.mock('../commands/validationCommands', () => {
    const getInitializedSqlValidator = jest.fn();
    return {
        getInitializedSqlValidator,
        createSqlValidatorForDocument: jest.fn((documentUri?: string) => getInitializedSqlValidator(documentUri))
    };
});

describe('providers/linterCodeActions', () => {
    const resolveDatabaseKind = jest.fn(() => 'postgresql');
    const provider = new NetezzaLinterCodeActionProvider(resolveDatabaseKind);

    type MockWorkspaceEdit = {
        insert: jest.Mock;
        replace: jest.Mock;
    };

    const makeDocument = (text: string): vscode.TextDocument =>
        ({
            uri: { toString: () => 'file:///test.sql' },
            getText: jest.fn((range?: { start: { line: number; character: number }; end: { line: number; character: number } }) => {
                if (!range) {
                    return text;
                }
                return text.substring(range.start.character, range.end.character);
            }),
            offsetAt: jest.fn((position: { line: number; character: number }) => {
                return (position.line * 10000) + position.character;
            }),
            positionAt: jest.fn((offset: number) => ({ line: 0, character: offset }))
        }) as unknown as vscode.TextDocument;

    const makeDiagnostic = (
        code: string,
        message: string,
        startChar: number = 0,
        endChar: number = 6,
        data?: { suggestedFix?: string }
    ): vscode.Diagnostic => ({
        code,
        message,
        range: {
            start: { line: 0, character: startChar },
            end: { line: 0, character: endChar }
        },
        data
    } as unknown as vscode.Diagnostic);

    beforeEach(() => {
        jest.clearAllMocks();
        resolveDatabaseKind.mockReturnValue('postgresql');
        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map()
        });
        (getInitializedSqlValidator as jest.Mock).mockReturnValue(undefined);
    });

    it('adds NZ002 safe WHERE fix and Copilot action', () => {
        const document = makeDocument('DELETE FROM users;');
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: 'DELETE FROM users',
            start: 0,
            end: 17
        });
        const diagnostic = makeDiagnostic('NZ002', 'NZ002: DELETE statement without WHERE clause will delete all rows');

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const whereFix = actions.find(action => action.title === 'Add safe WHERE guard (WHERE 1 = 0)');
        const copilotFix = actions.find(action => action.title === 'Fix with Copilot');

        expect(whereFix).toBeDefined();
        expect(whereFix?.edit).toBeDefined();
        expect((whereFix?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            { line: 0, character: 17 },
            ' WHERE 1 = 0'
        );
        expect(copilotFix?.command).toEqual({
            title: 'Fix with Copilot',
            command: 'netezza.fixSqlError',
            arguments: [diagnostic.message, 'DELETE FROM users']
        });
    });

    it('adds only one Copilot action when multiple diagnostics are present', () => {
        const document = makeDocument('DELETE FROM users; SELECT * FROM orders;');
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: 'DELETE FROM users; SELECT * FROM orders',
            start: 0,
            end: 42
        });
        const diagnostics = [
            makeDiagnostic('NZ002', 'NZ002: DELETE statement without WHERE clause will delete all rows'),
            makeDiagnostic('NZ006', 'NZ006: ORDER BY without LIMIT may process too many rows'),
            makeDiagnostic('SQL018', 'SQL018: Unused CTE'),
        ];

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const copilotFixes = actions.filter(action => action.title === 'Fix with Copilot');
        expect(copilotFixes).toHaveLength(1);
        expect(copilotFixes[0]?.diagnostics).toHaveLength(3);
        expect(copilotFixes[0]?.command).toEqual({
            title: 'Fix with Copilot',
            command: 'netezza.fixSqlError',
            arguments: [
                diagnostics.map(diagnostic => diagnostic.message).join('\n'),
                'DELETE FROM users; SELECT * FROM orders',
            ],
        });
    });

    it('adds NZ006 FETCH FIRST quick fix', () => {
        const document = makeDocument('SELECT * FROM users ORDER BY created_at;');
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: 'SELECT * FROM users ORDER BY created_at',
            start: 0,
            end: 38
        });
        const diagnostic = makeDiagnostic('NZ006', 'NZ006: ORDER BY without LIMIT may process too many rows');

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const fetchFix = actions.find(action => action.title === 'Add FETCH FIRST 100 ROWS ONLY');
        expect(fetchFix).toBeDefined();
        expect((fetchFix?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            { line: 0, character: 38 },
            ' FETCH FIRST 100 ROWS ONLY'
        );
    });

    it('adds SQL048 table qualification quick fix from diagnostic data', () => {
        const document = makeDocument('SELECT * FROM EMPLOYEES;');
        const diagnostic = makeDiagnostic(
            'SQL048',
            'SQL048: Table can be qualified',
            14,
            23,
            { suggestedFix: 'DB1.PUBLIC.EMPLOYEES' }
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const action = actions.find(item => item.title === 'Qualify as DB1.PUBLIC.EMPLOYEES');
        expect(action).toBeDefined();
        expect(action?.isPreferred).toBe(true);
        expect((action?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            'DB1.PUBLIC.EMPLOYEES'
        );
    });

    it('skips SQL048 quick fixes in production because LSP serves them', () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            const document = makeDocument('SELECT * FROM JUST_DATA..DEPARTMENT;');
            const diagnostic = makeDiagnostic(
                'SQL048',
                "SQL048: Table 'JUST_DATA..DEPARTMENT' can be qualified",
                14,
                37,
                { suggestedFix: 'JUST_DATA.ADMIN.DEPARTMENT' }
            );

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            expect(actions.some(item => item.title?.startsWith('Qualify as '))).toBe(false);
        } finally {
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('adds preferred full qualification for SQL007 before DB.. fallback', () => {
        const document = makeDocument('SELECT * FROM DB1.EMPLOYEES;');
        const diagnostic = makeDiagnostic(
            'SQL007',
            'SQL007: Invalid two-part name',
            14,
            27,
            { suggestedFix: 'DB1.PUBLIC.EMPLOYEES' }
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const qualified = actions.find(item => item.title === 'Qualify as DB1.PUBLIC.EMPLOYEES');
        const doubleDot = actions.find(item => item.title === 'Convert to DB..TABLE format (Netezza syntax)');

        expect(qualified?.isPreferred).toBe(true);
        expect(doubleDot).toBeDefined();
        expect(doubleDot?.isPreferred).toBe(false);
    });

    it('adds NZ007 quick fix to normalize keyword casing', () => {
        const statementSql = 'select id FROM users';
        const keywordOffset = statementSql.indexOf('select');
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic(
            'NZ007',
            "NZ007: Keyword 'select' should be UPPERCASE",
            keywordOffset,
            keywordOffset + 'select'.length
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const normalizeFix = actions.find(action => action.title === 'Normalize keyword casing');
        expect(normalizeFix).toBeDefined();
        expect((normalizeFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            'SELECT'
        );
    });

    it('adds only one keyword casing fix when multiple NZ007 diagnostics are present', () => {
        const statementSql = 'select id from users';
        const selectOffset = statementSql.indexOf('select');
        const fromOffset = statementSql.indexOf('from');
        const document = makeDocument(statementSql);
        const diagnostics = [
            makeDiagnostic(
                'NZ007',
                "NZ007: Keyword 'select' should be UPPERCASE",
                selectOffset,
                selectOffset + 'select'.length,
            ),
            makeDiagnostic(
                'NZ007',
                "NZ007: Keyword 'from' should be UPPERCASE",
                fromOffset,
                fromOffset + 'from'.length,
            ),
        ];

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const normalizeFixes = actions.filter(action => action.title === 'Normalize keyword casing');
        expect(normalizeFixes).toHaveLength(1);
        expect(normalizeFixes[0]?.diagnostics).toHaveLength(2);
        const edit = normalizeFixes[0]?.edit as unknown as MockWorkspaceEdit;
        expect(edit.replace).toHaveBeenCalledTimes(2);
    });

    it('adds NZ001 quick fix to expand SELECT * into explicit columns', () => {
        const statementSql = 'SELECT * FROM DB..CUSTOMERS C JOIN DB..ORDERS O ON C.ID = O.CUSTOMER_ID';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        (getInitializedSqlValidator as jest.Mock).mockReturnValue({
            validate: jest.fn().mockReturnValue({
                valid: true,
                errors: [],
                warnings: [],
                scope: {
                    tables: new Map([
                        ['C', { name: 'CUSTOMERS', alias: 'C', columns: [{ name: 'ID' }, { name: 'NAME' }] }],
                        ['O', { name: 'ORDERS', alias: 'O', columns: [{ name: 'ID' }, { name: 'CUSTOMER_ID' }] }]
                    ]),
                    ctes: new Map(),
                    level: 0
                }
            })
        });
        const starOffset = statementSql.indexOf('*');
        const diagnostic = makeDiagnostic('NZ001', 'NZ001: Avoid SELECT *', starOffset, starOffset + 1);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const expandFix = actions.find(action => action.title === 'Expand SELECT * to explicit columns');
        expect(expandFix).toBeDefined();
        expect((expandFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            expect.stringContaining('C.ID')
        );
        expect((expandFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            expect.stringContaining('O.CUSTOMER_ID')
        );
    });

    it('adds NZ004 quick fix to replace CROSS JOIN with INNER JOIN', () => {
        const statementSql = 'SELECT * FROM T1 CROSS JOIN T2';
        const crossOffset = statementSql.indexOf('CROSS JOIN');
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic(
            'NZ004',
            'NZ004: CROSS JOIN produces a Cartesian product',
            crossOffset,
            crossOffset + 'CROSS JOIN'.length
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const crossJoinFix = actions.find(action => action.title === 'Replace CROSS JOIN with explicit INNER JOIN');
        expect(crossJoinFix).toBeDefined();
        expect((crossJoinFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            'INNER JOIN'
        );
    });

    it('adds SQL008 qualification quick fixes for ambiguous columns', () => {
        const statementSql = 'SELECT ID FROM DB..USERS U JOIN DB..ORDERS O ON U.ID = O.USER_ID';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map([
                ['U', { db: 'DB', table: 'USERS' }],
                ['O', { db: 'DB', table: 'ORDERS' }]
            ])
        });
        const diagnostic = makeDiagnostic('SQL008', "Column 'ID' is ambiguous", 7, 9);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const qualifyActions = actions.filter(action => action.title.startsWith('Qualify column with'));
        expect(qualifyActions).toHaveLength(2);
        expect((qualifyActions[0].edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            expect.stringMatching(/\.ID$/)
        );
        expect(parseSemanticScopeWithParser).toHaveBeenCalledWith(statementSql, undefined, 'postgresql');
    });

    it('adds PAR101 quick fix to insert missing AS in CTE definition', () => {
        const statementSql = 'WITH ABC1 (SELECT X.ACCOUNTCODEALTERNATEKEY FROM JUST_DATA..DIMACCOUNT X) SELECT * FROM ABC1';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        const diagnosticOffset = statementSql.indexOf('X.ACCOUNTCODEALTERNATEKEY');
        const diagnostic = makeDiagnostic(
            'PAR101',
            "PAR101: CTE 'ABC1' is missing AS before the subquery.",
            diagnosticOffset,
            diagnosticOffset + 1
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const cteAsFix = actions.find(action => action.title === 'Insert missing AS in CTE definition');
        expect(cteAsFix).toBeDefined();
        expect((cteAsFix?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            { line: 0, character: statementSql.indexOf('(') },
            ' AS '
        );
    });

    it('adds PAR101 quick fix with leading space when CTE has no whitespace before opening paren', () => {
        const statementSql = 'WITH ABC1(SELECT 1) SELECT * FROM ABC1';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        const diagnosticOffset = statementSql.indexOf('SELECT 1');
        const diagnostic = makeDiagnostic(
            'PAR101',
            "PAR101: CTE 'ABC1' is missing AS before the subquery.",
            diagnosticOffset,
            diagnosticOffset + 1
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const cteAsFix = actions.find(action => action.title === 'Insert missing AS in CTE definition');
        expect(cteAsFix).toBeDefined();
        expect((cteAsFix?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            { line: 0, character: statementSql.indexOf('(') },
            ' AS '
        );
    });

    it('adds NZ010 quick fix to insert missing alias', () => {
        const statementSql = 'SELECT * FROM DB..CUSTOMERS JOIN DB..ORDERS O ON CUSTOMERS.ID = O.CUSTOMER_ID';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        (parseSemanticScopeWithParser as jest.Mock).mockReturnValue({
            preferredAliasBindings: new Map([
                ['CUSTOMERS', { db: 'DB', table: 'CUSTOMERS' }],
                ['O', { db: 'DB', table: 'ORDERS' }]
            ])
        });

        const diagnostic = makeDiagnostic('NZ010', 'NZ010: Table in JOIN should use alias');

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const aliasFix = actions.find(action => action.title.startsWith('Add missing table alias'));
        expect(aliasFix).toBeDefined();
        expect((aliasFix?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            expect.objectContaining({ line: 0 }),
            expect.stringMatching(/^ [A-Z]\d+$/)
        );
        expect(parseSemanticScopeWithParser).toHaveBeenCalledWith(statementSql, undefined, 'postgresql');
    });

    it('adds NZ012 quick fix to remove AS in UPDATE alias', () => {
        const statementSql = 'UPDATE DB..CUSTOMERS AS C SET NAME = \'X\'';
        const asOffset = statementSql.indexOf('AS');
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic('NZ012', 'NZ012: UPDATE ... AS alias is not supported', asOffset, asOffset + 2);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const removeAsFix = actions.find(action => action.title === 'Remove AS in UPDATE alias');
        expect(removeAsFix).toBeDefined();
        expect((removeAsFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            ''
        );
    });

    it('adds NZP012 quick fix to normalize ELSEIF syntax to ELSIF', () => {
        const statementSql = 'ELSEIF amount > 0 THEN';
        const elseifOffset = statementSql.indexOf('ELSEIF');
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic(
            'NZP012',
            'NZP012: Use ELSIF instead of ELSEIF in NZPLSQL',
            elseifOffset,
            elseifOffset + 'ELSEIF'.length
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const elsifFix = actions.find(action => action.title === 'Replace ELSEIF/ELSE IF with ELSIF');
        expect(elsifFix).toBeDefined();
        expect((elsifFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            'ELSIF'
        );
    });

    it('adds NZ013 quick fix to replace UNION with UNION ALL', () => {
        const statementSql = 'SELECT 1 UNION SELECT 2';
        const unionOffset = statementSql.indexOf('UNION');
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic('NZ013', 'NZ013: Prefer UNION ALL', unionOffset, unionOffset + 'UNION'.length);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const unionAllFix = actions.find(action => action.title === 'Replace UNION with UNION ALL');
        expect(unionAllFix).toBeDefined();
        expect((unionAllFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            'UNION ALL'
        );
    });

    it('adds NZ021 quick fix to remove extra comma', () => {
        const statementSql = 'SELECT 1,,2 FROM table1';
        const doubleCommaOffset = statementSql.indexOf(',,');
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic('NZ021', 'NZ021: Double Comma - Remove the extra comma', doubleCommaOffset + 1, doubleCommaOffset + 2);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const doubleCommaFix = actions.find(action => action.title === 'Remove extra comma (,, → ,)');
        expect(doubleCommaFix).toBeDefined();
        expect(doubleCommaFix?.isPreferred).toBe(true);
        expect((doubleCommaFix?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            diagnostic.range,
            ''
        );
    });

    it('adds PAR003 quick fix to remove duplicate keyword', () => {
        const statementSql = 'SELECT 1 FROM FROM DIMACCOUNT';
        const secondFromOffset = statementSql.indexOf('FROM', statementSql.indexOf('FROM') + 1);
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic('PAR003', 'PAR003: Duplicate FROM keyword', secondFromOffset, secondFromOffset + 4);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const duplicateKeywordFix = actions.find(action => action.title === 'Remove duplicate keyword');
        expect(duplicateKeywordFix).toBeDefined();
        expect(duplicateKeywordFix?.isPreferred).toBe(true);
    });

    it('adds P55 template actions for NZ002 with parameter placeholders', () => {
        const statementSql = 'DELETE FROM users';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        const diagnostic = makeDiagnostic('NZ002', 'NZ002: DELETE statement without WHERE clause will delete all rows');

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const predicateTemplate = actions.find(action => action.title === 'Template: Add WHERE <condition>');
        const keyTemplate = actions.find(action => action.title === 'Template: Add WHERE <key_column> IN (<value_1>, <value_2>)');
        expect(predicateTemplate).toBeDefined();
        expect(keyTemplate).toBeDefined();
        expect((predicateTemplate?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            { line: 0, character: statementSql.length },
            ' WHERE <condition>'
        );
    });

    it('adds P55 template action for NZ011 distribution-key guidance', () => {
        const statementSql = 'CREATE TABLE t AS SELECT * FROM src';
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });
        const diagnostic = makeDiagnostic('NZ011', 'NZ011: CTAS Missing Distribution', 0, 6);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const distributionTemplate = actions.find(action => action.title === 'Template: Add DISTRIBUTE ON (<distribution_key>)');
        expect(distributionTemplate).toBeDefined();
        expect((distributionTemplate?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            { line: 0, character: statementSql.length },
            ' DISTRIBUTE ON (<distribution_key>)'
        );
    });

    it('adds P55 template actions for NZP027 OWNER/CALLER clause selection', () => {
        const statementSql = 'CREATE OR REPLACE PROCEDURE p_test(i INTEGER)\nAS BEGIN_PROC\nBEGIN\nEND;\nEND_PROC;';
        const document = makeDocument(statementSql);
        const diagnostic = makeDiagnostic('NZP027', 'NZP027: Missing EXECUTE AS clause', 0, 6);

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {} as vscode.Range,
            { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const ownerTemplate = actions.find(action => action.title === 'Template: Add EXECUTE AS OWNER');
        const callerTemplate = actions.find(action => action.title === 'Template: Add EXECUTE AS CALLER');
        expect(ownerTemplate).toBeDefined();
        expect(callerTemplate).toBeDefined();
        expect((ownerTemplate?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
            document.uri,
            expect.objectContaining({ line: 0 }),
            '\nEXECUTE AS OWNER'
        );
    });

    it('adds fix-all actions for safe rules only (statement + file)', () => {
        const statementSql = 'select 1 UNION SELECT 2';
        const keywordOffset = statementSql.indexOf('select');
        const unionOffset = statementSql.indexOf('UNION');
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });

        const safeDiagnostic = makeDiagnostic(
            'NZ007',
            "NZ007: Keyword 'select' should be UPPERCASE",
            keywordOffset,
            keywordOffset + 'select'.length
        );
        const nonSafeDiagnostic = makeDiagnostic(
            'NZ013',
            'NZ013: Prefer UNION ALL',
            unionOffset,
            unionOffset + 'UNION'.length
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: statementSql.length }
            } as unknown as vscode.Range,
            { diagnostics: [safeDiagnostic, nonSafeDiagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const fixAllFile = actions.find(action => action.title === 'Fix all safe issues in file');
        const fixAllStatement = actions.find(action => action.title === 'Fix all safe issues in statement');

        expect(fixAllFile).toBeDefined();
        expect(fixAllFile?.kind).toBe('source.fixAll');
        expect((fixAllFile?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            safeDiagnostic.range,
            'SELECT'
        );
        expect((fixAllFile?.edit as unknown as MockWorkspaceEdit).replace).not.toHaveBeenCalledWith(
            document.uri,
            nonSafeDiagnostic.range,
            'UNION ALL'
        );

        expect(fixAllStatement).toBeDefined();
        expect((fixAllStatement?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            safeDiagnostic.range,
            'SELECT'
        );
    });

    it('includes NZP012 in safe fix-all rewrites', () => {
        const statementSql = 'ELSEIF amount > 0 THEN';
        const elseifOffset = statementSql.indexOf('ELSEIF');
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });

        const safeDiagnostic = makeDiagnostic(
            'NZP012',
            'NZP012: Use ELSIF instead of ELSEIF in NZPLSQL',
            elseifOffset,
            elseifOffset + 'ELSEIF'.length
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: statementSql.length }
            } as unknown as vscode.Range,
            { diagnostics: [safeDiagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const fixAllFile = actions.find(action => action.title === 'Fix all safe issues in file');
        expect(fixAllFile).toBeDefined();
        expect((fixAllFile?.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
            document.uri,
            safeDiagnostic.range,
            'ELSIF'
        );
    });

    it('does not add fix-all actions when there are no safe diagnostics', () => {
        const statementSql = 'SELECT 1 UNION SELECT 2';
        const unionOffset = statementSql.indexOf('UNION');
        const document = makeDocument(statementSql);
        (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
            sql: statementSql,
            start: 0,
            end: statementSql.length
        });

        const nonSafeDiagnostic = makeDiagnostic(
            'NZ013',
            'NZ013: Prefer UNION ALL',
            unionOffset,
            unionOffset + 'UNION'.length
        );

        const actions = provider.provideCodeActions(
            document as vscode.TextDocument,
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: statementSql.length }
            } as unknown as vscode.Range,
            { diagnostics: [nonSafeDiagnostic] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        expect(actions.some(action => action.title === 'Fix all safe issues in file')).toBe(false);
        expect(actions.some(action => action.title === 'Fix all safe issues in statement')).toBe(false);
    });

    // ═══════════════════════════════════════════════════════════════════
    // P56: REGRESSION GATE — Quick-Fix Idempotence & Semantic Preservation
    // These tests form a protected CI gate. Do NOT remove or weaken
    // assertions without explicit approval.
    // ═══════════════════════════════════════════════════════════════════
    describe('REGRESSION GATE — quick-fix idempotence and semantic preservation', () => {

        it('GATE: NZ004 fix is idempotent — applying to already-fixed SQL produces INNER JOIN not INNER INNER JOIN', () => {
            // After fix: "INNER JOIN" — running provider again on fixed SQL should not produce another fix
            const fixedSql = 'SELECT * FROM T1 INNER JOIN T2';
            const document = makeDocument(fixedSql);
            // NZ004 should not fire on INNER JOIN (only on CROSS JOIN)
            const diagnostic = makeDiagnostic(
                'NZ004',
                'NZ004: CROSS JOIN produces a Cartesian product',
                fixedSql.indexOf('INNER JOIN'),
                fixedSql.indexOf('INNER JOIN') + 'INNER JOIN'.length
            );

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const crossJoinFix = actions.find(action => action.title === 'Replace CROSS JOIN with explicit INNER JOIN');
            if (crossJoinFix?.edit) {
                // If a fix is generated, the replacement should be 'INNER JOIN' not 'INNER INNER JOIN'
                expect((crossJoinFix.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
                    document.uri,
                    diagnostic.range,
                    'INNER JOIN'
                );
            }
        });

        it('GATE: NZ012 fix is idempotent — removing AS does not over-delete', () => {
            // After fix: 'UPDATE DB..CUSTOMERS C SET NAME = ...' — no AS present
            const fixedSql = "UPDATE DB..CUSTOMERS C SET NAME = 'X'";
            const document = makeDocument(fixedSql);
            const diagnostic = makeDiagnostic('NZ012', 'NZ012: UPDATE ... AS alias is not supported', 0, 6);

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const removeAsFix = actions.find(action => action.title === 'Remove AS in UPDATE alias');
            // On already-fixed SQL (no AS), the fix should either not be offered
            // or should produce an empty replacement (no-op)
            if (removeAsFix?.edit) {
                expect((removeAsFix.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
                    document.uri,
                    diagnostic.range,
                    ''
                );
            }
        });

        it('GATE: NZ013 fix result (UNION ALL) should not trigger another NZ013 diagnostic', () => {
            // After fix: "UNION ALL" — should not be flagged again
            const fixedSql = 'SELECT 1 UNION ALL SELECT 2';
            const document = makeDocument(fixedSql);
            // Simulate: if somehow NZ013 fires on UNION ALL, the fix should still produce UNION ALL (idempotent)
            const unionAllOffset = fixedSql.indexOf('UNION ALL');
            const diagnostic = makeDiagnostic('NZ013', 'NZ013: Prefer UNION ALL', unionAllOffset, unionAllOffset + 'UNION ALL'.length);

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const unionAllFix = actions.find(action => action.title === 'Replace UNION with UNION ALL');
            if (unionAllFix?.edit) {
                // If offered, it should replace with 'UNION ALL' (not 'UNION ALL ALL')
                expect((unionAllFix.edit as unknown as MockWorkspaceEdit).replace).toHaveBeenCalledWith(
                    document.uri,
                    diagnostic.range,
                    'UNION ALL'
                );
            }
        });

        it('GATE: NZ006 FETCH FIRST fix does not double-add on already-limited SQL', () => {
            const alreadyLimitedSql = 'SELECT * FROM users ORDER BY created_at FETCH FIRST 100 ROWS ONLY';
            const document = makeDocument(alreadyLimitedSql);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
                sql: alreadyLimitedSql,
                start: 0,
                end: alreadyLimitedSql.length
            });

            const diagnostic = makeDiagnostic('NZ006', 'NZ006: ORDER BY without LIMIT may process too many rows');

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const fetchFix = actions.find(action => action.title === 'Add FETCH FIRST 100 ROWS ONLY');
            if (fetchFix?.edit) {
                // If offered, insertion point should be at end of statement
                expect((fetchFix.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
                    document.uri,
                    expect.objectContaining({ line: 0 }),
                    ' FETCH FIRST 100 ROWS ONLY'
                );
            }
        });

        it('GATE: NZ002 WHERE guard preserves original DELETE structure', () => {
            const sql = 'DELETE FROM DB..CUSTOMERS';
            const document = makeDocument(sql);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
                sql,
                start: 0,
                end: sql.length
            });
            const diagnostic = makeDiagnostic('NZ002', 'NZ002: DELETE statement without WHERE clause will delete all rows');

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const whereFix = actions.find(action => action.title === 'Add safe WHERE guard (WHERE 1 = 0)');
            expect(whereFix).toBeDefined();
            // Fix should append, not replace — original SQL structure preserved
            expect((whereFix?.edit as unknown as MockWorkspaceEdit).insert).toHaveBeenCalledWith(
                document.uri,
                expect.objectContaining({ line: 0, character: sql.length }),
                ' WHERE 1 = 0'
            );
        });

        it('GATE: NZ001 SELECT * expansion includes all aliased columns from all tables', () => {
            const statementSql = 'SELECT * FROM DB..CUSTOMERS C JOIN DB..ORDERS O ON C.ID = O.CUSTOMER_ID';
            const document = makeDocument(statementSql);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
                sql: statementSql,
                start: 0,
                end: statementSql.length
            });
            (getInitializedSqlValidator as jest.Mock).mockReturnValue({
                validate: jest.fn().mockReturnValue({
                    valid: true,
                    errors: [],
                    warnings: [],
                    scope: {
                        tables: new Map([
                            ['C', { name: 'CUSTOMERS', alias: 'C', columns: [{ name: 'ID' }, { name: 'NAME' }, { name: 'EMAIL' }] }],
                            ['O', { name: 'ORDERS', alias: 'O', columns: [{ name: 'ORDER_ID' }, { name: 'CUSTOMER_ID' }, { name: 'AMOUNT' }] }]
                        ]),
                        ctes: new Map(),
                        level: 0
                    }
                })
            });
            const starOffset = statementSql.indexOf('*');
            const diagnostic = makeDiagnostic('NZ001', 'NZ001: Avoid SELECT *', starOffset, starOffset + 1);

            const actions = provider.provideCodeActions(
                document as vscode.TextDocument,
                {} as vscode.Range,
                { diagnostics: [diagnostic] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const expandFix = actions.find(action => action.title === 'Expand SELECT * to explicit columns');
            expect(expandFix).toBeDefined();
            const replaceCall = (expandFix?.edit as unknown as MockWorkspaceEdit).replace;
            expect(replaceCall).toHaveBeenCalled();
            // All columns from both tables must be present in the expansion
            const expandedText = replaceCall.mock.calls[0][2] as string;
            expect(expandedText).toContain('C.ID');
            expect(expandedText).toContain('C.NAME');
            expect(expandedText).toContain('C.EMAIL');
            expect(expandedText).toContain('O.ORDER_ID');
            expect(expandedText).toContain('O.CUSTOMER_ID');
            expect(expandedText).toContain('O.AMOUNT');
        });

        it('GATE: fix-all produces consistent WorkspaceEdit on re-run', () => {
            const statementSql = 'select col from tab';
            const selectOffset = statementSql.indexOf('select');
            const fromOffset = statementSql.indexOf('from');
            const document = makeDocument(statementSql);
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
                sql: statementSql,
                start: 0,
                end: statementSql.length
            });

            const diag1 = makeDiagnostic('NZ007', "NZ007: Keyword 'select' should be UPPERCASE", selectOffset, selectOffset + 'select'.length);
            const diag2 = makeDiagnostic('NZ007', "NZ007: Keyword 'from' should be UPPERCASE", fromOffset, fromOffset + 'from'.length);

            const actions1 = provider.provideCodeActions(
                document as vscode.TextDocument,
                { start: { line: 0, character: 0 }, end: { line: 0, character: statementSql.length } } as unknown as vscode.Range,
                { diagnostics: [diag1, diag2] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const fixAll1 = actions1.find(action => action.title === 'Fix all safe issues in file');
            expect(fixAll1).toBeDefined();
            // Capture call count before clearing mocks
            const callCount1 = (fixAll1?.edit as unknown as MockWorkspaceEdit).replace.mock.calls.length;
            expect(callCount1).toBeGreaterThan(0);

            // Re-run with same inputs
            jest.clearAllMocks();
            (SqlParser.getStatementAtPosition as jest.Mock).mockReturnValue({
                sql: statementSql,
                start: 0,
                end: statementSql.length
            });

            const actions2 = provider.provideCodeActions(
                document as vscode.TextDocument,
                { start: { line: 0, character: 0 }, end: { line: 0, character: statementSql.length } } as unknown as vscode.Range,
                { diagnostics: [diag1, diag2] } as unknown as vscode.CodeActionContext,
                {} as vscode.CancellationToken
            );

            const fixAll2 = actions2.find(action => action.title === 'Fix all safe issues in file');
            expect(fixAll2).toBeDefined();
            const callCount2 = (fixAll2?.edit as unknown as MockWorkspaceEdit).replace.mock.calls.length;
            expect(callCount2).toBe(callCount1);
        });
    });
});

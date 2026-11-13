import * as vscode from 'vscode';
const validateMock = jest.fn();
const getInitializedSqlValidatorMock = jest.fn();
const getSqlValidationContextMock = jest.fn();

jest.mock('../sqlParser', () => ({
    SqlValidator: jest.fn().mockImplementation(() => ({
        validate: validateMock
    }))
}));

jest.mock('../sqlParser/sqlCoreBackedValidator', () => ({
    SqlCoreBackedValidator: jest.fn().mockImplementation(() => ({
        validate: validateMock
    }))
}));

jest.mock('../commands/validationCommands', () => ({
    getInitializedSqlValidator: getInitializedSqlValidatorMock,
    getSqlValidationContext: getSqlValidationContextMock
}));

const isSqlLanguageClientRunningMock = jest.fn(() => true);

jest.mock('../activation/lspRegistration', () => ({
    isSqlLanguageClientRunning: () => isSqlLanguageClientRunningMock()
}));

import { SqlLinterProvider } from '../providers/sqlLinterProvider';

describe('SqlLinterProvider lint modes', () => {
    let provider: SqlLinterProvider;

    const makeValidationResult = () => ({
        valid: false,
        errors: [
            {
                code: 'PAR001',
                message: 'Parser error',
                severity: 'error' as const,
                position: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 4, offset: 0 }
            }
        ],
        warnings: [],
        scope: { tables: new Map(), ctes: new Map(), level: 0 }
    });

    beforeEach(() => {
        validateMock.mockReset();
        getInitializedSqlValidatorMock.mockReset();
        getSqlValidationContextMock.mockReset();
        getInitializedSqlValidatorMock.mockReturnValue(undefined);
        getSqlValidationContextMock.mockReturnValue(undefined);
        provider = new SqlLinterProvider();
        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [];
    });

    afterEach(() => {
        provider.dispose();
    });

    it('includes parser diagnostics when LSP is not running', async () => {
        isSqlLanguageClientRunningMock.mockReturnValue(false);
        validateMock.mockReturnValue({
            valid: false,
            errors: [{ code: 'SQL003', message: 'Syntax error', severity: 'error', position: { offset: 0, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }],
            warnings: [],
            scope: { tables: new Map(), ctes: new Map(), level: 0 },
        });

        const issues = await provider.lintSql('SELECT FROM DIMACCOUNT;', {}, false, 'advanced');

        expect(validateMock).toHaveBeenCalled();
        expect(issues.some((issue) => issue.ruleId === 'SQL003')).toBe(true);
        isSqlLanguageClientRunningMock.mockReturnValue(true);
    });

    it('surfaces an incomplete qualified reference as a parser lint issue', async () => {
        isSqlLanguageClientRunningMock.mockReturnValue(false);
        validateMock.mockReturnValue({
            valid: false,
            errors: [{
                code: 'PAR001',
                message: "Incomplete qualified reference 'D.'. Add '*' or a column name after the dot.",
                severity: 'error',
                position: { offset: 7, startLine: 1, startColumn: 8, endLine: 1, endColumn: 9 },
            }],
            warnings: [],
            scope: { tables: new Map(), ctes: new Map(), level: 0 },
        });

        const issues = await provider.lintSql(`SELECT D.
FROM JUST_DATA.ADMIN.DIMDATE D
WHERE D.DATEKEY > 0
LIMIT 50`, {}, false, 'advanced');

        expect(issues.some((issue) => issue.ruleId === 'PAR001')).toBe(true);
        isSqlLanguageClientRunningMock.mockReturnValue(true);
    });

    it('does not invoke parser validator in quality-only lint mode', async () => {
        const sql = 'SELECT FROM DIMACCOUNT;';
        const issues = await provider.lintSql(sql, {}, false, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(issues.some(issue => issue.ruleId.startsWith('PAR'))).toBe(false);
        expect(issues.some(issue => issue.ruleId.startsWith('SQL'))).toBe(false);
    });

    it('keeps parser-owned CROSS JOIN diagnostics out of quality-only lint', async () => {
        const issues = await provider.lintSql('SELECT * FROM T1 CROSS JOIN T2;', {}, false, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(issues.some(issue => issue.ruleId === 'NZ001')).toBe(true);
        expect(issues.some(issue => issue.ruleId === 'NZ004')).toBe(false);
    });

    it('applies additional NZ rules from the unified SQL quality engine', async () => {
        const issues = await provider.lintSql("SELECT * FROM T1 WHERE NAME LIKE '%TEST';", {}, false, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(issues.some(issue => issue.ruleId === 'NZ001')).toBe(true);
        expect(issues.some(issue => issue.ruleId === 'NZ005')).toBe(true);
    });

    it('applies procedure NZP rules from the unified SQL quality engine', async () => {
        const sql = `
CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.BAD_PROC()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
    RETURN 1;
`;
        const issues = await provider.lintSql(sql, {}, false, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(issues.some(issue => issue.ruleId === 'NZP001')).toBe(true);
    });

    it('keeps procedure style heuristics out of automatic lint but available on demand', async () => {
        const sql = `
CREATE OR REPLACE PROCEDURE JUST_DATA.ADMIN.STYLE_PROC()
RETURNS INTEGER
LANGUAGE NZPLSQL AS
BEGIN_PROC
BEGIN
    RETURN 1;
END;
END_PROC;
`;
        const automaticIssues = await provider.lintSql(sql, {}, false, 'advanced');
        const onDemandIssues = await provider.lintSql(sql, {}, true, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(automaticIssues.some(issue => issue.ruleId === 'NZP009')).toBe(false);
        expect(automaticIssues.some(issue => issue.ruleId === 'NZP027')).toBe(false);
        expect(onDemandIssues.some(issue => issue.ruleId === 'NZP009')).toBe(true);
        expect(onDemandIssues.some(issue => issue.ruleId === 'NZP027')).toBe(true);
    });

    it('reuses cached diagnostics for same document version and mode', async () => {
        validateMock.mockReturnValue(makeValidationResult());

        const document = {
            uri: { toString: () => 'file:///cache.sql' },
            version: 1,
            languageId: 'sql',
            getText: jest.fn(() => 'SELECT FROM DIMACCOUNT;'),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];

        await provider.lintDocument(document);
        await provider.lintDocument(document);

        expect(validateMock).not.toHaveBeenCalled();
    });

    it('skips extension-host lint for large DDL when LSP is running', async () => {
        const largeSql = `${'CREATE TABLE t (id int);\n'.repeat(520)}SELECT 1;`;
        const document = {
            uri: { toString: () => 'file:///large-ddl.sql' },
            version: 1,
            languageId: 'sql',
            lineCount: largeSql.split('\n').length,
            getText: jest.fn(() => largeSql),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];
        const lintSqlSpy = jest.spyOn(provider, 'lintSql');
        const diagnosticCollection = (
            provider as unknown as { diagnosticCollection: { delete: jest.Mock; set: jest.Mock } }
        ).diagnosticCollection;

        const issues = await provider.lintDocument(document);

        expect(issues).toEqual([]);
        expect(lintSqlSpy).not.toHaveBeenCalled();
        expect(diagnosticCollection.delete).toHaveBeenCalledWith(document.uri);
        lintSqlSpy.mockRestore();
    });

    it('still allows on-demand lint for large DDL when LSP is running', async () => {
        const largeSql = `${'CREATE TABLE t (id int);\n'.repeat(520)}SELECT * FROM t;`;
        const document = {
            uri: { toString: () => 'file:///large-ddl-ondemand.sql' },
            version: 1,
            languageId: 'sql',
            lineCount: largeSql.split('\n').length,
            getText: jest.fn(() => largeSql),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];
        const lintSqlSpy = jest.spyOn(provider, 'lintSql').mockResolvedValue([]);

        await provider.lintDocument(document, true);

        expect(lintSqlSpy).toHaveBeenCalled();
        lintSqlSpy.mockRestore();
    });

    it('lintDocument publishes only quality diagnostics when LSP is running', async () => {
        const document = {
            uri: { toString: () => 'file:///quality-only.sql' },
            version: 1,
            languageId: 'sql',
            getText: jest.fn(() => 'SELECT * FROM T1;'),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];
        const diagnosticCollection = (
            provider as unknown as { diagnosticCollection: { set: jest.Mock } }
        ).diagnosticCollection;

        await provider.lintDocument(document);

        expect(validateMock).not.toHaveBeenCalled();
        expect(diagnosticCollection.set).toHaveBeenCalled();
        const lastSetCall =
            diagnosticCollection.set.mock.calls[
                diagnosticCollection.set.mock.calls.length - 1
            ];
        const diagnostics = lastSetCall?.[1] as vscode.Diagnostic[];
        expect(diagnostics.some((diagnostic) => diagnostic.code === 'NZ001')).toBe(true);
        expect(
            diagnostics.every((diagnostic) => {
                const code = String(diagnostic.code ?? '');
                return !code.startsWith('SQL') && !code.startsWith('PAR');
            }),
        ).toBe(true);
    });

    it('skips stale diagnostics when document version changes during async lint', async () => {
        let resolveLint: ((value: Array<{ ruleId: string; message: string; severity: vscode.DiagnosticSeverity; startOffset: number; endOffset: number }>) => void) | undefined;
        const lintSqlSpy = jest.spyOn(provider, 'lintSql').mockImplementation(
            () =>
                new Promise(resolve => {
                    resolveLint = resolve;
                })
        );

        const document = {
            uri: { toString: () => 'file:///stale.sql' },
            version: 1,
            languageId: 'sql',
            getText: jest.fn(() => 'SELECT FROM DIMACCOUNT;'),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];
        const diagnosticCollection = (
            provider as unknown as { diagnosticCollection: { set: jest.Mock } }
        ).diagnosticCollection;

        const lintPromise = provider.lintDocument(document);
        (document as unknown as { version: number }).version = 2;
        resolveLint?.([
            {
                ruleId: 'PAR001',
                message: 'PAR001: Parser error',
                severity: vscode.DiagnosticSeverity.Error,
                startOffset: 0,
                endOffset: 3
            }
        ]);
        await lintPromise;

        expect(diagnosticCollection.set).not.toHaveBeenCalled();
        lintSqlSpy.mockRestore();
    });

    it('publishes validator diagnostics with a base offset and source', () => {
        const document = {
            uri: { toString: () => 'file:///publish.sql' },
            version: 1,
            languageId: 'sql',
            getText: jest.fn(() => 'SELECT FROM T;'),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;
        const diagnosticCollection = (
            provider as unknown as { diagnosticCollection: { set: jest.Mock } }
        ).diagnosticCollection;

        provider.publishValidationErrors(document, [{
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
        }], { baseOffset: 7, source: 'Netezza Parser (selection)' });

        const diagnostics = diagnosticCollection.set.mock.calls[0][1] as vscode.Diagnostic[];
        expect(diagnostics[0].source).toBe('Netezza Parser (selection)');
        expect(diagnostics[0].message).toBe('SQL003: Syntax error');
        expect(diagnostics[0].range.start.character).toBe(7);
    });

    it('runs an explicitly requested on-demand lint even when automatic linting is disabled', async () => {
        const document = {
            uri: { toString: () => 'file:///disabled.sql' },
            version: 1,
            languageId: 'sql',
            lineCount: 1,
            getText: jest.fn(() => 'SELECT 1;'),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];
        (vscode.workspace.getConfiguration as jest.Mock).mockReturnValueOnce({
            get: jest.fn((key: string, defaultValue?: unknown) =>
                key === 'enabled' ? false : defaultValue
            )
        });

        const lintSqlSpy = jest.spyOn(provider, 'lintSql').mockResolvedValue([]);

        await provider.lintDocument(document, true);

        expect(lintSqlSpy).toHaveBeenCalled();
        lintSqlSpy.mockRestore();
    });

    it('clears on-demand diagnostics when a skipped large document changes', () => {
        const largeText = 'x'.repeat(1_000);
        const document = {
            uri: { toString: () => 'file:///large-change.sql' },
            version: 1,
            languageId: 'sql',
            lineCount: 1_000,
            getText: jest.fn(() => largeText),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        (vscode.workspace as unknown as { textDocuments: vscode.TextDocument[] }).textDocuments = [document];
        provider.activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);

        const changeHandler = (vscode.workspace.onDidChangeTextDocument as jest.Mock).mock.calls
            .find(call => typeof call[0] === 'function')?.[0] as
            | ((event: { document: vscode.TextDocument }) => void)
            | undefined;
        expect(changeHandler).toBeDefined();

        const diagnosticCollection = (
            provider as unknown as { diagnosticCollection: { delete: jest.Mock } }
        ).diagnosticCollection;

        changeHandler?.({ document });

        expect(diagnosticCollection.delete).toHaveBeenCalledWith(document.uri);
    });

    it('preserves quality diagnostics while replacing previous on-demand parser diagnostics', () => {
        const text = 'SELECT FROM T;';
        const document = {
            uri: { toString: () => 'file:///quality-preserve.sql' },
            version: 1,
            languageId: 'sql',
            lineCount: 1,
            getText: jest.fn(() => text),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        const collection = (
            provider as unknown as { diagnosticCollection: vscode.DiagnosticCollection }
        ).diagnosticCollection;

        const qualityDiagnostic = new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 6),
            'quality warning',
            vscode.DiagnosticSeverity.Warning
        );
        qualityDiagnostic.source = 'Netezza Quality';
        qualityDiagnostic.code = 'NZ001';

        const staleParserDiagnostic = new vscode.Diagnostic(
            new vscode.Range(0, 7, 0, 8),
            'stale parser error',
            vscode.DiagnosticSeverity.Error
        );
        staleParserDiagnostic.source = 'Netezza Parser (on demand)';
        staleParserDiagnostic.code = 'SQL003';

        const otherScopeDiagnostic = new vscode.Diagnostic(
            new vscode.Range(0, 0, 0, 6),
            'selection parser error',
            vscode.DiagnosticSeverity.Error
        );
        otherScopeDiagnostic.source = 'Netezza Parser (selection)';
        otherScopeDiagnostic.code = 'SQL003';

        collection.set(document.uri, [
            qualityDiagnostic,
            staleParserDiagnostic,
            otherScopeDiagnostic
        ]);

        const parserError = {
            code: 'SQL003',
            message: 'Syntax error',
            severity: 'error' as const,
            position: {
                startLine: 1,
                startColumn: 8,
                endLine: 1,
                endColumn: 9,
                offset: 7
            }
        };

        provider.publishValidationErrors(document, [parserError, parserError], {
            source: 'Netezza Parser (on demand)'
        });

        const published = collection.get(document.uri) ?? [];
        expect(published).toHaveLength(3);
        expect(published[0].code).toBe('NZ001');
        expect(published[0].source).toBe('Netezza Quality');
        expect(published[1].source).toBe('Netezza Parser (selection)');
        expect(published[2].code).toBe('SQL003');
        expect(published[2].message).toBe('SQL003: Syntax error');
        expect(published[2].source).toBe('Netezza Parser (on demand)');
    });

    it('does not let an in-flight lint overwrite an explicit validation result', async () => {
        const text = 'SELECT FROM T;';
        const document = {
            uri: { toString: () => 'file:///generation-guard.sql' },
            version: 1,
            languageId: 'sql',
            lineCount: 1,
            getText: jest.fn(() => text),
            positionAt: jest.fn((offset: number) => new vscode.Position(0, offset))
        } as unknown as vscode.TextDocument;

        let resolveLint: ((issues: never[]) => void) | undefined;
        const lintPromise = new Promise<never[]>((resolve) => {
            resolveLint = resolve;
        });
        const lintSqlSpy = jest.spyOn(provider, 'lintSql').mockReturnValue(lintPromise);

        const lintDocumentPromise = provider.lintDocument(document, true);

        provider.publishValidationErrors(
            document,
            [{
                code: 'SQL003',
                message: 'Syntax error',
                severity: 'error',
                position: {
                    startLine: 1,
                    startColumn: 8,
                    endLine: 1,
                    endColumn: 9,
                    offset: 7
                }
            }],
            { source: 'Netezza Parser (on demand)' }
        );

        resolveLint?.([]);
        await lintDocumentPromise;

        const collection = (
            provider as unknown as { diagnosticCollection: vscode.DiagnosticCollection }
        ).diagnosticCollection;
        const published = collection.get(document.uri) ?? [];
        expect(published).toHaveLength(1);
        expect(published[0].code).toBe('SQL003');
        expect(published[0].source).toBe('Netezza Parser (on demand)');

        lintSqlSpy.mockRestore();
    });
});

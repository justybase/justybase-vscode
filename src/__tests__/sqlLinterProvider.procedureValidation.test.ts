import * as vscode from 'vscode';
const validateMock = jest.fn();
const getInitializedSqlValidatorMock = jest.fn();
const getSqlValidationContextMock = jest.fn();

jest.mock('../sqlParser', () => ({
    SqlValidator: jest.fn().mockImplementation(() => ({
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

    it('does not invoke parser validator in quality-only lint mode', async () => {
        const sql = 'SELECT FROM DIMACCOUNT;';
        const issues = await provider.lintSql(sql, {}, false, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(issues.some(issue => issue.ruleId.startsWith('PAR'))).toBe(false);
        expect(issues.some(issue => issue.ruleId.startsWith('SQL'))).toBe(false);
    });

    it('adds supplemental NZ001 and NZ004 warnings for SELECT * and CROSS JOIN', async () => {
        const issues = await provider.lintSql('SELECT * FROM T1 CROSS JOIN T2;', {}, false, 'advanced');

        expect(validateMock).not.toHaveBeenCalled();
        expect(issues.some(issue => issue.ruleId === 'NZ001')).toBe(true);
        expect(issues.some(issue => issue.ruleId === 'NZ004')).toBe(true);
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
});

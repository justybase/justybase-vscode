jest.unmock('chevrotain');

import * as vscode from 'vscode';
import * as sqlParser from '../sqlParser';
import {
    buildExtractSubquerySql,
    EXTRACT_SUBQUERY_PREVIEW_COMMAND,
    SqlRefactorCodeActionProvider,
} from '../providers/sqlRefactorCodeActions';
import {
    registerSqlRefactorPreviewCommand,
    runExtractSubqueryPreview,
    type SqlRefactorPreviewDependencies,
    type SqlRefactorPreviewChoice,
} from '../providers/sqlRefactorPreview';

jest.mock('vscode', () => {
    class Position {
        constructor(public line: number, public character: number) {}
    }

    class Range {
        constructor(public start: Position, public end: Position) {}
    }

    class WorkspaceEdit {
        public insert = jest.fn();
        public replace = jest.fn();
        public delete = jest.fn();
    }

    class CodeAction {
        public edit?: WorkspaceEdit;
        public isPreferred?: boolean;
        public command?: unknown;

        constructor(public title: string, public kind: string) {}
    }

    class Uri {
        static parse(value: string) {
            return { toString: () => value };
        }
    }

    return {
        commands: { registerCommand: jest.fn(() => ({ dispose: jest.fn() })) },
        Position,
        Range,
        WorkspaceEdit,
        CodeAction,
        Uri,
        CodeActionKind: {
            QuickFix: 'quickfix',
            Refactor: 'refactor',
            RefactorExtract: 'refactor.extract',
            RefactorRewrite: 'refactor.rewrite'
        }
    };
});

type MockWorkspaceEdit = {
    insert: jest.Mock;
    replace: jest.Mock;
    delete: jest.Mock;
};

function createMockDocument(text: string): vscode.TextDocument {
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text[index] === '\n') {
            lineStarts.push(index + 1);
        }
    }

    return {
        uri: { toString: () => 'file:///refactor.sql' },
        getText: jest.fn(() => text),
        version: 4,
        languageId: 'sql',
        fileName: '/workspace/refactor.sql',
        offsetAt: jest.fn((position: vscode.Position) => {
            const lineStart = lineStarts[position.line] ?? 0;
            return lineStart + position.character;
        }),
        positionAt: jest.fn((offset: number) => {
            let line = 0;
            for (let index = 0; index < lineStarts.length; index++) {
                const currentStart = lineStarts[index];
                const nextStart = lineStarts[index + 1] ?? text.length + 1;
                if (offset >= currentStart && offset < nextStart) {
                    line = index;
                    break;
                }
            }
            return new vscode.Position(line, offset - lineStarts[line]);
        })
    } as unknown as vscode.TextDocument;
}

function createPreviewDocument(text: string, version: number): vscode.TextDocument {
    return {
        uri: { toString: () => 'file:///refactor.sql' },
        version,
        languageId: 'sql',
        fileName: '/workspace/refactor.sql',
        getText: () => text,
        positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;
}

function previewArgs(proposedSql: string) {
    return {
        sourceUri: 'file:///refactor.sql',
        expectedVersion: 4,
        originalSql: 'SELECT 1;',
        proposedSql,
        languageId: 'sql',
    };
}

function createPreviewDependencies(
    getSourceDocument: () => vscode.TextDocument,
    choice: SqlRefactorPreviewChoice,
): SqlRefactorPreviewDependencies {
    return {
        findSourceDocument: jest.fn(() => getSourceDocument()),
        openSourceDocument: jest.fn(() => Promise.resolve(getSourceDocument())),
        openPreviewDocument: jest.fn(() => Promise.resolve({
            uri: { toString: () => 'untitled:proposal.sql' },
        } as vscode.TextDocument)),
        openDiff: jest.fn(() => Promise.resolve(undefined)),
        choose: jest.fn(() => Promise.resolve(choice)),
        apply: jest.fn(() => Promise.resolve(true)),
        closeDiff: jest.fn(() => Promise.resolve(undefined)),
        showStaleMessage: jest.fn(),
        showApplyFailureMessage: jest.fn(),
    };
}

describe('SqlRefactorCodeActionProvider', () => {
    const provider = new SqlRefactorCodeActionProvider();

    it('registers the private preview command with VS Code', () => {
        const disposable = registerSqlRefactorPreviewCommand();
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            EXTRACT_SUBQUERY_PREVIEW_COMMAND,
            expect.any(Function),
        );
        disposable.dispose();
    });

    it('creates an Extract Subquery as CTE preview action without applying an edit', () => {
        const sql = `SELECT *
FROM (
    SELECT CUSTOMER_ID, COUNT(*) AS ORDER_COUNT
    FROM SALES..ORDERS
) ORDER_COUNTS;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(2, 12), new vscode.Position(2, 12));

        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const action = actions.find(item => item.title === '⚡ Refactor: Extract Subquery as CTE');
        expect(action).toBeDefined();
        expect(action?.edit).toBeUndefined();
        expect(action?.command).toMatchObject({ command: EXTRACT_SUBQUERY_PREVIEW_COMMAND });
        const command = action?.command as { arguments: Array<{ originalSql: string; proposedSql: string; expectedVersion: number }> };
        expect(command.arguments[0].originalSql).toBe(sql);
        expect(command.arguments[0].expectedVersion).toBe(4);
        expect(command.arguments[0].proposedSql).toContain('WITH new_cte_name AS');
        expect(command.arguments[0].proposedSql).toContain('FROM new_cte_name ORDER_COUNTS');
    });

    it('preserves CRLF while generating and parser-checking the extracted CTE', () => {
        const sql = 'SELECT *\r\nFROM (\r\n    SELECT ID\r\n    FROM ORDERS\r\n) O;';
        const analysis = sqlParser.analyzeSqlQueryStructures(sql);
        const proposed = buildExtractSubquerySql(sql, analysis.extractSubqueryCandidates[0]);
        expect(proposed).toBeDefined();
        expect(proposed).toContain('WITH new_cte_name AS (\r\n');
        expect(proposed).not.toContain('WITH new_cte_name AS (\n');
    });

    it('adds an extracted query to an existing WITH and avoids a CTE name collision', () => {
        const sql = `WITH NEW_CTE_NAME AS (
    SELECT 0 AS ID
)
SELECT *
FROM (
    SELECT ID FROM ORDERS
) O;`;
        const analysis = sqlParser.analyzeSqlQueryStructures(sql);
        const proposed = buildExtractSubquerySql(sql, analysis.extractSubqueryCandidates[0]);

        expect(proposed).toContain('NEW_CTE_NAME AS');
        expect(proposed).toMatch(/,\r?\n\s*new_cte_name_2 AS/u);
        expect(proposed).toContain('FROM new_cte_name_2 O');
    });

    it('chooses the innermost extracted subquery covering the cursor', () => {
        const sql = `SELECT *
FROM (
    SELECT *
    FROM (
        SELECT ID FROM ORDERS
    ) INNER_QUERY
) OUTER_QUERY;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(4, 18), new vscode.Position(4, 18));
        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken,
        );
        const action = actions.find(item => item.title === '⚡ Refactor: Extract Subquery as CTE');
        const args = (action?.command as { arguments: Array<{ proposedSql: string }> } | undefined)?.arguments[0];

        expect(args?.proposedSql).toContain('FROM new_cte_name_2 INNER_QUERY');
        expect(args?.proposedSql).toContain(') OUTER_QUERY');
    });

    it('does not offer extraction for a correlated subquery', () => {
        const sql = `SELECT C.ID
FROM CUSTOMERS C
JOIN (
    SELECT O.CUSTOMER_ID
    FROM ORDERS O
    WHERE O.CUSTOMER_ID = C.ID
) Q ON Q.CUSTOMER_ID = C.ID;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(5, 30), new vscode.Position(5, 30));
        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken,
        );
        expect(actions.find(item => item.title === '⚡ Refactor: Extract Subquery as CTE')).toBeUndefined();
    });

    it('shows the source against the proposal and applies only after confirmation', async () => {
        const sourceDocument = createPreviewDocument('SELECT 1;', 4);
        const liveDocument = sourceDocument;
        const deps = createPreviewDependencies(() => liveDocument, 'Apply');

        await runExtractSubqueryPreview(previewArgs('SELECT 2;'), deps);

        expect(deps.openDiff).toHaveBeenCalledWith(
            sourceDocument.uri,
            expect.objectContaining({ toString: expect.any(Function) }),
            expect.stringContaining('refactor.sql'),
        );
        expect(deps.apply).toHaveBeenCalledWith(sourceDocument, 'SELECT 2;');
        expect(deps.closeDiff).not.toHaveBeenCalled();
    });

    it('discards on Escape and refuses to apply if the source changed during review', async () => {
        const sourceDocument = createPreviewDocument('SELECT 1;', 4);
        const discardDeps = createPreviewDependencies(() => sourceDocument, undefined);
        await runExtractSubqueryPreview(previewArgs('SELECT 2;'), discardDeps);
        expect(discardDeps.apply).not.toHaveBeenCalled();
        expect(discardDeps.closeDiff).toHaveBeenCalledWith(
            sourceDocument.uri,
            expect.objectContaining({ toString: expect.any(Function) }),
        );

        const liveDocument = { current: createPreviewDocument('SELECT 1;', 4) };
        const changedDocument = createPreviewDocument('SELECT 3;', 5);
        const staleDeps = createPreviewDependencies(() => liveDocument.current, 'Apply');
        staleDeps.choose = jest.fn(() => {
            liveDocument.current = changedDocument;
            return Promise.resolve('Apply');
        });
        await runExtractSubqueryPreview(previewArgs('SELECT 2;'), staleDeps);
        expect(staleDeps.apply).not.toHaveBeenCalled();
        expect(staleDeps.showStaleMessage).toHaveBeenCalledTimes(1);
    });

    it('closes the diff after Apply & Close Diff', async () => {
        const sourceDocument = createPreviewDocument('SELECT 1;', 4);
        const deps = createPreviewDependencies(() => sourceDocument, 'Apply & Close Diff');
        await runExtractSubqueryPreview(previewArgs('SELECT 2;'), deps);
        expect(deps.apply).toHaveBeenCalledTimes(1);
        expect(deps.closeDiff).toHaveBeenCalledTimes(1);
    });

    it('creates a Materialize CTE to Temporary Table refactor action', () => {
        const sql = `WITH SALES_CTE AS (
    SELECT CUSTOMER_ID
    FROM SALES..ORDERS
)
SELECT * FROM SALES_CTE;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(0, 6), new vscode.Position(0, 15));

        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const action = actions.find(item => item.title === '⚡ Refactor: Materialize CTE to Temporary Table');
        expect(action).toBeDefined();
        const edit = action?.edit as unknown as MockWorkspaceEdit;
        expect(edit.replace).toHaveBeenCalledTimes(1);
        expect(edit.replace.mock.calls[0][2]).toContain('CREATE TEMP TABLE SALES_CTE AS');
        expect(edit.replace.mock.calls[0][2]).toContain('(\n    SELECT CUSTOMER_ID');
        expect(edit.replace.mock.calls[0][2]).toContain('FROM SALES..ORDERS');
        expect(edit.replace.mock.calls[0][2]).toContain(')DISTRIBUTE ON RANDOM;');
    });

    it('does not offer bulk CTE conversion when selection is inside a single CTE definition', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
),
CTE2 AS (
    SELECT 2 AS VALUE
)
SELECT * FROM CTE2;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(0, 6), new vscode.Position(1, 22));

        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        expect(actions.find(item => item.title === '⚡ Refactor: Materialize CTE to Temporary Table')).toBeDefined();
        expect(actions.find(item => item.title === '⚡ Refactor: Convert CTEs to Temp Tables')).toBeUndefined();
        expect(actions.find(item => item.title === '⚡ Refactor: Convert CTEs to Global Temp Tables')).toBeUndefined();
    });

    it('creates bulk Convert CTEs to Temp Tables refactor actions', () => {
        const sql = `WITH CTE1 AS (
    SELECT 1 AS VALUE
),
CTE2 AS (
    SELECT 2 AS VALUE
)
SELECT * FROM CTE2;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(6, 20));

        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const tempAction = actions.find(item => item.title === '⚡ Refactor: Convert CTEs to Temp Tables');
        const globalAction = actions.find(item => item.title === '⚡ Refactor: Convert CTEs to Global Temp Tables');
        expect(tempAction).toBeDefined();
        expect(globalAction).toBeDefined();

        const edit = tempAction?.edit as unknown as MockWorkspaceEdit;
        expect(edit.replace).toHaveBeenCalledTimes(1);
        expect(edit.replace.mock.calls[0][2]).toContain('CREATE TEMP TABLE CTE1');
        expect(edit.replace.mock.calls[0][2]).toContain('CREATE TEMP TABLE CTE2');
        expect(edit.replace.mock.calls[0][2]).not.toContain('WITH CTE1');
        expect(edit.replace.mock.calls[0][2]).toContain('SELECT * FROM CTE2;');
    });

    it('does not offer bulk CTE conversion for WITH RECURSIVE', () => {
        const sql = `WITH RECURSIVE CTE1 AS (
    SELECT 1 AS VALUE
)
SELECT * FROM CTE1;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(3, 20));

        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        expect(actions.find(item => item.title === '⚡ Refactor: Convert CTEs to Temp Tables')).toBeUndefined();
        expect(actions.find(item => item.title === '⚡ Refactor: Convert CTEs to Global Temp Tables')).toBeUndefined();
    });

    it('creates an Inline Temp Table as CTE refactor action', () => {
        const sql = `CREATE TEMP TABLE TMP_SALES AS
SELECT CUSTOMER_ID
FROM SALES..ORDERS;

SELECT *
FROM TMP_SALES;`;
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(0, 5), new vscode.Position(0, 14));

        const actions = provider.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        const action = actions.find(item => item.title === '⚡ Refactor: Inline Temp Table as CTE');
        expect(action).toBeDefined();
        const edit = action?.edit as unknown as MockWorkspaceEdit;
        expect(edit.delete).toHaveBeenCalledTimes(1);
        expect(edit.insert).toHaveBeenCalledTimes(1);
        expect(edit.insert.mock.calls[0][2]).toContain('WITH TMP_SALES AS');
    });

    it('passes the resolved database kind into query structure analysis', () => {
        const providerWithResolver = new SqlRefactorCodeActionProvider(() => 'db2');
        const analyzeSpy = jest.spyOn(sqlParser, 'analyzeSqlQueryStructures');
        const sql = 'SELECT * FROM SYSIBM.SYSDUMMY1;';
        const document = createMockDocument(sql);
        const selection = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));

        providerWithResolver.provideCodeActions(
            document,
            selection,
            { diagnostics: [] } as unknown as vscode.CodeActionContext,
            {} as vscode.CancellationToken
        );

        expect(analyzeSpy).toHaveBeenCalledWith(sql, 'db2');
    });
});

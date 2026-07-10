jest.unmock('chevrotain');

import * as vscode from 'vscode';
import * as sqlParser from '../sqlParser';
import { SqlRefactorCodeActionProvider } from '../providers/sqlRefactorCodeActions';

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

        constructor(public title: string, public kind: string) {}
    }

    return {
        Position,
        Range,
        WorkspaceEdit,
        CodeAction,
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

describe('SqlRefactorCodeActionProvider', () => {
    const provider = new SqlRefactorCodeActionProvider();

    it('creates an Extract Subquery as CTE refactor action', () => {
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
        const edit = action?.edit as unknown as MockWorkspaceEdit;
        expect(edit.insert).toHaveBeenCalledTimes(1);
        expect(edit.insert.mock.calls[0][2]).toContain('WITH new_cte_name AS');
        expect(edit.replace).toHaveBeenCalledTimes(1);
        expect(edit.replace.mock.calls[0][2]).toBe('new_cte_name');
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

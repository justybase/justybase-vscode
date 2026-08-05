import * as vscode from 'vscode';
import { SqlParser } from '../sql/sqlParser';
import {
    navigateToAdjacentSqlStatement,
    registerSqlStatementNavigation,
} from '../editors/sqlStatementNavigation';

jest.mock('vscode', () => jest.requireActual('./__mocks__/vscode'));

function createDocument(text: string, languageId = 'netezza-sql'): vscode.TextDocument {
    const lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') {
            lineStarts.push(index + 1);
        }
    }

    return {
        languageId,
        version: 1,
        uri: { toString: () => 'file:///navigation.sql' },
        getText: () => text,
        offsetAt: (position: vscode.Position) => {
            const lineStart = lineStarts[position.line] ?? text.length;
            return Math.min(text.length, lineStart + position.character);
        },
        positionAt: (offset: number) => {
            const boundedOffset = Math.max(0, Math.min(text.length, offset));
            let line = 0;
            while (line + 1 < lineStarts.length && lineStarts[line + 1] <= boundedOffset) {
                line += 1;
            }
            return new vscode.Position(line, boundedOffset - lineStarts[line]);
        },
    } as unknown as vscode.TextDocument;
}

function createEditor(text: string, offset: number, languageId = 'netezza-sql'): vscode.TextEditor {
    const document = createDocument(text, languageId);
    const position = document.positionAt(offset);
    return {
        document,
        selection: new vscode.Selection(position, position),
        revealRange: jest.fn(),
    } as unknown as vscode.TextEditor;
}

describe('sql statement navigation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        SqlParser.clearDocumentCache();
    });

    it.each(['sql', 'mssql', 'netezza-sql'])('moves to the next statement in %s', (languageId) => {
        const sql = 'SELECT 1;\n\n  SELECT 2; SELECT 3;';
        const editor = createEditor(sql, sql.indexOf('1'), languageId);

        expect(navigateToAdjacentSqlStatement('next', editor)).toBe(true);
        expect(editor.selection.active).toEqual(editor.document.positionAt(sql.indexOf('SELECT 2')));
        expect(editor.selection.isEmpty).toBe(true);
        expect(editor.revealRange).toHaveBeenCalledTimes(1);
    });

    it('moves to the previous statement and collapses an existing selection', () => {
        const sql = 'SELECT 1; SELECT 2; SELECT 3;';
        const editor = createEditor(sql, sql.indexOf('3'));
        const start = editor.document.positionAt(sql.indexOf('SELECT 3'));
        const end = editor.document.positionAt(sql.length);
        editor.selection = new vscode.Selection(end, start);

        expect(navigateToAdjacentSqlStatement('previous', editor)).toBe(true);
        expect(editor.selection.active).toEqual(editor.document.positionAt(sql.indexOf('SELECT 2')));
        expect(editor.selection.isEmpty).toBe(true);
    });

    it('skips empty semicolon-delimited segments and is a no-op at the ends', () => {
        const sql = 'SELECT 1;;; SELECT 2;';
        const editor = createEditor(sql, sql.indexOf('1'));

        expect(navigateToAdjacentSqlStatement('next', editor)).toBe(true);
        expect(editor.selection.active).toEqual(editor.document.positionAt(sql.indexOf('SELECT 2')));
        expect(navigateToAdjacentSqlStatement('next', editor)).toBe(false);
        expect(navigateToAdjacentSqlStatement('previous', createEditor(sql, 0))).toBe(false);
    });

    it('does not act in non-SQL editors', () => {
        const editor = createEditor('SELECT 1; SELECT 2;', 0, 'typescript');

        expect(navigateToAdjacentSqlStatement('next', editor)).toBe(false);
        expect(editor.revealRange).not.toHaveBeenCalled();
    });

    it('registers both navigation commands', () => {
        const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;

        registerSqlStatementNavigation(context);

        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'netezza.navigatePreviousStatement',
            expect.any(Function),
        );
        expect(vscode.commands.registerCommand).toHaveBeenCalledWith(
            'netezza.navigateNextStatement',
            expect.any(Function),
        );
    });
});

import * as vscode from 'vscode';
import { SqlParser } from '../sql/sqlParser';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

export type SqlStatementNavigationDirection = 'previous' | 'next';

/**
 * Move the active cursor to the first non-whitespace character of the
 * adjacent semicolon-delimited SQL statement.
 */
export function navigateToAdjacentSqlStatement(
    direction: SqlStatementNavigationDirection,
    editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): boolean {
    if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
        return false;
    }

    const document = editor.document;
    const activeOffset = document.offsetAt(editor.selection.active);
    const offset = direction === 'previous'
        ? Math.min(activeOffset, document.offsetAt(editor.selection.anchor))
        : activeOffset;
    const statement = SqlParser.getAdjacentStatementAtPosition(
        document.getText(),
        offset,
        direction === 'previous' ? -1 : 1,
        {
            documentId: document.uri.toString(),
            version: document.version,
        },
    );

    if (!statement) {
        return false;
    }

    const position = document.positionAt(statement.contentStart);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range);
    return true;
}

export function registerSqlStatementNavigation(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'netezza.navigatePreviousStatement',
            () => navigateToAdjacentSqlStatement('previous'),
        ),
        vscode.commands.registerCommand(
            'netezza.navigateNextStatement',
            () => navigateToAdjacentSqlStatement('next'),
        ),
    );
}

/**
 * SQL Shortcuts - Auto-expand shortcuts like SX -> SELECT
 */

import * as vscode from 'vscode';

// SQL shortcuts mapping
const shortcuts = new Map<string, string>([
    ['SX', 'SELECT'],
    ['WX', 'WHERE'],
    ['GX', 'GROUP BY'],
    ['HX', 'HAVING'],
    ['OX', 'ORDER BY'],
    ['FX', 'FROM'],
    ['JX', 'JOIN'],
    ['LX', 'LIMIT'],
    ['IX', 'INSERT INTO'],
    ['UX', 'UPDATE'],
    ['DX', 'DELETE FROM'],
    ['CX', 'CREATE TABLE']
]);

/** True when `char` may precede a shortcut trigger (not part of a larger identifier). */
function isShortcutBoundaryBefore(char: string | undefined): boolean {
    return char === undefined || !/[a-zA-Z0-9_]/.test(char);
}

/**
 * If `lineText` ends with `trigger` immediately before the inserted space at
 * `spaceColumn`, return the trigger start column; otherwise -1.
 */
function findShortcutAtSpace(
    lineText: string,
    spaceColumn: number,
    trigger: string,
): number {
    const textBeforeSpace = lineText.substring(0, spaceColumn);
    if (textBeforeSpace.length < trigger.length) {
        return -1;
    }

    const triggerStart = textBeforeSpace.length - trigger.length;
    if (textBeforeSpace.substring(triggerStart).toUpperCase() !== trigger.toUpperCase()) {
        return -1;
    }

    if (!isShortcutBoundaryBefore(textBeforeSpace[triggerStart - 1])) {
        return -1;
    }

    return triggerStart;
}

/**
 * Register SQL shortcuts handler
 */
export function registerSqlShortcuts(context: vscode.ExtensionContext): void {
    const disposable = vscode.workspace.onDidChangeTextDocument(async event => {
        // Only process SQL files
        if (event.document.languageId !== 'sql' && event.document.languageId !== 'mssql') {
            return;
        }

        // Only process single character additions (typing)
        if (event.contentChanges.length !== 1) {
            return;
        }

        const change = event.contentChanges[0];

        // Check if user typed a space (trigger for shortcuts)
        if (change.text !== ' ') {
            return;
        }

        // Get the active editor
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document) {
            return;
        }

        // Get the line where the change occurred
        const line = event.document.lineAt(change.range.start.line);
        const lineText = line.text;

        // Expand shortcut typed immediately before the inserted space (not only at EOL)
        const spaceColumn = change.range.start.character;
        let processed = false;
        for (const [trigger, replacement] of shortcuts) {
            const triggerStart = findShortcutAtSpace(lineText, spaceColumn, trigger);
            if (triggerStart < 0) {
                continue;
            }

            const line = change.range.start.line;
            const startPos = new vscode.Position(line, triggerStart);
            const endPos = new vscode.Position(line, spaceColumn + 1); // include typed space

            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(startPos, endPos), replacement + ' ');
            });

            if (['SELECT', 'FROM', 'JOIN'].includes(replacement)) {
                setTimeout(() => {
                    vscode.commands.executeCommand('editor.action.triggerSuggest');
                }, 100);
            }

            processed = true;
            break;
        }

        if (processed) {
            return;
        }

        // LIKE auto-snippet: "LIKE " → "LIKE '%%'" with cursor between %%
        const likeMatch = lineText.match(/\b(like)\s+$/i);
        if (likeMatch) {
            const keywordStart = lineText.toLowerCase().lastIndexOf('like');
            const wordEnd = keywordStart + likeMatch[1].length;

            const startPos = new vscode.Position(change.range.start.line, keywordStart);
            const endPos = new vscode.Position(change.range.start.line, wordEnd + 1); // +1 for trailing space

            await editor.edit(editBuilder => {
                editBuilder.replace(new vscode.Range(startPos, endPos), `${likeMatch[1]} '%%'`);
            });

            // Position cursor between the two % signs
            const cursorPos = new vscode.Position(change.range.start.line, wordEnd + 3);
            editor.selection = new vscode.Selection(cursorPos, cursorPos);
            editor.revealRange(new vscode.Range(cursorPos, cursorPos));
        }
    });

    context.subscriptions.push(disposable);
}

/**
 * Decoration Manager - manages SQL highlighting and script decorations
 */

import * as vscode from 'vscode';
import { SqlParser } from '../sql/sqlParser';
import { affectsExtensionConfiguration, getExtensionConfiguration } from '../compatibility/configuration';
import { LARGE_SCRIPT_CHAR_THRESHOLD, LARGE_SCRIPT_LINE_THRESHOLD } from '../sqlParser/validationConfig';

const SELECTION_HIGHLIGHT_DEBOUNCE_MS = 100;
const LARGE_SCRIPT_HIGHLIGHT_DEBOUNCE_MS = 500;

/**
 * Create decoration type for SQL statement highlighting
 */
export function createSqlStatementDecoration(): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(5, 115, 201, 0.10)',
        isWholeLine: false,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
    });
}

/**
 * Update script decorations for an editor
 */
// Script invocation decorations and CodeLens were removed intentionally.

interface HighlightState {
    version: number;
    offset: number;
    rangeStart: number;
    rangeEnd: number;
}

let lastHighlightState = new WeakMap<vscode.TextEditor, HighlightState>();
let selectionHighlightTimer: ReturnType<typeof setTimeout> | undefined;
let pendingHighlightEditor: vscode.TextEditor | undefined;

function shouldSkipHighlightUpdate(
    editor: vscode.TextEditor,
    version: number,
    offset: number,
    rangeStart: number,
    rangeEnd: number,
): boolean {
    const previous = lastHighlightState.get(editor);
    if (!previous) {
        return false;
    }

    return (
        previous.version === version &&
        previous.offset === offset &&
        previous.rangeStart === rangeStart &&
        previous.rangeEnd === rangeEnd
    );
}

function rememberHighlightState(
    editor: vscode.TextEditor,
    version: number,
    offset: number,
    rangeStart: number,
    rangeEnd: number,
): void {
    lastHighlightState.set(editor, {
        version,
        offset,
        rangeStart,
        rangeEnd,
    });
}

function clearHighlightState(editor: vscode.TextEditor): void {
    lastHighlightState.delete(editor);
}

/**
 * Update SQL statement highlighting based on cursor position
 */
export function updateSqlHighlight(
    sqlStatementDecoration: vscode.TextEditorDecorationType,
    editor: vscode.TextEditor | undefined
): void {
    const config = getExtensionConfiguration();
    const enabled = config.get<boolean>('highlightActiveStatement', true);

    if (!enabled || !editor || (editor.document.languageId !== 'sql' && editor.document.languageId !== 'mssql')) {
        if (editor) {
            editor.setDecorations(sqlStatementDecoration, []);
            clearHighlightState(editor);
        }
        return;
    }

    try {
        const document = editor.document;
        if (document.lineCount > LARGE_SCRIPT_LINE_THRESHOLD) {
            editor.setDecorations(sqlStatementDecoration, []);
            clearHighlightState(editor);
            return;
        }

        const documentId = document.uri.toString();
        const position = editor.selection.active;
        const offset = document.offsetAt(position);
        const text = document.getText() ?? '';
        if (text.length > LARGE_SCRIPT_CHAR_THRESHOLD) {
            editor.setDecorations(sqlStatementDecoration, []);
            clearHighlightState(editor);
            return;
        }
        const documentKey = {
            documentId,
            version: document.version,
        };

        const stmt = SqlParser.getStatementAtPosition(text, offset, documentKey);

        if (stmt) {
            if (shouldSkipHighlightUpdate(editor, document.version, offset, stmt.start, stmt.end)) {
                return;
            }

            const startPos = document.positionAt(stmt.start);
            const endPos = document.positionAt(stmt.end);
            const range = new vscode.Range(startPos, endPos);
            editor.setDecorations(sqlStatementDecoration, [range]);
            rememberHighlightState(editor, document.version, offset, stmt.start, stmt.end);
        } else {
            if (shouldSkipHighlightUpdate(editor, document.version, offset, -1, -1)) {
                return;
            }

            editor.setDecorations(sqlStatementDecoration, []);
            rememberHighlightState(editor, document.version, offset, -1, -1);
        }
    } catch (e) {
        console.error('Error updating SQL highlight:', e);
    }
}

function scheduleSqlHighlightUpdate(
    sqlStatementDecoration: vscode.TextEditorDecorationType,
    editor: vscode.TextEditor | undefined,
): void {
    pendingHighlightEditor = editor;

    if (selectionHighlightTimer) {
        clearTimeout(selectionHighlightTimer);
    }

    const debounceMs = editor?.document.lineCount && editor.document.lineCount > LARGE_SCRIPT_LINE_THRESHOLD
        ? LARGE_SCRIPT_HIGHLIGHT_DEBOUNCE_MS
        : SELECTION_HIGHLIGHT_DEBOUNCE_MS;

    selectionHighlightTimer = setTimeout(() => {
        selectionHighlightTimer = undefined;
        updateSqlHighlight(sqlStatementDecoration, pendingHighlightEditor);
        pendingHighlightEditor = undefined;
    }, debounceMs);
}

function clearSqlHighlightScheduling(): void {
    if (selectionHighlightTimer) {
        clearTimeout(selectionHighlightTimer);
        selectionHighlightTimer = undefined;
    }
    pendingHighlightEditor = undefined;
}

function flushSqlHighlightScheduling(sqlStatementDecoration: vscode.TextEditorDecorationType): void {
    const editor = pendingHighlightEditor;
    clearSqlHighlightScheduling();
    if (editor) {
        updateSqlHighlight(sqlStatementDecoration, editor);
    }
}

/**
 * Register all decoration-related subscriptions
 */
export function registerDecorationSubscriptions(
    context: vscode.ExtensionContext,
    sqlStatementDecoration: vscode.TextEditorDecorationType
): void {
    lastHighlightState = new WeakMap<vscode.TextEditor, HighlightState>();

    // SQL statement highlighting
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            scheduleSqlHighlightUpdate(sqlStatementDecoration, e.textEditor);
        }),
        vscode.window.onDidChangeActiveTextEditor(e => {
            flushSqlHighlightScheduling(sqlStatementDecoration);
            updateSqlHighlight(sqlStatementDecoration, e);
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (affectsExtensionConfiguration(e, 'highlightActiveStatement')) {
                clearSqlHighlightScheduling();
                updateSqlHighlight(sqlStatementDecoration, vscode.window.activeTextEditor);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            SqlParser.clearDocumentCache(doc.uri.toString());
        }),
        {
            dispose: () => {
                clearSqlHighlightScheduling();
                lastHighlightState = new WeakMap<vscode.TextEditor, HighlightState>();
            },
        },
    );

    // Initial update for SQL highlighting
    updateSqlHighlight(sqlStatementDecoration, vscode.window.activeTextEditor);
}

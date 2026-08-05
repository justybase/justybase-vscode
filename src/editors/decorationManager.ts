/**
 * Decoration Manager - manages SQL highlighting and script decorations
 */

import * as vscode from 'vscode';
import { SqlParser } from '../sql/sqlParser';
import { affectsExtensionConfiguration, getExtensionConfiguration } from '../compatibility/configuration';
import { LARGE_SCRIPT_CHAR_THRESHOLD, LARGE_SCRIPT_LINE_THRESHOLD } from '../sqlParser/validationConfig';
import { getUxPerfSession } from '../services/perf/uxPerfSession';
import { isSqlAuthoringLanguageId } from '../utils/sqlLanguage';

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
    rangeStart: number;
    rangeEnd: number;
}

interface DocumentLengthState {
    version: number;
    length: number;
}

let lastHighlightState = new WeakMap<vscode.TextEditor, HighlightState>();
let documentLengthState = new WeakMap<vscode.TextDocument, DocumentLengthState>();
let selectionHighlightTimer: ReturnType<typeof setTimeout> | undefined;
let pendingHighlightEditor: vscode.TextEditor | undefined;

function shouldSkipHighlightUpdate(
    editor: vscode.TextEditor,
    version: number,
    rangeStart: number,
    rangeEnd: number,
): boolean {
    const previous = lastHighlightState.get(editor);
    if (!previous) {
        return false;
    }

    return (
        previous.version === version &&
        previous.rangeStart === rangeStart &&
        previous.rangeEnd === rangeEnd
    );
}

function rememberHighlightState(
    editor: vscode.TextEditor,
    version: number,
    rangeStart: number,
    rangeEnd: number,
): void {
    lastHighlightState.set(editor, {
        version,
        rangeStart,
        rangeEnd,
    });
}

function clearHighlightState(editor: vscode.TextEditor): void {
    lastHighlightState.delete(editor);
}

function clearDecorations(
    editor: vscode.TextEditor,
    decoration: vscode.TextEditorDecorationType,
): void {
    editor.setDecorations(decoration, []);
}

function setEmptyDecorationsIfNeeded(
    editor: vscode.TextEditor,
    decoration: vscode.TextEditorDecorationType,
): void {
    const previous = lastHighlightState.get(editor);
    if (previous?.rangeStart === -1 && previous.rangeEnd === -1) {
        return;
    }

    clearDecorations(editor, decoration);
    rememberHighlightState(editor, editor.document.version, -1, -1);
}

function applyStatementDecorations(
    editor: vscode.TextEditor,
    decoration: vscode.TextEditorDecorationType,
    start: number,
    end: number,
): void {
    editor.setDecorations(decoration, [
        new vscode.Range(editor.document.positionAt(start), editor.document.positionAt(end)),
    ]);
}

function getDocumentTextSnapshot(document: vscode.TextDocument): { text?: string; length: number } {
    const known = documentLengthState.get(document);
    if (known?.version === document.version) {
        return { length: known.length };
    }

    const text = document.getText() ?? '';
    documentLengthState.set(document, { version: document.version, length: text.length });
    return { text, length: text.length };
}

function updateDocumentLengthFromChange(event: vscode.TextDocumentChangeEvent): void {
    const previous = documentLengthState.get(event.document);
    if (!previous || previous.version >= event.document.version) {
        return;
    }

    let length = previous.length;
    for (const change of event.contentChanges) {
        length += change.text.length - change.rangeLength;
    }

    documentLengthState.set(event.document, {
        version: event.document.version,
        length,
    });
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
    const uxStartedAt = performance.now();
    const debounceMs = editor?.document.lineCount && editor.document.lineCount > LARGE_SCRIPT_LINE_THRESHOLD
        ? LARGE_SCRIPT_HIGHLIGHT_DEBOUNCE_MS
        : SELECTION_HIGHLIGHT_DEBOUNCE_MS;

    if (!enabled || !editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
        if (editor) {
            clearDecorations(editor, sqlStatementDecoration);
            clearHighlightState(editor);
        }
        return;
    }

    try {
        const document = editor.document;
        if (document.lineCount > LARGE_SCRIPT_LINE_THRESHOLD) {
            setEmptyDecorationsIfNeeded(editor, sqlStatementDecoration);
            emitHighlightUx(document, uxStartedAt, debounceMs, true, 'line_threshold');
            return;
        }

        const documentId = document.uri.toString();
        const position = editor.selection.active;
        const offset = document.offsetAt(position);
        const snapshot = getDocumentTextSnapshot(document);
        if (snapshot.length > LARGE_SCRIPT_CHAR_THRESHOLD) {
            setEmptyDecorationsIfNeeded(editor, sqlStatementDecoration);
            emitHighlightUx(document, uxStartedAt, debounceMs, true, 'char_threshold');
            return;
        }
        const text = snapshot.text ?? document.getText() ?? '';
        const documentKey = {
            documentId,
            version: document.version,
        };

        const stmt = SqlParser.getStatementAtPosition(text, offset, documentKey);

        if (stmt) {
            if (shouldSkipHighlightUpdate(editor, document.version, stmt.start, stmt.end)) {
                return;
            }

            applyStatementDecorations(editor, sqlStatementDecoration, stmt.start, stmt.end);
            rememberHighlightState(editor, document.version, stmt.start, stmt.end);
        } else {
            if (shouldSkipHighlightUpdate(editor, document.version, -1, -1)) {
                return;
            }

            clearDecorations(editor, sqlStatementDecoration);
            rememberHighlightState(editor, document.version, -1, -1);
        }
        emitHighlightUx(document, uxStartedAt, debounceMs, false, 'updated');
    } catch (e) {
        console.error('Error updating SQL highlight:', e);
    }
}

function emitHighlightUx(
    document: vscode.TextDocument,
    startedAt: number,
    debounceMs: number,
    skipped: boolean,
    reason: string,
): void {
    const ux = getUxPerfSession();
    if (!ux.isActive()) {
        return;
    }
    ux.emit({
        op: 'editor.highlight',
        phase: 'end',
        durationMs: performance.now() - startedAt,
        doc: ux.docContextFromDocument(document),
        meta: {
            debounceMs,
            skipped,
            reason,
            largeScript: document.lineCount > LARGE_SCRIPT_LINE_THRESHOLD,
        },
    });
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
        vscode.workspace.onDidChangeTextDocument(updateDocumentLengthFromChange),
        vscode.workspace.onDidCloseTextDocument(doc => {
            SqlParser.clearDocumentCache(doc.uri.toString());
        }),
        {
            dispose: () => {
                clearSqlHighlightScheduling();
                lastHighlightState = new WeakMap<vscode.TextEditor, HighlightState>();
                documentLengthState = new WeakMap<vscode.TextDocument, DocumentLengthState>();
            },
        },
    );

    // Initial update for SQL highlighting
    updateSqlHighlight(sqlStatementDecoration, vscode.window.activeTextEditor);
}

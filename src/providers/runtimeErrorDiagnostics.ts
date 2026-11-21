import * as vscode from 'vscode';
import type { DatabaseErrorDetails } from '@justybase/contracts';
import { SqlParser } from '../sql/sqlParser';

/**
 * Runtime-error diagnostics for a failed PostgreSQL statement.
 *
 * Static validation owns the `netezza-sql-linter` collection. Runtime errors
 * use a separate collection so the next automatic lint pass cannot delete the
 * server's position before the user reads it. A document edit clears the
 * entry because the submitted SQL no longer matches the buffer.
 */

const DIAGNOSTIC_SOURCE = 'PostgreSQL';

let collection: vscode.DiagnosticCollection | undefined;

function getCollection(): vscode.DiagnosticCollection {
    if (!collection) {
        collection = vscode.languages.createDiagnosticCollection('justybase-runtime-error');
    }
    return collection;
}

/** Register disposal and the edit invalidation hook. */
export function activateRuntimeErrorDiagnostics(context: vscode.ExtensionContext): void {
    const diagnostics = getCollection();
    context.subscriptions.push(diagnostics);
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            diagnostics.delete(event.document.uri);
        }),
    );
}

function locateSqlOffset(
    document: vscode.TextDocument,
    sql: string,
    databaseKind: string,
    statementIndex: number | undefined,
): number | undefined {
    const ranges = SqlParser.splitStatementsWithPositions(document.getText(), databaseKind);
    if (statementIndex !== undefined && ranges[statementIndex]?.sql === sql) {
        return ranges[statementIndex].startOffset;
    }
    const matches = ranges.filter(range => range.sql === sql);
    if (matches.length === 1) return matches[0]?.startOffset;
    if (matches.length > 1) return undefined;

    const text = document.getText();
    const first = text.indexOf(sql);
    if (first < 0) return undefined;
    // A duplicate statement would make the caret ambiguous; leave the error in
    // the result panel instead of pointing at the wrong occurrence.
    return text.indexOf(sql, first + 1) < 0 ? first : undefined;
}

function formatDiagnosticMessage(message: string, details: DatabaseErrorDetails | undefined): string {
    const parts = [message];
    if (details?.detail) parts.push(`DETAIL: ${details.detail}`);
    if (details?.hint) parts.push(`HINT: ${details.hint}`);
    if (details?.context) parts.push(`CONTEXT: ${details.context}`);
    return parts.join('\n');
}

/**
 * Publishes one diagnostic for a PostgreSQL server error that carried a
 * one-based character position. Errors without a position (transport errors,
 * PL/pgSQL runtime errors whose only locator is `CONTEXT`) are left to the
 * result panel.
 */
export function publishRuntimeErrorDiagnostic(
    documentUri: string,
    sql: string,
    message: string,
    details: DatabaseErrorDetails | undefined,
    databaseKind: string,
    statementIndex?: number,
): void {
    if (databaseKind !== 'postgresql') return;
    const position = details?.position;
    if (position === undefined || !Number.isFinite(position) || position < 1) return;
    if (position > sql.length + 1) return;

    const document = vscode.workspace.textDocuments.find(
        candidate => candidate.uri.toString() === documentUri,
    );
    if (!document) return;
    const statementOffset = locateSqlOffset(document, sql, databaseKind, statementIndex);
    if (statementOffset === undefined) return;

    const startOffset = statementOffset + position - 1;
    const endOffset = Math.min(startOffset + 1, statementOffset + sql.length);
    const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
        formatDiagnosticMessage(message, details),
        vscode.DiagnosticSeverity.Error,
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    if (details?.code) {
        diagnostic.code = details.code;
    }
    getCollection().set(document.uri, [diagnostic]);
}

/** Clears the runtime error for a document, for example after a successful run. */
export function clearRuntimeErrorDiagnostic(documentUri: string): void {
    // Do not create the collection just to clear it: most executions never
    // publish a PostgreSQL error, and minimal test harnesses mock only the
    // commands they exercise.
    collection?.delete(vscode.Uri.parse(documentUri));
}

/** Test-only reset; production disposal is owned by the extension context. */
export function resetRuntimeErrorDiagnostics(): void {
    collection?.dispose();
    collection = undefined;
}

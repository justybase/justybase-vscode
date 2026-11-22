/**
 * Run As — one-off execution on another saved connection profile.
 *
 * The tab keeps its connection, persistent session, metadata context and
 * existing result tabs. The run-as request owns a transient session on the
 * selected profile, so no connection switch (and no metadata refresh) happens.
 */

import * as vscode from 'vscode';
import { SqlParser } from '../../sql/sqlParser';
import { createConnectionQuickPickItems } from '../../utils/connectionQuickPick';
import { isSqlAuthoringLanguageId } from '../../utils/sqlLanguage';
import type { QueryCommandsDependencies } from './queryCommandTypes';
import { detectRiskyStatements } from './queryCommandSafety';
import { runSmartSequentialQuery } from './querySmartSequentialRun';

export type RunAsScope = 'selection' | 'statement' | 'wholeDocument';

const SCOPE_LABELS: Record<RunAsScope, string> = {
    selection: 'selection',
    statement: 'statement',
    wholeDocument: 'whole file',
};

const SCOPE_COMMANDS: Record<RunAsScope, string> = {
    selection: 'netezza.runAsSelection',
    statement: 'netezza.runAsStatement',
    wholeDocument: 'netezza.runAsWholeFile',
};

/** A run-as batch keeps dependent statements on one profile-owned session. */
function splitRunAsStatements(
    sql: string,
    databaseKind: string | undefined,
    singleProcedure: boolean,
): string[] {
    const trimmed = sql.trim();
    if (!trimmed) {
        return [];
    }
    if (singleProcedure) {
        return [trimmed];
    }
    const statements = SqlParser.splitStatements(trimmed, databaseKind).filter(statement => statement.trim().length > 0);
    return statements.length > 0 ? statements : [trimmed];
}

/** Resolve the SQL for one scope without touching the editor selection. */
export function resolveRunAsQueries(
    editor: vscode.TextEditor,
    scope: RunAsScope,
    databaseKind: string | undefined,
): string[] {
    const document = editor.document;

    if (scope === 'wholeDocument') {
        const text = document.getText();
        return splitRunAsStatements(
            text,
            databaseKind,
            /^\s*CREATE\s+(OR\s+REPLACE\s+)?PROCEDURE\b/i.test(text),
        );
    }

    if (scope === 'selection') {
        if (editor.selection.isEmpty) {
            return [];
        }
        return splitRunAsStatements(document.getText(editor.selection), databaseKind, false);
    }

    // The statement scope is anchored at the cursor so the command stays
    // independent of any earlier selection.
    const statement = SqlParser.getStatementAtPosition(
        document.getText(),
        document.offsetAt(editor.selection.active),
        undefined,
        databaseKind,
    );
    return statement ? [statement.sql] : [];
}

/** Pick a saved profile; never offers the ad-hoc credential path. */
export async function pickRunAsConnection(
    deps: QueryCommandsDependencies,
    documentUri: string,
): Promise<string | undefined> {
    const connections = await deps.connectionManager.getConnections();
    if (connections.length === 0) {
        void vscode.window.showWarningMessage('No connections configured. Create a connection profile first.');
        return undefined;
    }

    const currentConnection = deps.connectionManager.getConnectionForExecution(documentUri)
        || deps.connectionManager.getActiveConnectionName();
    const picked = await vscode.window.showQuickPick(
        createConnectionQuickPickItems(connections, currentConnection),
        {
            placeHolder: 'Run As: select a saved connection profile (one-off session)',
            title: 'Run As',
            ignoreFocusOut: true,
        },
    );
    return picked?.name;
}

/**
 * Confirm risky DML independently of `safeExecute.enabled`: a one-off session
 * on another identity is exactly where an unintended DELETE/TRUNCATE hurts.
 */
export async function confirmRunAsRisk(
    queries: readonly string[],
    connectionName: string,
): Promise<boolean> {
    const risky = detectRiskyStatements([...queries]);
    if (risky.length === 0) {
        return true;
    }
    const types = [...new Set(risky.map(item => item.type))];
    const selection = await vscode.window.showWarningMessage(
        `Run As "${connectionName}": detected risky statement(s): ${types.join(', ')}. Continue?`,
        {
            modal: true,
            detail: 'This SQL runs once with the privileges of the selected profile. The tab connection stays unchanged.',
        },
        'Run As Anyway',
    );
    return selection === 'Run As Anyway';
}

function statusText(connectionName: string, scope: RunAsScope): string {
    return `$(sync~spin) Run As ${connectionName} (${SCOPE_LABELS[scope]}): running…`;
}

function reportOutcome(
    connectionName: string,
    scope: RunAsScope,
    statements: number,
    outcome: 'completed' | 'failed' | 'cancelled' | undefined,
    durationMs: number,
): void {
    const target = `${connectionName} (${SCOPE_LABELS[scope]})`;
    if (outcome === 'completed') {
        const detail = `${statements} statement(s) in ${durationMs} ms`;
        vscode.window.setStatusBarMessage(`$(check) Run As ${target}: ${detail}`, 10_000);
        void vscode.window.showInformationMessage(
            `Run As ${target} completed: ${detail}. This tab's connection was not changed.`,
            'Show Results',
        ).then(action => {
            if (action === 'Show Results') {
                void vscode.commands.executeCommand('netezza.results.focus');
            }
        });
        return;
    }
    if (outcome === 'cancelled') {
        vscode.window.setStatusBarMessage(`$(circle-slash) Run As ${target}: cancelled`, 10_000);
        return;
    }
    // The executor already surfaced the database message; keep the status bar
    // signal so the failed one-off operation is not mistaken for a no-op.
    vscode.window.setStatusBarMessage(`$(error) Run As ${target}: failed after ${durationMs} ms`, 15_000);
}

/**
 * Execute the current scope once on a selected profile.
 * Returns the queue outcome so callers (and tests) can assert the result.
 */
export async function runQueryAs(
    deps: QueryCommandsDependencies,
    scope: RunAsScope,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isSqlAuthoringLanguageId(editor.document.languageId)) {
        void vscode.window.showWarningMessage('Run As is available only in a SQL editor.');
        return;
    }
    if (editor.document.uri.scheme === 'vscode-notebook-cell') {
        void vscode.window.showWarningMessage('Run As is not available for notebook cells. Open the SQL in an editor first.');
        return;
    }

    const documentUri = editor.document.uri.toString();
    const connectionName = await pickRunAsConnection(deps, documentUri);
    if (!connectionName) {
        return;
    }

    const databaseKind = deps.connectionManager.getConnectionDatabaseKind(connectionName);
    const queries = resolveRunAsQueries(editor, scope, databaseKind);
    if (queries.length === 0) {
        void vscode.window.showWarningMessage(
            scope === 'selection'
                ? 'Run As: select the SQL to execute first.'
                : 'Run As: no SQL statement found at the cursor.',
        );
        return;
    }

    if (!(await confirmRunAsRisk(queries, connectionName))) {
        return;
    }

    const startedAt = Date.now();
    const progress = vscode.window.setStatusBarMessage(statusText(connectionName, scope), 60_000);
    try {
        const outcome = await runSmartSequentialQuery(deps, {
            queries,
            runAs: { connectionName },
        });
        progress.dispose();
        reportOutcome(connectionName, scope, queries.length, outcome, Date.now() - startedAt);
    } catch (error: unknown) {
        progress.dispose();
        reportOutcome(connectionName, scope, queries.length, 'failed', Date.now() - startedAt);
        throw error;
    }
}

/** Register the three explicit Run As entry points used by the context menu. */
export function registerRunAsCommands(
    deps: QueryCommandsDependencies,
): vscode.Disposable[] {
    return (Object.keys(SCOPE_COMMANDS) as RunAsScope[]).map(scope =>
        vscode.commands.registerCommand(SCOPE_COMMANDS[scope], () => runQueryAs(deps, scope)),
    );
}

/** Exported for menu declarations and tests. */
export const RUN_AS_SCOPE_COMMANDS = SCOPE_COMMANDS;

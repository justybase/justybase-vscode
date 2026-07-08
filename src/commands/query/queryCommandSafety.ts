import * as vscode from 'vscode';
import {
    ConfigurationProvider,
    DefaultConfigurationProvider,
    DefaultUIService,
    UIService
} from './queryCommandTypes';

export interface RiskyStatement {
    type: 'DELETE' | 'UPDATE' | 'TRUNCATE';
}

/**
 * Strips leading comments from SQL - pure function, easily testable
 * @param sql - SQL string to process
 * @returns SQL string with leading comments removed
 */
export function stripLeadingComments(sql: string): string {
    return sql
        .replace(/^\s*(?:--[^\n]*\n\s*)+/g, '')
        .replace(/^\s*\/\*[\s\S]*?\*\/\s*/g, '')
        .trimStart();
}

/**
 * Detects risky SQL statements (DELETE/UPDATE without WHERE, TRUNCATE)
 * Pure function - easily testable without dependencies
 * @param queries - Array of SQL queries to analyze
 * @returns Array of detected risky statements
 */
export function detectRiskyStatements(queries: string[]): RiskyStatement[] {
    const risky: RiskyStatement[] = [];

    for (const query of queries) {
        const normalized = stripLeadingComments(query);
        const upper = normalized.toUpperCase();

        if (/^DELETE\s+FROM\b/i.test(normalized) && !/\bWHERE\b/i.test(upper)) {
            risky.push({ type: 'DELETE' });
            continue;
        }

        if (/^UPDATE\s+[\w."]+\s+SET\b/i.test(normalized) && !/\bWHERE\b/i.test(upper)) {
            risky.push({ type: 'UPDATE' });
            continue;
        }

        if (/^TRUNCATE\b/i.test(normalized)) {
            risky.push({ type: 'TRUNCATE' });
        }
    }

    return risky;
}

/**
 * Checks if a single query is a Python script invocation
 * Pure function - easily testable
 * @param query - SQL query to check
 * @returns Object indicating if it's a Python script and parsed tokens
 */
export function detectPythonScript(query: string): { isPython: boolean; pythonPath?: string; script?: string; args?: string[] } {
    const tokens = query.trim().split(/\s+/);
    const first = tokens[0] || '';

    const isPythonExec =
        /python(\.exe)?$/i.test(first) &&
        tokens.length >= 2 &&
        tokens[1].toLowerCase().endsWith('.py');
    const isScriptDirect = first.toLowerCase().endsWith('.py');

    if (isPythonExec) {
        return {
            isPython: true,
            pythonPath: tokens[0],
            script: tokens[1],
            args: tokens.slice(2)
        };
    } else if (isScriptDirect) {
        return {
            isPython: true,
            script: first,
            args: tokens.slice(1)
        };
    }

    return { isPython: false };
}

/**
 * Creates the confirmation message for risky statements
 * Pure function - easily testable
 * @param riskyTypes - Array of risky statement types
 * @returns Formatted message string
 */
export function formatRiskyStatementMessage(riskyTypes: string[]): string {
    return `Safe Execute: detected risky statement(s): ${riskyTypes.join(', ')} without additional guard. Continue?`;
}

/**
 * Confirms execution of potentially risky statements
 * Uses dependency injection for testability
 */
export async function confirmSafeExecuteWithDeps(
    queries: string[],
    config: ConfigurationProvider,
    ui: UIService
): Promise<boolean> {
    const safeExecuteEnabled = config.get<boolean>('safeExecute.enabled', true);
    if (!safeExecuteEnabled) {
        return true;
    }

    const risky = detectRiskyStatements(queries);
    if (risky.length === 0) {
        return true;
    }

    const types = [...new Set(risky.map(item => item.type))];
    const selection = await ui.showWarningMessage(
        formatRiskyStatementMessage(types),
        {
            modal: true,
            detail: 'You can disable this check in settings: netezza.safeExecute.enabled'
        },
        'Run Anyway'
    );

    return selection === 'Run Anyway';
}

/**
 * Original confirmSafeExecute using default dependencies
 * Maintains backward compatibility
 */
export async function confirmSafeExecute(queries: string[]): Promise<boolean> {
    return confirmSafeExecuteWithDeps(queries, new DefaultConfigurationProvider(), new DefaultUIService());
}

/**
 * Handles post-execution completion flow
 * Uses dependency injection for testability
 */
export async function handleExecutionCompletionWithDeps(
    sourceUri: string,
    ui: UIService,
    commands: {
        executeCommand: (command: string) => Thenable<unknown>;
        openTextDocument: (uri: vscode.Uri) => Thenable<vscode.TextDocument>;
        showTextDocument: (
            document: vscode.TextDocument,
            options?: vscode.TextDocumentShowOptions
        ) => Thenable<vscode.TextEditor>;
    },
    activeEditorUri: string | undefined
): Promise<void> {
    if (!activeEditorUri || activeEditorUri === sourceUri) {
        await commands.executeCommand('netezza.results.focus');
        return;
    }

    const sourceFileName = sourceUri.split(/[\\/]/).pop() || sourceUri;
    const switchAction = 'Switch to SQL Document';
    const showResultsAction = 'Show Results';
    const selectedAction = await ui.showInformationMessage(
        `SQL execution completed for ${sourceFileName}.`,
        switchAction,
        showResultsAction
    );

    if (selectedAction === switchAction) {
        try {
            const sourceDocument = await commands.openTextDocument(vscode.Uri.parse(sourceUri));
            await commands.showTextDocument(sourceDocument, { preview: false });
        } catch {
            ui.showWarningMessage(`Could not open SQL document: ${sourceFileName}`);
        }
        await commands.executeCommand('netezza.results.focus');
        return;
    }

    if (selectedAction === showResultsAction) {
        await commands.executeCommand('netezza.results.focus');
    }
}

export async function handleExecutionCompletion(sourceUri: string): Promise<void> {
    const activeEditorUri = vscode.window.activeTextEditor?.document?.uri?.toString();
    await handleExecutionCompletionWithDeps(
        sourceUri,
        new DefaultUIService(),
        {
            executeCommand: vscode.commands.executeCommand,
            openTextDocument: vscode.workspace.openTextDocument,
            showTextDocument: vscode.window.showTextDocument
        },
        activeEditorUri
    );
}

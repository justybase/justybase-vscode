import * as vscode from 'vscode';
import type { DatabaseKind } from '../contracts/database';

/** The remediation text is deliberately independent of connection details. */
export const ACCESS_SORT_ORDER_INSTRUCTIONS = [
    '1. Make a backup copy of the .mdb/.accdb file.',
    '2. Open the database in Microsoft Access.',
    '3. Go to File → Options → General.',
    '4. Set New database sort order to General - Legacy (or General).',
    '5. Run Database Tools → Compact and Repair Database.',
    '6. Close Microsoft Access and retry the operation.',
].join('\n');

export const ACCESS_UNSUPPORTED_SORT_ORDER_MESSAGE =
    'Microsoft Access uses a database sort order that UCanAccess cannot read.\n\n' +
    ACCESS_SORT_ORDER_INSTRUCTIONS;

export const ACCESS_OBJECT_NOT_FOUND_MESSAGE =
    'Table {table} does not exist in the active database, or the user does not have access to it. ' +
    'Refresh metadata or choose an existing table.';

function collectErrorMessages(error: unknown, maxDepth = 8): string[] {
    const messages: string[] = [];
    let current: unknown = error;
    const seen = new Set<unknown>();

    for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth++) {
        if (seen.has(current)) {
            break;
        }
        seen.add(current);

        if (current instanceof Error) {
            messages.push(current.message);
            current = current.cause;
            continue;
        }

        if (typeof current === 'object' && 'message' in current) {
            const message = (current as { message?: unknown }).message;
            if (typeof message === 'string') {
                messages.push(message);
            }
        } else {
            messages.push(String(current));
        }
        break;
    }

    return messages.filter(message => message.trim().length > 0);
}

export function getAccessErrorText(error: unknown): string {
    return collectErrorMessages(error).join(' ');
}

/**
 * Detects the Jackcess/UCanAccess collation failure without treating unrelated
 * UCA exceptions as sort-order failures.
 */
export function isAccessUnsupportedSortOrderError(error: unknown): boolean {
    const text = getAccessErrorText(error);
    const normalized = text.toLowerCase();
    const mentionsSortOrder =
        normalized.includes('unsupported collating sort order')
        || /sortorder\s*\[\s*1045\b/i.test(text)
        || normalized.includes('sort order 1045');

    if (mentionsSortOrder) {
        return true;
    }

    return normalized.includes('ucaexc')
        && (normalized.includes('collat') || normalized.includes('1045') || normalized.includes('sortorder'));
}

export function isAccessObjectNotFoundError(error: unknown): boolean {
    const normalized = getAccessErrorText(error).toLowerCase();
    return normalized.includes('user lacks privilege or object not found');
}

function isAccessDatabaseKind(databaseKind: DatabaseKind | string | undefined): boolean {
    const normalized = databaseKind?.trim().toLowerCase();
    return normalized === 'access' || normalized === 'mdb' || normalized === 'accdb' || normalized === 'msaccess';
}

function unquoteIdentifier(identifier: string): string {
    const trimmed = identifier.trim();
    if (
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
        || (trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith('`') && trimmed.endsWith('`'))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function splitQualifiedIdentifier(identifier: string): string[] {
    const parts: string[] = [];
    let start = 0;
    let quote: '[' | '"' | '`' | undefined;

    for (let index = 0; index < identifier.length; index++) {
        const character = identifier[index];
        if (quote === '[') {
            if (character === ']') {
                quote = undefined;
            }
            continue;
        }
        if (quote === '"' || quote === '`') {
            if (character === quote) {
                if (identifier[index + 1] === quote) {
                    index++;
                } else {
                    quote = undefined;
                }
            }
            continue;
        }
        if (character === '[' || character === '"' || character === '`') {
            quote = character;
        } else if (character === '.') {
            parts.push(identifier.slice(start, index));
            start = index + 1;
        }
    }

    parts.push(identifier.slice(start));
    return parts;
}

/** Best-effort extraction for the table name used by a failed SELECT/DDL. */
export function extractAccessTableName(sql: string | undefined): string {
    if (!sql) {
        return 'specified table';
    }

    const identifier = '(?:\\[[^\\]]+\\]|"[^"]+"|`[^`]+`|[A-Za-z_][\\w$#@]*)';
    const match = sql.match(new RegExp(
        `\\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\\s+(${identifier}(?:\\s*\\.\\s*${identifier}){0,2})`,
        'i',
    ));
    if (!match) {
        return 'specified table';
    }

    const parts = splitQualifiedIdentifier(match[1]).map(part => unquoteIdentifier(part));
    return parts[parts.length - 1]?.trim() || 'specified table';
}

export function formatAccessObjectNotFoundMessage(sql?: string): string {
    return ACCESS_OBJECT_NOT_FOUND_MESSAGE.replace(
        '{table}',
        `\`${extractAccessTableName(sql)}\``,
    );
}

export interface AccessErrorPresentationOptions {
    databaseKind?: DatabaseKind | string;
    sql?: string;
    outputChannel?: vscode.OutputChannel;
    operation?: string;
}

export function formatAccessFailureMessage(
    error: unknown,
    options: Pick<AccessErrorPresentationOptions, 'databaseKind' | 'sql'> = {},
): string | undefined {
    if (
        isAccessUnsupportedSortOrderError(error)
        && (options.databaseKind === undefined || isAccessDatabaseKind(options.databaseKind))
    ) {
        return ACCESS_UNSUPPORTED_SORT_ORDER_MESSAGE;
    }
    if (isAccessDatabaseKind(options.databaseKind) && isAccessObjectNotFoundError(error)) {
        return formatAccessObjectNotFoundMessage(options.sql);
    }
    return undefined;
}

function logRawAccessError(error: unknown, options: AccessErrorPresentationOptions): void {
    const raw = getAccessErrorText(error);
    if (!raw) {
        return;
    }
    options.outputChannel?.appendLine(
        `[${options.operation ?? 'Access'}] Raw Access error: ${raw}`,
    );
}

/**
 * Shows the specialized Access dialog when applicable. Returns true when the
 * caller should skip its generic error dialog.
 */
export async function presentAccessError(
    error: unknown,
    options: AccessErrorPresentationOptions = {},
): Promise<boolean> {
    if (
        isAccessUnsupportedSortOrderError(error)
        && (options.databaseKind === undefined || isAccessDatabaseKind(options.databaseKind))
    ) {
        logRawAccessError(error, options);
        const action = await vscode.window.showErrorMessage(
            ACCESS_UNSUPPORTED_SORT_ORDER_MESSAGE,
            { modal: true },
            'Copy instructions',
        );
        if (action === 'Copy instructions') {
            await vscode.env.clipboard.writeText(ACCESS_SORT_ORDER_INSTRUCTIONS);
            vscode.window.showInformationMessage('Access repair instructions copied to the clipboard.');
        }
        return true;
    }

    if (isAccessDatabaseKind(options.databaseKind) && isAccessObjectNotFoundError(error)) {
        logRawAccessError(error, options);
        vscode.window.showErrorMessage(formatAccessObjectNotFoundMessage(options.sql));
        return true;
    }

    return false;
}

import * as vscode from 'vscode';
import type { DatabaseKind } from '../contracts/database';
import { normalizeDatabaseKind } from '../contracts/database';

const DIALECT_ICON_PATHS: Readonly<Partial<Record<DatabaseKind, readonly string[]>>> = {
    netezza: ['netezza_icon64.png'],
    sqlite: ['media', 'sqlite-dialect.svg'],
    duckdb: ['media', 'duckdb-dialect.svg'],
    db2: ['media', 'db2-dialect.svg'],
    postgresql: ['media', 'postgresql-dialect.svg'],
    vertica: ['media', 'vertica-dialect.svg'],
    oracle: ['media', 'oracle-dialect.svg'],
    mssql: ['media', 'mssql-dialect.svg'],
    mysql: ['media', 'mysql-dialect.svg'],
    snowflake: ['media', 'snowflake-dialect.svg'],
};

const DEFAULT_ICON_PATH: readonly string[] = ['icon.svg'];

export function getDialectIconSegments(kind?: string | DatabaseKind): readonly string[] {
    const normalizedKind = normalizeDatabaseKind(kind);
    return DIALECT_ICON_PATHS[normalizedKind] ?? DEFAULT_ICON_PATH;
}

export function getDialectIconUri(extensionUri: vscode.Uri, kind?: string | DatabaseKind): vscode.Uri {
    return vscode.Uri.joinPath(extensionUri, ...getDialectIconSegments(kind));
}

export function getDialectIconWebviewUri(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    kind?: string | DatabaseKind
): vscode.Uri {
    return webview.asWebviewUri(getDialectIconUri(extensionUri, kind));
}
